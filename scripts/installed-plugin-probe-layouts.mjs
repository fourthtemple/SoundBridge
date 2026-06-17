const MAX_BUS_LAYOUTS = 32;
const MAX_BUS_LAYOUT_SCAN = MAX_BUS_LAYOUTS * 2;

export function summarizeProbeBusLayout(plugin, layout) {
  const sourceInputBuses = busLayouts(layout?.inputBusLayouts);
  const sourceOutputBuses = busLayouts(layout?.outputBusLayouts);
  const inputBuses = boundedBusLayouts(sourceInputBuses);
  const outputBuses = boundedBusLayouts(sourceOutputBuses);
  const inputBusMetadataAtLimit = sourceInputBuses.length >= MAX_BUS_LAYOUTS;
  const outputBusMetadataAtLimit = sourceOutputBuses.length >= MAX_BUS_LAYOUTS;
  const inputBusCount = clampInt(layout?.inputBuses, 0, 32, inputBuses.length);
  const outputBusCount = clampInt(layout?.outputBuses, 1, 32, outputBuses.length || 1);
  const inputChannels = clampInt(layout?.inputChannels, 0, 32, 0);
  const outputChannels = clampInt(layout?.outputChannels, 1, 32, 1);
  const kind = knownKind(plugin?.kind);
  const activeInputs = inputBuses.filter(activeAudioBus);
  const activeOutputs = outputBuses.filter(activeAudioBus);
  const inactiveInputs = inputBuses.filter(inactiveAudioBus);
  const inactiveOutputs = outputBuses.filter(inactiveAudioBus);
  const overflowInputMetadata = overflowBusMetadata(sourceInputBuses, inputBuses);
  const overflowOutputMetadata = overflowBusMetadata(sourceOutputBuses, outputBuses);
  const nonsequentialInputBuses = countNonSequentialIndexes(inputBuses);
  const nonsequentialOutputBuses = countNonSequentialIndexes(outputBuses);
  const duplicateInputBusIndexes = cappedBusCount(countDuplicateIndexes(inputBuses) + overflowInputMetadata.duplicateBusIndexes);
  const duplicateOutputBusIndexes = cappedBusCount(countDuplicateIndexes(outputBuses) + overflowOutputMetadata.duplicateBusIndexes);
  const inputBusLayoutCount = uniqueBusIndexCount(inputBuses);
  const outputBusLayoutCount = uniqueBusIndexCount(outputBuses);
  const inputBusCountMismatch = inputBusLayoutCount > 0 && inputBusCount !== inputBusLayoutCount;
  const outputBusCountMismatch = outputBusLayoutCount > 0 && outputBusCount !== outputBusLayoutCount;
  const activeEmptyInputBuses = cappedBusCount(activeInputs.filter((bus) => bus.channels === 0).length + overflowInputMetadata.activeEmptyBuses);
  const activeEmptyOutputBuses = cappedBusCount(activeOutputs.filter((bus) => bus.channels === 0).length + overflowOutputMetadata.activeEmptyBuses);
  const unknownInputBusTypes = cappedBusCount(inputBuses.filter((bus) => bus.type === "unknown").length + overflowInputMetadata.unknownTypes);
  const unknownOutputBusTypes = cappedBusCount(outputBuses.filter((bus) => bus.type === "unknown").length + overflowOutputMetadata.unknownTypes);
  const inputBusNameFallbacks = cappedBusCount(inputBuses.filter((bus) => bus.nameFallback).length + overflowInputMetadata.nameFallbacks);
  const outputBusNameFallbacks = cappedBusCount(outputBuses.filter((bus) => bus.nameFallback).length + overflowOutputMetadata.nameFallbacks);
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
  if (nonsequentialInputBuses > 0 || nonsequentialOutputBuses > 0) {
    flags.push("nonsequential-bus-indexes");
  }
  if (duplicateInputBusIndexes > 0 || duplicateOutputBusIndexes > 0) {
    flags.push("duplicate-bus-indexes");
  }
  if (inputBusCountMismatch || outputBusCountMismatch) {
    flags.push("bus-count-mismatch");
  }
  if (activeEmptyInputBuses > 0 || activeEmptyOutputBuses > 0) {
    flags.push("active-empty-bus");
  }
  if (inactiveInputs.length > 0) {
    flags.push("inactive-input-bus");
  }
  if (inactiveOutputs.length > 0) {
    flags.push("inactive-output-bus");
  }
  if (unknownInputBusTypes > 0 || unknownOutputBusTypes > 0) {
    flags.push("unknown-bus-type");
  }
  if (inputBusNameFallbacks > 0) {
    flags.push("input-bus-name-fallback");
  }
  if (outputBusNameFallbacks > 0) {
    flags.push("output-bus-name-fallback");
  }
  if (inputBusMetadataAtLimit) {
    flags.push("input-bus-metadata-at-limit");
  }
  if (outputBusMetadataAtLimit) {
    flags.push("output-bus-metadata-at-limit");
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
    inputBusLayoutCount,
    outputBusLayoutCount,
    inputBusCountMismatch,
    outputBusCountMismatch,
    inactiveInputBuses: inactiveInputs.length,
    inactiveOutputBuses: inactiveOutputs.length,
    activeInputBusIndexes: boundedBusIndexes(activeInputs),
    activeOutputBusIndexes: boundedBusIndexes(activeOutputs),
    inactiveInputBusIndexes: boundedBusIndexes(inactiveInputs),
    inactiveOutputBusIndexes: boundedBusIndexes(inactiveOutputs),
    nonsequentialInputBuses,
    nonsequentialOutputBuses,
    duplicateInputBusIndexes,
    duplicateOutputBusIndexes,
    activeEmptyInputBuses,
    activeEmptyOutputBuses,
    unknownInputBusTypes,
    unknownOutputBusTypes,
    inputBusNameFallbacks,
    outputBusNameFallbacks,
    inputBusMetadataAtLimit,
    outputBusMetadataAtLimit
  };
}

function busLayouts(value) {
  return Array.isArray(value) ? value : [];
}

function hasEmptyName(value) {
  return value != null &&
    Object.prototype.hasOwnProperty.call(value, "name") &&
    String(value.name ?? "").length === 0;
}

function boundedBusLayouts(value) {
  return value.slice(0, MAX_BUS_LAYOUTS).map((bus, fallbackIndex) => normalizeBusLayout(bus, fallbackIndex));
}

function normalizeBusLayout(bus, fallbackIndex) {
  return {
    index: clampInt(bus?.index, 0, 31, fallbackIndex),
    channels: clampInt(bus?.channels, 0, 32, 0),
    active: bus?.active === true,
    nameFallback: bus?.nameFallback === true || hasEmptyName(bus),
    type: bus?.type === "main" || bus?.type === "aux" || bus?.type === "unknown" ? bus.type : "unknown"
  };
}

function overflowBusMetadata(sourceBuses, boundedBuses) {
  const seenIndexes = new Set(boundedBuses.map((bus) => bus.index));
  const duplicateIndexes = new Set();
  let activeEmptyBuses = 0;
  let unknownTypes = 0;
  let nameFallbacks = 0;
  for (let index = MAX_BUS_LAYOUTS; index < Math.min(sourceBuses.length, MAX_BUS_LAYOUT_SCAN); index += 1) {
    const bus = normalizeBusLayout(sourceBuses[index], 31);
    if (seenIndexes.has(bus.index)) {
      duplicateIndexes.add(bus.index);
    }
    seenIndexes.add(bus.index);
    if (bus.active && bus.channels === 0) {
      activeEmptyBuses = cappedBusCount(activeEmptyBuses + 1);
    }
    if (bus.type === "unknown") {
      unknownTypes = cappedBusCount(unknownTypes + 1);
    }
    if (bus.nameFallback) {
      nameFallbacks = cappedBusCount(nameFallbacks + 1);
    }
  }
  return { duplicateBusIndexes: duplicateIndexes.size, activeEmptyBuses, unknownTypes, nameFallbacks };
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

function countNonSequentialIndexes(buses) {
  return buses.filter((bus, index) => bus.index !== index).length;
}

function countDuplicateIndexes(buses) {
  const seen = new Set();
  const duplicates = new Set();
  for (const bus of buses) {
    if (seen.has(bus.index)) {
      duplicates.add(bus.index);
    } else {
      seen.add(bus.index);
    }
  }
  return duplicates.size;
}

function uniqueBusIndexCount(buses) {
  return new Set(buses.map((bus) => bus.index)).size;
}

function boundedBusIndexes(buses) {
  return [...new Set(buses.map((bus) => bus.index))].sort((left, right) => left - right);
}

function cappedBusCount(value) {
  return Math.min(MAX_BUS_LAYOUTS, value);
}

function knownKind(value) {
  const kind = String(value ?? "");
  return kind === "instrument" || kind === "effect" ? kind : "other";
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" && typeof value !== "string") {
    return fallback;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return fallback;
  }
  return numeric;
}
