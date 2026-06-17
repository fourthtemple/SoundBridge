import fs from "node:fs";
import path from "node:path";

export async function exerciseVst3NoteExpressionNativeWorker({
  check,
  createTestWorkers,
  tempDir,
  workerPath
}) {
  const noteExpressionWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096,
    maxWorkerStdoutLineBytes: 2048
  });
  const noteExpressionWorker = new noteExpressionWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    vst3InstrumentInstance()
  );

  try {
    await noteExpressionWorker.ready;
    const routed = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 60, velocity: 0.8, channel: 1, time: 0, noteId: 42, busIndex: 2 },
      { type: "noteExpression", typeId: 0, value: 0.5, noteId: 42, channel: 1, time: 2, busIndex: 2 },
      { type: "noteExpressionText", typeId: 6, text: "bow", noteId: 42, channel: 1, time: 4, busIndex: 2 }
    ]);
    const bounded = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 64, velocity: 0.5, channel: 15, time: 0, noteId: 2147483647 },
      { type: "noteExpression", typeId: 4294967295, value: 1, noteId: 2147483647, channel: 15, time: 1 },
      { type: "noteExpressionText", typeId: 6, text: "\u00b5-tilt", noteId: 2147483647, channel: 15, time: 2 },
      { type: "noteExpressionText", typeId: 6, text: "x".repeat(256), noteId: 2147483647, channel: 15, time: 7 }
    ]);
    const minimum = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 0, velocity: 0.1, channel: 0, time: 0, noteId: 0 },
      { type: "noteExpression", typeId: 1, value: 0, noteId: 0, channel: 0, time: 0 },
      { type: "noteExpressionText", typeId: 6, text: "z", noteId: 0, channel: 0, time: 1 }
    ]);
    check(
      routed.eventCount === 3 && bounded.eventCount === 4,
      "native VST3 workers encode bounded note-expression value/text event lists"
    );
    check(minimum.eventCount === 3, "native VST3 workers encode minimum note-expression value/text boundaries");
  } finally {
    noteExpressionWorker.destroy();
  }
}

export function writeVst3NoteExpressionNativeWorkerIpcFixtures({ tempDir }) {
  return {
    noteExpressionNativeWorkerPath: writeVst3NoteExpressionNativeWorker(tempDir)
  };
}

function vst3InstrumentInstance(maxBlockSize = 8) {
  return {
    sampleRate: 48000,
    maxBlockSize,
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
      maxBlockSize
    }
  };
}

function writeVst3NoteExpressionNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-note-expression-native-worker.mjs",
    `#!/usr/bin/env node
const utf8Text = "\\u00b5-tilt";
const maxText = "x".repeat(256);
const expectedCommands = new Set([
  "midi on:60:0.8:1:0:42:bus=2;expr:0:0.5:42:1:2:bus=2;exprText:6:Ym93:42:1:4:bus=2",
  [
    "midi on:64:0.5:15:0:2147483647",
    "expr:4294967295:1:2147483647:15:1",
    \`exprText:6:\${Buffer.from(utf8Text, "utf8").toString("base64")}:2147483647:15:2\`,
    \`exprText:6:\${Buffer.from(maxText, "utf8").toString("base64")}:2147483647:15:7\`
  ].join(";"),
  "midi on:0:0.1:0:0:0;expr:1:0:0:0:0;exprText:6:eg==:0:0:1"
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
    process.stdout.write(JSON.stringify(
      expectedCommands.has(line)
        ? { ok: true, eventCount: line.split(";").length }
        : { error: "bad_note_expression_events" }
    ) + "\\n");
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
