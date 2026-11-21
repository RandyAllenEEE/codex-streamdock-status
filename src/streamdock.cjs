'use strict';

const WebSocket = require('ws');
const { SessionMonitor } = require('./state.cjs');
const { dimension, renderKey } = require('./draw.cjs');
const { openChatGPT } = require('./navigate.cjs');

const ACTION = 'com.randy.streamdock.codexstatus.status';

function dockArguments(args) {
  function option(name) {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  }
  const port = Number(option('-port'));
  const pluginUUID = option('-pluginUUID');
  const registerEvent = option('-registerEvent');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !pluginUUID || !registerEvent) {
    throw new Error('Stream Dock launch arguments are missing or invalid');
  }
  return { port, pluginUUID, registerEvent };
}

function createDockController(send, { monitor = new SessionMonitor(),
  navigate = openChatGPT, draw = renderKey } = {}) {
  const keys = new Map();
  let nextUpdate;
  let lastPressAt = -Infinity;
  let navigating = false;

  function refresh() {
    clearTimeout(nextUpdate);
    const view = monitor.view();
    const visual = [view.state, view.active, view.waiting, view.failed].join(':');
    const images = new Map();
    for (const [context, key] of keys) {
      if (visual === key.previous) continue;
      const size = key.width + 'x' + key.height;
      if (!images.has(size)) {
        images.set(size, 'data:image/png;base64,' + draw(view, key.width, key.height).toString('base64'));
      }
      if (send({ event: 'setImage', context, payload: { image: images.get(size), target: 0 } })) {
        key.previous = visual;
      }
    }
    if (Number.isFinite(view.nextAt) && keys.size > 0) {
      nextUpdate = setTimeout(refresh, Math.max(1, view.nextAt - monitor.clock()));
    }
  }

  function action(message) {
    const { context, payload } = message;
    if (message.action !== ACTION || typeof context !== 'string' || !context) return;
    if (message.event === 'willAppear') {
      if (payload?.isInMultiAction || (payload?.controller && payload.controller !== 'Keypad')) return;
      keys.set(context, { width: dimension(payload?.width), height: dimension(payload?.height) });
      refresh();
    } else if (message.event === 'willDisappear') {
      keys.delete(context);
      if (!keys.size) clearTimeout(nextUpdate);
    } else if (message.event === 'keyUp' && keys.has(context) && !navigating
      && monitor.clock() - lastPressAt >= 500) {
      lastPressAt = monitor.clock();
      navigating = true;
      Promise.resolve().then(() => navigate(monitor.view().targetSessionId))
        .catch(() => send({ event: 'showAlert', context }))
        .finally(() => { navigating = false; });
    }
  }

  return {
    action,
    event(event) {
      if (monitor.accept(event)) refresh();
    },
    close() {
      clearTimeout(nextUpdate);
      keys.clear();
    },
  };
}

function connectDock(config, { onClose, navigate, monitor } = {}) {
  const socket = new WebSocket('ws://127.0.0.1:' + config.port, { maxPayload: 1024 * 1024 });
  function send(message) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  const dock = createDockController(send, { navigate, monitor });
  socket.once('open', () => send({ event: config.registerEvent, uuid: config.pluginUUID }));
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message && typeof message === 'object') dock.action(message);
  });
  socket.on('error', () => {
    process.stderr.write('Codex Status: Stream Dock connection failed.\n');
  });
  socket.once('close', () => {
    dock.close();
    onClose?.();
  });
  return { event: dock.event, close: () => socket.terminate() };
}

module.exports = { ACTION, dockArguments, createDockController, connectDock };
