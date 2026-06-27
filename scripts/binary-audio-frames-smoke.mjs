import { decodeBinaryAudioEnvelope, encodeBinaryAudioEnvelope } from "./binary-audio-frames.mjs";

const requestEnvelope = {
  type: "request",
  id: "binary-smoke-1",
  command: "processAudioBlock",
  sessionToken: "session-token",
  payload: {
    instanceId: "inst-1",
    blockId: 7,
    sampleRate: 48000,
    channels: [
      [0, 0.25, -0.25],
      Float32Array.from([0.5, -0.5, 1])
    ],
    transport: { playing: true, samplePosition: 896 }
  }
};

const encodedRequest = encodeBinaryAudioEnvelope(requestEnvelope);
const decodedRequest = decodeBinaryAudioEnvelope(encodedRequest);
assert(decodedRequest.id === "binary-smoke-1", "binary request preserves envelope id");
assert(decodedRequest.payload.blockId === 7, "binary request preserves JSON payload fields");
assert(decodedRequest.payload.channels.length === 2, "binary request restores channel count");
assert(Math.abs(decodedRequest.payload.channels[1][1] + 0.5) < 0.000001, "binary request restores Float32 samples");
assert(!("channels" in readBinaryHeader(encodedRequest).payload), "binary request keeps samples out of JSON header");

const typedOnlyRequest = {
  ...requestEnvelope,
  id: "binary-smoke-typed",
  payload: {
    ...requestEnvelope.payload,
    channels: [Float32Array.from([0, 0.25, 0.5, 0.75]), Float32Array.from([1, 0.5, 0.25, 0])]
  }
};
const decodedTypedOnly = decodeBinaryAudioEnvelope(encodeBinaryAudioEnvelope(typedOnlyRequest));
assert(decodedTypedOnly.payload.channels[0].length === 4, "binary request counts typed-array-only frame lengths");
assert(Math.abs(decodedTypedOnly.payload.channels[1][0] - 1) < 0.000001, "binary request restores typed-array-only samples");

const responseEnvelope = {
  type: "response",
  id: "binary-smoke-1",
  ok: true,
  payload: {
    blockId: 7,
    channels: [
      [0, 0.125, -0.125],
      [0.25, -0.25, 0.5]
    ],
    outputBuses: [{ index: 0, channels: [[999]] }],
    latencySamples: 3,
    tailSamples: 0,
    infiniteTail: false,
    renderEngine: "mock"
  }
};

const decodedResponse = decodeBinaryAudioEnvelope(encodeBinaryAudioEnvelope(responseEnvelope));
assert(decodedResponse.ok === true, "binary response preserves ok status");
assert(decodedResponse.payload.latencySamples === 3, "binary response preserves non-audio payload metadata");
assert(!("outputBuses" in decodedResponse.payload), "binary response omits duplicated bus sample arrays");
assert(decodedResponse.payload.channels[0][2] < 0, "binary response restores output samples");

for (const malformed of [Buffer.alloc(0), Buffer.from("nope"), encodeBinaryAudioEnvelope(responseEnvelope).subarray(0, 10)]) {
  assertThrows(() => decodeBinaryAudioEnvelope(malformed), "malformed binary audio frames are rejected");
}

console.log("Binary audio frame smoke checks passed.");

function assertThrows(callback, message) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readBinaryHeader(frame) {
  const headerLength = frame.readUInt32BE(4);
  return JSON.parse(frame.subarray(8, 8 + headerLength).toString("utf8"));
}
