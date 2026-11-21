'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const hidden = { windowsHide: true, timeout: 4_000 };
let installedProtocol;

function threadUri(sessionId) {
  return typeof sessionId === 'string' && uuid.test(sessionId)
    ? 'codex://threads/' + sessionId : null;
}

function hasCodexProtocol(execute) {
  return execute(path.join(system32, 'reg.exe'), ['query', 'HKCR\\codex', '/v', 'URL Protocol'], hidden)
    .then(() => true, () => false);
}

function prepareNavigation() {
  if (process.platform === 'win32') installedProtocol = hasCodexProtocol(run);
}

async function activateChatGPT(execute) {
  const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$app = Get-StartApps | Where-Object { $_.AppID -match "^OpenAI\\.Codex_[A-Za-z0-9]+!App$" } | Select-Object -First 1',
    'if (!$app) { exit 1 }',
    'Start-Process -FilePath (Join-Path $env:WINDIR "explorer.exe") -ArgumentList ("shell:AppsFolder\\" + $app.AppID)',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], hidden);
}

async function openChatGPT(sessionId, { execute = run } = {}) {
  const uri = threadUri(sessionId);
  if (uri) {
    const available = await (execute === run && installedProtocol ? installedProtocol : hasCodexProtocol(execute));
    if (available) {
      try {
        // The URI contains a validated UUID. CMD's START forwards it to the registered handler.
        await execute(path.join(system32, 'cmd.exe'), [
          '/d', '/s', '/c', 'start "" "' + uri + '"',
        ], { ...hidden, windowsVerbatimArguments: true });
        return true;
      } catch {
        if (execute === run) installedProtocol = undefined;
      }
    } else if (execute === run) {
      installedProtocol = undefined;
    }
  }
  await activateChatGPT(execute);
  return false;
}

module.exports = { threadUri, openChatGPT, prepareNavigation };
