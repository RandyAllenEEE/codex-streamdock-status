#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateSet('Install', 'Uninstall', 'Status')][string]$Action,
    [ValidateSet('Project', 'User')][string]$Scope = 'Project',
    [string]$ProjectRoot,
    [string]$StreamDockExecutable,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'CodexStreamDockStatus'
$launcherPath = Join-Path $runtimeRoot 'emit.cmd'
$endpointPath = Join-Path $runtimeRoot 'endpoint.json'
$registeredEvents = @(
    'UserPromptSubmit', 'PermissionRequest', 'PreModelRequest',
    'PostModelRequest', 'Stop', 'Interrupt', 'SessionEnd'
)

if ($Scope -eq 'Project') {
    if (!$ProjectRoot) { throw 'Provide -ProjectRoot for project-scoped hooks.' }
    $project = Get-Item -LiteralPath $ProjectRoot
    if (!$project.PSIsContainer) { throw 'ProjectRoot must be an existing directory.' }
    $configDirectory = Join-Path $project.FullName '.codex'
} else {
    if ($ProjectRoot) { throw 'Use -ProjectRoot only with -Scope Project.' }
    $configDirectory = if ($env:CODEX_HOME) {
        [IO.Path]::GetFullPath($env:CODEX_HOME)
    } else {
        Join-Path $env:USERPROFILE '.codex'
    }
}
$configPath = Join-Path $configDirectory 'hooks.json'

function Write-AtomicText([string]$Destination, [string]$Value) {
    if ([IO.File]::Exists($Destination) -and [IO.File]::ReadAllText($Destination) -ceq $Value) { return }
    $tempPath = $Destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($tempPath, $Value, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Destination)) {
            [IO.File]::Move($tempPath, $Destination, $true)
        } else {
            [IO.File]::Move($tempPath, $Destination)
        }
    } finally {
        if ([IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
    }
}

function Resolve-NodeRuntime {
    if ($NodePath) {
        $resolvedNode = (Get-Item -LiteralPath $NodePath).FullName
    } else {
        $hostExe = $StreamDockExecutable
        if (!$hostExe) {
            $hostExe = Get-Process -Name StreamDock -ErrorAction SilentlyContinue |
                Select-Object -First 1 -ExpandProperty Path
        }
        if (!$hostExe) { throw 'Start Stream Dock or supply -StreamDockExecutable or -NodePath.' }
        $hostExe = (Get-Item -LiteralPath $hostExe).FullName
        $resolvedNode = Join-Path (Split-Path -Parent $hostExe) 'node\node20.exe'
        $resolvedNode = (Get-Item -LiteralPath $resolvedNode).FullName
    }
    if ($resolvedNode -match '[%"!\r\n]') { throw 'The Node executable path is not suitable for the CMD launcher.' }
    $version = & $resolvedNode --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+\.\d+\.\d+)' -or
         [version]$Matches[1] -lt [version]'20.8.1') {
        throw 'Node.js 20.8.1 or newer is required.'
    }
    return $resolvedNode
}

if ($launcherPath -match '[%"!\r\n]') {
    throw 'The local application data path is not suitable for the CMD launcher.'
}
$command = 'cmd.exe /d /s /c call "' + $launcherPath + '"'
$launcherCommand = $command
$runtimeHook = Join-Path $runtimeRoot 'hook.cjs'
$commandSuffix = ' ' + $runtimeHook + ' ' + $endpointPath

function Is-OwnedHandler($Handler) {
    if ($Handler.type -ne 'command') { return $false }
    foreach ($configured in @($Handler.command, $Handler.commandWindows)) {
        if ($configured -is [string] -and ($configured -ceq $launcherCommand -or
            $configured.EndsWith($commandSuffix, [StringComparison]::OrdinalIgnoreCase))) {
            return $true
        }
    }
    return $false
}

$config = [pscustomobject]@{}
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
if ($config -isnot [pscustomobject]) { throw 'hooks.json must contain a JSON object.' }
if ($null -eq $config.PSObject.Properties['hooks']) {
    $config | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}
if ($config.hooks -isnot [pscustomobject]) { throw 'The hooks property must contain a JSON object.' }

$ownedCount = 0
foreach ($eventName in $registeredEvents) {
    $entry = $config.hooks.PSObject.Properties[$eventName]
    if ($null -eq $entry) { continue }
    if ($entry.Value -isnot [array]) { throw "$eventName must contain an array." }
    foreach ($group in $entry.Value) {
        if ($group -isnot [pscustomobject] -or $group.hooks -isnot [array]) {
            throw "Invalid hook group in $eventName."
        }
        $ownedCount += @($group.hooks | Where-Object { Is-OwnedHandler $_ }).Count
    }
}

if ($Action -eq 'Status') {
    [pscustomobject]@{
        Scope = $Scope
        Configuration = $configPath
        RegisteredHandlers = $ownedCount
        EndpointConfigured = (Test-Path -LiteralPath $endpointPath)
    }
    return
}
if ($Action -eq 'Uninstall' -and $ownedCount -eq 0) {
    Write-Output 'No Codex Stream Dock Status hooks in this scope.'
    return
}
if (!$PSCmdlet.ShouldProcess($configPath, "$Action Codex Stream Dock Status hooks")) { return }

if ($Action -eq 'Install') {
    $nodeRuntime = Resolve-NodeRuntime
    $barePaths = '^[A-Za-z0-9_:\\.\-]+$'
    if ($nodeRuntime -match $barePaths -and $runtimeHook -match $barePaths -and $endpointPath -match $barePaths) {
        $command = $nodeRuntime + $commandSuffix
    }
    $sourceRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'src'
    $sourceFiles = @('hook.cjs', 'events.cjs', 'pipe.cjs')
    foreach ($sourceFile in $sourceFiles) {
        if (!(Test-Path -LiteralPath (Join-Path $sourceRoot $sourceFile) -PathType Leaf)) {
            throw "Missing Hook source: $sourceFile"
        }
    }
    if (Test-Path -LiteralPath $endpointPath) {
        $saved = Get-Content -LiteralPath $endpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.token -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid endpoint.json token.' }
    }
    [void][IO.Directory]::CreateDirectory($runtimeRoot)
    foreach ($sourceFile in $sourceFiles) {
        $contents = [IO.File]::ReadAllText((Join-Path $sourceRoot $sourceFile))
        Write-AtomicText (Join-Path $runtimeRoot $sourceFile) $contents
    }
    if (!(Test-Path -LiteralPath $endpointPath)) {
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $bytes = New-Object byte[] 32
            $random.GetBytes($bytes)
        } finally { $random.Dispose() }
        $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        Write-AtomicText $endpointPath (@{ token = $token } | ConvertTo-Json -Compress)
    }
    $launcher = @('@echo off', 'setlocal DisableDelayedExpansion')
    if ($nodeRuntime -match '[^\x00-\x7f]') { $launcher += 'chcp 65001 >nul' }
    $launcher += '"' + $nodeRuntime + '" "%~dp0hook.cjs" "%~dp0endpoint.json"'
    $launcher += 'exit /b %ERRORLEVEL%'
    Write-AtomicText $launcherPath (($launcher -join "`r`n") + "`r`n")
}

foreach ($eventName in $registeredEvents) {
    $entry = $config.hooks.PSObject.Properties[$eventName]
    $groups = [Collections.Generic.List[object]]::new()
    if ($null -ne $entry) {
        foreach ($group in $entry.Value) {
            $remaining = @($group.hooks | Where-Object { !(Is-OwnedHandler $_) })
            if ($remaining.Count -eq $group.hooks.Count -or $remaining.Count -gt 0) {
                $group.hooks = $remaining
                $groups.Add($group)
            }
        }
    }
    if ($Action -eq 'Install') {
        $groups.Add([pscustomobject]@{
            hooks = @([pscustomobject]@{ type = 'command'; command = $command; timeout = 1 })
        })
    }
    if ($null -ne $entry) { $config.hooks.PSObject.Properties.Remove($eventName) }
    if ($groups.Count -gt 0) {
        $config.hooks | Add-Member -NotePropertyName $eventName -NotePropertyValue $groups.ToArray()
    }
}

[void][IO.Directory]::CreateDirectory($configDirectory)
if (Test-Path -LiteralPath $configPath) {
    $backup = $configPath + '.codex-streamdock-status.bak'
    if (!(Test-Path -LiteralPath $backup)) { [IO.File]::Copy($configPath, $backup) }
}
Write-AtomicText $configPath (($config | ConvertTo-Json -Depth 100) + [char]10)
Write-Output "$Action complete for $Scope scope. Configuration: $configPath"
if ($Action -eq 'Install') { Write-Output 'Review and trust the hooks in Codex Settings > Hooks.' }
