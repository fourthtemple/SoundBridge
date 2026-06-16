import fs from "node:fs";
import path from "node:path";

export async function exerciseGrantAwareNativeWorker({
  check,
  createTestWorkers,
  fixtureGrantPath,
  nativeWorkerInstance,
  tempDir,
  workerPath
}) {
  const grantWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096
  });
  const grantWorker = new grantWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await grantWorker.ready;
  const grantWorkerResult = await grantWorker.useFileGrant({
    operation: "loadSample",
    grant: {
      grantId: "filegrant-test",
      purpose: "sample",
      access: "read",
      kind: "file",
      displayName: "Fixture Grant.wav",
      absolutePath: fixtureGrantPath
    }
  });
  check(
    grantWorkerResult.applied === true && grantWorkerResult.status === "grant-ok",
    "native host workers encode bounded file grant commands"
  );
  const stateDirectoryGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "saveStateDirectory",
    grant: {
      grantId: "filegrant-state-dir",
      purpose: "state",
      access: "readWrite",
      kind: "directory",
      displayName: "Fixture Grants",
      absolutePath: tempDir
    }
  });
  check(
    stateDirectoryGrantWorkerResult.applied === true && stateDirectoryGrantWorkerResult.status === "state-dir-ok",
    "native host workers encode bounded directory file grant commands"
  );
  const parameterWorker = new grantWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await parameterWorker.ready;
  const spacedParameter = await parameterWorker.setParameter("gain amount", 0.25, 7);
  check(
    spacedParameter?.id === "gain amount" &&
      Math.abs(spacedParameter.normalizedValue - 0.25) < 0.000001 &&
      spacedParameter.displayValue === "offset-ok",
    "native host workers encode bounded parameter id commands"
  );
  parameterWorker.destroy();
  const textWorker = new grantWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    nativeWorkerInstance()
  );
  await textWorker.ready;
  const textParameter = await textWorker.setParameterDisplayValue("42", "0.0 dB");
  check(
    textParameter?.id === "42" &&
      textParameter.displayValue === "0.0 dB" &&
      Math.abs(textParameter.normalizedValue - 0.5) < 0.000001,
    "native host workers encode bounded parameter display text commands"
  );
  textWorker.destroy();
  grantWorker.destroy();
}

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
    vst3MidiControllerMappingInstance()
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

export function writeNativeWorkerIpcFixtures({ tempDir, fixtureGrantPath }) {
  return {
    exampleWorkerPath: writeExecutable(
      tempDir,
      "oversized-example-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("x".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    nativeWorkerPath: writeExecutable(
      tempDir,
      "oversized-native-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("y".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    exampleStderrWorkerPath: writeExecutable(
      tempDir,
      "oversized-example-stderr-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("e".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    nativeStderrWorkerPath: writeExecutable(
      tempDir,
      "oversized-native-stderr-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("n".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    exampleStderrBudgetWorkerPath: writeExecutable(
      tempDir,
      "stderr-budget-example-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write(" ".repeat(40) + "\\n" + " ".repeat(40) + "\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    nativeStderrBudgetWorkerPath: writeExecutable(
      tempDir,
      "stderr-budget-native-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write(" ".repeat(40) + "\\n" + " ".repeat(40) + "\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    diagnosticControlWorkerPath: writeExecutable(
      tempDir,
      "diagnostic-control-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let handled = false;
process.stdin.on("data", () => {
  if (handled) {
    return;
  }
  handled = true;
  process.stderr.write("\\u001b[31mwarning\\rfake\\x7f\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ channels: [[0]] }) + "\\n");
  }, 10);
});
setTimeout(() => {}, 30000);
`
    ),
    malformedExampleWorkerPath: writeExecutable(
      tempDir,
      "malformed-example-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("not-json\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    malformedNativeReadyWorkerPath: writeExecutable(
      tempDir,
      "malformed-native-ready-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write("not-json\\n");
setTimeout(() => {}, 30000);
`
    ),
    invalidNativeReadyWorkerPath: writeExecutable(
      tempDir,
      "invalid-native-ready-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: false, error: "bad-ready" }) + "\\n");
setTimeout(() => {}, 30000);
`
    ),
    malformedNativeCommandWorkerPath: writeExecutable(
      tempDir,
      "malformed-native-command-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("not-json\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    unsolicitedExampleWorkerPath: writeExecutable(
      tempDir,
      "unsolicited-example-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
setTimeout(() => {}, 30000);
`
    ),
    unsolicitedNativeWorkerPath: writeExecutable(
      tempDir,
      "unsolicited-native-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
setTimeout(() => {}, 30000);
`
    ),
    hangingNativeWorkerPath: writeExecutable(
      tempDir,
      "hanging-native-worker.mjs",
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    hangingExampleCommandWorkerPath: writeExecutable(
      tempDir,
      "hanging-example-command-worker.mjs",
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    hangingNativeCommandWorkerPath: writeExecutable(
      tempDir,
      "hanging-native-command-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    stubbornExampleCommandWorkerPath: writeExecutable(
      tempDir,
      "stubborn-example-command-worker.mjs",
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    stubbornNativeCommandWorkerPath: writeExecutable(
      tempDir,
      "stubborn-native-command-worker.mjs",
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    grantAwareNativeWorkerPath: writeGrantAwareNativeWorker(tempDir, fixtureGrantPath),
    midiControllerMappingNativeWorkerPath: writeVst3MidiControllerMappingNativeWorker(tempDir),
    multiBusNativeWorkerPath: writeVst3MultiBusNativeWorker(tempDir)
  };
}

function vst3MidiControllerMappingInstance() {
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

function writeGrantAwareNativeWorker(tempDir, fixtureGrantPath) {
  return writeExecutable(
    tempDir,
    "grant-aware-native-worker.mjs",
    `#!/usr/bin/env node
const expectedFilePath = ${JSON.stringify(fixtureGrantPath)};
const expectedDirectoryPath = ${JSON.stringify(tempDir)};
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
    const parts = line.split(" ");
    const workerText = (token) => Buffer.from(token === "-" ? "" : token, "base64").toString("utf8");
    if (parts[0] === "setParameter") {
      const parameterId = workerText(parts[1]);
      process.stdout.write(JSON.stringify({
        parameter: {
          id: parameterId,
          normalizedValue: Number(parts[2]),
          displayValue: parts[3] === "7" ? "offset-ok" : "offset-missing"
        }
      }) + "\\n");
      continue;
    }
    if (parts[0] === "setParameterDisplayValue") {
      const parameterId = workerText(parts[1]);
      const displayValue = workerText(parts[2]);
      process.stdout.write(JSON.stringify({
        parameter: {
          id: parameterId,
          normalizedValue: displayValue === "0.0 dB" ? 0.5 : 0,
          displayValue
        }
      }) + "\\n");
      continue;
    }
    if (parts[0] !== "fileGrant") {
      process.stdout.write(JSON.stringify({ error: "unknown_command" }) + "\\n");
      continue;
    }
    const displayName = workerText(parts[6]);
    const absolutePath = workerText(parts[7]);
    const sampleApplied = parts[1] === "loadSample" &&
      parts[2] === "sample" &&
      parts[3] === "read" &&
      parts[4] === "file" &&
      parts[5] === "filegrant-test" &&
      displayName === "Fixture Grant.wav" &&
      absolutePath === expectedFilePath;
    const stateDirectoryApplied = parts[1] === "saveStateDirectory" &&
      parts[2] === "state" &&
      parts[3] === "readWrite" &&
      parts[4] === "directory" &&
      parts[5] === "filegrant-state-dir" &&
      displayName === "Fixture Grants" &&
      absolutePath === expectedDirectoryPath;
    process.stdout.write(JSON.stringify({
      applied: sampleApplied || stateDirectoryApplied,
      status: stateDirectoryApplied ? "state-dir-ok" : "grant-ok"
    }) + "\\n");
  }
});
setTimeout(() => {}, 30000);
`
  );
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
