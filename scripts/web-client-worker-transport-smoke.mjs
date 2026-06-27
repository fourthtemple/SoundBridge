class FakeWorker extends EventTarget {
  static last;

  constructor(url, options) {
    super();
    this.url = String(url);
    this.options = options;
    this.messages = [];
    FakeWorker.last = this;
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => this.respond(message));
  }

  respond(message) {
    if (message.type === "connect") {
      this.dispatchEvent(new MessageEvent("message", { data: { type: "connected" } }));
      return;
    }
    if (message.type !== "request") {
      return;
    }
    const envelope = message.envelope;
    const response = {
      type: "response",
      id: envelope.id,
      ok: true,
      payload: responsePayload(envelope.command, envelope.payload)
    };
    this.dispatchEvent(new MessageEvent("message", { data: { type: "message", envelope: response } }));
  }
}

class FakeAudioWorkletNode {
  static last;

  constructor(context, name, options) {
    this.context = context;
    this.name = name;
    this.options = options;
    this.port = new FakeAudioPort();
    FakeAudioWorkletNode.last = this;
  }

  connect(destination) {
    return destination;
  }

  disconnect() {}
}

class FakeAudioPort {
  onmessage = undefined;
  messages = [];
  transfers = [];

  postMessage(message, transfer = []) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }
}

Object.defineProperty(globalThis, "crossOriginIsolated", {
  value: true,
  configurable: true
});
globalThis.Worker = FakeWorker;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;

const {
  SoundBridgeAudioNode,
  SoundBridgeClient,
  createLivePerformanceAudioNodeOptions
} = await import("../packages/web-client/dist/soundbridge-client.js");
const client = new SoundBridgeClient({
  url: "ws://127.0.0.1:47370/bridge",
  origin: "http://127.0.0.1:5173",
  transport: "worker"
});

await client.connect();
assert(FakeWorker.last.options?.type === "module", "worker transport uses a module worker");
assert(FakeWorker.last.messages[0].type === "connect", "worker transport receives connect command");

const pair = await client.pair("token");
assert(pair.sessionToken === "session-1", "worker transport pair response resolves through client");
assert(FakeWorker.last.messages.at(-1).timeoutMs === 5000, "worker transport receives default request deadlines");

const audioPort = client.createAudioWorkletTransportPort({
  instanceId: "inst-1",
  sampleRate: 48000,
  maxInFlightBlocks: 3,
  audioTransport: "binary"
});
const audioPortMessage = FakeWorker.last.messages.at(-1);
assert(audioPort, "worker transport creates an audio worklet port after pairing");
assert(audioPortMessage.type === "audio-port", "worker transport registers audio worklet ports with the worker");
assert(audioPortMessage.instanceId === "inst-1", "worker audio port registration includes instance id");
assert(audioPortMessage.maxInFlightBlocks === 3, "worker audio port registration includes the bounded in-flight limit");
assert(audioPortMessage.audioRequestTimeoutMs === 2000, "worker audio port registration includes the default audio timeout");
assert(audioPortMessage.sharedAudio?.inputControl instanceof SharedArrayBuffer, "worker audio port registration includes shared input control when isolated");
assert(audioPortMessage.sharedAudio?.outputAudio instanceof SharedArrayBuffer, "worker audio port registration includes shared output audio when isolated");
audioPort.close();

const processed = await client.processAudioBlockBinary({
  instanceId: "inst-1",
  blockId: 42,
  sampleRate: 48000,
  channels: [Float32Array.from([1, 0.5])],
  inputBuses: [{ index: 1, channels: [Float32Array.from([0.25, 0.125])] }]
});
const audioMessage = FakeWorker.last.messages.at(-1);
assert(audioMessage.type === "request", "worker transport receives binary audio request");
assert(audioMessage.timeoutMs === 2000, "worker transport receives audio request deadlines");
assert(Array.isArray(audioMessage.binaryAudioChannels), "worker transport carries binary audio channels separately");
assert(audioMessage.envelope.payload.inputBuses[0].index === 1, "worker transport preserves bus metadata");
assert(!("channels" in audioMessage.envelope.payload), "worker transport keeps main channels out of JSON payload");
assert(processed.channels[0][0] === 0.5, "worker transport resolves processed audio response");

const liveNodeOptions = createLivePerformanceAudioNodeOptions({
  instanceId: "inst-live",
  inputChannels: 2,
  outputChannels: 2
});
assert(liveNodeOptions.audioTransport === "binary", "live AudioNode preset uses binary audio");
assert(liveNodeOptions.audioRequestTimeoutMs === 250, "live AudioNode preset uses a bounded audio request timeout");
assert(liveNodeOptions.audioTransferMode === "auto", "live AudioNode preset stays shared-memory capable");
assert(liveNodeOptions.maxInFlightBlocks === 4, "live AudioNode preset bounds in-flight work");
assert(liveNodeOptions.maxQueuedOutputBlocks === 8, "live AudioNode preset bounds queued output");
assert(liveNodeOptions.outputLatencyBlocks === 2, "live AudioNode preset starts at two output blocks");
assert(liveNodeOptions.minOutputLatencyBlocks === 1, "live AudioNode preset can recover to one output block");
assert(liveNodeOptions.maxOutputLatencyBlocks === 4, "live AudioNode preset bounds adaptive latency growth");
assert(liveNodeOptions.latencyRecoveryBlocks === 128, "live AudioNode preset recovers faster than the generic default");
assert(liveNodeOptions.latencyPressureThresholdBlocks === 2, "live AudioNode preset reacts to deadline pressure quickly");
assert(liveNodeOptions.sharedBufferBlocks === 4, "live AudioNode preset uses a compact shared audio ring");
assert(liveNodeOptions.maxBlockFrames === 128, "live AudioNode preset keeps 128-frame block metadata");

const overriddenLiveNodeOptions = createLivePerformanceAudioNodeOptions({
  instanceId: "inst-override",
  inputChannels: 2,
  outputChannels: 2,
  audioTransport: "json",
  audioRequestTimeoutMs: 333,
  audioTransferMode: "message",
  maxInFlightBlocks: 9,
  maxQueuedOutputBlocks: 6,
  outputLatencyBlocks: 3,
  minOutputLatencyBlocks: 2,
  maxOutputLatencyBlocks: 6,
  latencyRecoveryBlocks: 64,
  latencyPressureThresholdBlocks: 5,
  sharedBufferBlocks: 7,
  maxBlockFrames: 256
});
assert(overriddenLiveNodeOptions.audioTransport === "json", "live AudioNode preset preserves explicit transport overrides");
assert(overriddenLiveNodeOptions.audioRequestTimeoutMs === 333, "live AudioNode preset preserves explicit timeout overrides");
assert(overriddenLiveNodeOptions.audioTransferMode === "message", "live AudioNode preset preserves explicit transfer-mode overrides");
assert(overriddenLiveNodeOptions.maxInFlightBlocks === 9, "live AudioNode preset preserves explicit in-flight overrides");
assert(overriddenLiveNodeOptions.maxQueuedOutputBlocks === 6, "live AudioNode preset preserves explicit queue overrides");
assert(overriddenLiveNodeOptions.outputLatencyBlocks === 3, "live AudioNode preset preserves explicit latency overrides");
assert(overriddenLiveNodeOptions.minOutputLatencyBlocks === 2, "live AudioNode preset preserves explicit minimum latency overrides");
assert(overriddenLiveNodeOptions.maxOutputLatencyBlocks === 6, "live AudioNode preset preserves explicit maximum latency overrides");
assert(overriddenLiveNodeOptions.latencyRecoveryBlocks === 64, "live AudioNode preset preserves explicit recovery overrides");
assert(overriddenLiveNodeOptions.latencyPressureThresholdBlocks === 5, "live AudioNode preset preserves explicit pressure overrides");
assert(overriddenLiveNodeOptions.sharedBufferBlocks === 7, "live AudioNode preset preserves explicit shared-ring overrides");
assert(overriddenLiveNodeOptions.maxBlockFrames === 256, "live AudioNode preset preserves explicit block-frame overrides");

const addedModules = [];
const fakeContext = {
  sampleRate: 48000,
  audioWorklet: {
    async addModule(url) {
      addedModules.push(String(url));
    }
  }
};
const liveNode = await SoundBridgeAudioNode.createLivePerformance(fakeContext, client, {
  instanceId: "inst-live-node",
  inputChannels: 2,
  outputChannels: 2,
  workletUrl: "/soundbridge-worklet.js"
});
assert(liveNode instanceof SoundBridgeAudioNode, "createLivePerformance returns a SoundBridgeAudioNode");
assert(addedModules[0] === "/soundbridge-worklet.js", "createLivePerformance loads the requested worklet");
const processorOptions = FakeAudioWorkletNode.last.options.processorOptions;
assert(processorOptions.maxInFlightBlocks === 4, "createLivePerformance forwards live in-flight limits to the worklet");
assert(processorOptions.maxQueuedOutputBlocks === 8, "createLivePerformance forwards live output queue limits");
assert(processorOptions.outputLatencyBlocks === 2, "createLivePerformance forwards live output latency");
assert(processorOptions.maxOutputLatencyBlocks === 4, "createLivePerformance forwards live adaptive latency bounds");
assert(processorOptions.latencyRecoveryBlocks === 128, "createLivePerformance forwards live recovery timing");
const liveAudioPortMessage = FakeWorker.last.messages.at(-1);
assert(liveAudioPortMessage.type === "audio-port", "createLivePerformance registers a worker audio port");
assert(liveAudioPortMessage.maxInFlightBlocks === 4, "createLivePerformance forwards live in-flight limits to the worker");
assert(liveAudioPortMessage.audioRequestTimeoutMs === 250, "createLivePerformance forwards live audio timeouts to the worker");
assert(liveAudioPortMessage.audioTransport === "binary", "createLivePerformance registers binary worker audio");
assert(liveAudioPortMessage.sharedAudio?.slots === 4, "createLivePerformance registers the live shared ring depth");
assert(
  FakeAudioWorkletNode.last.port.messages.some((message) => message.type === "connect-transport"),
  "createLivePerformance connects the worklet to the worker transport"
);

const fallbackCalls = [];
const fallbackClient = {
  createAudioWorkletTransportConnection() {
    return undefined;
  },
  processAudioBlockBinary(request, timeoutMs) {
    fallbackCalls.push({ request, timeoutMs });
    return Promise.resolve({
      blockId: request.blockId,
      channels: [Float32Array.from([0.25, 0.125])],
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false
    });
  },
  processAudioBlock(request, timeoutMs) {
    fallbackCalls.push({ request, timeoutMs });
    return Promise.resolve({
      blockId: request.blockId,
      channels: request.channels,
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false
    });
  }
};
await SoundBridgeAudioNode.createLivePerformance(fakeContext, fallbackClient, {
  instanceId: "inst-fallback",
  inputChannels: 1,
  outputChannels: 1,
  workletUrl: "/soundbridge-worklet.js"
});
const fallbackPort = FakeAudioWorkletNode.last.port;
fallbackPort.onmessage({
  data: {
    type: "process",
    blockId: 77,
    frames: 2,
    channels: [Float32Array.from([0.1, 0.2])]
  }
});
await Promise.resolve();
await Promise.resolve();
assert(fallbackCalls[0]?.timeoutMs === 250, "live AudioNode page fallback uses the live audio timeout");
assert(fallbackCalls[0]?.request.instanceId === "inst-fallback", "live AudioNode fallback forwards instance id");
assert(
  fallbackPort.messages.some((message) => message.type === "processed" && message.blockId === 77),
  "live AudioNode fallback posts processed blocks"
);

console.log("Web client worker transport smoke checks passed.");

function responsePayload(command, payload) {
  if (command === "pair") {
    return { sessionToken: "session-1", expiresAt: Date.now() + 1000 };
  }
  if (command === "processAudioBlock") {
    return {
      blockId: payload.blockId,
      channels: [Float32Array.from([0.5, 0.25])],
      outputBuses: [{ index: 0, channels: [Float32Array.from([0.5, 0.25])] }],
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false
    };
  }
  return {};
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
