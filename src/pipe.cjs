'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { isEvent } = require('./events.cjs');

const MAX_FRAME_BYTES = 512;
const SEND_TIMEOUT_MS = 35;
const MAX_CONNECTIONS = 32;
const tokenPattern = /^[0-9a-f]{64}$/;

function endpointPath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexStreamDockStatus', 'endpoint.json');
}

function loadEndpoint(filename = endpointPath()) {
  try {
    const descriptor = fs.openSync(filename, 'r');
    try {
      const buffer = Buffer.alloc(1025);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === buffer.length) return null;
      const { token } = JSON.parse(buffer.subarray(0, bytes));
      return typeof token === 'string' && tokenPattern.test(token) ? { token } : null;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

function pipeAddress({ token }) {
  return '\\\\.\\pipe\\codex-streamdock-status-' + token.slice(0, 24);
}

function sendEvent(endpoint, event, {
  address = pipeAddress(endpoint), timeout = SEND_TIMEOUT_MS,
} = {}) {
  const frame = JSON.stringify({ token: endpoint.token, event });
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.resolve(false);

  return new Promise(resolve => {
    const client = net.createConnection(address);
    let settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      client.destroy();
      resolve(ok);
    }
    const deadline = setTimeout(() => finish(false), timeout);
    client.on('error', () => finish(false));
    client.on('end', () => finish(false));
    client.once('connect', () => client.write(frame + '\n'));
    client.once('data', data => finish(data[0] === 0x4b));
  });
}

function eventServer(endpoint, consume) {
  const expectedToken = Buffer.from(endpoint.token, 'hex');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(250, () => socket.destroy());
    socket.on('error', () => socket.destroy());

    let length = 0;
    const chunks = [];
    socket.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_FRAME_BYTES + 1) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(0x0a)) return;

      try {
        const line = Buffer.concat(chunks).toString('utf8');
        const { token, event } = JSON.parse(line);
        if (typeof token !== 'string' || !tokenPattern.test(token)
          || !timingSafeEqual(expectedToken, Buffer.from(token, 'hex')) || !isEvent(event)) {
          socket.destroy();
          return;
        }
        consume(event);
        socket.end('K');
      } catch {
        socket.destroy();
      }
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) server.close();
    },
  };
}

module.exports = { endpointPath, loadEndpoint, pipeAddress, sendEvent, eventServer };
