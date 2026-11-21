'use strict';

const { connectDock, dockArguments } = require('./streamdock.cjs');
const { prepareNavigation } = require('./navigate.cjs');
const { eventServer, loadEndpoint, pipeAddress } = require('./pipe.cjs');

function start() {
  let pipe;
  let retry;
  const dock = connectDock(dockArguments(process.argv.slice(2)), {
    onClose() {
      clearTimeout(retry);
      pipe?.close();
    },
  });

  function listen() {
    const endpoint = loadEndpoint();
    if (!endpoint) {
      retry = setTimeout(listen, 2_000).unref();
      return;
    }
    pipe = eventServer(endpoint, dock.event);
    pipe.server.on('error', () => {
      process.stderr.write('Codex Status: the local event pipe could not be opened.\n');
    });
    pipe.server.listen(pipeAddress(endpoint));
  }

  listen();
  prepareNavigation();
}

if (require.main === module) start();
module.exports = { start };
