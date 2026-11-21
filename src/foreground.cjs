'use strict';

const { createRequire } = require('node:module');
const { join } = require('node:path');

function foregroundEvents() {
  let native;
  return {
    watch(callback) {
      if (native === null) return null;
      try {
        native ??= createRequire(__filename)(join(__dirname, 'foreground.node'));
        native.start(callback);
        return () => native.stop();
      } catch {
        native = null;
        process.stderr.write('Codex Status: Windows foreground monitoring is unavailable.\n');
        return null;
      }
    },
    isForeground() {
      return native?.isCodexForeground() ?? false;
    },
  };
}

module.exports = { foregroundEvents };
