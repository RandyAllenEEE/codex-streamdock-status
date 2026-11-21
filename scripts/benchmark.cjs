'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { SessionMonitor } = require('../src/state.cjs');
const { listenForEvents } = require('../src/pipe.cjs');

const SAMPLE_COUNT = 30;
const POWERSHELL = 'pwsh.exe';
const payload = JSON.stringify({
  hook_event_name: 'PreModelRequest',
  session_id: 'benchmark-session',
  turn_id: 'benchmark-turn',
  fixture: 'x'.repeat(65_536),
});

function runCommand(command, data, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      env, windowsHide: true, windowsVerbatimArguments: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code !== 0 || stdout.trim() !== '{}') {
        reject(new Error('Hook command failed (' + code + '): ' + stderr.trim()));
      } else {
        resolve(performance.now() - started);
      }
    });
    child.stdin.end(data);
  });
}

function measure(samples) {
  samples.sort((a, b) => a - b);
  const median = samples.length / 2;
  const point = value => Math.round(value * 10) / 10;
  return {
    samples: samples.length,
    medianMs: point((samples[median - 1] + samples[median]) / 2),
    p95Ms: point(samples[Math.ceil(samples.length * 0.95) - 1]),
    maxMs: point(samples.at(-1)),
  };
}

async function run() {
  if (process.platform !== 'win32') throw new Error('This benchmark needs Windows.');
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'codex-status-benchmark-'));
  const projectRoot = path.join(root, 'test project');
  const plugin = path.join(root, 'test plugin.sdPlugin');
  const runtime = path.join(plugin, 'hooks');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(runtime, { recursive: true });
  for (const file of ['hook.cjs', 'events.cjs', 'pipe.cjs']) {
    fs.copyFileSync(path.join(__dirname, '..', 'src', file), path.join(runtime, file));
  }
  let pipe;
  try {
    const setup = spawnSync(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'hooks.ps1'),
      '-Action', 'Install', '-ProjectRoot', projectRoot, '-NodePath', process.argv[2] || process.execPath,
      '-PluginDirectory', plugin,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (setup.status !== 0) throw new Error(setup.stderr || setup.stdout || 'Benchmark fixture setup failed');

    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, '.codex', 'hooks.json'), 'utf8'));
    const command = config.hooks.PreModelRequest[0].hooks[0].command;
    const monitor = new SessionMonitor();
    let delivered = 0;
    pipe = listenForEvents(path.join(runtime, 'endpoint.json'), event => {
      if (monitor.accept(event)) delivered += 1;
      monitor.view();
    }, error => { throw error; });
    await once(pipe.server, 'listening');
    const expectedFiles = fs.readdirSync(runtime).sort();

    async function sample() {
      const durations = [];
      for (let index = 0; index < SAMPLE_COUNT + 2; index += 1) {
        const elapsed = await runCommand(command, payload);
        if (index >= 2) durations.push(elapsed);
      }
      return measure(durations);
    }

    const connected = await sample();
    assert.equal(delivered, SAMPLE_COUNT + 2);
    assert.equal(monitor.view().active, 1);
    const closed = once(pipe.server, 'close');
    pipe.close();
    await closed;
    const disconnected = await sample();
    assert.deepEqual(fs.readdirSync(runtime).sort(), expectedFiles);

    process.stdout.write(JSON.stringify({
      inputBytes: Buffer.byteLength(payload),
      connected,
      disconnected,
      estimateTenModelAttemptsMs: Math.round(connected.medianMs * 20),
      newRuntimeFiles: 0,
    }, null, 2) + '\n');
  } finally {
    pipe?.close();
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), parent);
    assert.match(path.basename(actual), /^codex-status-benchmark-/);
    fs.rmSync(actual, { recursive: true });
  }
}

run().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
