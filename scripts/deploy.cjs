'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { build, PLUGIN } = require('./build.cjs');

const marker = '.codex-streamdock-status-dev';

function checkChild(root, target) {
  if (path.dirname(target) !== root) throw new Error('Unexpected plugin directory: ' + target);
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (info && (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(target) !== target)) {
    throw new Error('The plugin path must be an ordinary local directory: ' + target);
  }
  return Boolean(info);
}

async function deploy() {
  const requestedRoot = process.argv[2] || path.join(process.env.APPDATA || '',
    'HotSpot', 'StreamDock', 'plugins');
  const root = fs.realpathSync(requestedRoot);
  const target = path.join(root, PLUGIN);
  const installed = checkChild(root, target);
  if (installed && !fs.existsSync(path.join(target, marker))) {
    throw new Error('An installed release already uses this plugin ID. Uninstall it in Stream Dock first.');
  }

  const files = await build();
  const staging = fs.mkdtempSync(path.join(root, 'codex-status-stage-'));
  const backup = staging + '-previous';
  let swapped = false;
  try {
    for (const [name, content] of Object.entries(files)) {
      const filename = path.join(staging, name.slice(PLUGIN.length + 1));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    fs.writeFileSync(path.join(staging, marker), PLUGIN);
    if (installed) {
      checkChild(root, target);
      checkChild(root, backup);
      fs.renameSync(target, backup);
    }
    try {
      checkChild(root, staging);
      fs.renameSync(staging, target);
      swapped = true;
    } catch (error) {
      if (installed && checkChild(root, backup)) fs.renameSync(backup, target);
      throw error;
    }
  } finally {
    if (checkChild(root, staging)) fs.rmSync(staging, { recursive: true });
    if (swapped && checkChild(root, backup)) fs.rmSync(backup, { recursive: true });
  }
  process.stdout.write('Development plugin deployed to ' + target + '\n');
}

deploy().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
