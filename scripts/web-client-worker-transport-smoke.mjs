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

class FakeMainSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.readyState = FakeMainSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeMainSocket.instances.push(this);
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
    this.emit("close", {});
  }

  emit(type, event) {
    if (type === "open") {
      this.readyState = FakeMainSocket.OPEN;
    } else if (type === "close") {
      this.readyState = FakeMainSocket.CLOSED;
    }
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

Object.defineProperty(globalThis, "crossOriginIsolated", {
  value: true,
  configurable: true
});
globalThis.Worker = FakeWorker;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
globalThis.WebSocket = FakeMainSocket;

const { SoundBridgeAudioNode, SoundBridgeClient, createLivePerformanceAudioNodeOptions } = await import("../packages/web-client/dist/soundbridge-client.js");
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
assert(liveNodeOptions.latencyPressureThresholdBlocks === 2 && liveNodeOptions.responseJitterThresholdBlocks === 2, "live AudioNode preset reacts to deadline and jitter pressure quickly");
assert(liveNodeOptions.statsIntervalBlocks === 32, "live AudioNode preset reports stats quickly for live hosts");
assert(liveNodeOptions.sharedBufferBlocks === 8, "live AudioNode preset derives shared ring depth from queue and latency bounds");
assert(liveNodeOptions.maxBlockFrames === 128, "live AudioNode preset keeps 128-frame block metadata");
assert(liveNodeOptions.maxConsecutiveRenderBudgetMisses === 2, "live AudioNode preset fails dry after repeated budget misses");
assert(liveNodeOptions.maxConsecutiveAudioErrors === 1, "live AudioNode preset fails dry on audio errors");
assert(liveNodeOptions.maxConsecutiveTransportPressureEvents === 3, "live AudioNode preset fails dry after sustained transport pressure");

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
  maxBlockFrames: 256,
  maxConsecutiveRenderBudgetMisses: 5,
  maxConsecutiveAudioErrors: 4,
  maxConsecutiveTransportPressureEvents: 6
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
assert(overriddenLiveNodeOptions.maxConsecutiveRenderBudgetMisses === 5, "live AudioNode preset preserves budget miss overrides");
assert(overriddenLiveNodeOptions.maxConsecutiveAudioErrors === 4, "live AudioNode preset preserves audio-error overrides");
assert(overriddenLiveNodeOptions.maxConsecutiveTransportPressureEvents === 6, "live AudioNode preset preserves transport-pressure overrides");

const addedModules = [];
const fakeContext = {
  sampleRate: 48000,
  audioWorklet: {
    async addModule(url) {
      addedModules.push(String(url));
    }
  }
};
await SoundBridgeAudioNode.createLivePerformance(fakeContext, client, { instanceId: "inst-source-node", inputChannels: 0, outputChannels: 2, workletUrl: "/soundbridge-worklet.js" });
assert(FakeAudioWorkletNode.last.options.numberOfInputs === 0 && FakeAudioWorkletNode.last.options.channelCount === 1 && FakeAudioWorkletNode.last.options.processorOptions.inputChannels === 0, "zero-input live AudioNodes are source-style worklets");
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
assert(processorOptions.statsIntervalBlocks === 32 && processorOptions.responseJitterThresholdBlocks === 2, "createLivePerformance forwards live stats and jitter cadence");
assert(processorOptions.bypassed === false, "createLivePerformance starts the worklet unbypassed by default");
const liveAudioPortMessage = FakeWorker.last.messages.at(-1);
assert(liveAudioPortMessage.type === "audio-port", "createLivePerformance registers a worker audio port");
assert(liveAudioPortMessage.maxInFlightBlocks === 4, "createLivePerformance forwards live in-flight limits to the worker");
assert(liveAudioPortMessage.audioRequestTimeoutMs === 250, "createLivePerformance forwards live audio timeouts to the worker");
assert(liveAudioPortMessage.audioTransport === "binary", "createLivePerformance registers binary worker audio");
assert(liveAudioPortMessage.sharedAudio?.slots === 8, "createLivePerformance registers the live shared ring depth");
assert(FakeAudioWorkletNode.last.port.messages.some((message) => message.type === "connect-transport"), "createLivePerformance connects the worklet to the worker transport");
let healthChangeEvents = 0;
let healthChangeDetail;
liveNode.addEventListener("healthchange", (event) => {
  healthChangeEvents += 1;
  healthChangeDetail = event.detail;
});
let retryEvents = 0, retryDetail;
liveNode.addEventListener("retry", (event) => { retryEvents += 1; retryDetail = event.detail; });
assert(liveNode.health.bypassed === false, "SoundBridgeAudioNode health starts unbypassed");
assert(liveNode.health.maxConsecutiveRenderBudgetMisses === 2, "SoundBridgeAudioNode health reports the render-budget miss threshold");
assert(liveNode.health.maxConsecutiveAudioErrors === 1, "SoundBridgeAudioNode health reports the audio-error threshold");
assert(liveNode.health.maxConsecutiveTransportPressureEvents === 3, "SoundBridgeAudioNode health reports the transport-pressure threshold");
assert(liveNode.retry() === false && retryEvents === 0, "SoundBridgeAudioNode retry is idle before auto-bypass");
liveNode.setBypassed(true);
assert(liveNode.health.bypassed === true, "SoundBridgeAudioNode health tracks manual bypass");
assert(liveNode.health.bypassEvents === 1, "SoundBridgeAudioNode health counts bypass changes");
assert(
  FakeAudioWorkletNode.last.port.messages.at(-1)?.type === "set-bypassed" &&
    FakeAudioWorkletNode.last.port.messages.at(-1)?.bypassed === true,
  "SoundBridgeAudioNode sends bypass commands to the worklet"
);
assert(healthChangeEvents === 1 && healthChangeDetail?.bypassed === true, "manual bypass emits a healthchange event");
liveNode.setBypassed(true);
assert(healthChangeEvents === 1, "unchanged bypass state does not emit duplicate healthchange events");
liveNode.setBypassed(false);
assert(liveNode.health.bypassed === false, "SoundBridgeAudioNode can return to wet processing");
assert(liveNode.health.bypassEvents === 2, "SoundBridgeAudioNode counts wet/dry bypass transitions");
assert(healthChangeEvents === 2 && healthChangeDetail?.bypassed === false, "clearing bypass emits a healthchange event");
let statsEvents = 0;
let statsDetail;
liveNode.addEventListener("stats", (event) => { statsEvents += 1; statsDetail = event.detail; });
let fallbackOutputEvents = 0, fallbackOutputDetail;
liveNode.addEventListener("fallback-output", (event) => { fallbackOutputEvents += 1; fallbackOutputDetail = event.detail; });
let transportPressureEvents = 0;
let transportPressureDetail;
let transportPressureAutoBypassEvents = 0;
let transportPressureAutoBypassDetail;
liveNode.addEventListener("transport-pressure", (event) => { transportPressureEvents += 1; transportPressureDetail = event.detail; });
liveNode.addEventListener("transport-pressure-auto-bypassed", (event) => { transportPressureAutoBypassEvents += 1; transportPressureAutoBypassDetail = event.detail; });
let latencyEvents = 0;
let latencyDetail;
liveNode.addEventListener("latencychange", (event) => { latencyEvents += 1; latencyDetail = event.detail; });
const pressureStats = {
  type: "stats",
  inFlightBlocks: 3,
  queuedOutputBlocks: 2,
  outputLatencyBlocks: 2,
  transportLatencySamples: 256,
  latencyIncreases: 1,
  latencyDecreases: 0,
  responseDeadlineLeadSamples: -128,
  responseJitterBlocks: 3,
  responseJitterSamples: 384,
  responseDeadlineMisses: 4,
  responseDeadlineMissesSinceLastStats: 1,
  fallbackOutputBlocks: 7,
  lastFallbackReason: "underrun",
  staleOutputBlocks: 2,
  droppedInputBlocks: 1,
  underruns: 7,
  sharedAudioEnabled: true,
  sharedInputQueuedBlocks: 3,
  sharedOutputQueuedBlocks: 4,
  sharedInputDroppedBlocks: 5,
  sharedOutputDroppedBlocks: 6,
  sharedTransportInFlightBlocks: 4
};
FakeAudioWorkletNode.last.port.onmessage({ data: pressureStats });
assert(statsEvents === 1, "SoundBridgeAudioNode emits one stats event per worklet stats message");
assert(statsDetail.transportLatencySamples === 256 && statsDetail.fallbackOutputBlocks === 7 && statsDetail.sharedBufferBlocks === 8, "SoundBridgeAudioNode preserves stats event details and fixed shared-ring capacity");
assert(fallbackOutputEvents === 1 && fallbackOutputDetail?.deltaBlocks === 7 && fallbackOutputDetail?.reason === "underrun", "SoundBridgeAudioNode emits fallback-output for new fallback blocks");
assert(liveNode.health.inFlightBlocks === 3, "SoundBridgeAudioNode health tracks worklet in-flight blocks");
assert(liveNode.health.queuedOutputBlocks === 2, "SoundBridgeAudioNode health tracks queued output blocks");
assert(liveNode.health.outputLatencyBlocks === 2, "SoundBridgeAudioNode health tracks output latency blocks");
assert(liveNode.health.transportLatencySamples === 256, "SoundBridgeAudioNode health tracks transport latency samples");
assert(liveNode.health.reportedLatencySamples === 256, "SoundBridgeAudioNode health combines transport latency before plugin refresh");
assert(liveNode.health.reportedLatencyMs === 5.333, "SoundBridgeAudioNode health exposes reported latency in milliseconds");
assert(liveNode.health.latencyIncreases === 1, "SoundBridgeAudioNode health tracks adaptive latency increases");
assert(liveNode.health.latencyDecreases === 0, "SoundBridgeAudioNode health tracks adaptive latency decreases");
assert(liveNode.health.latencyChangeEvents === 1, "SoundBridgeAudioNode health counts latency changes");
assert(liveNode.health.lastLatencyChangeDirection === "increased", "SoundBridgeAudioNode health tracks latency direction");
assert(liveNode.health.responseDeadlineLeadSamples === -128, "SoundBridgeAudioNode health tracks deadline lead");
assert(liveNode.health.responseJitterSamples === 384 && liveNode.health.responseJitterBlocks === 3 && liveNode.health.responseJitterThresholdBlocks === 2, "SoundBridgeAudioNode health tracks response jitter against the live threshold");
assert(liveNode.health.responseDeadlineMisses === 4 && liveNode.health.responseDeadlineMissesSinceLastStats === 1, "SoundBridgeAudioNode health tracks deadline misses");
assert(liveNode.health.fallbackOutputBlocks === 7 && liveNode.health.lastFallbackReason === "underrun", "SoundBridgeAudioNode health tracks fallback output");
assert(liveNode.health.staleOutputBlocks === 2, "SoundBridgeAudioNode health tracks stale output blocks");
assert(liveNode.health.droppedInputBlocks === 1, "SoundBridgeAudioNode health tracks dropped input blocks");
assert(liveNode.health.underruns === 7, "SoundBridgeAudioNode health tracks underruns");
assert(liveNode.health.sharedAudioEnabled === true && liveNode.health.sharedInputQueuedBlocks === 3 && liveNode.health.sharedOutputQueuedBlocks === 4, "SoundBridgeAudioNode health tracks shared audio queue depth");
assert(liveNode.health.sharedInputDroppedBlocks === 5, "SoundBridgeAudioNode health tracks shared input drops");
assert(liveNode.health.sharedOutputDroppedBlocks === 6, "SoundBridgeAudioNode health tracks shared output drops");
assert(latencyEvents === 1, "SoundBridgeAudioNode emits latencychange when worklet latency changes");
assert(latencyDetail?.direction === "increased", "latencychange reports adaptive latency increase direction");
assert(latencyDetail?.previous?.outputLatencyBlocks === 0, "latencychange includes previous latency state");
assert(latencyDetail?.health?.transportLatencySamples === 256, "latencychange includes updated health");
assert(transportPressureEvents === 1, "SoundBridgeAudioNode emits transport-pressure on increased pressure counters");
assert(
  transportPressureDetail?.reasons?.join(",") === "deadline-miss,response-jitter,stale-output,dropped-input,underrun,shared-input-drop,shared-output-drop,shared-transport-saturation",
  "transport-pressure reports bounded pressure reasons"
);
assert(transportPressureDetail?.health?.transportPressureEvents === 1, "transport-pressure includes updated health");
assert(
  liveNode.health.lastTransportPressureReasons.includes("deadline-miss"),
  "SoundBridgeAudioNode health tracks the latest transport-pressure reason"
);
FakeAudioWorkletNode.last.port.onmessage({ data: { ...pressureStats, sharedTransportInFlightBlocks: 0 } });
assert(fallbackOutputEvents === 1, "SoundBridgeAudioNode does not repeat fallback-output for unchanged counters");
assert(transportPressureEvents === 1, "SoundBridgeAudioNode does not repeat transport-pressure for unchanged counters");
assert(latencyEvents === 1, "SoundBridgeAudioNode does not repeat latencychange for unchanged latency stats");
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    ...pressureStats,
    outputLatencyBlocks: 1,
    transportLatencySamples: 128,
    latencyDecreases: 1, sharedTransportInFlightBlocks: 0
  }
});
assert(latencyEvents === 2, "SoundBridgeAudioNode emits latencychange when adaptive latency recovers");
assert(latencyDetail?.direction === "decreased", "latencychange reports adaptive latency decrease direction");
assert(liveNode.health.latencyDecreases === 1, "SoundBridgeAudioNode health tracks latency recovery decreases");
assert(liveNode.health.lastLatencyChangeDirection === "decreased", "SoundBridgeAudioNode health tracks recovery direction");
assert(transportPressureEvents === 1, "latency recovery without new pressure counters does not emit transport-pressure");
const refreshedLatency = await liveNode.refreshLatency(384);
const latencyRequest = FakeWorker.last.messages.at(-1);
assert(latencyRequest.envelope.command === "getLatency", "SoundBridgeAudioNode refreshLatency requests daemon latency");
assert(latencyRequest.envelope.payload.transportLatencySamples === 384 && FakeAudioWorkletNode.last.port.messages.some((message) => message.type === "set-output-latency" && message.outputLatencyBlocks === 3), "refreshLatency retargets worklet output latency and daemon latency");
assert(refreshedLatency.pluginLatencySamples === 96, "refreshLatency stores plugin latency in health");
assert(refreshedLatency.reportedLatencySamples === 480, "refreshLatency stores plugin plus transport latency in health");
assert(refreshedLatency.reportedLatencyMs === 10, "refreshLatency stores reported latency milliseconds in health");
assert(refreshedLatency.latencyRefreshes === 1, "refreshLatency counts latency refreshes");
assert(latencyEvents === 3 && latencyDetail?.direction === "changed", "refreshLatency emits latencychange when reported latency changes");
assert(healthChangeEvents === 3 && healthChangeDetail?.reportedLatencySamples === 480, "refreshLatency emits healthchange with reported latency");
FakeAudioWorkletNode.last.port.onmessage({
  data: { type: "process-diagnostics", blockId: 87, latencySamples: 144, renderEngine: "native-vst3", renderDurationMs: 1.25, renderBudgetMs: 2.667, renderBudgetExceeded: false }
});
assert(liveNode.health.pluginLatencySamples === 144, "SoundBridgeAudioNode updates plugin latency from render diagnostics");
assert(liveNode.health.reportedLatencySamples === 528, "SoundBridgeAudioNode combines render latency with transport latency");
assert(liveNode.health.reportedLatencyMs === 11, "render diagnostics update reported latency milliseconds");
assert(latencyEvents === 4 && latencyDetail?.health?.pluginLatencySamples === 144, "render latency changes emit latencychange");
assert(healthChangeEvents === 4 && healthChangeDetail?.reportedLatencySamples === 528, "render latency changes emit healthchange");
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    ...pressureStats,
    outputLatencyBlocks: 1,
    transportLatencySamples: 128,
    latencyIncreases: 1,
    latencyDecreases: 1,
    responseDeadlineMisses: 5,
    staleOutputBlocks: 3,
    droppedInputBlocks: 2,
    underruns: 8
  }
});
assert(liveNode.health.consecutiveTransportPressureEvents === 1, "transport-pressure streak starts after a new pressure window");
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    ...pressureStats,
    outputLatencyBlocks: 1,
    transportLatencySamples: 128,
    latencyIncreases: 1,
    latencyDecreases: 1,
    responseDeadlineMisses: 6,
    staleOutputBlocks: 4,
    droppedInputBlocks: 3,
    underruns: 9
  }
});
assert(liveNode.health.consecutiveTransportPressureEvents === 2, "transport-pressure streak counts consecutive pressure windows");
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    ...pressureStats,
    outputLatencyBlocks: 1,
    transportLatencySamples: 128,
    latencyIncreases: 1,
    latencyDecreases: 1,
    responseDeadlineMisses: 7,
    staleOutputBlocks: 5,
    droppedInputBlocks: 4,
    underruns: 10
  }
});
assert(liveNode.health.bypassed === true, "sustained transport pressure auto-bypasses the AudioNode");
assert(liveNode.health.healthy === false, "transport-pressure auto-bypass marks AudioNode unhealthy");
assert(liveNode.health.unhealthyReason === "transport-pressure", "transport-pressure auto-bypass records a recoverable reason");
assert(liveNode.health.transportPressureAutoBypassed === true, "SoundBridgeAudioNode health reports transport-pressure auto-bypass");
assert(liveNode.health.consecutiveTransportPressureEvents === 3, "SoundBridgeAudioNode keeps the streak that tripped transport auto-bypass");
assert(transportPressureAutoBypassEvents === 1, "SoundBridgeAudioNode emits transport-pressure auto-bypass once");
assert(transportPressureAutoBypassDetail?.health?.unhealthyReason === "transport-pressure", "transport-pressure auto-bypass includes unhealthy health");
assert(
  FakeAudioWorkletNode.last.port.messages.at(-1)?.type === "set-bypassed" &&
    FakeAudioWorkletNode.last.port.messages.at(-1)?.bypassed === true,
  "transport-pressure auto-bypass sends a dry command to the worklet"
);
FakeAudioWorkletNode.last.port.onmessage({ data: { ...pressureStats, outputLatencyBlocks: 1, transportLatencySamples: 128, latencyIncreases: 1, latencyDecreases: 1, responseDeadlineMisses: 7, staleOutputBlocks: 5, droppedInputBlocks: 4, underruns: 10, sharedTransportInFlightBlocks: 0 } });
assert(liveNode.health.transportPressureAutoBypassed === true, "stale calm stats do not clear transport-pressure auto-bypass");
assert(liveNode.retry() === true, "SoundBridgeAudioNode retry resumes after transport-pressure auto-bypass");
assert(liveNode.health.bypassed === false, "AudioNode retry unbypasses after transport-pressure auto-bypass");
assert(liveNode.health.healthy === true, "AudioNode retry clears transport-pressure auto-bypass health");
assert(liveNode.health.unhealthyReason === undefined, "AudioNode retry clears the transport-pressure unhealthy reason");
assert(liveNode.health.consecutiveTransportPressureEvents === 0, "AudioNode retry clears the transport-pressure streak");
assert(retryEvents === 1 && retryDetail?.health?.healthy === true, "AudioNode retry emits recovered health");
let renderPressureEvents = 0;
let renderPressureDetail;
let autoBypassEvents = 0;
let autoBypassDetail;
liveNode.addEventListener("render-budget-exceeded", (event) => {
  renderPressureEvents += 1;
  renderPressureDetail = event.detail;
});
liveNode.addEventListener("render-budget-auto-bypassed", (event) => {
  autoBypassEvents += 1;
  autoBypassDetail = event.detail;
});
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "process-diagnostics",
    blockId: 88,
    renderEngine: "native-vst3",
    renderDurationMs: 3.5,
    renderBudgetMs: 2.667,
    renderBudgetExceeded: true
  }
});
assert(liveNode.health.lastRenderEngine === "native-vst3", "SoundBridgeAudioNode health tracks render engine diagnostics");
assert(liveNode.health.lastRenderDurationMs === 3.5, "SoundBridgeAudioNode health tracks render duration");
assert(liveNode.health.lastRenderBudgetMs === 2.667, "SoundBridgeAudioNode health tracks render budget");
assert(liveNode.health.renderBudgetExceeded === true, "SoundBridgeAudioNode health records render pressure");
assert(liveNode.health.renderBudgetMisses === 1, "SoundBridgeAudioNode health counts render-budget misses");
assert(renderPressureEvents === 1, "SoundBridgeAudioNode emits render-budget pressure events");
assert(renderPressureDetail?.health?.renderBudgetMisses === 1, "render-budget pressure events include health");
assert(liveNode.health.renderBudgetAutoBypassed === false, "first render-budget miss stays wet");
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "process-diagnostics",
    blockId: 89,
    renderEngine: "native-vst3",
    renderDurationMs: 3.25,
    renderBudgetMs: 2.667,
    renderBudgetExceeded: true
  }
});
assert(liveNode.health.bypassed === true, "repeated render-budget misses auto-bypass the AudioNode");
assert(liveNode.health.healthy === false, "render-budget auto-bypass marks AudioNode unhealthy");
assert(liveNode.health.unhealthyReason === "render-budget-exceeded", "render-budget auto-bypass records a recoverable reason");
assert(liveNode.health.renderBudgetAutoBypassed === true, "SoundBridgeAudioNode health reports render-budget auto-bypass");
assert(liveNode.health.renderBudgetMisses === 2, "SoundBridgeAudioNode keeps the miss count that tripped auto-bypass");
assert(renderPressureEvents === 2, "SoundBridgeAudioNode emits every render-budget pressure event");
assert(autoBypassEvents === 1, "SoundBridgeAudioNode emits render-budget auto-bypass once");
assert(autoBypassDetail?.health?.unhealthyReason === "render-budget-exceeded", "auto-bypass event includes unhealthy health");
assert(
  FakeAudioWorkletNode.last.port.messages.at(-1)?.type === "set-bypassed" &&
    FakeAudioWorkletNode.last.port.messages.at(-1)?.bypassed === true,
  "render-budget auto-bypass sends a dry command to the worklet"
);
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "process-diagnostics",
    blockId: 90,
    renderEngine: "native-vst3",
    renderDurationMs: 1.5,
    renderBudgetMs: 2.667,
    renderBudgetExceeded: false
  }
});
assert(liveNode.health.renderBudgetAutoBypassed === true, "stale on-budget diagnostics do not clear auto-bypass");
assert(liveNode.retry() === true, "SoundBridgeAudioNode retry resumes after render-budget auto-bypass");
assert(liveNode.health.bypassed === false, "AudioNode retry unbypasses after render-budget auto-bypass");
assert(liveNode.health.healthy === true, "AudioNode retry clears render-budget auto-bypass health");
assert(liveNode.health.unhealthyReason === undefined, "AudioNode retry clears the render-budget unhealthy reason");
assert(liveNode.health.renderBudgetMisses === 0, "AudioNode retry clears render-budget miss count");
assert(liveNode.health.renderBudgetExceeded === false, "AudioNode retry clears render-budget pressure state");
assert(retryEvents === 2 && retryDetail?.health?.renderBudgetAutoBypassed === false, "AudioNode retry emits render-budget recovery health");
let audioErrorEvents = 0;
let audioErrorDetail;
let audioErrorAutoBypassEvents = 0;
let audioErrorAutoBypassDetail;
liveNode.addEventListener("audio-error", (event) => {
  audioErrorEvents += 1;
  audioErrorDetail = event.detail;
});
liveNode.addEventListener("audio-error-auto-bypassed", (event) => {
  audioErrorAutoBypassEvents += 1;
  audioErrorAutoBypassDetail = event.detail;
});
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "audio-error",
    blockId: 91, error: "native render timeout", sharedTransportInFlightBlocks: 2
  }
});
assert(audioErrorEvents === 1 && audioErrorDetail === "native render timeout", "SoundBridgeAudioNode emits audio errors");
assert(liveNode.health.healthy === false && liveNode.health.sharedTransportInFlightBlocks === 2, "SoundBridgeAudioNode health marks audio errors unhealthy and records shared status");
assert(liveNode.health.audioErrors === 1, "SoundBridgeAudioNode health counts audio errors");
assert(liveNode.health.consecutiveAudioErrors === 1, "SoundBridgeAudioNode health counts consecutive audio errors");
assert(liveNode.health.lastAudioError === "native render timeout", "SoundBridgeAudioNode health tracks the latest audio error");
assert(liveNode.health.unhealthyReason === "audio-error", "SoundBridgeAudioNode health records the audio error reason");
assert(liveNode.health.bypassed === true, "live AudioNode fails dry after an audio error");
assert(liveNode.health.audioErrorAutoBypassed === true, "SoundBridgeAudioNode health reports audio-error auto-bypass");
assert(audioErrorAutoBypassEvents === 1, "SoundBridgeAudioNode emits audio-error auto-bypass");
assert(audioErrorAutoBypassDetail?.health?.audioErrorAutoBypassed === true, "audio-error auto-bypass includes health");
assert(
  FakeAudioWorkletNode.last.port.messages.at(-1)?.type === "set-bypassed" &&
    FakeAudioWorkletNode.last.port.messages.at(-1)?.bypassed === true,
  "audio-error auto-bypass sends a dry command to the worklet"
);
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "process-diagnostics",
    blockId: 92,
    renderEngine: "native-vst3",
    renderDurationMs: 1.25,
    renderBudgetMs: 2.667,
    renderBudgetExceeded: false
  }
});
assert(liveNode.health.audioErrorAutoBypassed === true, "stale successful diagnostics do not clear audio-error auto-bypass");
assert(liveNode.health.unhealthyReason === "audio-error", "stale successful diagnostics keep audio-error health");
assert(liveNode.retry() === true, "SoundBridgeAudioNode retry resumes after audio-error auto-bypass");
assert(liveNode.health.bypassed === false, "AudioNode retry unbypasses after audio-error auto-bypass");
assert(liveNode.health.healthy === true, "AudioNode retry clears audio-error auto-bypass health");
assert(liveNode.health.audioErrorAutoBypassed === false, "AudioNode retry clears audio-error auto-bypass state");
assert(liveNode.health.consecutiveAudioErrors === 0, "AudioNode retry clears consecutive audio errors");
assert(liveNode.health.lastAudioError === undefined, "AudioNode retry clears the latest audio error");
assert(liveNode.health.audioErrors === 1, "SoundBridgeAudioNode keeps cumulative audio error count after recovery");
assert(retryEvents === 3 && retryDetail?.health?.audioErrorAutoBypassed === false, "AudioNode retry emits audio-error recovery health");
FakeAudioWorkletNode.last.port.onmessage({ data: { type: "audio-error", blockId: 93, error: { code: "render_quarantined", message: "native render quarantined" } } });
assert(audioErrorEvents === 2 && audioErrorDetail?.code === "render_quarantined" && liveNode.health.unhealthyReason === "process-timeout", "SoundBridgeAudioNode classifies serialized render deadline errors");
assert(liveNode.health.audioErrorAutoBypassed === true && audioErrorAutoBypassEvents === 2 && audioErrorAutoBypassDetail?.health?.unhealthyReason === "process-timeout", "render deadline errors fail dry with process-timeout health");
assert(liveNode.retry() === false && retryEvents === 3 && liveNode.health.unhealthyReason === "process-timeout", "manual AudioNode retry does not clear render-deadline quarantine");

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
assert(fallbackCalls[0]?.request.renderTimeoutMs === 250, "live AudioNode fallback forwards render deadlines");
assert(
  fallbackPort.messages.some((message) => message.type === "processed" && message.blockId === 77),
  "live AudioNode fallback posts processed blocks"
);

const mainClient = new SoundBridgeClient({
  url: "ws://127.0.0.1:47370/bridge",
  origin: "http://127.0.0.1:5173",
  requestTimeoutMs: 500
});
let mainDisconnects = 0;
mainClient.addEventListener("disconnect", () => {
  mainDisconnects += 1;
});
const firstMainConnect = mainClient.connect();
const firstMainSocket = FakeMainSocket.instances.at(-1);
firstMainSocket.emit("open", {});
await firstMainConnect;

const mainPair = mainClient.pair("token");
const pairEnvelope = JSON.parse(firstMainSocket.sent.at(-1));
firstMainSocket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: pairEnvelope.id,
    ok: true,
    payload: { sessionToken: "session-main", expiresAt: Date.now() + 1000 }
  })
});
assert((await mainPair).sessionToken === "session-main", "main transport pair response resolves through client");

const zeroTimeoutRequest = mainClient.processAudioBlock(
  { instanceId: "inst-main", blockId: 91, sampleRate: 48000, channels: [[0, 0]] },
  0
);
let zeroTimeoutRejected;
zeroTimeoutRequest.catch((error) => {
  zeroTimeoutRejected = error;
});
const zeroTimeoutEnvelope = JSON.parse(firstMainSocket.sent.at(-1));
await new Promise((resolve) => setTimeout(resolve, 5));
assert(zeroTimeoutRejected === undefined, "zero request timeout disables the main transport response timer");
firstMainSocket.emit("message", {
  data: JSON.stringify({
    type: "response",
    id: zeroTimeoutEnvelope.id,
    ok: true,
    payload: {
      blockId: 91,
      channels: [[0.5, 0.25]],
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false
    }
  })
});
assert((await zeroTimeoutRequest).blockId === 91, "zero-timeout main transport audio requests still resolve");

const retiredRequest = mainClient.heartbeat();
let retiredError;
retiredRequest.catch((error) => {
  retiredError = error;
});
firstMainSocket.readyState = FakeMainSocket.CONNECTING;
const secondMainConnect = mainClient.connect();
await Promise.resolve();
assert(/reconnect/.test(String(retiredError?.message)), "main transport rejects retired pending requests on reconnect");
const secondMainSocket = FakeMainSocket.instances.at(-1);
assert(secondMainSocket !== firstMainSocket, "main transport creates a fresh socket on reconnect");
secondMainSocket.emit("open", {});
await secondMainConnect;
assert(mainDisconnects === 0, "main transport ignores retired socket close events during reconnect");

const currentRequest = mainClient.heartbeat();
let currentSettled = false;
currentRequest.then(() => {
  currentSettled = true;
});
const currentEnvelope = JSON.parse(secondMainSocket.sent.at(-1));
firstMainSocket.emit("message", {
  data: JSON.stringify({ type: "response", id: currentEnvelope.id, ok: true, payload: { stale: true } })
});
firstMainSocket.emit("error", {});
firstMainSocket.emit("close", {});
await Promise.resolve();
assert(currentSettled === false && mainDisconnects === 0, "main transport ignores stale socket events after reconnect");
secondMainSocket.emit("message", {
  data: JSON.stringify({ type: "response", id: currentEnvelope.id, ok: true, payload: { fresh: true } })
});
assert((await currentRequest).fresh === true, "main transport resolves responses from the active socket after reconnect");

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
  if (command === "getLatency") {
    const transportLatencySamples = Math.max(0, Math.min(1048576, Math.floor(Number(payload.transportLatencySamples ?? 0))));
    return {
      pluginLatencySamples: 96,
      transportLatencySamples,
      reportedLatencySamples: Math.min(1048576, 96 + transportLatencySamples)
    };
  }
  return {};
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
