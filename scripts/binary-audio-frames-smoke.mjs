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
    inputBuses: [
      { index: 0, channels: [Float32Array.from([0.1, 0.2, 0.3])] },
      { index: 2, channels: [[0.9, 0.8, 0.7], [0.6, 0.5, 0.4]] }
    ],
    transport: { playing: true, samplePosition: 896 }
  }
};

const encodedRequest = encodeBinaryAudioEnvelope(requestEnvelope);
const decodedRequest = decodeBinaryAudioEnvelope(encodedRequest);
assert(decodedRequest.id === "binary-smoke-1", "binary request preserves envelope id");
assert(decodedRequest.payload.blockId === 7, "binary request preserves JSON payload fields");
assert(decodedRequest.payload.channels.length === 2, "binary request restores channel count");
assert(decodedRequest.payload.channels[0] instanceof Float32Array, "binary request restores typed channel buffers");
assert(Math.abs(decodedRequest.payload.channels[1][1] + 0.5) < 0.000001, "binary request restores Float32 samples");
assert(decodedRequest.payload.inputBuses.length === 2, "binary request restores input bus count");
assert(decodedRequest.payload.inputBuses[1].index === 2, "binary request restores input bus indexes");
assert(decodedRequest.payload.inputBuses[1].channels[0] instanceof Float32Array, "binary request restores typed input bus buffers");
assert(Math.abs(decodedRequest.payload.inputBuses[1].channels[0][2] - 0.7) < 0.000001, "binary request restores input bus samples");
assert(!("channels" in readBinaryHeader(encodedRequest).payload), "binary request keeps samples out of JSON header");
assert(!("inputBuses" in readBinaryHeader(encodedRequest).payload), "binary request keeps input bus samples out of JSON header");

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
    renderDurationMs: 1.5,
    renderBudgetMs: 2.667,
    renderBudgetExceeded: false,
    renderEngine: "mock"
  }
};

const decodedResponse = decodeBinaryAudioEnvelope(encodeBinaryAudioEnvelope(responseEnvelope));
assert(decodedResponse.ok === true, "binary response preserves ok status");
assert(decodedResponse.payload.latencySamples === 3, "binary response preserves non-audio payload metadata");
assert(decodedResponse.payload.renderDurationMs === 1.5, "binary response preserves render timing metadata");
assert(decodedResponse.payload.renderBudgetMs === 2.667, "binary response preserves render budget metadata");
assert(decodedResponse.payload.renderBudgetExceeded === false, "binary response preserves render budget verdict");
assert(decodedResponse.payload.outputBuses[0].channels[0][0] === 999, "binary response restores output bus samples");
assert(!("outputBuses" in readBinaryHeader(encodeBinaryAudioEnvelope(responseEnvelope)).payload), "binary response keeps output bus samples out of JSON header");
assert(decodedResponse.payload.channels[0][2] < 0, "binary response restores output samples");

const decodedSanitizedResponse = decodeBinaryAudioEnvelope(encodeBinaryAudioEnvelope({
  ...responseEnvelope,
  payload: {
    ...responseEnvelope.payload,
    channels: [Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY, 0.5])]
  }
}));
assert(decodedSanitizedResponse.payload.channels[0][0] === 0, "binary response sanitizes typed NaN samples");
assert(decodedSanitizedResponse.payload.channels[0][1] === 0, "binary response sanitizes typed infinite samples");
const decodedCoercedResponse = decodeBinaryAudioEnvelope(encodeBinaryAudioEnvelope({
  ...responseEnvelope,
  payload: { ...responseEnvelope.payload, channels: [["1", "bad"]] }
}));
assert(decodedCoercedResponse.payload.channels[0][0] === 1, "binary response coerces numeric string samples");
assert(decodedCoercedResponse.payload.channels[0][1] === 0, "binary response sanitizes nonnumeric string samples");

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
