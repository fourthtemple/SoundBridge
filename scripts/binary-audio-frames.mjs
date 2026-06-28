const MAGIC = 0x53424131; // SBA1
const HEADER_BYTES = 8;
const FLOAT_BYTES = 4;
const LITTLE_ENDIAN_FLOATS = new Uint8Array(new Float32Array([1]).buffer)[0] === 0;
const MAX_CHANNELS = 32;
const MAX_FRAMES = 8192;
const MAX_BUSES = 32;

export function decodeBinaryAudioEnvelope(frame) {
  const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buffer.length < HEADER_BYTES || buffer.readUInt32BE(0) !== MAGIC) {
    throw new Error("invalid_binary_audio_frame");
  }

  const headerLength = buffer.readUInt32BE(4);
  const headerEnd = HEADER_BYTES + headerLength;
  if (headerLength < 2 || headerEnd > buffer.length) {
    throw new Error("invalid_binary_audio_header");
  }

  const envelope = JSON.parse(buffer.subarray(HEADER_BYTES, headerEnd).toString("utf8"));
  const audio = envelope.binaryAudio;
  const channelCount = boundedInteger(audio?.channels, 0, MAX_CHANNELS, "binaryAudio.channels");
  const frames = boundedInteger(audio?.frames, 1, MAX_FRAMES, "binaryAudio.frames");
  let offset = headerEnd;
  const mainBlock = readChannelBlock(buffer, offset, channelCount, frames);
  offset = mainBlock.offset;
  const inputBuses = readBusBlocks(buffer, offset, audio?.inputBuses, "binaryAudio.inputBuses");
  offset = inputBuses.offset;
  const outputBuses = readBusBlocks(buffer, offset, audio?.outputBuses, "binaryAudio.outputBuses");
  offset = outputBuses.offset;
  if (buffer.length !== offset) {
    throw new Error("invalid_binary_audio_payload");
  }

  envelope.payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  envelope.payload.channels = mainBlock.channels;
  if (inputBuses.blocks.length > 0) {
    envelope.payload.inputBuses = inputBuses.blocks;
  }
  if (outputBuses.blocks.length > 0) {
    envelope.payload.outputBuses = outputBuses.blocks;
  }
  delete envelope.binaryAudio;
  return envelope;
}

export function encodeBinaryAudioEnvelope(envelope) {
  const payload = envelope?.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const channels = Array.isArray(payload.channels) ? normalizeChannelBlock(payload.channels) : undefined;
  const inputBuses = normalizeBusBlocks(payload.inputBuses);
  const outputBuses = normalizeBusBlocks(payload.outputBuses);
  if (!channels && inputBuses.length === 0 && outputBuses.length === 0) {
    return undefined;
  }

  const mainBlock = channels ?? { channels: [], frames: inputBuses[0]?.frames ?? outputBuses[0]?.frames ?? 1 };
  const binaryAudio = {
    channels: mainBlock.channels.length,
    frames: mainBlock.frames,
    ...(inputBuses.length > 0 ? { inputBuses: busHeaders(inputBuses) } : {}),
    ...(outputBuses.length > 0 ? { outputBuses: busHeaders(outputBuses) } : {})
  };
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: undefined,
      inputBuses: undefined,
      outputBuses: undefined
    },
    binaryAudio
  };
  delete header.payload.channels;
  delete header.payload.inputBuses;
  delete header.payload.outputBuses;

  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const blocks = [mainBlock, ...inputBuses, ...outputBuses];
  const bodyBytes = blocks.reduce((total, block) => total + block.channels.length * block.frames * FLOAT_BYTES, 0);
  const frame = Buffer.alloc(HEADER_BYTES + headerBytes.length + bodyBytes);
  frame.writeUInt32BE(MAGIC, 0);
  frame.writeUInt32BE(headerBytes.length, 4);
  headerBytes.copy(frame, HEADER_BYTES);
  writeChannelBlocks(frame, HEADER_BYTES + headerBytes.length, blocks);
  return frame;
}

function readChannelBlock(buffer, offset, channelCount, frames) {
  const bytes = channelCount * frames * FLOAT_BYTES;
  if (offset + bytes > buffer.length) {
    throw new Error("invalid_binary_audio_payload");
  }
  return {
    channels: readPlanarFloat32(buffer, offset, channelCount, frames),
    offset: offset + bytes
  };
}

function readBusBlocks(buffer, offset, specs, label) {
  if (specs === undefined) {
    return { blocks: [], offset };
  }
  if (!Array.isArray(specs) || specs.length > MAX_BUSES) {
    throw new Error(`${label}_out_of_range`);
  }
  const seen = new Set();
  const blocks = [];
  for (const spec of specs) {
    const index = boundedInteger(spec?.index, 0, MAX_BUSES - 1, `${label}.index`);
    if (seen.has(index)) {
      throw new Error(`${label}.index_duplicate`);
    }
    seen.add(index);
    const channelCount = boundedInteger(spec?.channels, 0, MAX_CHANNELS, `${label}.channels`);
    const frames = boundedInteger(spec?.frames, 1, MAX_FRAMES, `${label}.frames`);
    const block = readChannelBlock(buffer, offset, channelCount, frames);
    offset = block.offset;
    blocks.push({ index, channels: block.channels });
  }
  return { blocks, offset };
}

function readPlanarFloat32(buffer, offset, channelCount, frames) {
  const channels = [];
  const bytes = frames * FLOAT_BYTES;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = new Float32Array(frames);
    if (LITTLE_ENDIAN_FLOATS) {
      buffer.copy(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength), 0, offset, offset + bytes);
      offset += bytes;
    } else {
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        channel[frameIndex] = buffer.readFloatLE(offset);
        offset += FLOAT_BYTES;
      }
    }
    channels.push(channel);
  }
  return channels;
}

function writeChannelBlocks(buffer, offset, blocks) {
  for (const block of blocks) {
    for (const channel of block.channels) {
      if (LITTLE_ENDIAN_FLOATS && channel instanceof Float32Array) {
        Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength).copy(buffer, offset);
        offset += channel.byteLength;
        continue;
      }
      for (const sample of channel) {
        buffer.writeFloatLE(Number.isFinite(sample) ? sample : 0, offset);
        offset += FLOAT_BYTES;
      }
    }
  }
}

function normalizeChannelBlock(channels) {
  const limited = channels.slice(0, MAX_CHANNELS);
  const frames = Math.max(0, ...limited.map((channel) => channelFrameCount(channel)));
  const blockFrames = Math.max(1, frames);
  return {
    channels: limited.map((channel) => normalizeChannel(channel, blockFrames)),
    frames: blockFrames
  };
}

function normalizeChannel(channel, frames) {
  if (channel?.length === frames) {
    let reusable = true;
    for (let index = 0; reusable && index < frames; index += 1) reusable = Number.isFinite(channel[index]);
    if (reusable) return channel;
  }
  const normalized = ArrayBuffer.isView(channel) ? new Float32Array(frames) : new Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const value = Number(channel?.[index] ?? 0);
    normalized[index] = Number.isFinite(value) ? value : 0;
  }
  return normalized;
}

function normalizeBusBlocks(buses) {
  if (!Array.isArray(buses)) {
    return [];
  }
  const seen = new Set();
  return buses.slice(0, MAX_BUSES).map((bus) => {
    const index = boundedInteger(bus?.index, 0, MAX_BUSES - 1, "bus.index");
    if (seen.has(index)) {
      throw new Error("bus.index_duplicate");
    }
    seen.add(index);
    return { index, ...normalizeChannelBlock(Array.isArray(bus?.channels) ? bus.channels : []) };
  });
}

function busHeaders(buses) {
  return buses.map((bus) => ({ index: bus.index, channels: bus.channels.length, frames: bus.frames }));
}

function channelFrameCount(channel) {
  const length = Math.floor(Number(channel?.length ?? 0));
  return Number.isFinite(length) && length > 0 ? Math.min(length, MAX_FRAMES) : 0;
}

function boundedInteger(value, min, max, label) {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer) || integer < min || integer > max) {
    throw new Error(`${label}_out_of_range`);
  }
  return integer;
}
