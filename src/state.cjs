'use strict';

const { isEvent } = require('./events.cjs');

const FAIL_AFTER_MS = 15_000;
const SESSION_TTL_MS = 60 * 60_000;
const MAX_SESSIONS = 128;
const MAX_OLD_TURNS = 16;
const terminal = new Set(['stop', 'interrupt', 'end']);

function newSession(at) {
  return {
    turnId: null, retired: new Set(), updatedAt: at, phase: 'closed',
    waitingAt: null, failureAt: null, modelCompleted: false,
  };
}

function changeTurn(session, turnId) {
  if (session.turnId && session.turnId !== turnId) {
    session.retired.add(session.turnId);
    if (session.retired.size > MAX_OLD_TURNS) {
      session.retired.delete(session.retired.values().next().value);
    }
  }
  session.turnId = turnId;
  session.waitingAt = null;
  session.failureAt = null;
  session.modelCompleted = false;
}

class SessionMonitor {
  constructor({ clock = Date.now, failAfter = FAIL_AFTER_MS, ttl = SESSION_TTL_MS,
    limit = MAX_SESSIONS } = {}) {
    this.clock = clock;
    this.failAfter = failAfter;
    this.ttl = ttl;
    this.limit = limit;
    this.sessions = new Map();
    this.unviewed = new Map();
    this.received = false;
  }

  prune(now = this.clock()) {
    for (const [id, session] of this.sessions) {
      if (session.updatedAt + this.ttl <= now) this.sessions.delete(id);
    }
  }

  reserve(event) {
    if (this.sessions.size >= this.limit) {
      const ordered = [...this.sessions].sort(([, a], [, b]) =>
        Number(a.phase !== 'closed') - Number(b.phase !== 'closed') || a.updatedAt - b.updatedAt);
      // A terminal event for an unseen session should never evict a live one.
      if (terminal.has(event.kind) && ordered[0][1].phase !== 'closed') return null;
      this.sessions.delete(ordered[0][0]);
    }
    const session = newSession(event.at);
    this.sessions.set(event.sessionId, session);
    return session;
  }

  recordCompletion(event) {
    const earlier = this.unviewed.get(event.sessionId);
    if (!earlier && this.unviewed.size >= this.limit) {
      this.unviewed.delete(this.unviewed.keys().next().value);
    }
    this.unviewed.set(event.sessionId, {
      sessionId: event.sessionId, at: earlier?.at ?? event.at,
    });
  }

  acknowledge(completion = null) {
    if (completion) {
      return this.unviewed.get(completion.sessionId) === completion
        && this.unviewed.delete(completion.sessionId);
    }
    if (!this.unviewed.size) return false;
    this.unviewed.clear();
    return true;
  }

  accept(event) {
    const now = this.clock();
    if (!isEvent(event) || event.at > now + 5_000 || event.at + this.ttl <= now) return false;
    this.prune(now);

    let session = this.sessions.get(event.sessionId);
    if (session) {
      if (event.at <= session.updatedAt || session.retired.has(event.turnId)) return false;
      const sameTurn = session.turnId === event.turnId;
      if (event.turnId && !sameTurn && session.turnId
        && (terminal.has(event.kind) || (session.phase !== 'closed' && event.kind !== 'start'))) {
        return false;
      }
      if (event.turnId && sameTurn && session.phase === 'closed') return false;
    } else {
      session = this.reserve(event);
      if (!session) return false;
    }

    if (event.turnId && session.turnId !== event.turnId) {
      changeTurn(session, event.turnId);
      session.phase = 'running';
    }
    session.updatedAt = event.at;
    this.received = true;

    switch (event.kind) {
      case 'start':
      case 'modelStart':
        session.phase = 'running';
        session.waitingAt = null;
        session.failureAt = null;
        session.modelCompleted = false;
        break;
      case 'approval':
        session.phase = 'waiting';
        session.waitingAt ??= event.at;
        session.failureAt = null;
        break;
      case 'modelCompleted':
        session.failureAt = null;
        session.modelCompleted = true;
        break;
      case 'modelFailed':
        if (session.phase === 'running') session.failureAt ??= event.at;
        session.modelCompleted = false;
        break;
      case 'modelCancelled':
        session.modelCompleted = false;
        break;
      case 'stop':
      case 'interrupt':
      case 'end':
        if (event.kind === 'stop' && session.phase === 'running' && session.modelCompleted) {
          this.recordCompletion(event);
        }
        session.phase = 'closed';
        session.waitingAt = null;
        session.failureAt = null;
        session.modelCompleted = false;
        break;
    }
    return true;
  }

  view(now = this.clock()) {
    this.prune(now);
    let running = 0;
    const waiting = [];
    const failed = [];
    let nextAt = Infinity;

    for (const [id, record] of this.sessions) {
      if (record.phase === 'closed') continue;
      nextAt = Math.min(nextAt, record.updatedAt + this.ttl);
      const failAt = record.failureAt === null ? Infinity : record.failureAt + this.failAfter;
      if (failAt <= now) {
        failed.push({ id, at: record.failureAt });
      } else if (record.phase === 'waiting') {
        waiting.push({ id, at: record.waitingAt });
      } else {
        running += 1;
        nextAt = Math.min(nextAt, failAt);
      }
    }

    const first = failed.length ? failed : waiting;
    first.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    let completion = null;
    if (!first.length) {
      for (const entry of this.unviewed.values()) {
        if (!completion || entry.at < completion.at) completion = entry;
      }
    }

    return {
      state: failed.length ? 'error' : waiting.length ? 'waiting'
        : completion ? 'completed' : running ? 'running' : this.received ? 'idle' : 'unknown',
      active: running + waiting.length,
      waiting: waiting.length,
      failed: failed.length,
      unviewed: this.unviewed.size,
      completion,
      targetSessionId: first[0]?.id ?? completion?.sessionId ?? null,
      nextAt,
    };
  }
}

module.exports = { SessionMonitor, FAIL_AFTER_MS, SESSION_TTL_MS, MAX_SESSIONS };
