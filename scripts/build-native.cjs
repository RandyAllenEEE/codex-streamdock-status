'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const build = path.join(root, 'build', 'native');
const headersName = 'node-v20.8.1-headers.tar.gz';
const headersSha = 'b2db83feb961721f17142e792643974b04456cf2da34c22da3ac29cd00123226';

function buildForeground() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (process.platform !== 'win32' || !arch) {
    throw new Error('Build the foreground module with Windows Node on x64 or ARM64.');
  }
  fs.mkdirSync(build, { recursive: true });
  const archive = path.join(build, headersName);
  if (!fs.existsSync(archive)) {
    const download = execFileSync('curl.exe', [
      '-fLsS', '--retry', '2', 'https://nodejs.org/dist/v20.8.1/' + headersName,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    if (createHash('sha256').update(download).digest('hex') !== headersSha) {
      throw new Error('Node-API headers failed SHA-256 verification.');
    }
    fs.writeFileSync(archive, download);
  }
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== headersSha) {
    throw new Error('The cached Node-API header archive failed SHA-256 verification.');
  }
  execFileSync('tar.exe', ['-xf', archive, '-C', build], { windowsHide: true, stdio: 'inherit' });
  const headers = path.join(build, 'node-v20.8.1', 'include', 'node');
  const output = path.join(build, 'foreground.node');
  const zig = process.env.STREAMDOCK_ZIG || 'zig.exe';
  execFileSync(zig, [
    'cc', '-target', arch + '-windows-gnu', '-shared', '-O2', '-s', '-std=c11',
    '-DWIN32_LEAN_AND_MEAN', '-DNAPI_VERSION=8',
    '-I', headers, path.join(root, 'native', 'foreground.c'), '-luser32', '-o', output,
  ], {
    windowsHide: true, stdio: 'inherit',
    env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: path.join(build, 'zig-cache'),
      ZIG_LOCAL_CACHE_DIR: path.join(build, 'zig-local-cache') },
  });
  return fs.readFileSync(output);
}

module.exports = { buildForeground };
