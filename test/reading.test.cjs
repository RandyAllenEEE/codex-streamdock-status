'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { createPlanReader, inspectPlanTail, readPlanTail, TAIL_BYTES } = require('../src/plan.cjs');
const { extractUnreadState, readUnreadState, watchDesktopUnread } = require('../src/desktop-unread.cjs');
const { ACTION, createDockController } = require('../src/streamdock.cjs');
const { linesFor } = require('../src/draw.cjs');
const { SessionMonitor } = require('../src/state.cjs');

function fixtures(t) {
  const parent = fs.realpathSync(tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'codex-status-read-'));
  t.after(() => {
    const folder = fs.realpathSync(root);
    assert.equal(path.dirname(folder), parent);
    assert.match(path.basename(folder), /^codex-status-read-/);
    fs.rmSync(folder, { recursive: true });
  });
  return root;
}

function record(type, payload) {
  return JSON.stringify({ type, payload }) + '\n';
}

function transcript(turnId, mode = 'plan', complete = true) {
  return record('turn_context', { turn_id: turnId, collaboration_mode: { mode } })
    + record('response_item', {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ text: '<proposed_plan>\nA plan for the fixture\n</proposed_plan>' }],
    })
    + (complete ? record('event_msg', { type: 'task_complete', turn_id: turnId }) : '');
}

async function until(predicate) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('The expected display update did not arrive');
}

test('tail classification needs an ended Plan turn and respects the local path and byte cap', async t => {
  const root = fixtures(t);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions);
  const event = { sessionId: 'chat', turnId: 'turn', transcriptPath: path.join(sessions, 'rollout-chat.jsonl') };
  const buffer = Buffer.alloc(TAIL_BYTES);
  assert.equal(inspectPlanTail(Buffer.from(transcript('turn', 'plan', false)), 'turn'), 'incomplete');
  assert.equal(inspectPlanTail(Buffer.from(transcript('past') + transcript('turn', 'default')), 'turn'), 'complete');
  fs.writeFileSync(event.transcriptPath, transcript('turn'));
  assert.equal(await readPlanTail(sessions, event, buffer), 'plan');
  const other = path.join(root, 'rollout-chat.jsonl');
  fs.copyFileSync(event.transcriptPath, other);
  assert.equal(await readPlanTail(sessions, { ...event, transcriptPath: other }, buffer), 'complete');
  assert.equal(await readPlanTail(sessions, { ...event, sessionId: 'other' }, buffer), 'complete');
  fs.writeFileSync(event.transcriptPath, transcript('turn', 'plan', false)
    + record('event_msg', { type: 'other', content: 'x'.repeat(TAIL_BYTES) })
    + record('event_msg', { type: 'task_complete', turn_id: 'turn' }));
  assert.equal(await readPlanTail(sessions, event, buffer), 'complete');
});

test('parallel Stops retry independently and share a single tail buffer', async t => {
  const buffers = new Set();
  const passes = new Map();
  let reading = 0;
  const reader = createPlanReader({
    deadline: 900, retryAfter: 25,
    async read(_root, { sessionId }, buffer) {
      buffers.add(buffer);
      assert.equal(++reading, 1);
      const pass = (passes.get(sessionId) ?? 0) + 1;
      passes.set(sessionId, pass);
      await delay(sessionId === 'b' ? 50 : 1);
      reading -= 1;
      return sessionId === 'a' ? (pass === 1 ? 'incomplete' : 'plan') : 'complete';
    },
  });
  t.after(() => reader.close());
  const result = id => new Promise(resolve => reader.classify({ sessionId: id }, () => true, resolve));
  assert.deepEqual(await Promise.all([result('a'), result('b')]), [true, false]);
  assert.equal(buffers.size, 1);
  assert.equal(passes.get('a'), 2);
  assert.equal(passes.get('b'), 1);
});

test('a blocked read falls back once and its late result is discarded', async t => {
  let release;
  const reader = createPlanReader({ deadline: 30, read: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => reader.close());
  const results = [];
  reader.classify({ sessionId: 'blocked' }, () => true, result => results.push(result));
  await until(() => results.length);
  assert.deepEqual(results, [false]);
  release('plan');
  await delay(5);
  assert.deepEqual(results, [false]);
});

test('the controller displays a parallel Plan wait and ignores a result from a retired turn', async t => {
  const root = fixtures(t);
  const reader = createPlanReader({ sessionsRoot: root, deadline: 1_000, retryAfter: 20 });
  let now = 1_000;
  const monitor = new SessionMonitor({ clock: () => now });
  const opened = [];
  const dock = createDockController(() => true, {
    monitor, planReader: reader, draw: () => Buffer.from('image'), navigate: async id => opened.push(id),
  });
  t.after(() => dock.close());
  const key = { action: ACTION, context: 'key' };
  dock.action({ ...key, event: 'willAppear' });
  const send = (kind, sessionId, turnId, more = {}) => dock.event({
    kind, sessionId, turnId, at: ++now, ...more,
  });
  for (const [id, mode] of [['plan', 'plan'], ['plain', 'default'], ['retired', 'plan']]) {
    const file = path.join(root, 'rollout-' + id + '.jsonl');
    fs.writeFileSync(file, transcript('old', mode));
    send('modelCompleted', id, 'old');
    send('stop', id, 'old', { transcriptPath: file });
  }
  send('modelStart', 'retired', 'new');
  await until(() => monitor.view().waiting === 1 && monitor.view().unviewed === 1);
  assert.deepEqual(linesFor(monitor.view()), ['1/1']);
  dock.action({ ...key, event: 'keyUp' });
  await until(() => opened.length);
  assert.deepEqual(opened, ['plan']);
  assert.equal(monitor.view().waiting, 1);
  send('modelStart', 'plan', 'new');
  assert.deepEqual(linesFor(monitor.view()), ['1/2']);
});

const FIELD = 'electron-thread-read-state-v1';
const saved = unreadByIdentity => JSON.stringify({
  decoy: [{ [FIELD]: 'nested value', text: 'A quoted " brace {' }],
  [FIELD]: { version: 1, unreadByIdentity },
});

test('only the top-level unread state is parsed and malformed snapshots are refused', () => {
  const sample = saved({ account: { local: ['a'] } });
  assert.deepEqual(extractUnreadState(Buffer.from(sample)), { account: { local: ['a'] } });
  assert.throws(() => extractUnreadState(Buffer.from(sample.slice(0, -1))));
  assert.throws(() => extractUnreadState(Buffer.from(saved({ account: { local: false } }))));
  assert.throws(() => extractUnreadState(Buffer.from('{' + JSON.stringify(FIELD) + ':[],' + sample.slice(1))));
});

test('same-window read changes clear only the opened chat and stop the file watcher', async t => {
  const root = fixtures(t);
  const file = path.join(root, '.codex-global-state.json');
  fs.writeFileSync(file, saved({ account: { host: ['first', 'second', 'unrelated'] } }));
  const monitor = new SessionMonitor();
  let reads = 0;
  let readErrors = 0;
  let stopped = 0;
  const dock = createDockController(() => true, {
    monitor, draw: () => Buffer.from('image'),
    watchUnread(completions, acknowledge) {
      const watch = watchDesktopUnread(completions, acknowledge, {
        filename: file, interval: 30, async read(...args) {
          try {
            const state = await readUnreadState(...args);
            reads += 1;
            return state;
          } catch (error) {
            readErrors += 1;
            throw error;
          }
        },
      });
      return {
        refresh: watch.refresh, get available() { return watch.available; },
        stop() { stopped += 1; watch.stop(); },
      };
    },
  });
  t.after(() => dock.close());
  let now = Date.now();
  const send = (kind, sessionId) => dock.event({ kind, sessionId, turnId: 'turn', at: ++now });
  dock.action({ action: ACTION, context: 'key', event: 'willAppear' });
  send('start', 'one');
  send('start', 'two');
  for (const id of ['first', 'second']) {
    send('modelCompleted', id);
    send('stop', id);
  }
  assert.deepEqual(linesFor(monitor.view()), ['2/2']);
  await until(() => reads === 1);
  function replace(content) {
    const replacement = path.join(root, 'replacement');
    fs.writeFileSync(replacement, content);
    fs.renameSync(replacement, file);
  }
  const change = ids => replace(saved({ account: { host: ids } }));
  change(['first', 'second']);
  await until(() => reads >= 2);
  assert.equal(monitor.view().unviewed, 2);
  replace('{');
  await until(() => readErrors >= 1);
  assert.equal(monitor.view().unviewed, 2);
  change(['second']);
  await until(() => monitor.view().unviewed === 1);
  assert.deepEqual(linesFor(monitor.view()), ['1/2']);
  assert.equal(monitor.view().targetSessionId, 'second');
  change([]);
  await until(() => monitor.view().unviewed === 0);
  assert.deepEqual(linesFor(monitor.view()), ['2']);
  assert.equal(stopped, 1);
});
