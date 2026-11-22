#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateSet('Install', 'Uninstall', 'Status')][string]$Action,
    [ValidateSet('Project', 'User')][string]$Scope = 'Project',
    [string]$ProjectRoot,
    [string]$StreamDockExecutable,
    [string]$NodePath,
    [string]$PluginDirectory
)

$ErrorActionPreference = 'Stop'
$pluginRoot = if ($PluginDirectory) {
    [IO.Path]::GetFullPath($PluginDirectory)
} else {
    Join-Path $env:APPDATA 'HotSpot\StreamDock\plugins\com.randy.streamdock.codexstatus.sdPlugin'
}
$runtimeRoot = Join-Path $pluginRoot 'hooks'
$runtimeHook = Join-Path $runtimeRoot 'hook.cjs'
$endpointPath = Join-Path $runtimeRoot 'endpoint.json'
$registeredEvents = @(
    'UserPromptSubmit', 'PermissionRequest', 'PreModelRequest',
    'PostModelRequest', 'Stop', 'Interrupt', 'SessionEnd', 'PreToolUse', 'PostToolUse'
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
    if ($resolvedNode -match '[%"!\^\r\n]') { throw 'The Node executable path cannot be quoted safely for the Hook command.' }
    $version = & $resolvedNode --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+\.\d+\.\d+)' -or
         [version]$Matches[1] -lt [version]'20.8.1') {
        throw 'Node.js 20.8.1 or newer is required.'
    }
    return $resolvedNode
}

if ($runtimeHook -match '[%"!\^\r\n]') {
    throw 'The plugin path cannot be quoted safely for the Hook command.'
}
# The fixed entry point drains stdin if the plugin is absent during an update.
$bootstrap = 'try{require(process.argv[1]).main()}catch(e){if(e.code===''MODULE_NOT_FOUND''){process.stdin.resume();process.stdin.on(''end'',console.log.bind(console,''{}''))}else{throw(e)}}'
$commandSuffix = ' -e "' + $bootstrap + '" -- "' + $runtimeHook + '"'
$legacyRoot = Join-Path $env:LOCALAPPDATA 'CodexStreamDockStatus'
$legacyLauncher = 'cmd.exe /d /s /c call "' + (Join-Path $legacyRoot 'emit.cmd') + '"'
$legacySuffix = ' ' + (Join-Path $legacyRoot 'hook.cjs') + ' ' + (Join-Path $legacyRoot 'endpoint.json')

function Is-OwnedHandler($Handler) {
    if ($Handler.type -ne 'command') { return $false }
    foreach ($configured in @($Handler.command, $Handler.commandWindows)) {
        if ($configured -is [string] -and ($configured -ceq $legacyLauncher -or
            $configured.EndsWith($legacySuffix, [StringComparison]::OrdinalIgnoreCase) -or
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
    foreach ($sourceFile in @('hook.cjs', 'events.cjs', 'pipe.cjs')) {
        if (!(Test-Path -LiteralPath (Join-Path $runtimeRoot $sourceFile) -PathType Leaf)) {
            throw "Install the Codex Status Stream Dock plugin first. Missing $sourceFile in $runtimeRoot"
        }
    }
    $nodeRuntime = Resolve-NodeRuntime
    $command = if ($nodeRuntime -match '^[A-Za-z0-9_:\\.\-]+$') {
        $nodeRuntime + $commandSuffix
    } else {
        'cmd.exe /d /s /v:off /c call "' + $nodeRuntime + '"' + $commandSuffix
    }
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
        $group = [pscustomobject]@{
            hooks = @([pscustomobject]@{ type = 'command'; command = $command; timeout = 1 })
        }
        if ($eventName -in @('PreToolUse', 'PostToolUse')) {
            $group | Add-Member -NotePropertyName matcher -NotePropertyValue '^request_user_input$'
        }
        $groups.Add($group)
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
