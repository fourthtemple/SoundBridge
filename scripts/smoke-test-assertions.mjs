import { FILE_GRANT_OPERATION_NAMES, isKnownFileGrantOperation } from "./daemon-file-grant-operations.mjs";

const MAX_PLUGIN_LATENCY_SAMPLES = 1_048_576;
const MAX_PLUGIN_TAIL_SAMPLES = 1_048_576;
const MAX_AUDIO_CHANNELS = 32;
const MAX_PLUGIN_BUSES = 32;
const MAX_PLUGIN_METADATA_BYTES = 256;
const KNOWN_PLUGIN_EDITOR_KINDS = new Set(["generic-parameters", "native-window"]);

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertLatencyReport(latency, transportLatencySamples, message) {
  assert(
    Number.isInteger(latency.pluginLatencySamples) &&
      latency.pluginLatencySamples >= 0 &&
      latency.pluginLatencySamples <= MAX_PLUGIN_LATENCY_SAMPLES,
    `${message}: plugin latency is bounded`
  );
  assert(latency.transportLatencySamples === transportLatencySamples, `${message}: transport latency round-trips`);
  assert(
    latency.reportedLatencySamples ===
      Math.min(latency.pluginLatencySamples + transportLatencySamples, MAX_PLUGIN_LATENCY_SAMPLES),
    `${message}: reported latency is the clamped total`
  );
}

export function assertTailReport(tail, message) {
  assert(
    Number.isInteger(tail.tailSamples) &&
      tail.tailSamples >= 0 &&
      tail.tailSamples <= MAX_PLUGIN_TAIL_SAMPLES,
    `${message}: tail samples are bounded`
  );
  assert(typeof tail.infiniteTail === "boolean", `${message}: infinite tail is explicit`);
}

export function assertLayoutReport(layout, requestedInputChannels, requestedOutputChannels, sampleRate, maxBlockSize, message) {
  assert(layout && typeof layout === "object", `${message}: layout object exists`);
  assert(layout.requestedInputChannels === requestedInputChannels, `${message}: requested input channels round-trip`);
  assert(layout.requestedOutputChannels === requestedOutputChannels, `${message}: requested output channels round-trip`);
  assert(
    Number.isInteger(layout.inputChannels) &&
      layout.inputChannels >= 0 &&
      layout.inputChannels <= MAX_AUDIO_CHANNELS,
    `${message}: input channels are bounded`
  );
  assert(
    Number.isInteger(layout.outputChannels) &&
      layout.outputChannels >= 1 &&
      layout.outputChannels <= MAX_AUDIO_CHANNELS,
    `${message}: output channels are bounded`
  );
  assert(
    Number.isInteger(layout.inputBuses) &&
      layout.inputBuses >= 0 &&
      layout.inputBuses <= MAX_PLUGIN_BUSES,
    `${message}: input bus count is bounded`
  );
  assert(
    Number.isInteger(layout.outputBuses) &&
      layout.outputBuses >= 1 &&
      layout.outputBuses <= MAX_PLUGIN_BUSES,
    `${message}: output bus count is bounded`
  );
  assertBusLayouts(layout.inputBusLayouts, "input", layout.inputBuses, `${message}: input bus layouts`);
  assertBusLayouts(layout.outputBusLayouts, "output", layout.outputBuses, `${message}: output bus layouts`);
  assert(Math.abs(layout.sampleRate - sampleRate) < 0.01, `${message}: sample rate round-trips`);
  assert(layout.maxBlockSize === maxBlockSize, `${message}: max block size round-trips`);
}

export function assertOutputBuses(block, layout, message) {
  assert(Array.isArray(block.outputBuses), `${message}: output bus array exists`);
  assert(block.outputBuses.length === layout.outputBuses, `${message}: output bus count matches layout`);
  const mainBus = block.outputBuses.find((bus) => bus.index === 0);
  assert(mainBus, `${message}: main output bus exists`);
  assert(
    JSON.stringify(mainBus.channels) === JSON.stringify(block.channels),
    `${message}: main output bus mirrors legacy channels`
  );
  for (const bus of block.outputBuses) {
    assert(Number.isInteger(bus.index) && bus.index >= 0 && bus.index < MAX_PLUGIN_BUSES, `${message}: output bus index is bounded`);
    assert(Array.isArray(bus.channels), `${message}: output bus channels are arrays`);
    assert(bus.channels.length <= MAX_AUDIO_CHANNELS, `${message}: output bus channel count is bounded`);
    for (const channel of bus.channels) {
      assert(Array.isArray(channel) && channel.length <= 8192, `${message}: output bus frame count is bounded`);
    }
  }
}

export function assertPublicPluginMetadata(plugin, message) {
  if (plugin.editorKinds != null) {
    assert(
      Array.isArray(plugin.editorKinds) &&
        plugin.editorKinds.length <= KNOWN_PLUGIN_EDITOR_KINDS.size &&
        new Set(plugin.editorKinds).size === plugin.editorKinds.length &&
        plugin.editorKinds.every((kind) => KNOWN_PLUGIN_EDITOR_KINDS.has(kind)),
      `${message}: editorKinds are bounded known editor kinds`
    );
  }
  if (plugin.fileGrantOperations != null) {
    assert(
      Array.isArray(plugin.fileGrantOperations) &&
        plugin.fileGrantOperations.length <= FILE_GRANT_OPERATION_NAMES.length &&
        new Set(plugin.fileGrantOperations).size === plugin.fileGrantOperations.length &&
        plugin.fileGrantOperations.every((operation) => isKnownFileGrantOperation(operation)),
      `${message}: fileGrantOperations are bounded known operations`
    );
  }
  const parameters = Array.isArray(plugin.parameters) ? plugin.parameters : [];
  for (const [index, parameter] of parameters.entries()) {
    if (parameter.displayValue != null) {
      assert(
        typeof parameter.displayValue === "string" &&
          Buffer.byteLength(parameter.displayValue, "utf8") <= 160 &&
          !parameter.displayValue.includes("\u0000"),
        `${message}: parameter ${index} displayValue is bounded`
      );
    }
  }
  const metadata = plugin.metadata;
  if (metadata == null) {
    return;
  }
  assert(typeof metadata === "object" && !Array.isArray(metadata), `${message}: metadata object is bounded`);
  for (const forbidden of ["bundlePath", "executablePath", "path", "diagnostics"]) {
    assert(!(forbidden in metadata), `${message}: ${forbidden} is not public metadata`);
  }
  for (const [key, value] of Object.entries(metadata)) {
    assert(
      typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_PLUGIN_METADATA_BYTES,
      `${message}: ${key} is a bounded string`
    );
  }
}

export function assertSameLayout(actual, expected, message) {
  for (const key of [
    "requestedInputChannels",
    "requestedOutputChannels",
    "inputChannels",
    "outputChannels",
    "inputBuses",
    "outputBuses",
    "sampleRate",
    "maxBlockSize"
  ]) {
    assert(actual[key] === expected[key], `${message}: ${key} matches`);
  }
  assert(
    JSON.stringify(actual.inputBusLayouts) === JSON.stringify(expected.inputBusLayouts),
    `${message}: inputBusLayouts match`
  );
  assert(
    JSON.stringify(actual.outputBusLayouts) === JSON.stringify(expected.outputBusLayouts),
    `${message}: outputBusLayouts match`
  );
}

export function blockHasSignal(channels) {
  return channels.some((channel) => channel.some((sample) => Math.abs(sample) > 0.0001));
}

function assertBusLayouts(buses, direction, expectedCount, message) {
  assert(Array.isArray(buses), `${message}: bus layout array exists`);
  assert(buses.length === expectedCount, `${message}: bus layout count matches aggregate count`);
  for (const [index, bus] of buses.entries()) {
    assert(bus && typeof bus === "object", `${message}: bus ${index} is an object`);
    assert(Number.isInteger(bus.index) && bus.index >= 0 && bus.index < MAX_PLUGIN_BUSES, `${message}: bus ${index} index is bounded`);
    assert(bus.direction === direction, `${message}: bus ${index} direction matches`);
    assert(bus.mediaType === "audio", `${message}: bus ${index} media type is audio`);
    assert(typeof bus.name === "string" && Buffer.byteLength(bus.name, "utf8") <= 160, `${message}: bus ${index} name is bounded`);
    assert(["main", "aux", "unknown"].includes(bus.type), `${message}: bus ${index} type is bounded`);
    assert(
      Number.isInteger(bus.channels) && bus.channels >= 0 && bus.channels <= MAX_AUDIO_CHANNELS,
      `${message}: bus ${index} channels are bounded`
    );
    assert(typeof bus.active === "boolean", `${message}: bus ${index} active flag is explicit`);
  }
}
