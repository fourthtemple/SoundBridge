import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const workerPath = resolve("packages/web-client/dist/soundbridge-transport-worker.js");
const workerSource = readFileSync(workerPath, "utf8").replace(
  /import \{[\s\S]*?\} from "\.\/soundbridge-client\.js";/,
  `
const decodeBinaryAudioEnvelope = globalThis.decodeBinaryAudioEnvelope;
const encodeBinaryAudioEnvelope = globalThis.encodeBinaryAudioEnvelope;
`
);
const postedMessages = [];
const encodedBinaryChannels = [];
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
  encodeBinaryAudioEnvelope(_envelope, channels = []) {
    encodedBinaryChannels.push(channels);
    return new ArrayBuffer(8);
  },
  performance: {
    now() {
      return 123;
    }
  },
  setTimeout() {
    return 0;
  },
  self
};
context.globalThis = context;

vm.runInNewContext(workerSource, context, { filename: workerPath });

self.onmessage({ data: { type: "connect", url: "ws://127.0.0.1:47370/bridge" } });
const socket = FakeSocket.instances[0];
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
    channels: [input]
  }
});
assert(socket.sent.length === 1, "transport worker sends the audio process frame");
assert(audioPort.messages[0]?.type === "recycle-input", "transport worker recycles worklet input after send");
assert(audioPort.messages[0]?.channels?.[0] === input, "transport worker returns the original input channel");
assert(audioPort.transfers[0]?.[0] === input.buffer, "transport worker transfers the recycled input buffer");

socket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: "audio-1",
    ok: true,
    payload: {
      blockId: 7,
      channels: [[0.75, 1]],
      latencySamples: 0,
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

const sharedAudio = createSharedAudio(2, 1, 2);
writeSharedInput(sharedAudio, 13, [Float32Array.from([0.1, 0.2])]);
writeSharedInput(sharedAudio, 14, [Float32Array.from([0.3, 0.4])]);
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
  sharedPort.messages.some((message) => message.type === "shared-audio-status" && message.wakeMode === "atomics"),
  "transport worker reports atomic shared-audio wakeups"
);
assert(socket.sent.length === 2, "transport worker drains shared input up to its in-flight limit");
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
      latencySamples: 0,
      renderEngine: "shared-worker"
    }
  })
});
assert(socket.sent.length === 3, "transport worker resumes shared input drain after a response frees capacity");
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
  sharedPort.messages.some((message) => message.type === "process-diagnostics" && message.renderEngine === "shared-worker"),
  "transport worker forwards shared path render diagnostics"
);

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

function writeSharedInput(sharedAudio, blockId, channels) {
  const control = new Int32Array(sharedAudio.inputControl);
  const audio = new Float32Array(sharedAudio.inputAudio);
  const writeIndex = Atomics.load(control, 0);
  const metadataOffset = 8 + writeIndex * 4;
  Atomics.store(control, metadataOffset, blockId);
  Atomics.store(control, metadataOffset + 1, channels[0].length);
  Atomics.store(control, metadataOffset + 2, channels.length);
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
