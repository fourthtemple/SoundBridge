const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_MAX_BLOCK_SIZE = 64;

export function renderPayloadForLayout(instanceId, layout, options = {}) {
  const sampleRate = clampInt(options.sampleRate, 8000, 384000, DEFAULT_SAMPLE_RATE);
  const maxBlockSize = clampInt(options.maxBlockSize, 1, 8192, DEFAULT_MAX_BLOCK_SIZE);
  const inputChannels = clampInt(layout?.inputChannels, 0, 32, 0);
  const frames = layoutBlockSize(layout, maxBlockSize);
  const inputBuses = mainInputBuses(inputChannels, frames);
  const inputBusLayouts = Array.isArray(layout?.inputBusLayouts) ? layout.inputBusLayouts : [];
  for (const bus of inputBusLayouts) {
    const index = clampInt(bus?.index, 0, 31, 0);
    const channels = clampInt(bus?.channels, 0, 32, 0);
    if (index === 0 || bus?.active !== true || channels <= 0 || inputBuses.some((candidate) => candidate.index === index)) {
      continue;
    }
    inputBuses.push({
      index,
      channels: Array.from({ length: channels }, () => Array(frames).fill(inputBusProbeValue(index)))
    });
  }
  return {
    instanceId,
    frames,
    sampleRate,
    channels: Array.from({ length: inputChannels }, () => Array(frames).fill(0)),
    inputBuses
  };
}

function mainInputBuses(inputChannels, frames) {
  if (inputChannels <= 0) {
    return [];
  }
  return [{ index: 0, channels: Array.from({ length: inputChannels }, () => Array(frames).fill(0.05)) }];
}

function inputBusProbeValue(index) {
  return 0.02 + Math.min(index, 8) * 0.005;
}

function layoutBlockSize(layout, maxBlockSize) {
  return clampInt(layout?.maxBlockSize, 1, maxBlockSize, maxBlockSize);
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
