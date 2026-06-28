import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { liveTransportForBlock } from "../packages/web-client/dist/soundbridge-client.js";

const workerPath = resolve("packages/web-client/dist/soundbridge-transport-worker.js");
const workerSource = readFileSync(workerPath, "utf8").replace(
  /import \{[\s\S]*?\} from "\.\/soundbridge-client\.js";/,
  `
const decodeBinaryAudioEnvelope = globalThis.decodeBinaryAudioEnvelope;
const encodeBinaryAudioEnvelope = globalThis.encodeBinaryAudioEnvelope;
const liveTransportForBlock = globalThis.liveTransportForBlock;
`
);
const postedMessages = [];
const timers = new Map();
const encodedBinaryChannels = [];
const encodedBinaryEnvelopes = [];
let timerSeq = 0;
let waitAsyncCalls = 0;
const testAtomics = {
  add: Atomics.add.bind(Atomics),
  exchange: Atomics.exchange.bind(Atomics),
  load: Atomics.load.bind(Atomics),
  notify: Atomics.notify.bind(Atomics),
  store: Atomics.store.bind(Atomics),
  sub: Atomics.sub.bind(Atomics),
  waitAsync(_typedArray, _index, _value, timeoutMs) {
    waitAsyncCalls += 1;
    assert(timeoutMs === 100, "transport worker uses a bounded shared-audio wait timeout");
    return { async: true, value: new Promise(() => {}) };
  }
};
const originalWaitAsync = testAtomics.waitAsync;

class FakeSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

class TestPort {
  onmessage = undefined;
  messages = [];
  transfers = [];
  closed = false;

  postMessage(message, transfer = []) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  close() {
    this.closed = true;
  }
}

const self = {
  onmessage: undefined,
  postMessage(message) {
    postedMessages.push(message);
  }
};
const context = {
  Array,
  ArrayBuffer,
  Atomics: testAtomics,
  Float32Array,
  Int32Array,
  JSON,
  Map,
  Math,
  Number,
  Set,
  SharedArrayBuffer,
  String,
  WebSocket: FakeSocket,
  console,
  decodeBinaryAudioEnvelope() {
    throw new Error("binary response decoding is not used by this smoke test");
  },
  encodeBinaryAudioEnvelope(envelope, channels = []) {
    encodedBinaryEnvelopes.push(envelope);
    encodedBinaryChannels.push(channels);
    return new ArrayBuffer(8);
  },
  liveTransportForBlock,
  performance: {
    now() {
      return 123;
    }
  },
  setTimeout(callback, ms) {
    const id = ++timerSeq;
    timers.set(id, { callback, ms });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  self
};
context.globalThis = context;

vm.runInNewContext(workerSource, context, { filename: workerPath });

self.onmessage({ data: { type: "connect", url: "ws://127.0.0.1:47370/bridge" } });
let socket = FakeSocket.instances[0];
assert(socket, "transport worker creates a WebSocket");
socket.emit("open", {});
assert(postedMessages.some((message) => message.type === "connected"), "transport worker reports connection open");

const audioPort = new TestPort();
self.onmessage({
  data: {
    type: "audio-port",
    port: audioPort,
    instanceId: "inst-1",
    sampleRate: 48000,
    sessionToken: "session-1",
    audioTransport: "binary"
  }
});
assert(typeof audioPort.onmessage === "function", "transport worker attaches an audio port handler");

const input = Float32Array.from([0.25, 0.5]);
audioPort.onmessage({
  data: {
    type: "process",
    blockId: 7,
    frames: 2,
    transportLatencySamples: 4,
    reportedLatencySamples: 6,
    channels: [input, input]
  }
});
assert(socket.sent.length === 1, "transport worker sends the audio process frame");
assert(encodedBinaryEnvelopes[0]?.payload.renderTimeoutMs === 2000, "transport worker forwards default render deadlines");
assert(encodedBinaryEnvelopes[0]?.payload.transport?.samplePosition === 20, "transport worker compensates direct transport sample positions from reported latency");
assert(audioPort.messages[0]?.type === "recycle-input", "transport worker recycles worklet input after send");
assert(audioPort.messages[0]?.channels?.[0] === input, "transport worker returns the original input channel");
assert(audioPort.messages[0]?.channels?.length === 1, "transport worker deduplicates aliased recycled input channels");
assert(audioPort.transfers[0]?.[0] === input.buffer, "transport worker transfers the recycled input buffer");
assert(audioPort.transfers[0]?.length === 1, "transport worker deduplicates aliased recycled input transfers");

socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "audio-1",
    ok: true,
    payload: {
      blockId: 7,
      channels: [[0.75, 1]],
      latencySamples: 32,
      renderDurationMs: 1.25,
      renderBudgetMs: 2.667,
      renderBudgetExceeded: false,
      renderEngine: "json-compat"
    }
  })
});
const processed = audioPort.messages.find((message) => message.type === "processed");
assert(processed?.channels?.[0]?.[0] === 0.75, "transport worker routes JSON-compatible processed responses");
assert(
  audioPort.transfers.at(-1).length === 0,
  "transport worker does not try to transfer plain JSON channel arrays"
);
assert(processed.renderDurationMs === 1.25, "transport worker routes render timing diagnostics on the port path");
assert(processed.renderBudgetMs === 2.667, "transport worker routes render budget diagnostics on the port path");
assert(processed.renderBudgetExceeded === false, "transport worker routes render budget verdict on the port path");

const sharedAudio = createSharedAudio(2, 1, 2);
writeSharedInput(sharedAudio, 13, [Float32Array.from([0.1, 0.2])], 6);
writeSharedInput(sharedAudio, 14, [Float32Array.from([0.3, 0.4])], 8);
const sharedPort = new TestPort();
self.onmessage({
  data: {
    type: "audio-port",
    port: sharedPort,
    instanceId: "inst-shared",
    sampleRate: 48000,
    sessionToken: "session-1",
    maxInFlightBlocks: 1,
    audioTransport: "binary",
    sharedAudio
  }
});
assert(
  sharedPort.messages.some((message) => message.type === "shared-audio-status" && message.wakeMode === "atomics" && message.sharedTransportInFlightBlocks === 0),
  "transport worker reports atomic shared-audio wakeups and bounded shared status"
);
assert(socket.sent.length === 2, "transport worker drains shared input up to its in-flight limit");
assert(encodedBinaryEnvelopes[1]?.payload.transport?.samplePosition === 32, "transport worker compensates shared-ring transport sample positions");
assert(Atomics.load(new Int32Array(sharedAudio.inputControl), 2) === 1, "transport worker leaves shared input queued under backpressure");
assert(waitAsyncCalls === 0, "transport worker does not wait for new shared input while backpressured");
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "audio-2",
    ok: true,
    payload: {
      blockId: 13,
      channels: [Float32Array.from([0.9, 0.8])],
      latencySamples: 32,
      renderDurationMs: 2.5,
      renderBudgetMs: 1.333,
      renderBudgetExceeded: true,
      renderEngine: "shared-worker"
    }
  })
});
assert(socket.sent.length === 3, "transport worker resumes shared input drain after a response frees capacity");
assert(encodedBinaryEnvelopes[2]?.payload.transport?.samplePosition === 36, "transport worker preserves per-block shared transport latency");
assert(Atomics.load(new Int32Array(sharedAudio.inputControl), 2) === 0, "transport worker consumes remaining shared input after backpressure clears");
assert(waitAsyncCalls === 1, "transport worker waits on shared input after draining queued blocks");
assert(
  encodedBinaryChannels[1]?.[0] === encodedBinaryChannels[2]?.[0],
  "transport worker reuses shared input buffers after binary send"
);
const sharedOutputControl = new Int32Array(sharedAudio.outputControl);
const sharedOutputAudio = new Float32Array(sharedAudio.outputAudio);
assert(Atomics.load(sharedOutputControl, 2) === 1, "transport worker writes shared output slots");
assert(
  Math.abs(sharedOutputAudio[0] - 0.9) < 0.000001 && Math.abs(sharedOutputAudio[1] - 0.8) < 0.000001,
  "transport worker writes shared output samples"
);
assert(
  sharedPort.messages.some((message) =>
    message.type === "process-diagnostics" &&
    message.renderEngine === "shared-worker" &&
    message.latencySamples === 32 &&
    message.renderDurationMs === 2.5 &&
    message.renderBudgetMs === 1.333 &&
    message.renderBudgetExceeded === true &&
    message.sharedTransportInFlightBlocks === 0 &&
    message.sharedInputBufferAllocations === 1
  ),
  "transport worker forwards shared path render timing and shared-ring diagnostics"
);

const outputPressureAudio = createSharedAudio(2, 1, 2);
writeSharedInput(outputPressureAudio, 30, [Float32Array.from([0.3, 0.3])]);
writeSharedInput(outputPressureAudio, 31, [Float32Array.from([0.31, 0.31])]);
const outputPressurePort = new TestPort();
self.onmessage({
  data: {
    type: "audio-port",
    port: outputPressurePort,
    instanceId: "inst-output-pressure",
    sampleRate: 48000,
    sessionToken: "session-1",
    maxInFlightBlocks: 2,
    audioTransport: "binary",
    sharedAudio: outputPressureAudio
  }
});
assert(socket.sent.length === 5, "transport worker drains multiple shared inputs up to capacity");
writeSharedInput(outputPressureAudio, 32, [Float32Array.from([0.32, 0.32])]);
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "audio-4",
    ok: true,
    payload: { blockId: 30, channels: [Float32Array.from([0.3, 0.3])], latencySamples: 0 }
  })
});
assert(socket.sent.length === 6, "transport worker drains new shared input after one output response");
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "audio-5",
    ok: true,
    payload: { blockId: 31, channels: [Float32Array.from([0.31, 0.31])], latencySamples: 0 }
  })
});
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "audio-6",
    ok: true,
    payload: { blockId: 32, channels: [Float32Array.from([0.32, 0.32])], latencySamples: 0 }
  })
});
const outputPressureControl = new Int32Array(outputPressureAudio.outputControl);
const outputPressureSamples = new Float32Array(outputPressureAudio.outputAudio);
assert(Atomics.load(outputPressureControl, 2) === 2, "transport worker keeps a full shared output ring bounded");
assert(Atomics.load(outputPressureControl, 3) === 1, "transport worker records overwritten shared output blocks");
assert(Atomics.load(outputPressureControl, 0) === 1 && Atomics.load(outputPressureControl, 1) === 1, "transport worker advances a full shared output ring after overwrite");
assert(Atomics.load(outputPressureControl, 8) === 32, "transport worker overwrites the oldest output slot with the newest block");
assert(Math.abs(outputPressureSamples[0] - 0.32) < 0.000001, "transport worker keeps the newest output audio under pressure");

const timeoutPort = new TestPort();
self.onmessage({
  data: {
    type: "audio-port",
    port: timeoutPort,
    instanceId: "inst-timeout",
    sampleRate: 48000,
    sessionToken: "session-1",
    audioRequestTimeoutMs: 25,
    audioTransport: "binary"
  }
});
timeoutPort.onmessage({
  data: {
    type: "process",
    blockId: 40,
    frames: 2,
    channels: [Float32Array.from([0.4, 0.4])]
  }
});
assert(encodedBinaryEnvelopes.at(-1)?.payload.renderTimeoutMs === 25, "transport worker forwards custom direct render deadlines");
runTimerWithDelay(25);
assert(
  timeoutPort.messages.some((message) => message.type === "audio-error" && message.blockId === 40 && /timed out/.test(message.error)),
  "transport worker times out direct audio requests"
);
const timedOutDirectId = encodedBinaryEnvelopes.at(-1)?.id;
const postedBeforeLateDirect = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: timedOutDirectId,
    ok: true,
    payload: { blockId: 40, channels: [Float32Array.from([0.4, 0.4])], latencySamples: 0 }
  })
});
assert(!timeoutPort.messages.some((message) => message.type === "processed" && message.blockId === 40), "transport worker ignores late direct audio responses after timeout");
assert(postedMessages.length === postedBeforeLateDirect, "transport worker suppresses late direct audio responses after timeout");

const sharedTimeoutAudio = createSharedAudio(2, 1, 2);
writeSharedInput(sharedTimeoutAudio, 50, [Float32Array.from([0.5, 0.5])]);
writeSharedInput(sharedTimeoutAudio, 51, [Float32Array.from([0.51, 0.51])]);
const sharedTimeoutPort = new TestPort();
const sentBeforeSharedTimeout = socket.sent.length;
self.onmessage({
  data: {
    type: "audio-port",
    port: sharedTimeoutPort,
    instanceId: "inst-shared-timeout",
    sampleRate: 48000,
    sessionToken: "session-1",
    maxInFlightBlocks: 1,
    audioRequestTimeoutMs: 30,
    audioTransport: "binary",
    sharedAudio: sharedTimeoutAudio
  }
});
assert(socket.sent.length === sentBeforeSharedTimeout + 1, "transport worker sends one shared block before timeout backpressure");
assert(encodedBinaryEnvelopes.at(-1)?.payload.renderTimeoutMs === 30, "transport worker forwards custom shared render deadlines");
const timedOutSharedId = encodedBinaryEnvelopes.at(-1)?.id;
runTimerWithDelay(30);
assert(
  sharedTimeoutPort.messages.some((message) => message.type === "audio-error" && message.blockId === 50 && /timed out/.test(message.error) && message.sharedTransportInFlightBlocks === 0),
  "transport worker times out shared audio requests"
);
assert(socket.sent.length === sentBeforeSharedTimeout + 2, "shared timeout releases capacity and drains the next queued block");
const postedBeforeLateShared = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: timedOutSharedId,
    ok: true,
    payload: { blockId: 50, channels: [Float32Array.from([0.5, 0.5])], latencySamples: 0 }
  })
});
assert(postedMessages.length === postedBeforeLateShared, "transport worker suppresses late shared audio responses after timeout");

const destroyPort = new TestPort();
self.onmessage({
  data: {
    type: "audio-port",
    port: destroyPort,
    instanceId: "inst-destroy-direct",
    sampleRate: 48000,
    sessionToken: "session-1",
    audioRequestTimeoutMs: 41,
    audioTransport: "binary"
  }
});
destroyPort.onmessage({
  data: {
    type: "process",
    blockId: 60,
    frames: 2,
    channels: [Float32Array.from([0.6, 0.6])]
  }
});
const destroyedDirectId = encodedBinaryEnvelopes.at(-1)?.id;
assert(countTimersWithDelay(41) === 1, "direct audio destroy setup leaves one pending render timer");
destroyPort.onmessage({ data: { type: "destroy" } });
assert(destroyPort.closed === true, "direct audio destroy closes the message port");
assert(countTimersWithDelay(41) === 0, "direct audio destroy clears pending render timers");
const postedBeforeDestroyedDirect = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: destroyedDirectId,
    ok: true,
    payload: { blockId: 60, channels: [Float32Array.from([0.6, 0.6])], latencySamples: 0 }
  })
});
assert(!destroyPort.messages.some((message) => message.type === "processed"), "direct audio destroy drops late render output");
assert(postedMessages.length === postedBeforeDestroyedDirect, "direct audio destroy suppresses late worker responses");

const destroySharedAudio = createSharedAudio(2, 1, 2);
writeSharedInput(destroySharedAudio, 61, [Float32Array.from([0.61, 0.61])]);
const destroySharedPort = new TestPort();
self.onmessage({
  data: {
    type: "audio-port",
    port: destroySharedPort,
    instanceId: "inst-destroy-shared",
    sampleRate: 48000,
    sessionToken: "session-1",
    maxInFlightBlocks: 1,
    audioRequestTimeoutMs: 43,
    audioTransport: "binary",
    sharedAudio: destroySharedAudio
  }
});
const destroyedSharedId = encodedBinaryEnvelopes.at(-1)?.id;
assert(countTimersWithDelay(43) === 1, "shared audio destroy setup leaves one pending render timer");
destroySharedPort.onmessage({ data: { type: "destroy" } });
assert(destroySharedPort.closed === true, "shared audio destroy closes the message port");
assert(countTimersWithDelay(43) === 0, "shared audio destroy clears pending render timers");
const postedBeforeDestroyedShared = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: destroyedSharedId,
    ok: true,
    payload: { blockId: 61, channels: [Float32Array.from([0.61, 0.61])], latencySamples: 0 }
  })
});
assert(Atomics.load(new Int32Array(destroySharedAudio.outputControl), 2) === 0, "shared audio destroy drops late output blocks");
assert(postedMessages.length === postedBeforeDestroyedShared, "shared audio destroy suppresses late worker responses");

clearTimersWithDelay(1);
const timerFallbackAudio = createSharedAudio(2, 1, 2);
const timerFallbackPort = new TestPort();
testAtomics.waitAsync = undefined;
self.onmessage({
  data: {
    type: "audio-port",
    port: timerFallbackPort,
    instanceId: "inst-timer-fallback",
    sampleRate: 48000,
    sessionToken: "session-1",
    audioTransport: "binary",
    sharedAudio: timerFallbackAudio
  }
});
assert(
  timerFallbackPort.messages.some((message) => message.type === "shared-audio-status" && message.wakeMode === "timer"),
  "transport worker reports timer shared-audio wakeups when atomics wait is unavailable"
);
assert([...timers.values()].some((timer) => timer.ms === 1), "transport worker polls timer shared-audio fallback at live-safe cadence");
const timerPollsBeforeDestroy = countTimersWithDelay(1);
timerFallbackPort.onmessage({ data: { type: "destroy" } });
runTimerWithDelay(1);
assert(countTimersWithDelay(1) === timerPollsBeforeDestroy - 1, "destroyed timer shared-audio fallback stops polling");
testAtomics.waitAsync = originalWaitAsync;

const genericEnvelope = {
  type: "request",
  id: "generic-ok",
  command: "hello",
  payload: {}
};
self.onmessage({ data: { type: "request", envelope: genericEnvelope, timeoutMs: 17 } });
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "generic-ok",
    ok: true,
    payload: { version: "test" }
  })
});
assert(
  postedMessages.some((message) => message.type === "message" && message.envelope?.id === "generic-ok"),
  "transport worker routes generic responses"
);

const genericTimeoutEnvelope = {
  type: "request",
  id: "generic-timeout",
  command: "processAudioBlock",
  payload: { instanceId: "inst-timeout", blockId: 90 }
};
const sentBeforeGenericTimeout = socket.sent.length;
self.onmessage({ data: { type: "request", envelope: genericTimeoutEnvelope, timeoutMs: 15 } });
assert(socket.sent.length === sentBeforeGenericTimeout + 1, "transport worker sends generic requests");
runTimerWithDelay(15);
assert(
  postedMessages.some((message) => message.type === "send-error" && message.id === "generic-timeout" && /timed out/.test(message.message)),
  "transport worker times out generic worker requests"
);
const postedBeforeLateGeneric = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "generic-timeout",
    ok: true,
    payload: { blockId: 90, channels: [[0.9]], latencySamples: 0 }
  })
});
assert(postedMessages.length === postedBeforeLateGeneric, "transport worker suppresses late generic responses after timeout");

const sentBeforeStaleCap = socket.sent.length;
for (let index = 0; index < 1030; index += 1) {
  self.onmessage({
    data: {
      type: "request",
      envelope: { type: "request", id: `generic-cap-${index}`, command: "hello", payload: {} },
      timeoutMs: 19
    }
  });
  runTimerWithDelay(19);
}
assert(
  socket.sent.length === sentBeforeStaleCap + 1030,
  "transport worker keeps sending timed generic requests while bounding stale ids"
);
const postedBeforeRecentLate = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({ type: "response", id: "generic-cap-1029", ok: true, payload: {} })
});
assert(postedMessages.length === postedBeforeRecentLate, "transport worker suppresses recent stale responses inside the bounded cache");
const postedBeforeEvictedLate = postedMessages.length;
socket.emit("message", {
  data: JSON.stringify({ type: "response", id: "generic-cap-0", ok: true, payload: {} })
});
assert(
  postedMessages.length === postedBeforeEvictedLate + 1 &&
    postedMessages.at(-1)?.type === "message" &&
    postedMessages.at(-1)?.envelope?.id === "generic-cap-0",
  "transport worker evicts oldest stale response ids after the bounded cache fills"
);

const oldSocket = socket;
self.onmessage({ data: { type: "connect", url: "ws://127.0.0.1:47370/bridge?reconnect=1" } });
socket = FakeSocket.instances.at(-1);
assert(socket && socket !== oldSocket, "transport worker creates a fresh socket on reconnect");
socket.emit("open", {});
const reconnectEnvelope = {
  type: "request",
  id: "generic-reconnect",
  command: "hello",
  payload: {}
};
self.onmessage({ data: { type: "request", envelope: reconnectEnvelope, timeoutMs: 23 } });
const postedBeforeOldSocketEvents = postedMessages.length;
oldSocket.emit("message", {
  data: JSON.stringify({ type: "response", id: "generic-reconnect", ok: true, payload: { stale: true } })
});
oldSocket.emit("error", {});
oldSocket.emit("close", {});
assert(postedMessages.length === postedBeforeOldSocketEvents, "transport worker ignores stale socket events after reconnect");
socket.emit("message", {
  data: JSON.stringify({ type: "response", id: "generic-reconnect", ok: true, payload: { fresh: true } })
});
assert(
  postedMessages.at(-1)?.type === "message" &&
    postedMessages.at(-1)?.envelope?.id === "generic-reconnect" &&
    postedMessages.at(-1)?.envelope?.payload?.fresh === true,
  "transport worker routes the active socket response after reconnect"
);

clearTimersWithDelay(1);
const closeFallbackAudio = createSharedAudio(2, 1, 2);
const closeFallbackPort = new TestPort();
testAtomics.waitAsync = undefined;
self.onmessage({
  data: {
    type: "audio-port",
    port: closeFallbackPort,
    instanceId: "inst-close-fallback",
    sampleRate: 48000,
    sessionToken: "session-1",
    audioTransport: "binary",
    sharedAudio: closeFallbackAudio
  }
});
const timerPollsBeforeClose = countTimersWithDelay(1);
socket.close();
runTimerWithDelay(1);
assert(countTimersWithDelay(1) === timerPollsBeforeClose - 1, "timer shared-audio fallback stops polling after socket close");
testAtomics.waitAsync = originalWaitAsync;

console.log("Transport worker audio port smoke checks passed.");

function createSharedAudio(slots, channels, frames) {
  const controlInts = 8 + slots * 4;
  const audioSamples = slots * channels * frames;
  return {
    version: 1,
    slots,
    channels,
    frames,
    inputControl: new SharedArrayBuffer(controlInts * Int32Array.BYTES_PER_ELEMENT),
    inputAudio: new SharedArrayBuffer(audioSamples * Float32Array.BYTES_PER_ELEMENT),
    outputControl: new SharedArrayBuffer(controlInts * Int32Array.BYTES_PER_ELEMENT),
    outputAudio: new SharedArrayBuffer(audioSamples * Float32Array.BYTES_PER_ELEMENT)
  };
}

function writeSharedInput(sharedAudio, blockId, channels, transportLatencySamples = 0) {
  const control = new Int32Array(sharedAudio.inputControl);
  const audio = new Float32Array(sharedAudio.inputAudio);
  const writeIndex = Atomics.load(control, 0);
  const metadataOffset = 8 + writeIndex * 4;
  Atomics.store(control, metadataOffset, blockId);
  Atomics.store(control, metadataOffset + 1, channels[0].length);
  Atomics.store(control, metadataOffset + 2, channels.length);
  Atomics.store(control, metadataOffset + 3, transportLatencySamples);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    audio.set(channels[channelIndex], writeIndex * sharedAudio.channels * sharedAudio.frames + channelIndex * sharedAudio.frames);
  }
  Atomics.store(control, 0, (writeIndex + 1) % sharedAudio.slots);
  Atomics.add(control, 2, 1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runTimerWithDelay(ms) {
  const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
  assert(entry, `expected timer with ${ms}ms delay`);
  const [id, timer] = entry;
  timers.delete(id);
  timer.callback();
}

function countTimersWithDelay(ms) {
  return [...timers.values()].filter((timer) => timer.ms === ms).length;
}

function clearTimersWithDelay(ms) {
  for (const [id, timer] of timers) {
    if (timer.ms === ms) {
      timers.delete(id);
    }
  }
}
