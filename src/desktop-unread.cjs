'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { codexHome } = require('./codex-home.cjs');

const STATE_FILE = '.codex-global-state.json';
const READ_STATE = 'electron-thread-read-state-v1';
const MAX_BYTES = 2 * 1024 * 1024;

function whitespace(bytes, at) {
  while (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 10 || bytes[at] === 13) at += 1;
  return at;
}

function endOfString(bytes, start) {
  for (let at = start + 1; at < bytes.length; at += 1) {
    if (bytes[at] === 34) return at + 1;
    if (bytes[at] === 92) at += 1;
  }
  throw new Error('Unterminated JSON string');
}

function endOfValue(bytes, start, stack) {
  const first = bytes[start];
  if (first === 34) return endOfString(bytes, start);
  if (first !== 123 && first !== 91) {
    let at = start;
    while (at < bytes.length && bytes[at] !== 44 && bytes[at] !== 125
      && whitespace(bytes, at) === at) at += 1;
    if (at === start) throw new Error('Missing JSON value');
    return at;
  }

  stack[0] = first;
  let depth = 1;
  for (let at = start + 1; at < bytes.length; at += 1) {
    const byte = bytes[at];
    if (byte === 34) at = endOfString(bytes, at) - 1;
    else if (byte === 123 || byte === 91) {
      if (depth === stack.length) throw new Error('Excessive JSON nesting');
      stack[depth++] = byte;
    } else if (byte === 125 || byte === 93) {
      if (stack[--depth] !== (byte === 125 ? 123 : 91)) throw new Error('Unbalanced JSON value');
      if (!depth) return at + 1;
    }
  }
  throw new Error('Unterminated JSON value');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractUnreadState(bytes) {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let at = whitespace(bytes, bom ? 3 : 0);
  if (bytes[at++] !== 123) throw new Error('Missing desktop state object');
  at = whitespace(bytes, at);

  const stack = new Uint8Array(128);
  let section;
  // Only decode property names and the one application field we use.
  while (bytes[at] !== 125) {
    if (bytes[at] !== 34) throw new Error('Invalid state property');
    const nameEnd = endOfString(bytes, at);
    const name = JSON.parse(bytes.toString('utf8', at, nameEnd));
    at = whitespace(bytes, nameEnd);
    if (bytes[at++] !== 58) throw new Error('Missing state property delimiter');
    const start = whitespace(bytes, at);
    const end = endOfValue(bytes, start, stack);
    if (name === READ_STATE) {
      if (section) throw new Error('Duplicate unread state');
      section = bytes.subarray(start, end);
    }
    at = whitespace(bytes, end);
    if (bytes[at] === 125) break;
    if (bytes[at++] !== 44) throw new Error('Invalid state property delimiter');
    at = whitespace(bytes, at);
    if (bytes[at] === 125) throw new Error('Missing state property');
  }
  if (!section || whitespace(bytes, at + 1) !== bytes.length) {
    throw new Error('Unread state unavailable');
  }
  const state = JSON.parse(section.toString('utf8'));
  if (state?.version !== 1 || !isObject(state.unreadByIdentity)) {
    throw new Error('Unsupported unread state');
  }
  for (const identity of Object.values(state.unreadByIdentity)) {
    if (!isObject(identity) || Object.values(identity).some(ids =>
      !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) {
      throw new Error('Invalid unread scope');
    }
  }
  return state.unreadByIdentity;
}

async function readUnreadState(filename) {
  const handle = await fs.promises.open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('Invalid desktop state file');
    const bytes = Buffer.allocUnsafe(before.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Desktop state changed during read');
    }
    return extractUnreadState(bytes);
  } finally {
    await handle.close();
  }
}

function unreadScopes(state, pending) {
  const scopes = new Map();
  for (const [identity, hosts] of Object.entries(state)) {
    for (const [host, ids] of Object.entries(hosts)) {
      for (const id of ids) {
        if (!pending.has(id)) continue;
        const scope = scopes.get(id);
        if (scope === undefined) scopes.set(id, { identity, host });
        else if (scope && (scope.identity !== identity || scope.host !== host)) scopes.set(id, null);
      }
    }
  }
  return scopes;
}

function watchDesktopUnread(completions, acknowledge, {
  filename = path.join(codexHome(), STATE_FILE),
  interval = 500,
  read = readUnreadState,
  watch = fs.watch,
} = {}) {
  const seen = new Map();
  const name = path.basename(filename).toLowerCase();
  let watcher;
  let timer;
  let closed = false;
  let reading = false;
  let dirty = false;
  let retry = false;
  let lastRead = -Infinity;
  let available;

  function refresh() {
    if (closed || !watcher) return;
    dirty = true;
    if (!reading && !timer) {
      timer = setTimeout(() => void update(), Math.max(0, lastRead + interval - performance.now()));
    }
  }

  async function update() {
    timer = undefined;
    if (closed || !watcher) return;
    dirty = false;
    reading = true;
    lastRead = performance.now();
    const current = new Map(completions());
    try {
      const state = await read(filename);
      if (closed || !watcher) return;
      retry = false;
      available = true;
      const pending = completions();
      const scopes = unreadScopes(state, current);
      const confirmed = [];
      for (const id of seen.keys()) {
        if (!pending.has(id)) seen.delete(id);
      }
      for (const [id, entry] of current) {
        if (pending.get(id) !== entry) continue;
        const scope = scopes.get(id);
        const previous = seen.get(id);
        if (scope) seen.set(id, { scope, entry });
        else {
          seen.delete(id);
          if (scope === undefined && previous?.entry === entry
            && Array.isArray(state[previous.scope.identity]?.[previous.scope.host])) {
            confirmed.push(entry);
          }
        }
      }
      if (confirmed.length) acknowledge(confirmed);
    } catch {
      if (!retry) {
        retry = true;
        dirty = true;
      } else {
        available = false;
      }
    } finally {
      reading = false;
      if (dirty) refresh();
    }
  }

  try {
    watcher = watch(path.dirname(filename), (_event, file) => {
      if (!file || file.toString().toLowerCase() === name) refresh();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
      available = false;
      seen.clear();
    });
    refresh();
  } catch {
    available = false;
  }
  return {
    refresh,
    get available() { return available; },
    stop() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
      watcher = undefined;
      seen.clear();
    },
  };
}

module.exports = { extractUnreadState, readUnreadState, watchDesktopUnread };
