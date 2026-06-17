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
    const multiAuxRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0, 0], [0, 0]],
      inputBuses: [
        { index: 0, channels: [[0.1, 0.1], [0.2, 0.2]] },
        { index: 1, channels: [[0.3, 0.4]] },
        { index: 2, channels: [[0.5, 0.6], [0.7, 0.8]] }
      ],
      transport: { samplePosition: 112 }
    });
    const multiAuxBuses = new Map((multiAuxRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      multiAuxRendered.outputBuses?.length === 4 &&
        JSON.stringify(multiAuxRendered.channels) === JSON.stringify([[0.8, 1], [0.7, 0.8]]) &&
        JSON.stringify(multiAuxBuses.get(0)) === JSON.stringify(multiAuxRendered.channels) &&
        JSON.stringify(multiAuxBuses.get(1)) === JSON.stringify([[0.3, 0.4]]) &&
        JSON.stringify(multiAuxBuses.get(2)) === JSON.stringify([[-0.5, -0.6]]) &&
        JSON.stringify(multiAuxBuses.get(4)) === JSON.stringify([[0.5, 0.6], [0.7, 0.8]]),
      "native VST3 workers preserve multiple aux input and nonsequential output buses"
    );
    const outOfOrderMainRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0, 0], [0, 0]],
      transport: { samplePosition: 168 }
    });
    check(
      outOfOrderMainRendered.outputBuses?.length === 3 &&
        outOfOrderMainRendered.outputBuses[0]?.index === 0 &&
        outOfOrderMainRendered.outputBuses[1]?.index === 1 &&
        outOfOrderMainRendered.outputBuses[2]?.index === 2 &&
        JSON.stringify(outOfOrderMainRendered.channels) === JSON.stringify([[0.2, 0.4], [0.6, 0.8]]) &&
        JSON.stringify(outOfOrderMainRendered.outputBuses[0].channels) === JSON.stringify(outOfOrderMainRendered.channels) &&
        JSON.stringify(outOfOrderMainRendered.outputBuses[1].channels) === JSON.stringify([[0.1, 0.3]]) &&
        JSON.stringify(outOfOrderMainRendered.outputBuses[2].channels) === JSON.stringify([[-0.1, -0.3]]),
      "native VST3 workers pin out-of-order main output buses to legacy channels"
    );
    const sparseAuxRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0, 0], [0, 0]],
      inputBuses: [
        { index: 3, channels: [[0.9, 0.7]] },
        { index: 0, channels: [[0.05, 0.15], [0.25, 0.35]] }
      ],
      transport: { samplePosition: 120 }
    });
    const sparseAuxBuses = new Map((sparseAuxRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      sparseAuxRendered.outputBuses?.length === 3 &&
        JSON.stringify(sparseAuxRendered.channels) === JSON.stringify([[0.95, 0.85], [0.25, 0.35]]) &&
        JSON.stringify(sparseAuxBuses.get(0)) === JSON.stringify(sparseAuxRendered.channels) &&
        JSON.stringify(sparseAuxBuses.get(1)) === JSON.stringify([[0.9, 0.7]]) &&
        JSON.stringify(sparseAuxBuses.get(4)) === JSON.stringify([[-0.9, -0.7]]),
      "native VST3 workers sort sparse aux input buses by explicit index"
    );
    const boundedInputRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0, 0], [0, 0]],
      inputBuses: [
        null,
        ["bad"],
        { index: 1, channels: [[0.2, 0.2]] },
        { index: "1", channels: [[0.9, 0.9]] },
        { index: 99, channels: [[0.4, 0.5]] },
        { index: -7, channels: [[0.1, 0.1], [0.3, 0.3]] }
      ],
      transport: { samplePosition: 160 }
    });
    const boundedInputBuses = new Map((boundedInputRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      boundedInputRendered.outputBuses?.length === 3 &&
        JSON.stringify(boundedInputRendered.channels) === JSON.stringify([[0.3, 0.3], [0.3, 0.3]]) &&
        JSON.stringify(boundedInputBuses.get(0)) === JSON.stringify(boundedInputRendered.channels) &&
        JSON.stringify(boundedInputBuses.get(1)) === JSON.stringify([[0.2, 0.2]]) &&
        JSON.stringify(boundedInputBuses.get(31)) === JSON.stringify([[0.4, 0.5]]),
      "native VST3 workers bound malformed duplicate input buses before IPC"
    );
    const inactiveOutputRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0.25, 0.5], [0.75, 1]],
      transport: { samplePosition: 152 }
    });
    const inactiveOutputBuses = new Map((inactiveOutputRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      inactiveOutputRendered.outputBuses?.length === 2 &&
        JSON.stringify(inactiveOutputBuses.get(0)) === JSON.stringify(inactiveOutputRendered.channels) &&
        JSON.stringify(inactiveOutputBuses.get(3)) === JSON.stringify([[1, -1]]),
      "native VST3 workers bound inactive output buses without disturbing the main output"
    );
    const weirdRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0.9, -0.9]],
      transport: { samplePosition: 128 }
    });
    const weirdBuses = new Map((weirdRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      JSON.stringify(weirdRendered.channels) === JSON.stringify([[1, -1], [0, 0.25]]) &&
        weirdRendered.outputBuses?.length === 4 &&
        JSON.stringify(weirdBuses.get(0)) === JSON.stringify(weirdRendered.channels) &&
        JSON.stringify(weirdBuses.get(1)) === JSON.stringify([[0, 0.5]]) &&
        JSON.stringify(weirdBuses.get(2)) === JSON.stringify([[1, -1]]) &&
        JSON.stringify(weirdBuses.get(31)) === JSON.stringify([[-0.2, -0.4]]),
      "native VST3 workers normalize weird output-bus render responses"
    );
    const duplicateRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0.2, 0.2], [0.4, 0.4]],
      transport: { samplePosition: 144 }
    });
    const duplicateBuses = new Map((duplicateRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      duplicateRendered.outputBuses?.length === 3 &&
        JSON.stringify(duplicateBuses.get(0)) === JSON.stringify(duplicateRendered.channels) &&
        JSON.stringify(duplicateBuses.get(1)) === JSON.stringify([[0.1, 0.2]]) &&
        JSON.stringify(duplicateBuses.get(31)) === JSON.stringify([[0.3, 0.4]]),
      "native VST3 workers keep first normalized duplicate output bus"
    );
    const auxOnlyRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0.6, 0.4], [0.2, 0]],
      transport: { samplePosition: 176 }
    });
    const auxOnlyBuses = new Map((auxOnlyRendered.outputBuses ?? []).map((bus) => [bus.index, bus.channels]));
    check(
      auxOnlyRendered.outputBuses?.length === 3 &&
        JSON.stringify(auxOnlyRendered.channels) === JSON.stringify([[0.6, 0.4], [0.2, 0]]) &&
        JSON.stringify(auxOnlyBuses.get(0)) === JSON.stringify(auxOnlyRendered.channels) &&
        JSON.stringify(auxOnlyBuses.get(1)) === JSON.stringify([[0.7, 0.8]]) &&
        JSON.stringify(auxOnlyBuses.get(4)) === JSON.stringify([[0.3, 0.2], [0.1, 0]]),
      "native VST3 workers synthesize main output buses when workers return only aux buses"
    );
    const legacyBusRendered = await busWorker.render({
      frames: 2,
      sampleRate: 48000,
      channels: [[0.4, 0.2], [0.1, 0]],
      transport: { samplePosition: 136 }
    });
    check(
      JSON.stringify(legacyBusRendered.channels) === JSON.stringify([[0.4, 0.2], [0.1, 0]]) &&
        legacyBusRendered.outputBuses?.length === 1 &&
        legacyBusRendered.outputBuses[0]?.index === 0 &&
        JSON.stringify(legacyBusRendered.outputBuses[0].channels) === JSON.stringify(legacyBusRendered.channels),
      "native VST3 workers synthesize main output buses for legacy render responses"
    );
  } finally {
    busWorker.destroy();
  }
}

export function writeVst3MultiBusNativeWorkerIpcFixtures({ tempDir }) {
  return {
    multiBusNativeWorkerPath: writeVst3MultiBusNativeWorker(tempDir)
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
      inputBuses: 3,
      outputBuses: 4,
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
        },
        {
          index: 2,
          direction: "input",
          mediaType: "audio",
          name: "Aux Input 2",
          type: "aux",
          channels: 2,
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
        },
        {
          index: 3,
          direction: "output",
          mediaType: "audio",
          name: "Inactive Aux Output",
          type: "aux",
          channels: 1,
          active: false
        },
        {
          index: 4,
          direction: "output",
          mediaType: "audio",
          name: "Aux Output 2",
          type: "aux",
          channels: 2,
          active: true
        }
      ],
      sampleRate: 48000,
      maxBlockSize: 2
    }
  };
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

    const multiAuxLegacyChannels = [[0, 0], [0, 0]];
    const multiAuxInputBuses = [
      { index: 0, channels: [[0.1, 0.1], [0.2, 0.2]] },
      { index: 1, channels: [[0.3, 0.4]] },
      { index: 2, channels: [[0.5, 0.6], [0.7, 0.8]] }
    ];
    const multiAuxRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[5] === "sample=112" &&
      JSON.stringify(channels) === JSON.stringify(multiAuxLegacyChannels) &&
      JSON.stringify(inputBuses) === JSON.stringify(multiAuxInputBuses);
    if (multiAuxRequestMatched) {
      const multiAuxMainOutput = [[0.8, 1], [0.7, 0.8]];
      process.stdout.write(JSON.stringify({
        channels: multiAuxMainOutput,
        outputBuses: [
          { index: 4, channels: [[0.5, 0.6], [0.7, 0.8]] },
          { index: 1, channels: [[0.3, 0.4]] },
          { index: 0, channels: multiAuxMainOutput },
          { index: 2, channels: [[-0.5, -0.6]] }
        ]
      }) + "\\n");
      continue;
    }

    const outOfOrderMainRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[4] === "-" &&
      parts[5] === "sample=168" &&
      JSON.stringify(channels) === JSON.stringify([[0, 0], [0, 0]]);
    if (outOfOrderMainRequestMatched) {
      const outOfOrderMainOutput = [[0.2, 0.4], [0.6, 0.8]];
      process.stdout.write(JSON.stringify({
        channels: outOfOrderMainOutput,
        outputBuses: [
          { index: 2, channels: [[-0.1, -0.3]] },
          { index: 0, channels: [[0.9, 0.9], [0.7, 0.7]] },
          { index: 1, channels: [[0.1, 0.3]] }
        ]
      }) + "\\n");
      continue;
    }

    const sparseAuxLegacyChannels = [[0, 0], [0, 0]];
    const sparseAuxInputBuses = [
      { index: 0, channels: [[0.05, 0.15], [0.25, 0.35]] },
      { index: 3, channels: [[0.9, 0.7]] }
    ];
    const sparseAuxRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[5] === "sample=120" &&
      JSON.stringify(channels) === JSON.stringify(sparseAuxLegacyChannels) &&
      JSON.stringify(inputBuses) === JSON.stringify(sparseAuxInputBuses);
    if (sparseAuxRequestMatched) {
      const sparseAuxMainOutput = [[0.95, 0.85], [0.25, 0.35]];
      process.stdout.write(JSON.stringify({
        channels: sparseAuxMainOutput,
        outputBuses: [
          { index: 4, channels: [[-0.9, -0.7]] },
          { index: 1, channels: [[0.9, 0.7]] },
          { index: 0, channels: sparseAuxMainOutput }
        ]
      }) + "\\n");
      continue;
    }

    const boundedInputBuses = [
      { index: 0, channels: [[0.1, 0.1], [0.3, 0.3]] },
      { index: 1, channels: [[0.2, 0.2]] },
      { index: 31, channels: [[0.4, 0.5]] }
    ];
    const boundedInputRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[5] === "sample=160" &&
      JSON.stringify(channels) === JSON.stringify([[0, 0], [0, 0]]) &&
      JSON.stringify(inputBuses) === JSON.stringify(boundedInputBuses);
    if (boundedInputRequestMatched) {
      const boundedInputMainOutput = [[0.3, 0.3], [0.3, 0.3]];
      process.stdout.write(JSON.stringify({
        channels: boundedInputMainOutput,
        outputBuses: [
          { index: 0, channels: boundedInputMainOutput },
          { index: 1, channels: [[0.2, 0.2]] },
          { index: 31, channels: [[0.4, 0.5]] }
        ]
      }) + "\\n");
      continue;
    }

    const inactiveOutputBusRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[4] === "-" &&
      parts[5] === "sample=152";
    if (inactiveOutputBusRequestMatched) {
      const inactiveMainOutput = [[0.25, 0.5], [0.75, 1]];
      process.stdout.write(JSON.stringify({
        channels: inactiveMainOutput,
        outputBuses: [
          { index: 3, channels: [[1.5, -1.5], [0.5, 0.5]] },
          { index: 0, channels: [[-0.25, -0.5], [-0.75, -1]] }
        ]
      }) + "\\n");
      continue;
    }

    const weirdRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[4] === "-" &&
      parts[5] === "sample=128";
    if (weirdRequestMatched) {
      process.stdout.write(JSON.stringify({
        channels: [[2, -2, 0.5], ["bad", 0.25], [0.5, 0.5]],
        outputBuses: [
          { index: 2, channels: [[1.5, -1.5, 0.25]] },
          null,
          { index: 1, channels: [["bad", 0.5], [0.1, 0.2]] },
          { index: 0, channels: [[0, 0]] },
          { index: 99, channels: [[-0.2, -0.4]] }
        ]
      }) + "\\n");
      continue;
    }

    const duplicateOutputBusRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[4] === "-" &&
      parts[5] === "sample=144";
    if (duplicateOutputBusRequestMatched) {
      process.stdout.write(JSON.stringify({
        channels,
        outputBuses: [
          { index: 1, channels: [[0.1, 0.2]] },
          { index: 1, channels: [[0.9, 0.9]] },
          { index: 31, channels: [[0.3, 0.4]] },
          { index: 99, channels: [[0.8, 0.8]] },
          { index: 0, channels: [[0.5, 0.5], [0.6, 0.6]] }
        ]
      }) + "\\n");
      continue;
    }

    const auxOnlyOutputBusRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[4] === "-" &&
      parts[5] === "sample=176" &&
      JSON.stringify(channels) === JSON.stringify([[0.6, 0.4], [0.2, 0]]);
    if (auxOnlyOutputBusRequestMatched) {
      process.stdout.write(JSON.stringify({
        channels,
        outputBuses: [
          { index: 4, channels: [[0.3, 0.2], [0.1, 0]] },
          { index: 1, channels: [[0.7, 0.8]] }
        ]
      }) + "\\n");
      continue;
    }

    const legacyOutputBusRequestMatched = frames === 2 &&
      Number(parts[2]) === 48000 &&
      parts[4] === "-" &&
      parts[5] === "sample=136" &&
      JSON.stringify(channels) === JSON.stringify([[0.4, 0.2], [0.1, 0]]);
    if (legacyOutputBusRequestMatched) {
      process.stdout.write(JSON.stringify({ channels }) + "\\n");
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
