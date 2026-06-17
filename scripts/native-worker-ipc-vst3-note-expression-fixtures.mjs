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
      { type: "noteOn", note: 64, velocity: 0.5, channel: 15, time: 0, noteId: 2147483647, busIndex: 31 },
      { type: "noteExpression", typeId: 4294967295, value: 1, noteId: 2147483647, channel: 15, time: 1, busIndex: 31 },
      { type: "noteExpressionText", typeId: 6, text: "\u00b5-tilt", noteId: 2147483647, channel: 15, time: 2, busIndex: 31 },
      { type: "noteExpressionText", typeId: 6, text: "\u00b5".repeat(128), noteId: 2147483647, channel: 15, time: 6, busIndex: 31 },
      { type: "noteExpressionText", typeId: 6, text: "x".repeat(256), noteId: 2147483647, channel: 15, time: 7, busIndex: 31 }
    ]);
    const minimum = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 0, velocity: 0.1, channel: 0, time: 0, noteId: 0 },
      { type: "noteExpression", typeId: 1, value: 0, noteId: 0, channel: 0, time: 0 },
      { type: "noteExpressionText", typeId: 6, text: "z", noteId: 0, channel: 0, time: 1 }
    ]);
    const delimiterText = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 72, velocity: 0.7, channel: 2, time: 0, noteId: 99, busIndex: 2 },
      { type: "noteExpressionText", typeId: 6, text: "expr:bus=2;line\nrobot\u{1f916}", noteId: 99, channel: 2, time: 3, busIndex: 2 }
    ]);
    const notes = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 67, channel: 0, time: 0, busIndex: 2 },
      { type: "noteOff", note: 67, channel: 0, time: 3, busIndex: 2 },
      { type: "polyPressure", note: 67, pressure: 0.25, channel: 0, time: 4, noteId: 88, busIndex: 2 }
    ]);
    const identifiedNotes = await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 69, velocity: 0.6, channel: 3, time: 1, noteId: 123, busIndex: 4 },
      { type: "noteOff", note: 69, velocity: 0.2, channel: 3, time: 5, noteId: 123, busIndex: 4 }
    ]);
    check(
      routed.eventCount === 3 && bounded.eventCount === 5,
      "native VST3 workers encode bounded note-expression value/text event lists"
    );
    check(minimum.eventCount === 3, "native VST3 workers encode minimum note-expression value/text boundaries");
    check(delimiterText.eventCount === 2, "native VST3 workers base64-encode delimiter-rich note-expression text");
    check(notes.eventCount === 3, "native VST3 workers encode routed note and poly-pressure event boundaries");
    check(identifiedNotes.eventCount === 2, "native VST3 workers encode note-off note IDs on routed events");
    const invalidTextMessages = await Promise.all([
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 6, text: "", noteId: 1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 6, text: "a\u0000h", noteId: 1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 6, text: "x".repeat(257), noteId: 1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 6, text: "\u00b5".repeat(129), noteId: 1, channel: 0, time: 0 }
      ]))
    ]);
    check(
      invalidTextMessages.every((message) =>
        message === "VST3 note-expression text must be 1..256 UTF-8 bytes without NUL characters."
      ),
      "native VST3 workers reject malformed note-expression text before IPC"
    );
    const nonStringTextMessage = await rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
      { type: "noteExpressionText", typeId: 6, text: 7, noteId: 1, channel: 0, time: 0 }
    ]));
    check(
      nonStringTextMessage === "VST3 note-expression text must be a string.",
      "native VST3 workers reject non-string note-expression text before IPC"
    );
    const invalidValueMessages = await Promise.all([
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpression", typeId: -1, value: 0.5, noteId: 1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpression", typeId: 0, value: 0.5, noteId: 2147483648, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpression", typeId: 0, value: 2, noteId: 1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 4294967296, text: "z", noteId: 1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 6, text: "z", noteId: -1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteExpressionText", typeId: 6, text: "z", noteId: 1, channel: 0, time: 0, busIndex: 32 }
      ]))
    ]);
    check(
      JSON.stringify(invalidValueMessages) === JSON.stringify([
        "VST3 note-expression typeId must be an integer in 0..4294967295.",
        "VST3 note-expression noteId must be an integer in 0..2147483647.",
        "VST3 note-expression value must be a number in 0..1.",
        "VST3 note-expression typeId must be an integer in 0..4294967295.",
        "VST3 note-expression noteId must be an integer in 0..2147483647.",
        "MIDI busIndex must be an integer in 0..31."
      ]),
      "native VST3 workers reject malformed note-expression value and route metadata before IPC"
    );
    const invalidNoteMessages = await Promise.all([
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteOn", note: -1, velocity: 0.8, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteOn", note: 60, velocity: 2, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "polyPressure", note: 60, pressure: -0.1, channel: 0, time: 0 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteOn", note: 60, velocity: 0.8, channel: 0, time: 0, noteId: 2147483648 }
      ])),
      rejectedMessage(() => noteExpressionWorker.sendMidiEvents([
        { type: "noteOn", note: 60, velocity: 0.8, channel: 0, time: 8192 }
      ]))
    ]);
    check(
      JSON.stringify(invalidNoteMessages) === JSON.stringify([
        "MIDI note must be an integer in 0..127.",
        "MIDI velocity must be a number in 0..1.",
        "MIDI pressure must be a number in 0..1.",
        "MIDI noteId must be an integer in 0..2147483647.",
        "MIDI time must be an integer in 0..8191."
      ]),
      "native VST3 workers reject malformed note and poly-pressure events before IPC"
    );
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
const maxUtf8Text = "\\u00b5".repeat(128);
const maxText = "x".repeat(256);
const delimiterText = "expr:bus=2;line\\nrobot\\u{1f916}";
const expectedCommands = new Set([
  "midi on:60:0.8:1:0:42:bus=2;expr:0:0.5:42:1:2:bus=2;exprText:6:Ym93:42:1:4:bus=2",
  [
    "midi on:64:0.5:15:0:2147483647:bus=31",
    "expr:4294967295:1:2147483647:15:1:bus=31",
    \`exprText:6:\${Buffer.from(utf8Text, "utf8").toString("base64")}:2147483647:15:2:bus=31\`,
    \`exprText:6:\${Buffer.from(maxUtf8Text, "utf8").toString("base64")}:2147483647:15:6:bus=31\`,
    \`exprText:6:\${Buffer.from(maxText, "utf8").toString("base64")}:2147483647:15:7:bus=31\`
  ].join(";"),
  "midi on:0:0.1:0:0:0;expr:1:0:0:0:0;exprText:6:eg==:0:0:1",
  [
    "midi on:72:0.7:2:0:99:bus=2",
    \`exprText:6:\${Buffer.from(delimiterText, "utf8").toString("base64")}:99:2:3:bus=2\`
  ].join(";"),
  "midi on:67:0.8:0:0:bus=2;off:67:0:0:3:bus=2;poly:67:0.25:0:4:88:bus=2",
  "midi on:69:0.6:3:1:123:bus=4;off:69:0.2:3:5:123:bus=4"
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

async function rejectedMessage(operation) {
  try {
    await operation();
  } catch (error) {
    return error.message;
  }
  return undefined;
}
