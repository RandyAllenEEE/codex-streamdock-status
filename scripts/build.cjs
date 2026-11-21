'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ncc = require('@vercel/ncc');
const { zipSync, unzipSync } = require('fflate');
const { renderKey } = require('../src/draw.cjs');
const { ACTION } = require('../src/streamdock.cjs');
const { buildForeground } = require('./build-native.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = 'com.randy.streamdock.codexstatus.sdPlugin';
const RELEASE = path.join(ROOT, 'release');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function add(files, key, content) {
  files[key] = Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function writeArchive(filename, files) {
  const zip = zipSync(files, { level: 6, mtime: new Date(2026, 0, 1) });
  const unpacked = unzipSync(zip);
  assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(files).sort());
  for (const [name, source] of Object.entries(files)) {
    assert.deepEqual(Buffer.from(unpacked[name]), source, 'Archive entry ' + name);
  }
  fs.writeFileSync(path.join(RELEASE, filename), zip);
}

async function build() {
  const manifest = JSON.parse(read('plugin/manifest.json'));
  const version = JSON.parse(read('package.json')).version;
  assert.equal(manifest.Version, version);
  assert.equal(manifest.Actions[0].UUID, ACTION);
  assert.equal(ACTION.split('.').slice(0, -1).join('.') + '.sdPlugin', PLUGIN);
  const foreground = buildForeground();

  const { code, assets } = await ncc(path.join(ROOT, 'src', 'plugin.cjs'), {
    cache: false,
    minify: false,
    sourceMap: false,
    target: 'es2022',
  });
  assert.deepEqual(Object.keys(assets), [], 'Review newly emitted runtime assets before packaging');
  const notice = Buffer.concat([
    read('THIRD_PARTY_NOTICES.md'),
    Buffer.from('\n\n--- ws ---\n'), read('node_modules/ws/LICENSE'),
    Buffer.from('\n\n--- pngjs ---\n'), read('node_modules/pngjs/LICENSE'),
  ]);

  const pluginFiles = {};
  add(pluginFiles, PLUGIN + '/manifest.json', read('plugin/manifest.json'));
  add(pluginFiles, PLUGIN + '/zh_CN.json', read('plugin/zh_CN.json'));
  add(pluginFiles, PLUGIN + '/static/status.png',
    renderKey({ state: 'running', active: 1, waiting: 0, failed: 0 }, 144, 144));
  add(pluginFiles, PLUGIN + '/plugin/index.js', code);
  add(pluginFiles, PLUGIN + '/plugin/foreground.node', foreground);
  for (const filename of ['hook.cjs', 'events.cjs', 'pipe.cjs']) {
    add(pluginFiles, PLUGIN + '/hooks/' + filename, read('src/' + filename));
  }
  add(pluginFiles, PLUGIN + '/LICENCE', read('LICENCE'));
  add(pluginFiles, PLUGIN + '/THIRD_PARTY_NOTICES.txt', notice);

  const hookFiles = {};
  for (const relative of [
    'scripts/hooks.ps1', 'README.md', 'LICENCE',
  ]) {
    add(hookFiles, 'codex-streamdock-hooks/' + relative, read(relative));
  }
  fs.mkdirSync(RELEASE, { recursive: true });
  writeArchive(PLUGIN, pluginFiles);
  writeArchive('codex-streamdock-hooks.zip', hookFiles);
  return pluginFiles;
}

if (require.main === module) {
  build().then(() => {
    process.stdout.write('Built and verified two packages in release/.\n');
  }).catch(error => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}

module.exports = { build, PLUGIN, RELEASE };
