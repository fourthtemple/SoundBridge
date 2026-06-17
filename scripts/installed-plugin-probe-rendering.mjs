const SIGNAL_EPSILON = 0.000001;

export function assertProbeRenderMatchesLayout(rendered, layout, frames) {
  const expectedOutputChannels = clampInt(layout?.outputChannels, 1, 32, 1);
  if (!Array.isArray(rendered?.channels) || rendered.channels.length !== expectedOutputChannels) {
    throwRenderLayoutError(`rendered ${rendered?.channels?.length ?? 0} channel(s), expected ${expectedOutputChannels}`);
  }
  assertChannelFrames(rendered.channels, frames, "legacy output channels");

  if (!Array.isArray(rendered.outputBuses)) {
    throwRenderLayoutError("render response did not include outputBuses");
  }
  const outputBuses = indexedOutputBuses(rendered.outputBuses);
  const mainBus = outputBuses.get(0);
  if (!mainBus || !Array.isArray(mainBus.channels) || mainBus.channels.length !== expectedOutputChannels) {
    throwRenderLayoutError("render response main output bus did not match the negotiated layout");
  }
  if (JSON.stringify(mainBus.channels) !== JSON.stringify(rendered.channels)) {
    throwRenderLayoutError("render response main output bus did not mirror legacy channels");
  }

  for (const [index, bus] of outputBuses.entries()) {
    if (!Array.isArray(bus.channels) || bus.channels.length > 32) {
      throwRenderLayoutError(`render response output bus ${index} did not return bounded channel arrays`);
    }
    assertChannelFrames(bus.channels, frames, `output bus ${index}`);
  }

  for (const layoutBus of activeOutputLayouts(layout)) {
    const bus = outputBuses.get(layoutBus.index);
    if (!bus) {
      throwRenderLayoutError(`render response did not include negotiated output bus ${layoutBus.index}`);
    }
    if (!Array.isArray(bus.channels) || bus.channels.length !== layoutBus.channels) {
      throwRenderLayoutError(`render response output bus ${layoutBus.index} did not match the negotiated channel count`);
    }
  }
}

export function summarizeProbeRenderSignal(rendered) {
  let sawSample = false;
  for (const sample of renderSamples(rendered)) {
    sawSample = true;
    if (Math.abs(sample) > SIGNAL_EPSILON) {
      return "signal";
    }
  }
  return sawSample ? "silent" : "missing";
}

export function summarizeProbeOutputBusSignal(rendered, layout) {
  const activeBuses = activeOutputLayouts(layout);
  if (!Array.isArray(rendered?.outputBuses)) {
    return {
      category: "missing",
      flags: ["missing-output-buses"],
      outputBusCount: activeBuses.length,
      signalOutputBusCount: 0,
      silentOutputBusCount: 0,
      missingOutputBusCount: activeBuses.length,
      extraOutputBusCount: 0,
      extraSignalOutputBusCount: 0,
      missingOutputBusIndexes: activeBuses.map((bus) => bus.index),
      extraOutputBusIndexes: [],
      extraSignalOutputBusIndexes: []
    };
  }
  const outputBuses = indexedOutputBuses(rendered.outputBuses);
  const activeBusIndexes = new Set(activeBuses.map((bus) => bus.index));
  const signalOutputBusIndexes = [];
  const silentOutputBusIndexes = [];
  const missingOutputBusIndexes = [];
  const extraOutputBusIndexes = [...outputBuses.keys()]
    .filter((index) => !activeBusIndexes.has(index))
    .sort((left, right) => left - right);
  const extraSignalOutputBusIndexes = extraOutputBusIndexes.filter((index) => hasSignal(outputBuses.get(index)?.channels));
  for (const layoutBus of activeBuses) {
    const bus = outputBuses.get(layoutBus.index);
    if (!bus) {
      missingOutputBusIndexes.push(layoutBus.index);
      continue;
    }
    if (hasSignal(bus.channels)) {
      signalOutputBusIndexes.push(layoutBus.index);
    } else {
      silentOutputBusIndexes.push(layoutBus.index);
    }
  }
  const auxSignal = signalOutputBusIndexes.some((index) => index > 0);
  const mainSignal = signalOutputBusIndexes.includes(0);
  const flags = [
    ...(mainSignal ? ["main-signal"] : []),
    ...(auxSignal ? ["aux-signal"] : []),
    ...(signalOutputBusIndexes.length > 1 ? ["multi-output-signal"] : []),
    ...(silentOutputBusIndexes.length > 0 ? ["silent-output-bus"] : []),
    ...(missingOutputBusIndexes.length > 0 ? ["missing-output-bus"] : []),
    ...(extraOutputBusIndexes.length > 0 ? ["extra-output-bus"] : []),
    ...(extraSignalOutputBusIndexes.length > 0 ? ["extra-output-bus-signal"] : [])
  ];
  if (flags.length === 0) {
    flags.push("silent");
  }
  return {
    category: outputBusSignalCategory({
      activeBuses,
      auxSignal,
      extraSignalOutputBusIndexes,
      mainSignal,
      missingOutputBusIndexes,
      signalOutputBusIndexes
    }),
    flags,
    outputBusCount: activeBuses.length,
    signalOutputBusCount: signalOutputBusIndexes.length,
    silentOutputBusCount: silentOutputBusIndexes.length,
    missingOutputBusCount: missingOutputBusIndexes.length,
    extraOutputBusCount: extraOutputBusIndexes.length,
    extraSignalOutputBusCount: extraSignalOutputBusIndexes.length,
    signalOutputBusIndexes,
    silentOutputBusIndexes,
    missingOutputBusIndexes,
    extraOutputBusIndexes,
    extraSignalOutputBusIndexes
  };
}

function indexedOutputBuses(outputBuses) {
  const byIndex = new Map();
  for (const [position, bus] of outputBuses.entries()) {
    if (!bus || typeof bus !== "object" || Array.isArray(bus)) {
      throwRenderLayoutError(`render response outputBuses[${position}] was not an object`);
    }
    const index = bus.index;
    if (!Number.isInteger(index) || index < 0 || index > 31) {
      throwRenderLayoutError(`render response outputBuses[${position}] had an invalid index`);
    }
    if (byIndex.has(index)) {
      throwRenderLayoutError(`render response included duplicate output bus ${index}`);
    }
    byIndex.set(index, bus);
  }
  return byIndex;
}

function outputBusSignalCategory({
  activeBuses,
  auxSignal,
  extraSignalOutputBusIndexes,
  mainSignal,
  missingOutputBusIndexes,
  signalOutputBusIndexes
}) {
  if (
    activeBuses.length > 0 &&
    missingOutputBusIndexes.length === activeBuses.length &&
    extraSignalOutputBusIndexes.length === 0
  ) {
    return "missing";
  }
  if (mainSignal && auxSignal) {
    return "main-aux-signal";
  }
  if (auxSignal) {
    return "aux-signal";
  }
  if (mainSignal) {
    return "main-signal";
  }
  if (extraSignalOutputBusIndexes.length > 0) {
    return "extra-signal";
  }
  return signalOutputBusIndexes.length > 0 ? "signal" : "silent";
}

function activeOutputLayouts(layout) {
  const layouts = Array.isArray(layout?.outputBusLayouts) ? layout.outputBusLayouts : [];
  if (layouts.length === 0) {
    return [{ index: 0, channels: clampInt(layout?.outputChannels, 1, 32, 1) }];
  }
  return layouts
    .map((bus) => ({
      index: clampInt(bus?.index, 0, 31, 0),
      channels: clampInt(bus?.channels, 0, 32, 0),
      active: bus?.active !== false
    }))
    .filter((bus) => bus.active && bus.channels > 0);
}

function hasSignal(channels) {
  for (const sample of channelSamples(channels)) {
    if (Math.abs(sample) > SIGNAL_EPSILON) {
      return true;
    }
  }
  return false;
}

function assertChannelFrames(channels, frames, context) {
  const expectedFrames = clampInt(frames, 1, 8192, 1);
  for (const [index, channel] of channels.entries()) {
    if (!Array.isArray(channel) || channel.length !== expectedFrames) {
      throwRenderLayoutError(`render response ${context} channel ${index} did not match the requested frame count`);
    }
  }
}

function throwRenderLayoutError(message) {
  const error = new Error(message);
  error.code = "bad_render_layout";
  throw error;
}

function* renderSamples(rendered) {
  yield* channelSamples(rendered?.channels);
  if (Array.isArray(rendered?.outputBuses)) {
    for (const bus of rendered.outputBuses) {
      yield* channelSamples(bus?.channels);
    }
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function* channelSamples(channels) {
  if (!Array.isArray(channels)) {
    return;
  }
  for (const channel of channels) {
    if (!Array.isArray(channel)) {
      continue;
    }
    for (const sample of channel) {
      const value = Number(sample);
      if (Number.isFinite(value)) {
        yield value;
      }
    }
  }
}
