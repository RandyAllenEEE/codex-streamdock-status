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
    const env = { ...process.env, LOCALAPPDATA: path.join(folder, 'local app data'),
      CODEX_HOME: path.join(folder, 'codex user') };
    const plugin = path.join(folder, 'test plugin.sdPlugin');
    const runtime = path.join(plugin, 'hooks');
    fs.mkdirSync(runtime, { recursive: true });
    for (const file of ['hook.cjs', 'events.cjs', 'pipe.cjs']) {
      fs.copyFileSync(path.join(__dirname, '..', 'src', file), path.join(runtime, file));
    }
    const original = {
      description: 'Existing hooks',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo retained' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo also retained' }] }],
        PreToolUse: [{ matcher: '^shell$', hooks: [{ type: 'command', command: 'echo tool retained' }] }],
      },
    };
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const legacyLauncher = 'cmd.exe /d /s /c call "'
      + path.join(env.LOCALAPPDATA, 'CodexStreamDockStatus', 'emit.cmd') + '"';
    const old = structuredClone(original);
    old.hooks.Stop.push({ hooks: [{ type: 'command', command: legacyLauncher }] });
    fs.writeFileSync(config, JSON.stringify(old));

    function run(action, scope = 'Project') {
      const result = spawnSync('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-File', installer,
        '-Action', action, '-Scope', scope, ...(scope === 'Project' ? ['-ProjectRoot', project] : []),
        '-NodePath', process.execPath,
        '-PluginDirectory', plugin,
      ], { env, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout;
    }
    run('Install');
    const firstInstall = fs.readFileSync(config, 'utf8');
    run('Install');
    assert.equal(fs.readFileSync(config, 'utf8'), firstInstall);
    const content = JSON.parse(firstInstall);
    assert.equal(Object.keys(content.hooks).length, 10);
    assert.deepEqual(content.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
    assert.equal(content.hooks.PreToolUse[1].matcher, '^request_user_input$');
    assert.equal(content.hooks.PostToolUse[0].matcher, '^request_user_input$');
    assert.equal(content.hooks.Stop.length, 2);
    assert.deepEqual(content.hooks.Stop[0], original.hooks.Stop[0]);
    const command = content.hooks.Stop[1].hooks[0].command;
    const registeredHook = command.match(/ -- "([^"]+)"$/)?.[1];
    assert.ok(registeredHook, 'Expected a quoted Hook script path');
    assert.equal(
      fs.realpathSync.native(registeredHook),
      fs.realpathSync.native(path.join(runtime, 'hook.cjs')),
    );
    assert.equal(fs.existsSync(env.LOCALAPPDATA), false);
    const input = JSON.stringify({
      hook_event_name: 'Stop', session_id: 'a', turn_id: 't1', fixture: 'x'.repeat(65_536),
    });
    function invokeHook() {
      const hook = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
        env, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8',
        timeout: 2_000, input,
      });
      assert.ifError(hook.error);
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stdout.trim(), '{}');
    }
    invokeHook();
    fs.renameSync(plugin, plugin + '.old');
    invokeHook();
    fs.renameSync(plugin + '.old', plugin);
    run('Uninstall');
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), original);

    const user = path.join(env.CODEX_HOME, 'hooks.json');
    fs.mkdirSync(env.CODEX_HOME);
    const earlierUser = structuredClone(content);
    earlierUser.hooks.PreToolUse.pop();
    delete earlierUser.hooks.PostToolUse;
    fs.writeFileSync(user, JSON.stringify(earlierUser));
    assert.match(run('Status', 'User'), /hooks\.json\s+7\s+False/);
    run('Install', 'User');
    assert.deepEqual(JSON.parse(fs.readFileSync(user, 'utf8')), content);
    assert.match(run('Status', 'User'), /hooks\.json\s+9\s+False/);
    run('Uninstall', 'User');
    assert.deepEqual(JSON.parse(fs.readFileSync(user, 'utf8')), original);
  });
