import type { AudioBlockRequest } from "../../protocol/src/messages";
import type { BinaryAudioBusBlock } from "./client";

export function transitionOutputChannels(
  channels: ArrayLike<number>[],
  previousTail: number[] | undefined,
  previousPath: "wet" | "dry" | undefined,
  outputPath: "wet" | "dry",
  fadeSamples: number
): ArrayLike<number>[] {
  if (fadeSamples <= 0 || !previousTail || previousPath === undefined || previousPath === outputPath) {
    return channels;
  }
  return channels.map((source, channelIndex) => {
    const output = Array.from(source);
    const fade = Math.min(output.length, fadeSamples);
    const previous = previousTail[channelIndex % previousTail.length] ?? 0;
    for (let frame = 0; frame < fade; frame += 1) {
      const wet = (frame + 1) / (fade + 1);
      output[frame] = previous * (1 - wet) + output[frame] * wet;
    }
    return output;
  });
}

export function wetMixedChannels(
  wetChannels: ArrayLike<number>[],
  dryInput: ArrayLike<number>[] | undefined,
  outputChannels: number,
  wetMix: number,
  maxFrames = Number.MAX_SAFE_INTEGER
): ArrayLike<number>[] {
  if (wetMix <= 0) {
    return dryChannels(dryInput ?? [], outputChannels, maxFrames);
  }
  const wetOutput = boundedLiveEffectChannels(wetChannels, outputChannels, maxFrames);
  if (wetMix >= 1) {
    return wetOutput;
  }
  const dry = dryChannels(dryInput ?? [], outputChannels, maxFrames);
  const mixed = new Array<number[]>(outputChannels);
  const dryMix = 1 - wetMix;
  for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
    const wet = wetOutput.length > 0 ? wetOutput[channelIndex % wetOutput.length] : [];
    const dryChannel = dry[channelIndex];
    const frames = Math.max(wet.length, dryChannel.length);
    const output = new Array<number>(frames);
    for (let frame = 0; frame < frames; frame += 1) output[frame] = Number(dryChannel[frame] ?? 0) * dryMix + Number(wet[frame] ?? 0) * wetMix;
    mixed[channelIndex] = output;
  }
  return mixed;
}

export function boundedLiveEffectChannels(
  channels: ArrayLike<number>[],
  channelCount: number,
  maxFrames: number
): ArrayLike<number>[] {
  const count = boundedAudioCount(channelCount);
  const frames = boundedAudioFrames(channels, count, maxFrames);
  let bounded: ArrayLike<number>[] | undefined = channels.length !== count ? new Array<ArrayLike<number>>(count) : undefined;
  for (let index = 0; index < count; index += 1) {
    const source = channels.length > 0 ? channels[index % channels.length] : undefined;
    let output: ArrayLike<number>;
    if (channelLength(source) <= 0) {
      output = Array.from({ length: frames }, () => 0);
    } else {
      output = normalizedChannel(source, frames) ?? source;
    }
    if (bounded) {
      bounded[index] = output;
    } else if (output !== source) {
      bounded = new Array<ArrayLike<number>>(count);
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) bounded[previousIndex] = channels[previousIndex];
      bounded[index] = output;
    }
  }
  return bounded ?? channels;
}

export function boundedLiveEffectBusBlocks(buses: BinaryAudioBusBlock[] | undefined, maxFrames: number): BinaryAudioBusBlock[] | undefined {
  if (!buses?.length) return undefined;
  const bounded: BinaryAudioBusBlock[] = [];
  const seen = new Set<number>();
  for (const bus of buses) {
    const index = Math.floor(Number(bus.index));
    if (!Number.isFinite(index) || index < 0 || index > 31 || seen.has(index)) continue;
    seen.add(index);
    bounded.push({ index, channels: boundedLiveEffectChannels(bus.channels ?? [], bus.channels?.length ?? 1, maxFrames) });
    if (bounded.length >= 32) break;
  }
  return bounded.length > 0 ? bounded : undefined;
}

export function outputTail(channels: ArrayLike<number>[], outputChannels: number): number[] {
  const tail = new Array<number>(outputChannels);
  const channelCount = channels.length;
  for (let index = 0; index < outputChannels; index += 1) {
    const channel = channelCount > 0 ? channels[index % channelCount] : undefined;
    const sample = Number(channel?.[Math.max(0, channel.length - 1)] ?? 0);
    tail[index] = Number.isFinite(sample) ? sample : 0;
  }
  return tail;
}

export function cloneChannels(channels: ArrayLike<number>[], maxFrames = Number.MAX_SAFE_INTEGER): number[][] {
  return boundedLiveEffectChannels(channels, channels.length, maxFrames).map((channel) => Array.from(channel));
}

export function cloneBusBlocks(buses?: BinaryAudioBusBlock[], maxFrames = Number.MAX_SAFE_INTEGER): AudioBlockRequest["inputBuses"] {
  return boundedLiveEffectBusBlocks(buses, maxFrames)?.map((bus) => ({ index: bus.index, channels: cloneChannels(bus.channels, maxFrames) }));
}

export function dryChannels(channels: ArrayLike<number>[], outputChannels: number, maxFrames = Number.MAX_SAFE_INTEGER): number[][] {
  const bounded = boundedLiveEffectChannels(channels, outputChannels, maxFrames);
  const frames = bounded[0]?.length ?? 0;
  return Array.from({ length: outputChannels }, (_, index) => {
    const source = bounded.length > 0 ? bounded[index % bounded.length] : undefined;
    return source ? Array.from(source) : Array.from({ length: frames }, () => 0);
  });
}

function boundedAudioCount(value: number): number {
  const count = Math.floor(Number(value));
  return Number.isFinite(count) ? Math.max(1, Math.min(32, count)) : 1;
}

function boundedAudioFrames(channels: ArrayLike<number>[], channelCount: number, maxFrames: number): number {
  let frames = 0;
  const count = Math.min(channelCount, channels.length);
  for (let index = 0; index < count; index += 1) frames = Math.max(frames, channelLength(channels[index]));
  const max = Math.floor(Number(maxFrames));
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return Number.isFinite(max) && max > 0 ? Math.min(frames, Math.min(max, 8192)) : Math.min(frames, 8192);
}

function normalizedChannel(channel: ArrayLike<number>, frames: number): ArrayLike<number> | undefined {
  if (channelLength(channel) !== frames) return Array.from({ length: frames }, (_unused, index) => finiteSample(channel[index]));
  if (channel instanceof Float32Array) {
    for (let index = 0; index < frames; index += 1) if (!Number.isFinite(channel[index])) return Array.from({ length: frames }, (_unused, frame) => finiteSample(channel[frame]));
    return undefined;
  }
  for (let index = 0; index < frames; index += 1) {
    if (!Number.isFinite(Number(channel[index] ?? 0))) return Array.from({ length: frames }, (_unused, frame) => finiteSample(channel[frame]));
  }
  return undefined;
}

function channelLength(channel: ArrayLike<number> | undefined): number {
  const length = Math.floor(Number(channel?.length ?? 0));
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function finiteSample(value: unknown): number {
  const sample = Number(value ?? 0);
  return Number.isFinite(sample) ? sample : 0;
}
