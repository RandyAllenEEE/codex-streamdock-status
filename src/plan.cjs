'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { codexHome } = require('./codex-home.cjs');
const { MAX_SESSIONS } = require('./state.cjs');

const TAIL_BYTES = 512 * 1024;
const CONTEXT = Buffer.from('"type":"turn_context"');
const FINAL = Buffer.from('"phase":"final_answer"');
const DONE = Buffer.from('"type":"task_complete"');
const PLAN_OPEN = /(?:^|\n)[ \t]*<proposed_plan>[ \t]*\r?\n/;
const PLAN_CLOSE = /(?:^|\n)[ \t]*<\/proposed_plan>[ \t]*(?=\r?\n|$)/;

function hasPlanBlock(text) {
  if (typeof text !== 'string') return false;
  const open = PLAN_OPEN.exec(text);
  if (!open) return false;
  const remainder = text.slice(open.index + open[0].length);
  const close = PLAN_CLOSE.exec(remainder);
  return Boolean(close && /\S/.test(remainder.slice(0, close.index)));
}

function inspectPlanTail(tail, turnId, truncated = false) {
  let currentTurn;
  let hasPlan = false;
  const turn = Buffer.from('"' + turnId + '"');
  let start = truncated ? tail.indexOf(0x0a) + 1 : 0;
  if (truncated && start === 0) return 'incomplete';
  while (start < tail.length) {
    const newline = tail.indexOf(0x0a, start);
    if (newline < 0) break; // The writer can still be appending the last line.
    const line = tail.subarray(start, newline);
    start = newline + 1;
    const context = line.includes(CONTEXT);
    const final = currentTurn === turnId && line.includes(FINAL);
    const done = line.includes(DONE) && line.includes(turn);
    if (!context && !final && !done) continue;
    let item;
    try {
      item = JSON.parse(line.toString('utf8'));
    } catch {
      return 'complete';
    }
    const payload = item?.payload;
    if (item?.type === 'turn_context') {
      currentTurn = payload?.collaboration_mode?.mode === 'plan' ? payload.turn_id : undefined;
      hasPlan = false;
    } else if (final && item?.type === 'response_item' && payload?.type === 'message'
      && payload.role === 'assistant' && payload.phase === 'final_answer') {
      hasPlan = Array.isArray(payload.content) && payload.content.some(part => hasPlanBlock(part?.text));
    } else if (item?.type === 'event_msg' && payload?.type === 'task_complete'
      && payload.turn_id === turnId) {
      return currentTurn === turnId && hasPlan ? 'plan' : 'complete';
    }
  }
  return 'incomplete';
}

async function readPlanTail(sessionsRoot, event, buffer) {
  const file = event.transcriptPath;
  const name = path.basename(file).toLowerCase();
  const suffix = '-' + event.sessionId.toLowerCase() + '.jsonl';
  if (!path.isAbsolute(file) || !name.startsWith('rollout-') || !name.endsWith(suffix)) {
    return 'complete';
  }
  try {
    const root = await fs.realpath(sessionsRoot);
    const resolved = await fs.realpath(file);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative) || path.basename(resolved).toLowerCase() !== name) {
      return 'complete';
    }
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return 'complete';
      const offset = Math.max(0, stat.size - buffer.length);
      const { bytesRead } = await handle.read(buffer, 0, stat.size - offset, offset);
      return inspectPlanTail(buffer.subarray(0, bytesRead), event.turnId, offset > 0);
    } finally {
      await handle.close();
    }
  } catch {
    return 'complete';
  }
}

function createPlanReader({
  sessionsRoot = path.join(codexHome(), 'sessions'),
  read = readPlanTail,
  deadline = 300,
  retryAfter = 200,
} = {}) {
  const jobs = new Set();
  let closed = false;
  let active = false;
  let buffer;

  function releaseBuffer() {
    if (!jobs.size && !active) buffer = undefined;
  }

  function finish(job, planned) {
    if (!jobs.delete(job)) return;
    clearTimeout(job.timeout);
    clearTimeout(job.retry);
    if (!closed) job.resolve(planned);
    releaseBuffer();
  }

  async function pump() {
    if (active || closed) return;
    active = true;
    while (!closed) {
      let job;
      for (const candidate of jobs) {
        if (candidate.ready) {
          job = candidate;
          break;
        }
      }
      if (!job) break;
      if (!job.pending() || performance.now() >= job.expires) {
        finish(job, false);
        continue;
      }
      buffer ??= Buffer.allocUnsafe(TAIL_BYTES);
      let outcome;
      try {
        outcome = await read(sessionsRoot, job.event, buffer);
      } catch {
        outcome = 'complete';
      }
      if (!jobs.has(job)) continue;
      if (performance.now() >= job.expires) finish(job, false);
      else if (outcome === 'incomplete' && !job.retried) {
        job.ready = false;
        job.retried = true;
        job.retry = setTimeout(() => {
          job.ready = true;
          void pump();
        }, Math.max(0, job.enqueued + retryAfter - performance.now()));
      } else finish(job, outcome === 'plan');
    }
    active = false;
    releaseBuffer();
  }

  return {
    classify(event, pending, resolve) {
      if (closed || jobs.size >= MAX_SESSIONS) return resolve(false);
      const enqueued = performance.now();
      const job = { event, pending, resolve, enqueued, expires: enqueued + deadline, ready: true };
      jobs.add(job);
      job.timeout = setTimeout(() => finish(job, false), deadline);
      void pump();
    },
    close() {
      closed = true;
      for (const job of jobs) finish(job, false);
    },
  };
}

module.exports = { createPlanReader, inspectPlanTail, readPlanTail, TAIL_BYTES };
