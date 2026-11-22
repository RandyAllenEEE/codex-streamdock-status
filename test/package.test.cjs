'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const { WebSocketServer } = require('ws');
const { loadEndpoint, sendEvent } = require('../src/pipe.cjs');
const { PNG } = require('pngjs');

const root = join(__dirname, '..');
const name = 'com.randy.streamdock.codexstatus.sdPlugin';
const packaged = join(root, 'release', name);
const packagedHooks = join(root, 'release', 'codex-streamdock-hooks.zip');

test('the packaged receiver rotates its endpoint and the bundled sender updates a key',
  { skip: process.platform !== 'win32' || !existsSync(packaged), timeout: 10_000 }, async t => {
    const files = unzipSync(new Uint8Array(readFileSync(packaged)));
    assert.equal(Object.keys(files).length, 10);
    const manifest = JSON.parse(Buffer.from(files[name + '/manifest.json']));
    assert.equal(manifest.SDKVersion, 3);
    assert.equal(manifest.Actions[0].UserTitleEnabled, true);
    assert.equal(manifest.Actions[0].States[0].Title, '');
    assert.ok(files[name + '/LICENCE']);
    assert.ok(files[name + '/THIRD_PARTY_NOTICES.txt']);
    assert.ok(files[name + '/static/status.png']);
    assert.ok(files[name + '/hooks/hook.cjs']);
    assert.equal(files[name + '/hooks/endpoint.json'], undefined);
    const hookFiles = unzipSync(new Uint8Array(readFileSync(packagedHooks)));
    assert.ok(hookFiles['codex-streamdock-hooks/scripts/hooks.ps1']);
    assert.equal(hookFiles['codex-streamdock-hooks/src/hook.cjs'], undefined);

    const parent = realpathSync(tmpdir());
    const folder = mkdtempSync(join(parent, 'codex-packed-entry-'));
    for (const [key, data] of Object.entries(files)) {
      assert.ok(key.startsWith(name + '/') && !key.split('/').includes('..'));
      const filename = join(folder, key);
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename, data);
    }
    const plugin = join(folder, name);
    const codexHome = join(folder, 'codex');
    mkdirSync(codexHome);
    const endpoint = join(plugin, 'hooks', 'endpoint.json');
    const sender = join(plugin, 'hooks', 'hook.cjs');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    let child;
    let exited;
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      server.close();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      const actual = realpathSync(folder);
      assert.equal(dirname(actual), parent);
      rmSync(actual, { recursive: true });
    });
    // Windows keeps a loaded .node file locked until its process exits.
    const probe = spawnSync(process.execPath, ['-e', [
      "const assert = require('node:assert/strict');",
      'const foreground = require(process.argv[1]);',
      "assert.equal(typeof foreground.isCodexForeground(), 'boolean');",
      'assert.throws(() => foreground.start(null), /callback/);',
      'for (let i = 0; i < 3; i++) { foreground.start(() => {}); foreground.stop(); }',
      'foreground.start(() => {});',
    ].join('\n'), join(plugin, 'plugin', 'foreground.node')], {
      windowsHide: true, encoding: 'utf8', timeout: 2_000,
    });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    let oldToken;
    for (let launch = 0; launch < 2; launch += 1) {
      const uuid = randomBytes(16).toString('hex');
      const listening = once(server, 'connection');
      child = spawn(process.execPath, [
        join(plugin, manifest.CodePathWin), '-port', String(server.address().port),
        '-pluginUUID', uuid, '-registerEvent', 'registerPlugin',
      ], { windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome } });
      let errors = '';
      child.stderr.on('data', data => { errors += data; });
      exited = once(child, 'close');
      const [socket] = await listening;
      const [message] = await once(socket, 'message');
      assert.deepEqual(JSON.parse(message), { event: 'registerPlugin', uuid });
      const firstImage = once(socket, 'message');
      socket.send(JSON.stringify({
        event: 'willAppear', action: manifest.Actions[0].UUID, context: 'validation-key',
      }));
      const initial = JSON.parse((await firstImage)[0]);
      assert.equal(initial.event, 'setImage');
      const published = loadEndpoint(endpoint);
      assert.ok(published);
      assert.notEqual(published.token, oldToken);
      oldToken = published.token;

      const change = once(socket, 'message');
      const hook = spawnSync(process.execPath, [sender], {
        input: '{"hook_event_name":"UserPromptSubmit","session_id":"a","turn_id":"t1"}',
        encoding: 'utf8', windowsHide: true, timeout: 2_000,
      });
      assert.ifError(hook.error);
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stdout.trim(), '{}');
      const updated = JSON.parse((await change)[0]);
      assert.equal(updated.event, 'setImage');
      assert.notEqual(updated.payload.image, initial.payload.image);
      const done = once(socket, 'message');
      const at = Date.now() + 1;
      const event = { sessionId: 'a', turnId: 't1' };
      assert.equal(await sendEvent(published, { ...event, kind: 'modelCompleted', at }), true);
      assert.equal(await sendEvent(published, { ...event, kind: 'stop', at: at + 1 }), true);
      const completed = JSON.parse((await done)[0]);
      const blue = PNG.sync.read(Buffer.from(completed.payload.image.split(',')[1], 'base64'));
      assert.deepEqual([...blue.data.subarray(0, 3)], [18, 100, 174]);
      socket.terminate();
      assert.deepEqual(await exited, [0, null]);
      assert.equal(errors, '');
    }
  });
