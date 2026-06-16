import fs from "node:fs";
import path from "node:path";

export async function exerciseVst3MultiBusNativeWorker({
  check,
  createTestWorkers,
  tempDir,
  workerPath
}) {
  const busWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096,
    maxWorkerStdoutLineBytes: 2048
  });
  const busWorker = new busWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    vst3MultiBusInstance()
  );

  try {
    await busWorker.ready;
    const rendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0.1, 0.2], [0.3, 0.4]],
      inputBuses: [
        { index: 0, channels: [[0.1, 0.2], [0.3, 0.4]] },
        { index: 1, channels: [[0.5, 0.6]] }
      ],
      transport: { playing: true, samplePosition: 32 }
    });

    check(
      Array.isArray(rendered.outputBuses) &&
        rendered.outputBuses.length === 3 &&
        rendered.outputBuses[1]?.index === 1 &&
        JSON.stringify(rendered.outputBuses[1].channels) === JSON.stringify([[0.5, 0.6]]) &&
        rendered.outputBuses[2]?.index === 2,
      "native VST3 workers preserve multi-bus render responses"
    );
    check(
      JSON.stringify(rendered.outputBuses?.[0]?.channels) === JSON.stringify(rendered.channels),
      "native VST3 workers keep bus 0 mirrored in legacy render channels"
    );
    const sidechainRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0, 0], [0, 0]],
      inputBuses: [
        { index: 0, channels: [[0.2, 0.4], [0.6, 0.8]] },
        { index: 1, channels: [[0.1, 0.3]] }
      ],
      transport: { samplePosition: 96 }
    });
    check(
      sidechainRendered.outputBuses?.length === 3 &&
        JSON.stringify(sidechainRendered.outputBuses?.[0]?.channels) === JSON.stringify(sidechainRendered.channels) &&
        JSON.stringify(sidechainRendered.channels) === JSON.stringify([[0.3, 0.7], [0.6, 0.8]]) &&
        JSON.stringify(sidechainRendered.outputBuses?.[2]?.channels) === JSON.stringify([[-0.1, -0.3]]),
      "native VST3 workers route explicit sidechain buses independently of legacy channels"
    );
  } finally {
    busWorker.destroy();
  }
}

export async function exerciseVst3MidiControllerMappingNativeWorker({
  check,
  createTestWorkers,
  tempDir,
  workerPath
}) {
  const midiWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096,
    maxWorkerStdoutLineBytes: 2048
  });
  const midiWorker = new midiWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    vst3InstrumentInstance()
  );

  try {
    await midiWorker.ready;
    await midiWorker.sendMidiEvents([
      { type: "controlChange", controller: 74, value: 0.25, channel: 2, time: 3 },
      { type: "pitchBend", value: -0.5, channel: 2, time: 4 },
      { type: "channelPressure", pressure: 0.75, channel: 2, time: 5 }
    ]);
    check(true, "native VST3 workers encode mapped MIDI-controller parameter events");
  } finally {
    midiWorker.destroy();
  }
}

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
    await noteExpressionWorker.sendMidiEvents([
      { type: "noteOn", note: 60, velocity: 0.8, channel: 1, time: 0, noteId: 42 },
      { type: "noteExpression", typeId: 0, value: 0.5, noteId: 42, channel: 1, time: 2 },
      { type: "noteExpressionText", typeId: 6, text: "bow", noteId: 42, channel: 1, time: 4 }
    ]);
    check(true, "native VST3 workers encode note-expression value/text event lists");
  } finally {
    noteExpressionWorker.destroy();
  }
}

export async function exerciseVst3WeirdMetadataNativeWorker({
  check,
  createTestWorkers,
  tempDir,
  workerPath
}) {
  const metadataWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096,
    maxWorkerStdoutLineBytes: 8192
  });
  const metadataWorker = new metadataWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    vst3InstrumentInstance()
  );

  try {
    await metadataWorker.ready;
    const parameters = await metadataWorker.getParameters();
    check(
      parameters.length === 2 &&
        parameters[0].id === "cutoff" &&
        parameters[0].name === "cutoff" &&
        parameters[0].normalizedValue === 0 &&
        parameters[0].defaultNormalizedValue === 1 &&
        parameters[0].readOnly === true &&
        !parameters[0].vst3Unit &&
        parameters[1].programChange === true &&
        parameters[1].programList?.programs?.[0]?.index === 1 &&
        parameters[1].programList?.programs?.[0]?.name === "Program 2",
      "native VST3 workers normalize partial/weird parameter metadata"
    );

    const programLists = await metadataWorker.getVst3ProgramLists();
    check(
      programLists.length === 1 &&
        programLists[0].id === 2147483647 &&
        programLists[0].name === "Programs" &&
        programLists[0].unitId === -1 &&
        programLists[0].programDataSupported === true &&
        programLists[0].programs?.[0]?.index === 0 &&
        programLists[0].programs?.[0]?.name === "Program 1" &&
        programLists[0].programs?.[0]?.normalizedValue === 1 &&
        programLists[0].programs?.[1]?.index === 255 &&
        programLists[0].programs?.[1]?.normalizedValue === 0,
      "native VST3 workers normalize partial/weird program-list metadata"
    );

    const noteExpressions = await metadataWorker.getVst3NoteExpressions();
    check(
      noteExpressions.length === 1 &&
        noteExpressions[0].typeId === 6 &&
        noteExpressions[0].name === "Expression 6" &&
        noteExpressions[0].shortName === "txt" &&
        noteExpressions[0].defaultValue === 0.75 &&
        noteExpressions[0].minValue === 0.75 &&
        noteExpressions[0].maxValue === 0.75 &&
        noteExpressions[0].busIndex === 31 &&
        noteExpressions[0].channel === 15 &&
        noteExpressions[0].bipolar === true &&
        noteExpressions[0].oneShot === true &&
        noteExpressions[0].absolute === true,
      "native VST3 workers normalize partial/weird note-expression metadata"
    );

    const layout = await metadataWorker.getLayout();
    check(
      layout.requestedOutputChannels === 32 &&
        layout.outputChannels === 1 &&
        layout.outputBuses === 2 &&
        layout.outputBusLayouts?.[0]?.index === 31 &&
        layout.outputBusLayouts?.[0]?.name === "Output 1" &&
        layout.outputBusLayouts?.[0]?.type === "unknown" &&
        layout.outputBusLayouts?.[0]?.channels === 32 &&
        layout.outputBusLayouts?.[1]?.name === "Output 2" &&
        layout.sampleRate === 8000 &&
        layout.maxBlockSize === 8192,
      "native VST3 workers normalize partial/weird bus layout metadata"
    );
  } finally {
    metadataWorker.destroy();
  }
}

export function writeVst3NativeWorkerIpcFixtures({ tempDir }) {
  return {
    midiControllerMappingNativeWorkerPath: writeVst3MidiControllerMappingNativeWorker(tempDir),
    multiBusNativeWorkerPath: writeVst3MultiBusNativeWorker(tempDir),
    noteExpressionNativeWorkerPath: writeVst3NoteExpressionNativeWorker(tempDir),
    weirdMetadataNativeWorkerPath: writeVst3WeirdMetadataNativeWorker(tempDir)
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

function vst3MultiBusInstance() {
  return {
    sampleRate: 48000,
    maxBlockSize: 2,
    inputChannels: 2,
    outputChannels: 2,
    kind: "effect",
    layout: {
      requestedInputChannels: 2,
      requestedOutputChannels: 2,
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 2,
      outputBuses: 3,
      inputBusLayouts: [
        {
          index: 0,
          direction: "input",
          mediaType: "audio",
          name: "Main Input",
          type: "main",
          channels: 2,
          active: true
        },
        {
          index: 1,
          direction: "input",
          mediaType: "audio",
          name: "Aux Input",
          type: "aux",
          channels: 1,
          active: true
        }
      ],
      outputBusLayouts: [
        {
          index: 0,
          direction: "output",
          mediaType: "audio",
          name: "Main Output",
          type: "main",
          channels: 2,
          active: true
        },
        {
          index: 1,
          direction: "output",
          mediaType: "audio",
          name: "Aux Output",
          type: "aux",
          channels: 1,
          active: true
        },
        {
          index: 2,
          direction: "output",
          mediaType: "audio",
          name: "Sidechain Monitor",
          type: "aux",
          channels: 1,
          active: true
        }
      ],
      sampleRate: 48000,
      maxBlockSize: 2
    }
  };
}

function writeVst3MidiControllerMappingNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-midi-controller-mapping-native-worker.mjs",
    `#!/usr/bin/env node
const expectedCommand = "midi cc:74:0.25:2:3;bend:-0.5:2:4;pressure:0.75:2:5";
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
      line === expectedCommand
        ? { ok: true, eventCount: 3 }
        : { error: "bad_mapped_midi_controller_events" }
    ) + "\\n");
  }
});
setTimeout(() => {}, 30000);
`
  );
}

function writeVst3NoteExpressionNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-note-expression-native-worker.mjs",
    `#!/usr/bin/env node
const expectedCommand = "midi on:60:0.8:1:0:42;expr:0:0.5:42:1:2;exprText:6:Ym93:42:1:4";
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
      line === expectedCommand
        ? { ok: true, eventCount: 3 }
        : { error: "bad_note_expression_events" }
    ) + "\\n");
  }
});
setTimeout(() => {}, 30000);
`
  );
}

function writeVst3WeirdMetadataNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-weird-metadata-native-worker.mjs",
    `#!/usr/bin/env node
const longText = "x".repeat(200);
const responses = {
  parameters: {
    parameters: [
      null,
      { name: "missing id", normalizedValue: 0.5 },
      {
        id: "cutoff",
        name: "",
        normalizedValue: "not-a-number",
        defaultNormalizedValue: 3,
        displayValue: longText,
        readOnly: true,
        stepCount: -5,
        vst3Unit: { id: "not-an-int", name: "bad" }
      },
      {
        id: "program",
        name: "Program",
        normalizedValue: 0.3,
        programChange: true,
        programList: {
          id: "bad",
          name: "",
          programs: [
            null,
            { index: "bad", name: "", normalizedValue: 2 }
          ]
        }
      }
    ]
  },
  programLists: {
    vst3ProgramLists: [
      null,
      {
        id: 999999999999,
        name: "",
        unitId: "bad",
        programDataSupported: true,
        programs: [
          null,
          { index: -5, name: "", normalizedValue: 2 },
          { index: 999, name: null, normalizedValue: -1 }
        ]
      },
      { id: 2, name: "Empty", programs: [] }
    ]
  },
  noteExpressions: {
    vst3NoteExpressions: [
      null,
      { typeId: "bad", name: "broken" },
      {
        typeId: 6,
        name: "",
        shortName: "txt",
        unit: "",
        defaultValue: 2,
        minValue: 0.75,
        maxValue: -1,
        stepCount: -1,
        busIndex: 99,
        channel: 99,
        unitId: "bad",
        associatedParameterId: "",
        bipolar: true,
        oneShot: true,
        absolute: true
      }
    ]
  },
  layout: {
    requestedOutputChannels: 99,
    outputChannels: "bad",
    outputBuses: 2,
    outputBusLayouts: [
      { index: 99, name: "", type: "side", channels: 99, active: "yes" },
      null
    ],
    sampleRate: 1,
    maxBlockSize: 999999
  }
};

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
    process.stdout.write(JSON.stringify(responses[line] ?? { error: "unknown_command" }) + "\\n");
  }
});
setTimeout(() => {}, 30000);
`
  );
}

function writeVst3MultiBusNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-multi-bus-native-worker.mjs",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";

function parseChannels(token, frames) {
  if (!token || token === "-") {
    return [];
  }
  return token.split("|").map((channel) => {
    const samples = channel.split(",");
    return Array.from({ length: frames }, (_, frame) => Number(samples[frame] ?? 0));
  });
}

function parseInputBuses(token, frames) {
  if (!token || token === "-") {
    return [];
  }
  return token.split(";").map((bus) => {
    const separator = bus.indexOf("=");
    return {
      index: Number(bus.slice(0, separator)),
      channels: parseChannels(bus.slice(separator + 1), frames)
    };
  });
}

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
    const parts = line.split(" ");
    if (parts[0] !== "render") {
      process.stdout.write(JSON.stringify({ error: "unknown_command" }) + "\\n");
      continue;
    }

    const frames = Number(parts[1]);
    const channels = parseChannels(parts[3], frames);
    const inputBuses = parseInputBuses(parts[4], frames);
    const mainChannels = [[0.1, 0.2], [0.3, 0.4]];
    const mainInputBuses = [
      { index: 0, channels: [[0.1, 0.2], [0.3, 0.4]] },
      { index: 1, channels: [[0.5, 0.6]] }
    ];
    const mainRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[5] === "playing=1,sample=32" &&
      JSON.stringify(channels) === JSON.stringify(mainChannels) &&
      JSON.stringify(inputBuses) === JSON.stringify(mainInputBuses);
    if (mainRequestMatched) {
      const mainOutput = [[0.6, 0.8], [0.3, 0.4]];
      process.stdout.write(JSON.stringify({
        channels: mainOutput,
        outputBuses: [
          { index: 0, channels: mainOutput },
          { index: 1, channels: [[0.5, 0.6]] },
          { index: 2, channels: [[-0.5, -0.6]] }
        ]
      }) + "\\n");
      continue;
    }

    const sidechainLegacyChannels = [[0, 0], [0, 0]];
    const sidechainInputBuses = [
      { index: 0, channels: [[0.2, 0.4], [0.6, 0.8]] },
      { index: 1, channels: [[0.1, 0.3]] }
    ];
    const sidechainRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[5] === "sample=96" &&
      JSON.stringify(channels) === JSON.stringify(sidechainLegacyChannels) &&
      JSON.stringify(inputBuses) === JSON.stringify(sidechainInputBuses);
    if (sidechainRequestMatched) {
      const sidechainMainOutput = [[0.3, 0.7], [0.6, 0.8]];
      process.stdout.write(JSON.stringify({
        channels: sidechainMainOutput,
        outputBuses: [
          { index: 0, channels: sidechainMainOutput },
          { index: 1, channels: [[0.1, 0.3]] },
          { index: 2, channels: [[-0.1, -0.3]] }
        ]
      }) + "\\n");
      continue;
    }

    process.stdout.write(JSON.stringify({ error: "bad_multibus_render" }) + "\\n");
    continue;
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
