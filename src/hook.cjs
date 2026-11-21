'use strict';

const { performance } = require('node:perf_hooks');
const { hookEvent } = require('./events.cjs');
const { loadEndpoint, sendEvent } = require('./pipe.cjs');

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

async function readHook(input) {
  let length = 0;
  const chunks = [];
  for await (const chunk of input) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
}

async function main() {
  const at = performance.timeOrigin + performance.now();
  try {
    const input = await readHook(process.stdin);
    const event = hookEvent(input, at);
    const endpoint = event && loadEndpoint(process.argv[2]);
    if (endpoint) await sendEvent(endpoint, event);
  } catch {
    // A display integration cannot veto a Codex operation.
  } finally {
    process.stdout.write('{}\n');
  }
}

if (require.main === module) void main();
module.exports = { main };
