export function summarizeProbeBusLayout(plugin, layout) {
  const inputBuses = boundedBusLayouts(layout?.inputBusLayouts);
  const outputBuses = boundedBusLayouts(layout?.outputBusLayouts);
  const inputBusCount = clampInt(layout?.inputBuses, 0, 32, inputBuses.length);
  const outputBusCount = clampInt(layout?.outputBuses, 1, 32, outputBuses.length || 1);
  const inputChannels = clampInt(layout?.inputChannels, 0, 32, 0);
  const outputChannels = clampInt(layout?.outputChannels, 1, 32, 1);
  const kind = knownKind(plugin?.kind);
  const activeInputs = inputBuses.filter(activeAudioBus);
  const activeOutputs = outputBuses.filter(activeAudioBus);
  const inactiveInputs = inputBuses.filter(inactiveAudioBus);
  const inactiveOutputs = outputBuses.filter(inactiveAudioBus);
  const sidechain = activeInputs.some((bus) => bus.index > 0 || bus.type === "aux");
  const multiOutput = outputBusCount > 1 || activeOutputs.some((bus) => bus.index > 0);
  const flags = [];

  if (sidechain) {
    flags.push("sidechain-input");
  }
  if (inputBusCount > (inputChannels > 0 ? 1 : 0)) {
    flags.push("multi-input");
  }
  if (multiOutput) {
    flags.push("multi-output");
  }
  if (kind === "instrument" && multiOutput) {
    flags.push("multi-output-instrument");
  }
  if (hasNonSequentialIndexes(inputBuses) || hasNonSequentialIndexes(outputBuses)) {
    flags.push("nonsequential-bus-indexes");
  }
  if (hasDuplicateIndexes(inputBuses) || hasDuplicateIndexes(outputBuses)) {
    flags.push("duplicate-bus-indexes");
  }
  if (activeInputs.some((bus) => bus.channels === 0) || activeOutputs.some((bus) => bus.channels === 0)) {
    flags.push("active-empty-bus");
  }
  if (inactiveInputs.length > 0) {
    flags.push("inactive-input-bus");
  }
  if (inactiveOutputs.length > 0) {
    flags.push("inactive-output-bus");
  }
  if (inputBuses.some((bus) => bus.type === "unknown") || outputBuses.some((bus) => bus.type === "unknown")) {
    flags.push("unknown-bus-type");
  }
  if (flags.length === 0) {
    flags.push("main-bus");
  }

  return {
    category: busProfileCategory({ kind, multiOutput, sidechain }),
    flags,
    inputChannels,
    outputChannels,
    inputBuses: inputBusCount,
    outputBuses: outputBusCount,
    activeInputBuses: activeInputs.length,
    activeOutputBuses: activeOutputs.length,
    inactiveInputBuses: inactiveInputs.length,
    inactiveOutputBuses: inactiveOutputs.length,
    activeInputBusIndexes: boundedBusIndexes(activeInputs),
    activeOutputBusIndexes: boundedBusIndexes(activeOutputs),
    inactiveInputBusIndexes: boundedBusIndexes(inactiveInputs),
    inactiveOutputBusIndexes: boundedBusIndexes(inactiveOutputs)
  };
}

function boundedBusLayouts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 32).map((bus, fallbackIndex) => ({
    index: clampInt(bus?.index, 0, 31, fallbackIndex),
    channels: clampInt(bus?.channels, 0, 32, 0),
    active: bus?.active === true,
    type: bus?.type === "main" || bus?.type === "aux" || bus?.type === "unknown" ? bus.type : "unknown"
  }));
}

function activeAudioBus(bus) {
  return bus.active === true && bus.channels >= 0;
}

function inactiveAudioBus(bus) {
  return bus.active === false && bus.channels >= 0;
}

function busProfileCategory({ kind, multiOutput, sidechain }) {
  if (kind === "instrument" && multiOutput) {
    return "multi-output-instrument";
  }
  if (sidechain) {
    return "sidechain";
  }
  if (multiOutput) {
    return "multi-output";
  }
  if (kind === "instrument") {
    return "instrument-main";
  }
  if (kind === "effect") {
    return "effect-main";
  }
  return "other-main";
}

function hasNonSequentialIndexes(buses) {
  return buses.some((bus, index) => bus.index !== index);
}

function hasDuplicateIndexes(buses) {
  return new Set(buses.map((bus) => bus.index)).size !== buses.length;
}

function boundedBusIndexes(buses) {
  return [...new Set(buses.map((bus) => bus.index))].sort((left, right) => left - right);
}

function knownKind(value) {
  const kind = String(value ?? "");
  return kind === "instrument" || kind === "effect" ? kind : "other";
}

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return fallback;
  }
  return numeric;
}
