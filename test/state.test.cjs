'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hookEvent } = require('../src/events.cjs');
const { SessionMonitor, FAIL_AFTER_MS, SESSION_TTL_MS, MAX_SESSIONS } = require('../src/state.cjs');

function rig(options = {}) {
  let clock = 10_000;
  const monitor = new SessionMonitor({ ...options, clock: () => clock });
  return {
    monitor,
    send(kind, sessionId = 'a', turnId = 't1', at = ++clock) {
      return monitor.accept({ kind, sessionId, turnId, at });
    },
    advance(time) { clock += time; },
    view() {
      const { nextAt, ...view } = monitor.view();
      return view;
    },
  };
}

test('parallel sessions count once, with approval before running and oldest first', () => {
  const r = rig();
  assert.equal(r.view().state, 'unknown');
  r.send('start');
  r.send('start', 'b');
  r.send('modelStart', 'b');
  assert.equal(r.view().active, 2);
  r.send('approval', 'b');
  r.send('approval', 'a');
  r.send('approval', 'b');
  r.send('modelCompleted', 'b');
  assert.deepEqual(r.view(), {
    state: 'waiting', active: 2, running: 0, waiting: 2, failed: 0, unviewed: 0, completion: null, targetSessionId: 'b',
  });
  r.send('modelStart', 'b');
  assert.equal(r.view().targetSessionId, 'a');
  r.send('stop', 'a');
  assert.equal(r.view().state, 'running');
  assert.equal(r.view().active, 1);
  r.send('end', 'b', null);
  assert.equal(r.view().state, 'idle');
  assert.equal(r.view().active, 0);
});

test('failed requests debounce, override waiting, and clear when retried', () => {
  const r = rig();
  r.send('modelStart');
  r.send('modelFailed');
  r.advance(FAIL_AFTER_MS - 1);
  assert.equal(r.view().state, 'running');
  r.send('modelStart');
  assert.equal(r.view().state, 'running');
  r.send('modelFailed');
  r.send('approval', 'b');
  r.advance(FAIL_AFTER_MS);
  assert.deepEqual(r.view(), {
    state: 'error', active: 1, running: 0, waiting: 1, failed: 1, unviewed: 0, completion: null, targetSessionId: 'a',
  });
  r.send('modelStart');
  assert.equal(r.view().state, 'waiting');
  assert.equal(r.view().active, 2);
  r.send('interrupt');
  r.send('stop', 'b');
  assert.equal(r.view().state, 'idle');
});

test('late, duplicate and retired turn events cannot resurrect or close another turn', () => {
  const r = rig();
  assert.equal(r.send('start'), true);
  assert.equal(r.send('start', 'a', 't1', 10_001), false);
  r.send('stop');
  assert.equal(r.send('modelStart'), false);
  r.send('start', 'a', 't2');
  assert.equal(r.send('stop', 'a', 't1'), false);
  assert.equal(r.send('start', 'a', 't1'), false);
  assert.equal(r.send('approval', 'a', 't2', 10_001), false);
  assert.equal(r.view().active, 1);
  assert.equal(r.view().state, 'running');
});

test('normal completions are retained per chat until acknowledged, with approval priority', () => {
  const r = rig();
  r.send('start', 'b');
  r.send('start', 'c');
  r.send('modelStart', 'a');
  r.send('modelCompleted', 'a');
  r.send('stop', 'a');
  assert.equal(r.send('stop', 'a'), false);
  const first = r.view();
  assert.equal(first.state, 'completed');
  assert.equal(first.active, 2);
  assert.equal(first.unviewed, 1);
  assert.equal(first.targetSessionId, 'a');
  r.send('approval', 'b');
  assert.equal(r.view().targetSessionId, 'b');
  assert.equal(r.view().state, 'waiting');
  assert.equal(r.view().unviewed, 1);
  r.send('modelStart', 'b');
  r.send('start', 'a', 't2');
  r.send('modelCompleted', 'a', 't2');
  r.send('stop', 'a', 't2');
  assert.equal(r.monitor.acknowledge(first.completion), false);
  assert.equal(r.view().unviewed, 1);
  assert.equal(r.monitor.acknowledge(r.view().completion), true);
  assert.equal(r.view().state, 'running');
  assert.equal(r.view().active, 2);
});

test('cancellation, failure, and unobserved stops create no completion reminder', () => {
  const r = rig();
  for (const outcome of ['modelCancelled', 'modelFailed']) {
    r.send('modelStart', outcome);
    r.send('modelCompleted', outcome);
    r.send('modelStart', outcome);
    r.send(outcome, outcome);
    r.send('stop', outcome);
  }
  r.send('start', 'interrupted');
  r.send('modelCompleted', 'interrupted');
  r.send('interrupt', 'interrupted');
  r.send('stop', 'unseen');
  assert.equal(r.view().unviewed, 0);
  assert.equal(r.view().state, 'idle');
});

test('the memory table is bounded and inactivity expires active records', () => {
  const r = rig();
  for (let index = 0; index < MAX_SESSIONS + 15; index += 1) {
    r.send('start', 'session' + index);
  }
  assert.equal(r.view().active, MAX_SESSIONS);
  assert.equal(r.monitor.sessions.size, MAX_SESSIONS);
  r.send('stop', 'unseen');
  assert.equal(r.view().active, MAX_SESSIONS);
  r.advance(SESSION_TTL_MS);
  assert.equal(r.view().state, 'idle');
  assert.equal(r.monitor.sessions.size, 0);
});

test('projection drops arbitrary input and subagent work', () => {
  const sample = {
    session_id: 'a', turn_id: 't1', hook_event_name: 'PermissionRequest',
    cwd: 'private', prompt: 'private', tool_input: { command: 'private' },
  };
  assert.deepEqual(hookEvent(sample, 1), {
    kind: 'approval', sessionId: 'a', turnId: 't1', at: 1,
  });
  assert.equal(hookEvent({ ...sample, hook_event_name: 'PreModelRequest', agent_id: 'subagent' }, 2), null);
  assert.equal(hookEvent({ ...sample, hook_event_name: 'PostToolUse' }, 2), null);
  assert.equal(hookEvent({ ...sample, session_id: 'a/path' }, 2), null);
  assert.equal(hookEvent({ ...sample, turn_id: undefined }, 2), null);
  assert.deepEqual(hookEvent({ ...sample, hook_event_name: 'PostModelRequest', status: 'failed' }, 2),
    { kind: 'modelFailed', sessionId: 'a', turnId: 't1', at: 2 });
});

test('only matching answers remove each question, leaving other waits in place', () => {
  let now = 1_000;
  const monitor = new SessionMonitor({ clock: () => now });
  const signal = (kind, extra = {}) => monitor.accept({
    kind, sessionId: 'a', turnId: 't1', at: ++now, ...extra,
  });
  const question = (kind, id) => signal(kind, { toolUseId: id });
  signal('approval');
  question('questionStart', 'first');
  question('questionStart', 'second');
  assert.equal(monitor.view().waiting, 1);
  assert.equal(signal('questionEnd', { toolUseId: 'first', turnId: 'old' }), false);
  assert.equal(question('questionEnd', 'unknown'), false);
  question('questionEnd', 'first');
  assert.equal(monitor.view().waiting, 1);
  question('questionEnd', 'second');
  assert.equal(monitor.view().waiting, 1);
  signal('modelStart');
  assert.equal(monitor.view().running, 1);
  question('questionStart', 'third');
  question('questionEnd', 'third');
  assert.equal(monitor.view().running, 1);
});

test('the sender includes only question identifiers and a bounded Stop path', () => {
  const input = { session_id: 'a', turn_id: 't1', tool_name: 'request_user_input',
    tool_use_id: 'call_a', tool_input: { questions: ['private'] }, tool_response: 'private' };
  for (const [hook_event_name, kind] of [['PreToolUse', 'questionStart'], ['PostToolUse', 'questionEnd']]) {
    assert.deepEqual(hookEvent({ ...input, hook_event_name }, 1), {
      kind, sessionId: 'a', turnId: 't1', toolUseId: 'call_a', at: 1,
    });
    assert.equal(hookEvent({ ...input, hook_event_name, tool_name: 'request_user_input_async' }), null);
    assert.equal(hookEvent({ ...input, hook_event_name, tool_use_id: undefined }), null);
  }
  const stop = { ...input, hook_event_name: 'Stop', transcript_path: 'C:\\sessions\\rollout-a.jsonl' };
  assert.equal(hookEvent(stop, 2).transcriptPath, stop.transcript_path);
  assert.equal(hookEvent({ ...stop, transcript_path: 'x'.repeat(1025) }, 2).transcriptPath, undefined);
});
