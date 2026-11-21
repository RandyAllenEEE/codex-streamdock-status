'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { PNG } = require('pngjs');
const { linesFor, renderKey } = require('../src/draw.cjs');
const { ACTION, connectDock, createDockController, dockArguments } = require('../src/streamdock.cjs');
const { SessionMonitor } = require('../src/state.cjs');
const { openChatGPT, threadUri } = require('../src/navigate.cjs');

test('SDK registration and dynamic image update reach a local websocket host', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const config = dockArguments([
    '-port', String(server.address().port), '-pluginUUID', 'fixture',
    '-registerEvent', 'registerPlugin', '-info', '{}',
  ]);
  const connection = once(server, 'connection');
  const dock = connectDock(config);
  t.after(() => { dock.close(); server.close(); });
  const [client] = await connection;
  const [registration] = await once(client, 'message');
  assert.deepEqual(JSON.parse(registration), { event: 'registerPlugin', uuid: 'fixture' });

  const image = once(client, 'message');
  client.send(JSON.stringify({
    event: 'willAppear', action: ACTION, context: 'physical-key',
    payload: { controller: 'Keypad', width: 72, height: 64 },
  }));
  const update = JSON.parse((await image)[0]);
  assert.equal(update.context, 'physical-key');
  assert.equal(update.event, 'setImage');
  const png = PNG.sync.read(Buffer.from(update.payload.image.split(',')[1], 'base64'));
  assert.equal(png.width, 72);
  assert.equal(png.height, 64);

  const waitingImage = once(client, 'message');
  dock.event({ kind: 'approval', sessionId: 's1', turnId: 't1', at: Date.now() });
  const waiting = JSON.parse((await waitingImage)[0]);
  const yellow = PNG.sync.read(Buffer.from(waiting.payload.image.split(',')[1], 'base64'));
  assert.deepEqual([...yellow.data.subarray(0, 3)], [255, 206, 87]);
});

test('keyUp uses the current target while duplicate draws and repeated presses are suppressed', async t => {
  let now = 100;
  const monitor = new SessionMonitor({ clock: () => now });
  const sent = [];
  const visits = [];
  const dock = createDockController(message => {
    sent.push(message);
    return true;
  }, { monitor, draw: () => Buffer.from('image'), navigate: async id => { visits.push(id); } });
  t.after(() => dock.close());
  const key = { action: ACTION, context: 'key' };
  dock.action({ ...key, event: 'willAppear' });
  dock.event({ kind: 'approval', sessionId: 'session', turnId: 'turn', at: now });
  dock.event({ kind: 'approval', sessionId: 'session', turnId: 'turn', at: ++now });
  assert.equal(sent.length, 2);
  dock.action({ ...key, event: 'keyDown' });
  dock.action({ ...key, event: 'keyUp' });
  dock.action({ ...key, event: 'keyUp' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(visits, ['session']);
  dock.action({ ...key, event: 'willDisappear' });
  now += 1_000;
  dock.action({ ...key, event: 'keyUp' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visits.length, 1);
});

test('blue key confirms one completion and a later manual foreground entry confirms the rest', async t => {
  let now = 1_000;
  let enter;
  let registrations = 0;
  let unregistrations = 0;
  const launched = [];
  const monitor = new SessionMonitor({ clock: () => now });
  const foreground = {
    watch(callback) {
      registrations += 1;
      enter = callback;
      return () => { unregistrations += 1; };
    },
    isForeground: () => false,
  };
  const dock = createDockController(() => true, {
    monitor, foreground, draw: () => Buffer.from('image'),
    navigate: async id => {
      launched.push(id);
      enter();
      return true;
    },
  });
  t.after(() => dock.close());
  const key = { action: ACTION, context: 'key' };
  const event = (kind, sessionId) => dock.event({ kind, sessionId, turnId: 'turn', at: ++now });
  dock.action({ ...key, event: 'willAppear' });
  event('start', 'still-running');
  assert.equal(registrations, 0);
  for (const id of ['first', 'second']) {
    event('modelCompleted', id);
    event('stop', id);
  }
  assert.equal(registrations, 1);
  assert.deepEqual(linesFor(monitor.view()), ['2/1']);
  dock.action({ ...key, event: 'keyUp' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(launched, ['first']);
  assert.deepEqual(linesFor(monitor.view()), ['1/1']);
  assert.equal(unregistrations, 0);
  enter();
  assert.deepEqual(linesFor(monitor.view()), ['1']);
  assert.equal(unregistrations, 1);
});

test('renders all colors and wide counts at supported LCD sizes', () => {
  for (const state of ['unknown', 'idle', 'running', 'completed', 'waiting', 'error']) {
    for (const size of [40, 64, 96, 144]) {
      const image = renderKey({ state, active: 128, waiting: 128, failed: 128, unviewed: 128 }, size, size);
      assert.equal(PNG.sync.read(image).width, size);
    }
  }
});

test('navigation uses direct Windows dispatch with a desktop activation fallback', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(threadUri(id), 'codex://threads/' + id);
  assert.equal(threadUri('x?y=1'), null);
  const commands = [];
  assert.equal(await openChatGPT(id, { execute: async (file, args) => { commands.push({ file, args }); } }), true);
  assert.equal(commands.length, 2);
  assert.match(commands[0].file, /reg\.exe$/i);
  assert.match(commands[1].file, /cmd\.exe$/i);
  assert.equal(commands[1].args.at(-1), 'start "" "codex://threads/' + id + '"');

  let script;
  assert.equal(await openChatGPT(id, { execute: async (file, args) => {
    if (file.endsWith('cmd.exe')) throw new Error('shell error');
    if (!file.endsWith('powershell.exe')) return;
    script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  } }), false);
  assert.ok(script.includes('shell:AppsFolder\\'));
  assert.ok(!script.includes(id));
});
