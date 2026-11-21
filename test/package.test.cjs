'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { unzipSync } = require('fflate');
const { WebSocketServer } = require('ws');

const root = join(__dirname, '..');
const name = 'com.randy.streamdock.codexstatus.sdPlugin';
const packaged = join(root, 'release', name);
const packagedHooks = join(root, 'release', 'codex-streamdock-hooks.zip');

test('the packaged bundle registers as an actual child process',
  { skip: !existsSync(packaged) ? 'Build packages first' : false, timeout: 10_000 }, async t => {
    const files = unzipSync(new Uint8Array(readFileSync(packaged)));
    assert.equal(Object.keys(files).length, 6);
    const manifest = JSON.parse(Buffer.from(files[name + '/manifest.json']));
    assert.equal(manifest.SDKVersion, 3);
    assert.ok(files[name + '/LICENCE']);
    assert.ok(files[name + '/THIRD_PARTY_NOTICES.txt']);
    assert.ok(files[name + '/static/status.png']);
    const hookFiles = unzipSync(new Uint8Array(readFileSync(packagedHooks)));
    assert.ok(hookFiles['codex-streamdock-hooks/scripts/hooks.ps1']);

    const folder = mkdtempSync(join(tmpdir(), 'codex-packed-entry-'));
    const plugin = join(folder, 'index.js');
    writeFileSync(plugin, files[name + '/' + manifest.CodePathWin]);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const token = randomBytes(16).toString('hex');
    const listening = once(server, 'connection');
    const child = spawn(process.execPath, [
      plugin, '-port', String(server.address().port),
      '-pluginUUID', token, '-registerEvent', 'registerPlugin',
    ], {
      windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: folder },
    });
    t.after(async () => {
      const exited = once(child, 'close');
      for (const socket of server.clients) socket.terminate();
      server.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      rmSync(plugin, { force: true });
      rmdirSync(folder);
    });
    const [socket] = await listening;
    const [message] = await once(socket, 'message');
    assert.deepEqual(JSON.parse(message), { event: 'registerPlugin', uuid: token });
  });
