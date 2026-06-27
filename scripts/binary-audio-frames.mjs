const MAGIC = 0x53424131; // SBA1
const HEADER_BYTES = 8;
const FLOAT_BYTES = 4;

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
  const channelCount = boundedInteger(audio?.channels, 0, 32, "binaryAudio.channels");
  const frames = boundedInteger(audio?.frames, 1, 8192, "binaryAudio.frames");
  const expectedBytes = channelCount * frames * FLOAT_BYTES;
  if (buffer.length !== headerEnd + expectedBytes) {
    throw new Error("invalid_binary_audio_payload");
  }

  envelope.payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  envelope.payload.channels = readPlanarFloat32(buffer, headerEnd, channelCount, frames);
  delete envelope.binaryAudio;
  return envelope;
}

export function encodeBinaryAudioEnvelope(envelope) {
  const payload = envelope?.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.channels)) {
    return undefined;
  }

  const channels = normalizeChannels(payload.channels);
  const header = {
    ...envelope,
    payload: {
      ...payload,
      channels: undefined,
      outputBuses: undefined
    },
    binaryAudio: {
      channels: channels.length,
      frames: channels[0]?.length ?? 0
    }
  };
  delete header.payload.channels;
  delete header.payload.outputBuses;

  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const bodyBytes = channels.length * (channels[0]?.length ?? 0) * FLOAT_BYTES;
  const frame = Buffer.alloc(HEADER_BYTES + headerBytes.length + bodyBytes);
  frame.writeUInt32BE(MAGIC, 0);
  frame.writeUInt32BE(headerBytes.length, 4);
  headerBytes.copy(frame, HEADER_BYTES);
  writePlanarFloat32(frame, HEADER_BYTES + headerBytes.length, channels);
  return frame;
}

function readPlanarFloat32(buffer, offset, channelCount, frames) {
  const channels = [];
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = [];
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      channel.push(buffer.readFloatLE(offset));
      offset += FLOAT_BYTES;
    }
    channels.push(channel);
  }
  return channels;
}

function writePlanarFloat32(buffer, offset, channels) {
  for (const channel of channels) {
    for (const sample of channel) {
      buffer.writeFloatLE(Number.isFinite(sample) ? sample : 0, offset);
      offset += FLOAT_BYTES;
    }
  }
}

function normalizeChannels(channels) {
  const limited = channels.slice(0, 32);
  const frames = Math.max(0, ...limited.map((channel) => channelFrameCount(channel)));
  return limited.map((channel) =>
    Array.from({ length: frames }, (_, index) => {
      const value = Number(channel?.[index] ?? 0);
      return Number.isFinite(value) ? value : 0;
    })
  );
}

function channelFrameCount(channel) {
  const length = Math.floor(Number(channel?.length ?? 0));
  return Number.isFinite(length) && length > 0 ? Math.min(length, 8192) : 0;
}

function boundedInteger(value, min, max, label) {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer) || integer < min || integer > max) {
    throw new Error(`${label}_out_of_range`);
  }
  return integer;
}
