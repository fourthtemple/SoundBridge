import fs from "node:fs";
import path from "node:path";

export async function exerciseVst3ProgramDataNativeWorker({
  check,
  createTestWorkers,
  tempDir,
  workerPath
}) {
  const programDataWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096,
    maxWorkerStdoutLineBytes: 2048
  });
  const programDataWorker = new programDataWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    vst3ProgramDataInstance()
  );

  try {
    await programDataWorker.ready;
    const exported = await programDataWorker.getVst3ProgramData(2147483647, 255);
    const exportedBytes = await programDataWorker.getVst3ProgramData(7, 2);
    const badExportMessage = await rejectedMessage(() =>
      programDataWorker.getVst3ProgramData(8, 0)
    );
    check(
      exported?.programListId === 2147483647 &&
        exported.programIndex === 255 &&
        exported.size === 0 &&
        exported.data === "",
      "native VST3 workers preserve empty program-data exports"
    );
    check(
      exportedBytes?.programListId === 7 &&
        exportedBytes.programIndex === 2 &&
        exportedBytes.size === 2 &&
        exportedBytes.data === "YWI=",
      "native VST3 workers derive program-data export sizes from bounded bytes"
    );
    check(
      badExportMessage === "VST3 program data was not valid base64.",
      "native VST3 workers reject invalid program-data exports"
    );

    const restoredEmpty = await programDataWorker.setVst3ProgramData(-2147483648, 0, "");
    const restoredBytes = await programDataWorker.setVst3ProgramData(7, 2, "YWI=");
    const restoredPaddedBytes = await programDataWorker.setVst3ProgramData(2147483647, 255, "+/8=");
    const sentinelRestoreMessage = await rejectedMessage(() =>
      programDataWorker.setVst3ProgramData(-1, 0, "YWI=")
    );
    const badRestoreAckMessage = await rejectedMessage(() =>
      programDataWorker.setVst3ProgramData(7, 3, "YWI=")
    );
    check(
      restoredEmpty?.restored === "empty" &&
        restoredBytes?.restored === "bytes" &&
        restoredPaddedBytes?.restored === "padded-bytes",
      "native VST3 workers encode signed, empty, and padded program-data restore commands"
    );
    check(
      sentinelRestoreMessage === "VST3 program data cannot use the no-program-list sentinel." &&
        badRestoreAckMessage === "worker returned invalid VST3 program-data restore acknowledgement",
      "native VST3 workers reject invalid program-data restore acknowledgements"
    );
  } finally {
    programDataWorker.destroy();
  }
}

export function writeVst3ProgramDataNativeWorkerIpcFixtures({ tempDir }) {
  return {
    programDataNativeWorkerPath: writeVst3ProgramDataNativeWorker(tempDir)
  };
}

function vst3ProgramDataInstance() {
  return {
    sampleRate: 48000,
    maxBlockSize: 8,
    inputChannels: 0,
    outputChannels: 1,
    kind: "instrument",
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
      maxBlockSize: 8
    }
  };
}

function writeVst3ProgramDataNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-program-data-native-worker.mjs",
    `#!/usr/bin/env node
const responses = new Map([
  [
    "getProgramData 2147483647 255",
    { programData: { format: "vst3", programListId: 2147483647, programIndex: 255, data: "" } }
  ],
  [
    "getProgramData 7 2",
    { programData: { format: "vst3", programListId: 7, programIndex: 2, size: 999, data: "YWI=" } }
  ],
  ["getProgramData 8 0", { programData: { format: "vst3", programListId: 8, programIndex: 0, data: "not-base64" } }],
  ["setProgramData -2147483648 0 -", { ok: true, restored: "empty" }],
  ["setProgramData 7 2 YWI=", { ok: true, restored: "bytes" }],
  ["setProgramData 7 3 YWI=", { ok: false }],
  ["setProgramData 2147483647 255 +/8=", { ok: true, restored: "padded-bytes" }]
]);

process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "quit") {
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(responses.get(line) ?? { error: "bad_program_data_command" }) + "\\n");
  }
});
setTimeout(() => {}, 30000);
`
  );
}

function writeExecutable(tempDir, filename, source) {
  const file = path.join(tempDir, filename);
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

async function rejectedMessage(operation) {
  try {
    await operation();
  } catch (error) {
    return error.message;
  }
  return undefined;
}
