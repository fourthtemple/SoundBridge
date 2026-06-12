import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { createNativeWorkerProcesses } from "./native-worker-processes.mjs";

const MAX_TEST_STDOUT_LINE_BYTES = 128;

let passed = 0;
const failures = [];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-worker-ipc-"));

try {
  const exampleWorkerPath = writeExecutable(
    "oversized-example-worker.mjs",
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("x".repeat(2048));
});
setTimeout(() => {}, 30000);
`
  );
  const nativeWorkerPath = writeExecutable(
    "oversized-native-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("y".repeat(2048));
});
setTimeout(() => {}, 30000);
`
  );

  const workers = createNativeWorkerProcesses({
    nativeRenderer: nativeWorkerPath,
    normalizers: createDaemonNormalizers(),
    maxWorkerStdoutLineBytes: MAX_TEST_STDOUT_LINE_BYTES
  });

  const exampleWorker = new workers.ExampleInstrumentWorker(exampleWorkerPath);
  await expectRejected(
    () => exampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stdout_too_large",
    "example instrument workers reject oversized stdout lines"
  );
  exampleWorker.destroy();

  const nativeWorker = new workers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    {
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
        outputBusLayouts: [
          {
            index: 0,
            direction: "output",
            mediaType: "audio",
            name: "Main Output",
            type: "main",
            channels: 1,
            active: true
          }
        ],
        sampleRate: 48000,
        maxBlockSize: 1
      }
    }
  );
  await nativeWorker.ready;
  await expectRejected(
    () => nativeWorker.getParameters(),
    "worker_stdout_too_large",
    "native host workers reject oversized stdout lines"
  );
  nativeWorker.destroy();
} finally {
  fs.rmSync(tempDir, { force: true, recursive: true });
}

console.log(`\n${passed} worker IPC checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  process.exit(1);
}

function writeExecutable(filename, source) {
  const file = path.join(tempDir, filename);
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
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

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok  - ${message}`);
  } else {
    fail(message);
  }
}

function fail(message) {
  failures.push(message);
  console.log(`  FAIL- ${message}`);
}
