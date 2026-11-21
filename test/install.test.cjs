'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const installer = path.join(__dirname, '..', 'scripts', 'hooks.ps1');

test('PowerShell installer preserves other hook groups and is idempotent',
  { skip: process.platform !== 'win32' }, t => {
    const parent = fs.realpathSync(os.tmpdir());
    const folder = fs.mkdtempSync(path.join(parent, 'codex-status-install-'));
    t.after(() => {
      const actual = fs.realpathSync(folder);
      assert.equal(path.dirname(actual), parent);
      assert.match(path.basename(actual), /^codex-status-install-/);
      fs.rmSync(actual, { recursive: true });
    });
    const project = path.join(folder, 'test project');
    const config = path.join(project, '.codex', 'hooks.json');
    const env = { ...process.env, LOCALAPPDATA: path.join(folder, 'local app data') };
    const original = {
      description: 'Existing hooks',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo retained' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo also retained' }] }],
      },
    };
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(original));

    function run(action) {
      const result = spawnSync('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-File', installer,
        '-Action', action, '-ProjectRoot', project, '-NodePath', process.execPath,
      ], { env, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    run('Install');
    run('Install');
    const content = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(Object.keys(content.hooks).length, 8);
    assert.equal(content.hooks.Stop.length, 2);
    assert.deepEqual(content.hooks.Stop[0], original.hooks.Stop[0]);
    const command = content.hooks.Stop[1].hooks[0].command;
    const hook = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      env, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8',
      timeout: 2_000, input: '{"hook_event_name":"Stop","session_id":"a","turn_id":"t1"}',
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stdout.trim(), '{}');
    run('Uninstall');
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), original);
  });
