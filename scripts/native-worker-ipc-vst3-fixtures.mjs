import fs from "node:fs";
import path from "node:path";

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
    const routed = await midiWorker.sendMidiEvents([
      { type: "controlChange", controller: 74, value: 0.25, channel: 2, time: 3, busIndex: 1 },
      { type: "pitchBend", value: -0.5, channel: 2, time: 4, busIndex: 1 },
      { type: "channelPressure", pressure: 0.75, channel: 2, time: 5, busIndex: 1 },
      { type: "programChange", program: 7, channel: 2, time: 6, busIndex: 1 }
    ]);
    const mainBus = await midiWorker.sendMidiEvents([
      { type: "controlChange", controller: 1, value: 0.4, channel: 0, time: 0 },
      { type: "pitchBend", value: 0.1, channel: 0, time: 1 },
      { type: "channelPressure", pressure: 0.3, channel: 0, time: 2 },
      { type: "programChange", program: 2, channel: 0, time: 3 }
    ]);
    const boundaries = await midiWorker.sendMidiEvents([
      { type: "controlChange", controller: 0, value: 0, channel: 0, time: 0, busIndex: 0 },
      { type: "controlChange", controller: 127, value: 1, channel: 15, time: 7, busIndex: 31 },
      { type: "pitchBend", value: -1, channel: 0, time: 1, busIndex: 0 },
      { type: "pitchBend", value: 1, channel: 15, time: 6, busIndex: 31 },
      { type: "channelPressure", pressure: 0, channel: 0, time: 2, busIndex: 0 },
      { type: "channelPressure", pressure: 1, channel: 15, time: 5, busIndex: 31 },
      { type: "programChange", program: 0, channel: 0, time: 3, busIndex: 0 },
      { type: "programChange", program: 127, channel: 15, time: 4, busIndex: 31 }
    ]);
    const badAckMessage = await rejectedMessage(() =>
      midiWorker.sendMidiEvents([{ type: "controlChange", controller: 2, value: 0.5, channel: 0, time: 0 }])
    );
    check(
      routed.eventCount === 4 && mainBus.eventCount === 4,
      "native VST3 workers encode explicit-bus and main-bus MIDI-controller/program-change events"
    );
    check(boundaries.eventCount === 8, "native VST3 workers encode MIDI-controller/program-change boundary routes");
    check(
      badAckMessage === "worker returned invalid MIDI acknowledgement",
      "native host workers reject mismatched MIDI acknowledgements"
    );
  } finally {
    midiWorker.destroy();
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
      parameters.length === 3 &&
        parameters[0].id === "cutoff" &&
        parameters[0].name === "cutoff" &&
        parameters[0].normalizedValue === 0 &&
        parameters[0].defaultNormalizedValue === 1 &&
        parameters[0].readOnly === true &&
        !parameters[0].vst3Unit &&
        parameters[0].vst3MidiMappings?.length === 1 &&
        parameters[0].vst3MidiMappings[0].busIndex === 0 &&
        parameters[0].vst3MidiMappings[0].channel === 0 &&
        parameters[0].vst3MidiMappings[0].controller === 1 &&
        parameters[1].programChange === true &&
        parameters[1].programList?.programDataSupported === false &&
        parameters[1].programList?.programs?.[0]?.index === 1 &&
        parameters[1].programList?.programs?.[0]?.name === "Program 2" &&
        parameters[1].programList?.programs?.[0]?.nameFallback === true &&
        parameters[2].id === "program-empty-list" &&
        parameters[2].programChange === true &&
        !Object.hasOwn(parameters[2], "programList"),
      "native VST3 workers normalize partial/weird parameter metadata"
    );

    const programLists = await metadataWorker.getVst3ProgramLists();
    check(
      programLists.length === 1 &&
        programLists[0].id === 2147483647 &&
        programLists[0].name === "Programs" &&
        programLists[0].nameFallback === true &&
        !Object.hasOwn(programLists[0], "unitId") &&
        programLists[0].programDataSupported === true &&
        programLists[0].programs?.[0]?.index === 0 &&
        programLists[0].programs?.[0]?.name === "Program 1" &&
        programLists[0].programs?.[0]?.nameFallback === true &&
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
        noteExpressions[0].nameFallback === true &&
        noteExpressions[0].shortName === "txt" &&
        noteExpressions[0].defaultValue === 0.75 &&
        noteExpressions[0].minValue === 0.75 &&
        noteExpressions[0].maxValue === 0.75 &&
        noteExpressions[0].busIndex === 31 &&
        noteExpressions[0].channel === 15 &&
        !Object.hasOwn(noteExpressions[0], "unitId") &&
        !Object.hasOwn(noteExpressions[0], "associatedParameterId") &&
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

function writeVst3MidiControllerMappingNativeWorker(tempDir) {
  return writeExecutable(
    tempDir,
    "vst3-midi-controller-mapping-native-worker.mjs",
    `#!/usr/bin/env node
const expectedCommands = new Set([
  "midi cc:74:0.25:2:3:bus=1;bend:-0.5:2:4:bus=1;pressure:0.75:2:5:bus=1;program:7:2:6:bus=1",
  "midi cc:1:0.4:0:0;bend:0.1:0:1;pressure:0.3:0:2;program:2:0:3",
  "midi cc:0:0:0:0:bus=0;cc:127:1:15:7:bus=31;bend:-1:0:1:bus=0;bend:1:15:6:bus=31;pressure:0:0:2:bus=0;pressure:1:15:5:bus=31;program:0:0:3:bus=0;program:127:15:4:bus=31"
]);
const mismatchedAckCommands = new Set([
  "midi cc:2:0.5:0:0"
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
        ? { ok: true, eventCount: line.slice(5).split(";").length }
        : mismatchedAckCommands.has(line)
          ? { ok: true, eventCount: 0 }
        : { error: "bad_mapped_midi_controller_events" }
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
        vst3Unit: { id: "not-an-int", name: "bad" },
        vst3MidiMappings: [
          { busIndex: 0, channel: 0, controller: 1 },
          { busIndex: 99, channel: 0, controller: 1 },
          { busIndex: 0, channel: 99, controller: 1 },
          { busIndex: 0, channel: 0, controller: 999 }
        ]
      },
      {
        id: "program",
        name: "Program",
        normalizedValue: 0.3,
        programChange: true,
        programList: {
          id: 9,
          name: "",
          programDataSupported: false,
          programs: [
            { index: "bad", name: "broken", normalizedValue: 0.5 },
            { name: "", normalizedValue: 2, nameFallback: true }
          ]
        }
      },
      {
        id: "program-empty-list",
        name: "Program Empty List",
        normalizedValue: 0.8,
        programChange: true,
        programList: {
          id: 10,
          name: "Empty Program List",
          programDataSupported: true,
          programs: []
        }
      }
    ]
  },
  programLists: {
    vst3ProgramLists: [
      { id: "bad", programs: [{ index: 0 }] },
      { id: -1, programs: [{ index: 0, name: "Sentinel", normalizedValue: 0 }] },
      {
        id: 2147483647,
        name: "",
        nameFallback: true,
        unitId: "bad",
        programDataSupported: true,
        programs: [
          { name: "", normalizedValue: 2, nameFallback: true },
          { index: -5, name: "broken", normalizedValue: 0.5 },
          { index: 255, name: null, normalizedValue: -1 }
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
        nameFallback: true,
        shortName: "txt",
        unit: "",
        defaultValue: 2,
        minValue: 0.75,
        maxValue: -1,
        stepCount: -1,
        busIndex: 99,
        channel: 99,
        unitId: 9999999999,
        associatedParameterId: 4294967295,
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
