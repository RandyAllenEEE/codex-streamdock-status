'use strict';

const { join } = require('node:path');
const { connectDock, dockArguments } = require('./streamdock.cjs');
const { prepareNavigation } = require('./navigate.cjs');
const { foregroundEvents } = require('./foreground.cjs');
const { watchDesktopUnread } = require('./desktop-unread.cjs');
const { createPlanReader } = require('./plan.cjs');
const { listenForEvents } = require('./pipe.cjs');

function start() {
  const dock = connectDock(dockArguments(process.argv.slice(2)), {
    foreground: foregroundEvents(),
    watchUnread: watchDesktopUnread,
    planReader: createPlanReader(),
    onClose() {
      pipe.close();
    },
  });
  const endpoint = join(__dirname, '..', 'hooks', 'endpoint.json');
  const pipe = listenForEvents(endpoint, dock.event, () => {
    process.stderr.write('Codex Status: the local event receiver could not start.\n');
  });
  prepareNavigation();
}

if (require.main === module) start();
module.exports = { start };
