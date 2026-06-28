import type {
  AudioBlockResponse,
  AudioBusBlock,
  RequestEnvelope,
  ResponseEnvelope
} from "../../protocol/src/messages";

export interface BinaryAudioBusBlock extends Omit<AudioBusBlock, "channels"> {
  channels: ArrayLike<number>[];
}

const BINARY_AUDIO_MAGIC = 0x53424131;
const BINARY_AUDIO_HEADER_BYTES = 8;
const FLOAT_BYTES = 4;
const LITTLE_ENDIAN_FLOATS = new Uint8Array(new Float32Array([1]).buffer)[0] === 0;
const BINARY_TEXT_ENCODER = new TextEncoder();
const BINARY_TEXT_DECODER = new TextDecoder();
const MAX_BINARY_CHANNELS = 32;
const MAX_BINARY_FRAMES = 8192;
const MAX_BINARY_BUSES = 32;
const EMPTY_BINARY_BUSES: Array<{ index: number; channels: Float32Array[]; frames: number }> = [];
const EMPTY_READ_BINARY_BLOCKS: Array<{ index: number; channels: Float32Array[] }> = [];

export function encodeBinaryAudioEnvelope(envelope: RequestEnvelope, channels: ArrayLike<number>[]): ArrayBuffer {
  const mainBlock = normalizeBinaryBlock(channels);
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const inputBuses = normalizeBinaryBuses((payload as { inputBuses?: BinaryAudioBusBlock[] }).inputBuses);
  const outputBuses = normalizeBinaryBuses((payload as { outputBuses?: BinaryAudioBusBlock[] }).outputBuses);
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: undefined,
      inputBuses: undefined,
      outputBuses: undefined
    },
    binaryAudio: {
      channels: mainBlock.channels.length,
      frames: mainBlock.frames,
      ...(inputBuses.length > 0 ? { inputBuses: busHeaders(inputBuses) } : {}),
      ...(outputBuses.length > 0 ? { outputBuses: busHeaders(outputBuses) } : {})
    }
  };
  delete header.payload.channels;
  delete header.payload.inputBuses;
  delete header.payload.outputBuses;
  const headerBytes = BINARY_TEXT_ENCODER.encode(JSON.stringify(header));
  let sampleBytes = binaryBlockBytes(mainBlock);
  if (inputBuses.length > 0) sampleBytes += binaryBlocksBytes(inputBuses);
  if (outputBuses.length > 0) sampleBytes += binaryBlocksBytes(outputBuses);
  const buffer = new ArrayBuffer(BINARY_AUDIO_HEADER_BYTES + headerBytes.length + sampleBytes);
  const view = new DataView(buffer);
  view.setUint32(0, BINARY_AUDIO_MAGIC, false);
  view.setUint32(4, headerBytes.length, false);
  new Uint8Array(buffer, BINARY_AUDIO_HEADER_BYTES, headerBytes.length).set(headerBytes);
  const target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let offset = BINARY_AUDIO_HEADER_BYTES + headerBytes.length;
  offset = writeBinaryBlockSamples(view, target, offset, mainBlock);
  if (inputBuses.length > 0) offset = writeBinaryBlocks(view, target, offset, inputBuses);
  if (outputBuses.length > 0) writeBinaryBlocks(view, target, offset, outputBuses);
  return buffer;
}

export function decodeBinaryAudioEnvelope(data: unknown): ResponseEnvelope {
  const bytes = binaryBytes(data);
  if (!bytes || bytes.byteLength < BINARY_AUDIO_HEADER_BYTES) {
    throw new Error("invalid_binary_audio_frame");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== BINARY_AUDIO_MAGIC) {
    throw new Error("invalid_binary_audio_magic");
  }
  const headerLength = view.getUint32(4, false);
  const headerEnd = BINARY_AUDIO_HEADER_BYTES + headerLength;
  if (headerLength < 2 || headerEnd > bytes.byteLength) {
    throw new Error("invalid_binary_audio_header");
  }

  const headerBytes = bytes.subarray(BINARY_AUDIO_HEADER_BYTES, headerEnd);
  const envelope = JSON.parse(BINARY_TEXT_DECODER.decode(headerBytes)) as ResponseEnvelope & {
    binaryAudio?: { channels?: number; frames?: number; inputBuses?: unknown; outputBuses?: unknown };
  };
  const channelCount = boundedBinaryInteger(envelope.binaryAudio?.channels, 0, MAX_BINARY_CHANNELS);
  const frames = boundedBinaryInteger(envelope.binaryAudio?.frames, 1, MAX_BINARY_FRAMES);
  let offset = headerEnd;
  const mainBlock = readBinaryBlock(view, offset, channelCount, frames);
  offset = mainBlock.offset;
  const inputBuses = readBinaryBuses(view, offset, envelope.binaryAudio?.inputBuses);
  offset = inputBuses.offset;
  const outputBuses = readBinaryBuses(view, offset, envelope.binaryAudio?.outputBuses);
  offset = outputBuses.offset;
  if (bytes.byteLength !== offset) {
    throw new Error("invalid_binary_audio_payload");
  }

  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    const payload = envelope.payload as AudioBlockResponse;
    payload.channels = mainBlock.channels;
    if (inputBuses.blocks.length > 0) {
      (payload as AudioBlockResponse & { inputBuses?: AudioBusBlock[] }).inputBuses = inputBuses.blocks as unknown as AudioBusBlock[];
    }
    if (outputBuses.blocks.length > 0) {
      payload.outputBuses = outputBuses.blocks as unknown as AudioBusBlock[];
    }
  }
  delete envelope.binaryAudio;
  return envelope;
}

function normalizeBinaryBlock(channels: ArrayLike<number>[]): { channels: Float32Array[]; frames: number } {
  const channelCount = Math.min(channels.length, MAX_BINARY_CHANNELS);
  let frames = 1;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const length = Math.max(0, Math.floor(Number(channels[channelIndex]?.length ?? 0)) || 0);
    frames = Math.max(frames, Math.min(MAX_BINARY_FRAMES, length));
  }
  const normalizedChannels = new Array<Float32Array>(channelCount);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    let reusable = channel instanceof Float32Array && channel.length === frames;
    for (let index = 0; reusable && index < frames; index += 1) reusable = Number.isFinite(channel[index]);
    if (reusable) {
      normalizedChannels[channelIndex] = channel;
      continue;
    }
    const normalized = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      const value = Number(channel[index] ?? 0);
      normalized[index] = Number.isFinite(value) ? value : 0;
    }
    normalizedChannels[channelIndex] = normalized;
  }
  return { channels: normalizedChannels, frames };
}

function normalizeBinaryBuses(buses?: BinaryAudioBusBlock[]): Array<{ index: number; channels: Float32Array[]; frames: number }> {
  if (!Array.isArray(buses) || buses.length === 0) {
    return EMPTY_BINARY_BUSES;
  }
  const seen = new Set<number>();
  const blocks: Array<{ index: number; channels: Float32Array[]; frames: number }> = [];
  const busCount = Math.min(buses.length, MAX_BINARY_BUSES);
  for (let busPosition = 0; busPosition < busCount; busPosition += 1) {
    const bus = buses[busPosition];
    const index = boundedBinaryInteger(bus?.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    blocks.push({ index, ...normalizeBinaryBlock(Array.isArray(bus?.channels) ? bus.channels : []) });
  }
  return blocks;
}

function busHeaders(buses: Array<{ index: number; channels: Float32Array[]; frames: number }>): Array<{ index: number; channels: number; frames: number }> {
  return buses.map((bus) => ({ index: bus.index, channels: bus.channels.length, frames: bus.frames }));
}

function binaryBlockBytes(block: { channels: Float32Array[]; frames: number }): number {
  return block.channels.length * block.frames * FLOAT_BYTES;
}

function binaryBlocksBytes(blocks: Array<{ channels: Float32Array[]; frames: number }>): number {
  let bytes = 0;
  for (const block of blocks) bytes += binaryBlockBytes(block);
  return bytes;
}

function writeBinaryBlocks(view: DataView, target: Uint8Array, offset: number, blocks: Array<{ channels: Float32Array[] }>): number {
  for (const block of blocks) offset = writeBinaryBlockSamples(view, target, offset, block);
  return offset;
}

function writeBinaryBlockSamples(view: DataView, target: Uint8Array, offset: number, block: { channels: Float32Array[] }): number {
  for (const channel of block.channels) {
    if (LITTLE_ENDIAN_FLOATS) {
      target.set(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength), offset);
      offset += channel.byteLength;
      continue;
    }
    for (const sample of channel) {
      view.setFloat32(offset, sample, true);
      offset += FLOAT_BYTES;
    }
  }
  return offset;
}

function readBinaryBlock(view: DataView, offset: number, channelCount: number, frames: number): { channels: Float32Array[]; offset: number } {
  const byteLength = channelCount * frames * FLOAT_BYTES;
  if (offset + byteLength > view.byteLength) {
    throw new Error("invalid_binary_audio_payload");
  }
  return { channels: readBinaryChannels(view, offset, channelCount, frames), offset: offset + byteLength };
}

function readBinaryBuses(view: DataView, offset: number, specs: unknown): { blocks: Array<{ index: number; channels: Float32Array[] }>; offset: number } {
  if (specs === undefined) {
    return { blocks: EMPTY_READ_BINARY_BLOCKS, offset };
  }
  if (!Array.isArray(specs) || specs.length > MAX_BINARY_BUSES) {
    throw new Error("binary_audio_bus_out_of_range");
  }
  const seen = new Set<number>();
  const blocks: Array<{ index: number; channels: Float32Array[] }> = [];
  for (const spec of specs) {
    const raw = spec as { index?: unknown; channels?: unknown; frames?: unknown };
    const index = boundedBinaryInteger(raw.index, 0, MAX_BINARY_BUSES - 1);
    if (seen.has(index)) {
      throw new Error("binary_audio_duplicate_bus");
    }
    seen.add(index);
    const channelCount = boundedBinaryInteger(raw.channels, 0, MAX_BINARY_CHANNELS);
    const frames = boundedBinaryInteger(raw.frames, 1, MAX_BINARY_FRAMES);
    const block = readBinaryBlock(view, offset, channelCount, frames);
    offset = block.offset;
    blocks.push({ index, channels: block.channels });
  }
  return { blocks, offset };
}

function readBinaryChannels(view: DataView, offset: number, channelCount: number, frames: number): Float32Array[] {
  const channels: Float32Array[] = [];
  const byteLength = frames * FLOAT_BYTES;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const normalized = new Float32Array(frames);
    if (LITTLE_ENDIAN_FLOATS) {
      new Uint8Array(normalized.buffer).set(new Uint8Array(view.buffer, view.byteOffset + offset, byteLength));
      offset += byteLength;
    } else {
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        normalized[frameIndex] = view.getFloat32(offset, true);
        offset += FLOAT_BYTES;
      }
    }
    channels.push(normalized);
  }
  return channels;
}

function binaryBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function boundedBinaryInteger(value: unknown, min: number, max: number): number {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer) || integer < min || integer > max) {
    throw new Error("binary_audio_integer_out_of_range");
  }
  return integer;
}
