class FakeAudioWorkletNode {
  static last;

  constructor(context, name, options) {
    this.context = context;
    this.name = name;
    this.options = options;
    this.port = new FakePort();
    FakeAudioWorkletNode.last = this;
  }

  connect(destination) {
    return destination;
  }

  disconnect() {}
}

class FakePort {
  onmessage = undefined;
  messages = [];

  postMessage(message) {
    this.messages.push(message);
  }
}

globalThis.AudioWorkletNode = FakeAudioWorkletNode;

const { SoundBridgeAudioNode } = await import("../packages/web-client/dist/soundbridge-client.js");
const fakeContext = {
  sampleRate: 48000,
  audioWorklet: {
    async addModule() {}
  }
};
const fakeClient = {
  createAudioWorkletTransportConnection() {
    return undefined;
  },
  async destroyInstance() {
    return { destroyed: true };
  }
};

const node = await SoundBridgeAudioNode.createLivePerformance(fakeContext, fakeClient, {
  instanceId: "inst-shared-health",
  inputChannels: 2,
  outputChannels: 2,
  workletUrl: "/soundbridge-worklet.js"
});

let statsDetail;
let deadlineMissEvents = 0;
let deadlineMissDetail;
node.addEventListener("stats", (event) => {
  statsDetail = event.detail;
});
node.addEventListener("response-deadline-missed", (event) => {
  deadlineMissEvents += 1;
  deadlineMissDetail = event.detail;
});
FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "stats",
    sharedAudioEnabled: true,
    sharedTransportInFlightBlocks: 3,
    sharedInputBufferAllocations: 5,
    sharedInputBufferReuses: 4,
    sharedPooledInputBuffers: 2,
    sharedInputQueuedBlocks: 1,
    sharedInputQueuedMaxBlocks: 4,
    sharedOutputQueuedBlocks: 2,
    sharedOutputQueuedMaxBlocks: 3,
    responseDeadlineMisses: 2,
    responseDeadlineMissesSinceLastStats: 2
  }
});

assert(statsDetail.sharedInputBufferAllocations === 5, "AudioNode stats events preserve shared transport allocation counters");
assert(deadlineMissEvents === 1 && deadlineMissDetail?.deltaMisses === 2, "AudioNode emits response-deadline-missed for new deadline misses");
assert(deadlineMissDetail?.health?.lastTransportPressureReasons?.includes("deadline-miss"), "deadline-miss events include updated pressure health");
assert(node.health.sharedAudioEnabled === true, "AudioNode health tracks shared-audio enablement");
assert(node.health.sharedTransportInFlightBlocks === 3, "AudioNode health tracks shared transport in-flight blocks");
assert(node.health.sharedInputBufferAllocations === 5, "AudioNode health tracks shared input buffer allocations");
assert(node.health.sharedInputBufferReuses === 4, "AudioNode health tracks shared input buffer reuse");
assert(node.health.sharedPooledInputBuffers === 2, "AudioNode health tracks pooled shared input buffers");
assert(node.health.sharedInputQueuedMaxBlocks === 4 && node.health.sharedOutputQueuedMaxBlocks === 3, "AudioNode health tracks peak shared queue depth");

FakeAudioWorkletNode.last.port.onmessage({
  data: {
    type: "stats",
    sharedTransportInFlightBlocks: 999,
    sharedInputBufferAllocations: Number.MAX_SAFE_INTEGER + 1000,
    sharedInputBufferReuses: Number.MAX_SAFE_INTEGER + 1000,
    sharedPooledInputBuffers: 9999,
    sharedInputQueuedMaxBlocks: 999,
    sharedOutputQueuedMaxBlocks: 999,
    responseDeadlineMisses: 2
  }
});

assert(node.health.sharedTransportInFlightBlocks === 64, "AudioNode health bounds shared transport in-flight blocks");
assert(node.health.sharedInputBufferAllocations === Number.MAX_SAFE_INTEGER, "AudioNode health bounds shared allocation counters");
assert(node.health.sharedPooledInputBuffers === 2048, "AudioNode health bounds pooled shared buffers");
assert(node.health.sharedInputQueuedMaxBlocks === 64 && node.health.sharedOutputQueuedMaxBlocks === 64, "AudioNode health bounds peak shared queue depth");
assert(deadlineMissEvents === 1, "AudioNode does not repeat deadline-miss events for unchanged counters");

let renderBudgetTripEvents = 0;
let renderBudgetTripDetail;
node.addEventListener("render-budget-tripped", (event) => {
  renderBudgetTripEvents += 1;
  renderBudgetTripDetail = event.detail;
});
FakeAudioWorkletNode.last.port.onmessage({
  data: { type: "process-diagnostics", renderDurationMs: 3.5, renderBudgetMs: 2.667, renderBudgetExceeded: true }
});
FakeAudioWorkletNode.last.port.onmessage({
  data: { type: "process-diagnostics", renderDurationMs: 3.25, renderBudgetMs: 2.667, renderBudgetExceeded: true }
});
assert(renderBudgetTripEvents === 1, "AudioNode emits render-budget-tripped when repeated render misses fail dry");
assert(renderBudgetTripDetail?.health?.unhealthyReason === "render-budget-exceeded", "render-budget trip events include unhealthy health");

console.log("Live AudioNode shared transport health smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
