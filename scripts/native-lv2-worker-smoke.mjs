import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LV2_FIXTURE_BUNDLE = "native/example-plugins/LV2/soundbridge-example-gain.lv2";
const LV2_BLOCK_PROFILE_BUNDLE = "native/example-plugins/LV2/soundbridge-block-profile-gain.lv2";

export async function runNativeLv2WorkerSmoke({ nativeRenderer, assert, assertLayoutReport }) {
  const worker = spawn(
    nativeRenderer,
    ["--host-lv2-worker", LV2_FIXTURE_BUNDLE, "48000", "128", "2", "2", "effect"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.warn(`LV2 worker stderr: ${message}`);
    }
  });

  const lines = [];
  let buffer = "";
  let waiter;
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        lines.push(line);
      }
      if (waiter) {
        const current = waiter;
        waiter = undefined;
        current();
      }
    }
  });

  const readJsonLine = async () => {
    const started = Date.now();
    while (lines.length === 0) {
      if (Date.now() - started > 5000) {
        throw new Error("LV2 worker timed out");
      }
      await new Promise((resolve) => {
        waiter = resolve;
        setTimeout(resolve, 25);
      });
    }
    return JSON.parse(lines.shift());
  };

  const requestWorker = async (command) => {
    worker.stdin.write(`${command}\n`, "utf8");
    const response = await readJsonLine();
    if (response.error) {
      throw new Error(response.error);
    }
    return response;
  };

  try {
    const ready = await readJsonLine();
    assert(ready.ok === true && ready.ready === true, "native LV2 worker reports ready");
    const gainParameter = workerText("gain");
    const modeParameter = workerText("mode");

    const parameters = await requestWorker("parameters");
    const gain = parameters.parameters?.find((parameter) => parameter.id === "gain");
    assert(gain?.automatable === true, "native LV2 worker exposes control ports as bounded parameters");
    const mode = parameters.parameters?.find((parameter) => parameter.id === "mode");
    assert(
      mode?.stepCount === 3 && mode.plainValue === 0 && Math.abs(mode.defaultNormalizedValue) < 0.000001,
      "native LV2 worker exposes integer/enumeration control metadata"
    );

    const layout = await requestWorker("layout");
    assertLayoutReport(layout, 2, 2, 48000, 128, "native LV2 worker reports layout");
    assert(
      layout.inputBuses === 1 &&
        layout.inputBusLayouts[0]?.index === 0 &&
        layout.inputBusLayouts[0]?.channels === 2 &&
        layout.inputBusLayouts[0]?.type === "main" &&
        layout.outputBuses === 1 &&
        layout.outputBusLayouts[0]?.index === 0 &&
        layout.outputBusLayouts[0]?.channels === 2 &&
        layout.outputBusLayouts[0]?.type === "main",
      "native LV2 worker honors declared LV2 port-groups as grouped main buses"
    );

    const set = await requestWorker(`setParameter ${gainParameter} 0.75 0`);
    assert(
      set.parameter?.id === "gain" && Math.abs(set.parameter.normalizedValue - 0.75) < 0.000001,
      "native LV2 worker updates a control port"
    );
    const modeSet = await requestWorker(`setParameter ${modeParameter} 0.6 0`);
    assert(
      modeSet.parameter?.id === "mode" &&
        modeSet.parameter.stepCount === 3 &&
        modeSet.parameter.plainValue === 2 &&
        Math.abs(modeSet.parameter.normalizedValue - 2 / 3) < 0.000001,
      "native LV2 worker rounds integer/enumeration control writes"
    );

    const savedState = await requestWorker("getState");
    assert(typeof savedState.state === "string" && savedState.state.length > 0, "native LV2 worker returns bounded control state");
    await requestWorker(`setParameter ${gainParameter} 0.1 0`);
    await requestWorker(`setParameter ${modeParameter} 0 0`);
    await requestWorker(`setState ${savedState.state}`);
    const restoredParameters = await requestWorker("parameters");
    const restoredGain = restoredParameters.parameters?.find((parameter) => parameter.id === "gain");
    const restoredMode = restoredParameters.parameters?.find((parameter) => parameter.id === "mode");
    assert(
      restoredGain &&
        Math.abs(restoredGain.normalizedValue - 0.75) < 0.000001 &&
        restoredMode?.plainValue === 2 &&
        Math.abs(restoredMode.normalizedValue - 2 / 3) < 0.000001,
      "native LV2 worker restores bounded control state"
    );

    const presetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "soundbridge-lv2-preset-"));
    try {
      const presetPath = path.join(presetDirectory, "Gain Snapshot.preset");
      fs.writeFileSync(presetPath, `${savedState.state}\n`, "utf8");
      await requestWorker(`setParameter ${gainParameter} 0.1 0`);
      await requestWorker(`setParameter ${modeParameter} 0 0`);
      const loadedPreset = await requestWorker(
        `fileGrant loadPreset preset read file filegrant-lv2-preset ${workerText("Gain Snapshot.preset")} ${workerText(presetPath)}`
      );
      assert(loadedPreset.applied === true && loadedPreset.status === "preset-loaded", "native LV2 worker loads preset grants");
      const presetParameters = await requestWorker("parameters");
      const presetGain = presetParameters.parameters?.find((parameter) => parameter.id === "gain");
      const presetMode = presetParameters.parameters?.find((parameter) => parameter.id === "mode");
      assert(
        presetGain &&
          Math.abs(presetGain.normalizedValue - 0.75) < 0.000001 &&
          presetMode?.plainValue === 2,
        "native LV2 worker applies bounded preset-state snapshots"
      );
    } finally {
      fs.rmSync(presetDirectory, { force: true, recursive: true });
    }

    const rendered = await requestWorker("render 4 48000 0.1,0.2,0.3,0.4|0.1,0.1,0.1,0.1");
    assert(rendered.channels?.length === 2, "native LV2 worker rendered stereo output");
    assert(
      Array.isArray(rendered.outputBuses) &&
        rendered.outputBuses.length === layout.outputBuses &&
        rendered.outputBuses[0]?.index === 0 &&
        JSON.stringify(rendered.outputBuses[0].channels) === JSON.stringify(rendered.channels),
      "native LV2 worker returns grouped main output bus audio"
    );
    assert(Math.abs(rendered.channels[0][0] - 0.15) < 0.00001, "native LV2 worker processed audio through the plugin");

    const busRendered = await requestWorker("render 4 48000 0,0,0,0|0,0,0,0 0=0.2,0.2,0.2,0.2|0.2,0.2,0.2,0.2");
    assert(
      Math.abs(busRendered.channels[0][0] - 0.3) < 0.00001 &&
        JSON.stringify(busRendered.outputBuses?.[0]?.channels) === JSON.stringify(busRendered.channels),
      "native LV2 worker renders explicit main input bus audio"
    );

    worker.stdin.write("render 4 48000 - malformed-bus-token -\n", "utf8");
    const invalidBusToken = await readJsonLine();
    assert(invalidBusToken.error === "invalid_render_arguments", "native LV2 worker rejects malformed input bus framing");

    worker.stdin.write("render 4 48000 - 0=0.1,0.1,0.1,0.1;0=0.2,0.2,0.2,0.2 -\n", "utf8");
    const duplicateBusIndex = await readJsonLine();
    assert(duplicateBusIndex.error === "invalid_render_arguments", "native LV2 worker rejects duplicate input bus indexes");

    const transported = await requestWorker(
      "render 4 48000 0.1,0.1,0.1,0.1|0.1,0.1,0.1,0.1 - playing=1,tempo=118,num=4,den=4,ppq=32,bar=32,sample=960000"
    );
    assert(transported.channels?.length === 2, "native LV2 worker accepts bounded host transport position");

    const offsetSet = await requestWorker(`setParameter ${gainParameter} 0.25 2`);
    assert(
      offsetSet.parameter?.id === "gain" && Math.abs(offsetSet.parameter.normalizedValue - 0.25) < 0.000001,
      "native LV2 worker accepts parameter events with sample offsets"
    );
    const automated = await requestWorker("render 4 48000 0.2,0.2,0.2,0.2|0.2,0.2,0.2,0.2");
    assert(
      Math.abs(automated.channels[0][0] - 0.3) < 0.00001 &&
        Math.abs(automated.channels[0][1] - 0.3) < 0.00001 &&
        Math.abs(automated.channels[0][2] - 0.1) < 0.00001 &&
        Math.abs(automated.channels[0][3] - 0.1) < 0.00001,
      "native LV2 worker applies queued parameter changes at the requested offset"
    );

    const latency = await requestWorker("latency");
    assert(latency.latencySamples === 17, "native LV2 worker reports bounded latency output ports");
    const tail = await requestWorker("tail");
    assert(tail.tailSamples === 0 && tail.infiniteTail === false, "native LV2 worker reports conservative tail time");

    const midi = await requestWorker("midi on:60:0.8:0:0;cc:1:0.5:0:1;bend:0.1:0:2;pressure:0.4:0:3;poly:60:0.2:0:3;program:2:0:3");
    assert(midi.eventCount === 6, "native LV2 worker queues richer bounded MIDI batches");

    await requestWorker(`setParameter ${gainParameter} 0.5 0`);
    const midiVolume = await requestWorker("midi cc:7:0.25:0:0");
    assert(midiVolume.eventCount === 1, "native LV2 worker queues MIDI for atom ports");
    const midiRendered = await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    assert(
      Math.abs(midiRendered.channels[0][0] - 0.4 * (32 / 127)) < 0.02,
      "native LV2 worker delivers MIDI CC to atom MIDI ports"
    );
    const extensionState = await requestWorker("getState");
    await requestWorker("midi cc:7:1:0:0");
    await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    await requestWorker(`setState ${extensionState.state}`);
    const restoredExtensionState = await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    assert(
      Math.abs(restoredExtensionState.channels[0][0] - 0.4 * (32 / 127)) < 0.02,
      "native LV2 worker restores bounded extension state"
    );

    await requestWorker("midi cc:7:1:0:0");
    await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    assert((await requestWorker("midi cc:8:0.5:0:0")).eventCount === 1, "native LV2 worker queues events that schedule worker work");
    await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    const workerResponded = await requestWorker("render 4 48000 0.4,0.4,0.4,0.4|0.4,0.4,0.4,0.4");
    assert(Math.abs(workerResponded.channels[0][0] - 0.4 * (64 / 127)) < 0.02, "native LV2 worker delivers bounded worker responses after run");

    worker.stdin.write("midi cc:200:0.5:0:0\n", "utf8");
    const invalidMidi = await readJsonLine();
    assert(invalidMidi.error === "invalid_midi_events", "native LV2 worker rejects malformed MIDI batches");
  } finally {
    worker.stdin.write("quit\n");
    worker.stdin.end();
    setTimeout(() => {
      if (!worker.killed) {
        worker.kill();
      }
    }, 250).unref?.();
  }

  const restrictedWorker = spawn(
    nativeRenderer,
    ["--host-lv2-worker", LV2_BLOCK_PROFILE_BUNDLE, "48000", "128", "2", "2", "effect"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  restrictedWorker.stderr.setEncoding("utf8");
  restrictedWorker.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.warn(`LV2 block-profile worker stderr: ${message}`);
    }
  });

  const restrictedLines = [];
  let restrictedBuffer = "";
  let restrictedWaiter;
  restrictedWorker.stdout.setEncoding("utf8");
  restrictedWorker.stdout.on("data", (chunk) => {
    restrictedBuffer += chunk;
    let newline;
    while ((newline = restrictedBuffer.indexOf("\n")) >= 0) {
      const line = restrictedBuffer.slice(0, newline).trim();
      restrictedBuffer = restrictedBuffer.slice(newline + 1);
      if (line) {
        restrictedLines.push(line);
      }
      if (restrictedWaiter) {
        const current = restrictedWaiter;
        restrictedWaiter = undefined;
        current();
      }
    }
  });

  const readRestrictedJsonLine = async () => {
    const started = Date.now();
    while (restrictedLines.length === 0) {
      if (Date.now() - started > 5000) {
        throw new Error("LV2 block-profile worker timed out");
      }
      await new Promise((resolve) => {
        restrictedWaiter = resolve;
        setTimeout(resolve, 25);
      });
    }
    return JSON.parse(restrictedLines.shift());
  };

  const requestRestrictedWorker = async (command) => {
    restrictedWorker.stdin.write(`${command}\n`, "utf8");
    const response = await readRestrictedJsonLine();
    if (response.error) {
      throw new Error(response.error);
    }
    return response;
  };

  try {
    const ready = await readRestrictedJsonLine();
    assert(ready.ok === true && ready.ready === true, "native LV2 block-profile worker reports ready");
    const gainParameter = workerText("gain");
    const fullBlock = new Array(128).fill("0.2").join(",");
    const restrictedRender = await requestRestrictedWorker(`render 128 48000 ${fullBlock}|${fullBlock}`);
    assert(restrictedRender.channels?.[0]?.length === 128, "native LV2 block-profile worker accepts fixed power-of-two blocks");
    const shortBlock = new Array(64).fill("0.2").join(",");
    restrictedWorker.stdin.write(`render 64 48000 ${shortBlock}|${shortBlock}\n`, "utf8");
    const invalidBlock = await readRestrictedJsonLine();
    assert(invalidBlock.error === "invalid_lv2_block_size", "native LV2 block-profile worker rejects short render blocks");
    restrictedWorker.stdin.write(`setParameter ${gainParameter} 0.5 4\n`, "utf8");
    const invalidParameterOffset = await readRestrictedJsonLine();
    assert(
      invalidParameterOffset.error === "lv2_block_profile_requires_block_boundary_parameters",
      "native LV2 block-profile worker rejects mid-block parameter changes"
    );
  } finally {
    restrictedWorker.stdin.write("quit\n");
    restrictedWorker.stdin.end();
    setTimeout(() => {
      if (!restrictedWorker.killed) {
        restrictedWorker.kill();
      }
    }, 250).unref?.();
  }
}

function workerText(value) {
  const text = String(value ?? "");
  return text ? Buffer.from(text, "utf8").toString("base64") : "-";
}
