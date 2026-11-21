'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, writeFileSync, readdirSync, rmSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { eventServer, sendEvent, pipeAddress } = require('../src/pipe.cjs');

function runHook(args, input) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, args, { windowsHide: true });
    let stdout = '';
    processHandle.stdout.on('data', chunk => { stdout += chunk; });
    processHandle.on('error', reject);
    processHandle.on('close', code => resolve({ code, stdout }));
    processHandle.stdin.on('error', reject);
    processHandle.stdin.end(input);
  });
}

test('local pipe delivers compact records and rejects credentials it does not own', async t => {
  const endpoint = { token: randomBytes(32).toString('hex') };
  const address = process.platform === 'win32' ? pipeAddress(endpoint)
    : join(tmpdir(), 'cst-' + endpoint.token.slice(0, 16) + '.sock');
  const received = [];
  const pipe = eventServer(endpoint, event => received.push(event));
  t.after(() => pipe.close());
  pipe.server.listen(address);
  await once(pipe.server, 'listening');

  const event = { kind: 'approval', sessionId: 'a', turnId: 'b', at: Date.now() };
  assert.equal(await sendEvent(endpoint, event, { address, timeout: 500 }), true);
  assert.equal(await sendEvent({ token: '0'.repeat(64) }, event, { address, timeout: 500 }), false);
  assert.deepEqual(received, [event]);
  pipe.close();
  assert.equal(await sendEvent(endpoint, event, { address, timeout: 500 }), false);
});

test('Windows Hook strips private fields and leaves no runtime files with or without its receiver',
  { skip: process.platform !== 'win32' }, async t => {
    const folder = mkdtempSync(join(tmpdir(), 'codex-status-fixture-'));
    const endpoint = { token: randomBytes(32).toString('hex') };
    const filename = join(folder, 'endpoint.json');
    writeFileSync(filename, JSON.stringify(endpoint));
    const received = [];
    const pipe = eventServer(endpoint, event => received.push(event));
    t.after(() => { pipe.close(); rmSync(filename, { force: true }); rmdirSync(folder); });
    pipe.server.listen(pipeAddress(endpoint));
    await once(pipe.server, 'listening');
    const script = join(__dirname, '..', 'src', 'hook.cjs');
    const args = [script, filename];
    const payload = JSON.stringify({
      hook_event_name: 'PermissionRequest', session_id: 'a', turn_id: 'b',
      tool_input: { command: 'PRIVATE' },
    });

    assert.deepEqual(await runHook(args, payload), { code: 0, stdout: '{}\n' });
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 'approval');
    assert.deepEqual(Object.keys(received[0]).sort(), ['at', 'kind', 'sessionId', 'turnId']);
    pipe.close();
    for (let index = 0; index < 10; index += 1) {
      assert.deepEqual(await runHook(args, payload), { code: 0, stdout: '{}\n' });
    }
    assert.deepEqual(readdirSync(folder), ['endpoint.json']);
  });
