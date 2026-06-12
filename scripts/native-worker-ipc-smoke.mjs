import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonNormalizers } from "./daemon-normalizers.mjs";
import { createNativeWorkerProcesses } from "./native-worker-processes.mjs";

const MAX_TEST_STDOUT_LINE_BYTES = 128;
const MAX_TEST_COMMAND_BYTES = 128;
const MAX_TEST_STDERR_LINE_BYTES = 128;
const MAX_TEST_STDERR_BYTES = 64;
const MAX_TEST_PENDING_COMMANDS = 8;
const TEST_READY_TIMEOUT_MS = 500;
const TEST_TERMINATION_GRACE_MS = 50;
const TEST_COMMAND_TIMEOUT_MS = 500;

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
  const exampleStderrWorkerPath = writeExecutable(
    "oversized-example-stderr-worker.mjs",
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("e".repeat(2048));
});
setTimeout(() => {}, 30000);
`
  );
  const nativeStderrWorkerPath = writeExecutable(
    "oversized-native-stderr-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("n".repeat(2048));
});
setTimeout(() => {}, 30000);
`
  );
  const exampleStderrBudgetWorkerPath = writeExecutable(
    "stderr-budget-example-worker.mjs",
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write(" ".repeat(40) + "\\n" + " ".repeat(40) + "\\n");
});
setTimeout(() => {}, 30000);
`
  );
  const nativeStderrBudgetWorkerPath = writeExecutable(
    "stderr-budget-native-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write(" ".repeat(40) + "\\n" + " ".repeat(40) + "\\n");
});
setTimeout(() => {}, 30000);
`
  );
  const malformedExampleWorkerPath = writeExecutable(
    "malformed-example-worker.mjs",
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("not-json\\n");
});
setTimeout(() => {}, 30000);
`
  );
  const malformedNativeReadyWorkerPath = writeExecutable(
    "malformed-native-ready-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write("not-json\\n");
setTimeout(() => {}, 30000);
`
  );
  const invalidNativeReadyWorkerPath = writeExecutable(
    "invalid-native-ready-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: false, error: "bad-ready" }) + "\\n");
setTimeout(() => {}, 30000);
`
  );
  const malformedNativeCommandWorkerPath = writeExecutable(
    "malformed-native-command-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("not-json\\n");
});
setTimeout(() => {}, 30000);
`
  );
  const unsolicitedExampleWorkerPath = writeExecutable(
    "unsolicited-example-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
setTimeout(() => {}, 30000);
`
  );
  const unsolicitedNativeWorkerPath = writeExecutable(
    "unsolicited-native-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
setTimeout(() => {}, 30000);
`
  );
  const hangingNativeWorkerPath = writeExecutable(
    "hanging-native-worker.mjs",
    `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );
  const hangingExampleCommandWorkerPath = writeExecutable(
    "hanging-example-command-worker.mjs",
    `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );
  const hangingNativeCommandWorkerPath = writeExecutable(
    "hanging-native-command-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );
  const stubbornExampleCommandWorkerPath = writeExecutable(
    "stubborn-example-command-worker.mjs",
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );
  const stubbornNativeCommandWorkerPath = writeExecutable(
    "stubborn-native-command-worker.mjs",
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
  );

  const workers = createTestWorkers(nativeWorkerPath);

  const exampleWorker = new workers.ExampleInstrumentWorker(exampleWorkerPath);
  await expectRejected(
    () => exampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stdout_too_large",
    "example instrument workers reject oversized stdout lines"
  );
  exampleWorker.destroy();

  const nativeWorker = new workers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeWorker.ready;
  await expectRejected(
    () => nativeWorker.getParameters(),
    "worker_stdout_too_large",
    "native host workers reject oversized stdout lines"
  );
  nativeWorker.destroy();

  const stderrWorkers = createTestWorkers(nativeStderrWorkerPath);
  const exampleStderrWorker = new stderrWorkers.ExampleInstrumentWorker(exampleStderrWorkerPath);
  await expectRejected(
    () => exampleStderrWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stderr_too_large",
    "example instrument workers reject oversized stderr lines"
  );
  check(exampleStderrWorker.process?.killed === true, "oversized-stderr example instrument worker process is killed");
  exampleStderrWorker.destroy();

  const nativeStderrWorker = new stderrWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeStderrWorker.ready;
  await expectRejected(
    () => nativeStderrWorker.getParameters(),
    "worker_stderr_too_large",
    "native host workers reject oversized stderr lines"
  );
  check(nativeStderrWorker.process?.killed === true, "oversized-stderr native host worker process is killed");
  nativeStderrWorker.destroy();

  const stderrBudgetWorkers = createTestWorkers(nativeStderrBudgetWorkerPath);
  const exampleStderrBudgetWorker = new stderrBudgetWorkers.ExampleInstrumentWorker(exampleStderrBudgetWorkerPath);
  await expectRejected(
    () => exampleStderrBudgetWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stderr_budget_exceeded",
    "example instrument workers reject cumulative stderr floods"
  );
  check(exampleStderrBudgetWorker.process?.killed === true, "stderr-flood example instrument worker process is killed");
  exampleStderrBudgetWorker.destroy();

  const nativeStderrBudgetWorker = new stderrBudgetWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await nativeStderrBudgetWorker.ready;
  await expectRejected(
    () => nativeStderrBudgetWorker.getParameters(),
    "worker_stderr_budget_exceeded",
    "native host workers reject cumulative stderr floods"
  );
  check(nativeStderrBudgetWorker.process?.killed === true, "stderr-flood native host worker process is killed");
  nativeStderrBudgetWorker.destroy();

  const malformedWorkers = createTestWorkers(malformedNativeCommandWorkerPath);
  const malformedExampleWorker = new malformedWorkers.ExampleInstrumentWorker(malformedExampleWorkerPath);
  await expectRejected(
    () => malformedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_stdout_malformed",
    "example instrument workers reject malformed stdout responses"
  );
  check(malformedExampleWorker.process?.killed === true, "malformed-stdout example instrument worker process is killed");
  malformedExampleWorker.destroy();

  const malformedNativeCommandWorker = new malformedWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await malformedNativeCommandWorker.ready;
  await expectRejected(
    () => malformedNativeCommandWorker.getParameters(),
    "worker_stdout_malformed",
    "native host workers reject malformed stdout responses"
  );
  check(malformedNativeCommandWorker.process?.killed === true, "malformed-stdout native host worker process is killed");
  malformedNativeCommandWorker.destroy();

  const malformedReadyWorkers = createTestWorkers(malformedNativeReadyWorkerPath);
  const malformedNativeReadyWorker = new malformedReadyWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await expectRejected(
    () => malformedNativeReadyWorker.ready,
    "worker_stdout_malformed",
    "native host workers reject malformed ready handshakes"
  );
  check(malformedNativeReadyWorker.process?.killed === true, "malformed-ready native host worker process is killed");
  malformedNativeReadyWorker.destroy();

  const invalidReadyWorkers = createTestWorkers(invalidNativeReadyWorkerPath);
  const invalidNativeReadyWorker = new invalidReadyWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await expectRejected(
    () => invalidNativeReadyWorker.ready,
    "worker_ready_invalid",
    "native host workers reject invalid ready handshakes"
  );
  check(invalidNativeReadyWorker.process?.killed === true, "invalid-ready native host worker process is killed");
  invalidNativeReadyWorker.destroy();

  const unsolicitedExampleWorkers = createTestWorkers(nativeWorkerPath);
  const unsolicitedExampleWorker = new unsolicitedExampleWorkers.ExampleInstrumentWorker(unsolicitedExampleWorkerPath);
  await waitForKilled(unsolicitedExampleWorker);
  check(unsolicitedExampleWorker.process?.killed === true, "unsolicited-stdout example instrument worker process is killed");
  await expectRejected(
    () => unsolicitedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker is not writable",
    "example instrument workers reject commands after unsolicited stdout"
  );
  unsolicitedExampleWorker.destroy();

  const unsolicitedNativeWorkers = createTestWorkers(unsolicitedNativeWorkerPath);
  const unsolicitedNativeWorker = new unsolicitedNativeWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await unsolicitedNativeWorker.ready;
  await waitForKilled(unsolicitedNativeWorker);
  check(unsolicitedNativeWorker.process?.killed === true, "unsolicited-stdout native host worker process is killed");
  await expectRejected(
    () => unsolicitedNativeWorker.getParameters(),
    "worker is not writable",
    "native host workers reject commands after unsolicited stdout"
  );
  unsolicitedNativeWorker.destroy();

  const commandLimitWorkers = createTestWorkers(nativeWorkerPath, { maxWorkerCommandBytes: 16 });
  const commandLimitExampleWorker = new commandLimitWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  await expectRejected(
    () => commandLimitExampleWorker.request("x".repeat(64)),
    "worker_command_too_large",
    "example instrument workers reject oversized commands before stdin write"
  );
  check(commandLimitExampleWorker.pending.length === 0, "oversized example worker commands are not queued");
  commandLimitExampleWorker.destroy();

  const commandLimitNativeWorker = new commandLimitWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await commandLimitNativeWorker.ready;
  await expectRejected(
    () => commandLimitNativeWorker.request("x".repeat(64)),
    "worker_command_too_large",
    "native host workers reject oversized commands before stdin write"
  );
  check(commandLimitNativeWorker.pending.length === 0, "oversized native worker commands are not queued");
  commandLimitNativeWorker.destroy();

  const cappedExampleWorkers = createTestWorkers(hangingNativeCommandWorkerPath, { maxWorkerPendingCommands: 1 });
  const cappedExampleWorker = new cappedExampleWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  const pendingExampleCommand = cappedExampleWorker
    .render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 })
    .catch(() => undefined);
  await expectRejected(
    () => cappedExampleWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_pending_commands_exceeded",
    "example instrument workers reject commands beyond the pending limit"
  );
  cappedExampleWorker.destroy();
  await pendingExampleCommand;

  const cappedNativeWorkers = createTestWorkers(hangingNativeCommandWorkerPath, { maxWorkerPendingCommands: 1 });
  const cappedNativeWorker = new cappedNativeWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await cappedNativeWorker.ready;
  const pendingNativeCommand = cappedNativeWorker.getParameters().catch(() => undefined);
  await expectRejected(
    () => cappedNativeWorker.getLatency(),
    "worker_pending_commands_exceeded",
    "native host workers reject commands beyond the pending limit"
  );
  cappedNativeWorker.destroy();
  await pendingNativeCommand;

  const hangingWorkers = createTestWorkers(hangingNativeWorkerPath);
  const hangingWorker = new hangingWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await expectRejected(
    () => hangingWorker.ready,
    "worker_ready_timeout",
    "native host workers reject missing ready handshakes"
  );
  hangingWorker.destroy();

  const hangingCommandWorkers = createTestWorkers(hangingNativeCommandWorkerPath);
  const hangingExampleCommandWorker = new hangingCommandWorkers.ExampleInstrumentWorker(hangingExampleCommandWorkerPath);
  await expectRejected(
    () => hangingExampleCommandWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_command_timeout",
    "example instrument workers terminate timed-out commands"
  );
  check(hangingExampleCommandWorker.process?.killed === true, "timed-out example instrument worker process is killed");
  hangingExampleCommandWorker.destroy();

  const hangingNativeCommandWorker = new hangingCommandWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await hangingNativeCommandWorker.ready;
  await expectRejected(
    () => hangingNativeCommandWorker.getParameters(),
    "worker_command_timeout",
    "native host workers terminate timed-out commands"
  );
  check(hangingNativeCommandWorker.process?.killed === true, "timed-out native host worker process is killed");
  hangingNativeCommandWorker.destroy();

  const stubbornWorkers = createTestWorkers(stubbornNativeCommandWorkerPath, {
    workerTerminationGraceMs: TEST_TERMINATION_GRACE_MS
  });
  const stubbornExampleCommandWorker = new stubbornWorkers.ExampleInstrumentWorker(stubbornExampleCommandWorkerPath);
  await expectRejected(
    () => stubbornExampleCommandWorker.render({ frames: 1, sampleRate: 48000, gain: 0.5, tone: 0.5, detune: 0.5 }),
    "worker_command_timeout",
    "example instrument workers time out stubborn commands"
  );
  await waitForExitSignal(stubbornExampleCommandWorker, "SIGKILL");
  check(stubbornExampleCommandWorker.process?.signalCode === "SIGKILL", "stubborn example worker escalates to SIGKILL");
  stubbornExampleCommandWorker.destroy();

  const stubbornNativeCommandWorker = new stubbornWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await stubbornNativeCommandWorker.ready;
  await expectRejected(
    () => stubbornNativeCommandWorker.getParameters(),
    "worker_command_timeout",
    "native host workers time out stubborn commands"
  );
  await waitForExitSignal(stubbornNativeCommandWorker, "SIGKILL");
  check(stubbornNativeCommandWorker.process?.signalCode === "SIGKILL", "stubborn native worker escalates to SIGKILL");
  stubbornNativeCommandWorker.destroy();
} finally {
  fs.rmSync(tempDir, { force: true, recursive: true });
}

function createTestWorkers(nativeRenderer, options = {}) {
  return createNativeWorkerProcesses({
    nativeRenderer,
    normalizers: createDaemonNormalizers(),
    maxWorkerStdoutLineBytes: MAX_TEST_STDOUT_LINE_BYTES,
    maxWorkerCommandBytes: options.maxWorkerCommandBytes ?? MAX_TEST_COMMAND_BYTES,
    maxWorkerStderrLineBytes: MAX_TEST_STDERR_LINE_BYTES,
    maxWorkerStderrBytes: MAX_TEST_STDERR_BYTES,
    maxWorkerPendingCommands: options.maxWorkerPendingCommands ?? MAX_TEST_PENDING_COMMANDS,
    workerReadyTimeoutMs: TEST_READY_TIMEOUT_MS,
    workerTerminationGraceMs: options.workerTerminationGraceMs ?? TEST_TERMINATION_GRACE_MS,
    exampleWorkerCommandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
    nativeWorkerCommandTimeoutMs: TEST_COMMAND_TIMEOUT_MS
  });
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
  };
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

async function waitForKilled(worker) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (worker.process?.killed === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExitSignal(worker, signal) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (worker.process?.signalCode === signal) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
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
