import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { createNativeWorkerProcesses } from "./native-worker-processes.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-render-deadline-"));
let passed = 0;
const failures = [];

try {
  const exampleWorkerPath = writeExecutable(
    "deadline-example-worker.mjs",
    `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );
  const nativeWorkerPath = writeExecutable(
    "deadline-native-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );
  const workers = createNativeWorkerProcesses({
    nativeRenderer: nativeWorkerPath,
    normalizers: createDaemonNormalizers(),
    workerTerminationGraceMs: 20,
    exampleWorkerCommandTimeoutMs: 80,
    nativeWorkerCommandTimeoutMs: 80
  });

  const exampleWorker = new workers.ExampleInstrumentWorker(exampleWorkerPath);
  await expectRejected(
    () => exampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5, renderTimeoutMs: 25 }),
    "worker command timed out after 25ms",
    "example render uses per-render deadlines"
  );
  await waitForKilled(exampleWorker);
  check(exampleWorker.process?.killed === true, "missed example render deadline terminates the worker");
  exampleWorker.destroy();

  const cappedExampleWorker = new workers.ExampleInstrumentWorker(exampleWorkerPath);
  await expectRejected(
    () => cappedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5, renderTimeoutMs: 60000 }),
    "worker command timed out after 80ms",
    "per-render deadlines cannot extend worker command timeouts"
  );
  cappedExampleWorker.destroy();

  const nativeWorker = new workers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeWorker.ready;
  await expectRejected(
    () => nativeWorker.render({ frames: 1, sampleRate: 48000, channels: [[]], inputBuses: [], renderTimeoutMs: 30 }),
    "worker command timed out after 30ms",
    "native render uses per-render deadlines"
  );
  await waitForKilled(nativeWorker);
  check(nativeWorker.process?.killed === true, "missed native render deadline terminates the worker");
  nativeWorker.destroy();
} finally {
  fs.rmSync(tempDir, { force: true, recursive: true });
}

console.log(`Native worker render deadline smoke checks passed (${passed} checks).`);
if (failures.length > 0) {
  process.exit(1);
}

function writeExecutable(name, source) {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
}

async function expectRejected(operation, expectedText, message) {
  try {
    await operation();
    fail(message);
  } catch (error) {
    check(String(error?.message ?? error).includes(expectedText), message);
  }
}

async function waitForKilled(worker) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (worker.process?.killed === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nativeWorkerInstance() {
  return {
    sampleRate: 48000,
    maxBlockSize: 1,
    inputChannels: 0,
    outputChannels: 1,
    kind: "effect",
    layout: {
      requestedInputChannels: 0,
      requestedOutputChannels: 1,
      inputChannels: 0,
      outputChannels: 1,
      inputBuses: 0,
      outputBuses: 1,
      inputBusLayouts: [],
      outputBusLayouts: [],
      sampleRate: 48000,
      maxBlockSize: 1
    }
  };
}

function check(condition, message) {
  if (condition) {
    passed += 1;
    return;
  }
  fail(message);
}

function fail(message) {
  failures.push(message);
  console.log(`FAIL - ${message}`);
}
