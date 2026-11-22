'use strict';

const { isEvent } = require('./events.cjs');

const FAIL_AFTER_MS = 15_000;
const SESSION_TTL_MS = 60 * 60_000;
const MAX_SESSIONS = 128;
const MAX_OLD_TURNS = 16;
const MAX_QUESTIONS = 32;
const terminal = new Set(['stop', 'interrupt', 'end']);

function newSession(at) {
  return {
    turnId: null, retired: new Set(), updatedAt: at, phase: 'closed',
    approvalAt: null, questions: null, failureAt: null, modelCompleted: false,
  };
}

function clearWaiting(session) {
  session.approvalAt = null;
  session.questions = null;
}

function waitingSince(session) {
  if (session.phase === 'plan') return session.updatedAt;
  let since = session.approvalAt ?? Infinity;
  if (session.questions) {
    for (const at of session.questions.values()) since = Math.min(since, at);
  }
  return since;
}

function changeTurn(session, turnId) {
  if (session.turnId && session.turnId !== turnId) {
    session.retired.add(session.turnId);
    if (session.retired.size > MAX_OLD_TURNS) {
      session.retired.delete(session.retired.values().next().value);
    }
  }
  session.turnId = turnId;
  clearWaiting(session);
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
    this.completionVersion = 0;
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
    this.completionVersion += 1;
  }

  acknowledge(completion = null) {
    if (completion) {
      if (this.unviewed.get(completion.sessionId) !== completion) return false;
      this.unviewed.delete(completion.sessionId);
    } else {
      if (!this.unviewed.size) return false;
      this.unviewed.clear();
    }
    this.completionVersion += 1;
    return true;
  }

  isCheckingPlan(event) {
    const session = this.sessions.get(event.sessionId);
    return session?.phase === 'planCheck' && session.turnId === event.turnId
      && session.updatedAt === event.at;
  }

  resolvePlan(event, planned) {
    this.prune();
    if (!this.isCheckingPlan(event)) return false;
    const session = this.sessions.get(event.sessionId);
    session.phase = planned ? 'plan' : 'closed';
    if (!planned) this.recordCompletion(event);
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
      const stopped = session.phase !== 'running';
      if (event.kind === 'questionEnd'
        && (!sameTurn || !session.questions?.has(event.toolUseId))) return false;
      if (event.turnId && session.turnId) {
        if (sameTurn && stopped
          && (event.kind !== 'interrupt' || session.phase === 'closed')) return false;
        if (!sameTurn && event.kind !== 'start') {
          const resumesPlan = stopped && event.kind === 'modelStart';
          if (terminal.has(event.kind) || (!resumesPlan && session.phase !== 'closed')) return false;
        }
      }
    } else {
      if (event.kind === 'questionEnd') return false;
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
        clearWaiting(session);
        session.failureAt = null;
        session.modelCompleted = false;
        break;
      case 'approval':
        session.approvalAt ??= event.at;
        session.failureAt = null;
        break;
      case 'questionStart':
        session.questions ??= new Map();
        if (session.questions.size < MAX_QUESTIONS && !session.questions.has(event.toolUseId)) {
          session.questions.set(event.toolUseId, event.at);
        }
        session.failureAt = null;
        break;
      case 'questionEnd':
        session.questions.delete(event.toolUseId);
        if (!session.questions.size) session.questions = null;
        break;
      case 'modelCompleted':
        session.failureAt = null;
        session.modelCompleted = true;
        break;
      case 'modelFailed':
        if (waitingSince(session) === Infinity) session.failureAt ??= event.at;
        session.modelCompleted = false;
        break;
      case 'modelCancelled':
        session.modelCompleted = false;
        break;
      case 'stop':
      case 'interrupt':
      case 'end':
        session.phase = 'closed';
        if (event.kind === 'stop' && session.modelCompleted && waitingSince(session) === Infinity) {
          if (event.transcriptPath) session.phase = 'planCheck';
          else this.recordCompletion(event);
        }
        clearWaiting(session);
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
      if (record.phase === 'closed' || record.phase === 'planCheck') continue;
      nextAt = Math.min(nextAt, record.updatedAt + this.ttl);
      const failAt = record.failureAt === null ? Infinity : record.failureAt + this.failAfter;
      const waitingAt = waitingSince(record);
      if (failAt <= now) {
        failed.push({ id, at: record.failureAt });
      } else if (waitingAt !== Infinity) {
        waiting.push({ id, at: waitingAt });
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
      running,
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
