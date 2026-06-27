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
  processAudioBlockBinary() {
    return Promise.reject(new Error("unexpected render"));
  }
};

const timeoutNode = await SoundBridgeAudioNode.createLivePerformance(fakeContext, fakeClient, {
  instanceId: "inst-timeout",
  inputChannels: 2,
  outputChannels: 2,
  workletUrl: "/soundbridge-worklet.js"
});
let timeoutEvents = 0;
let timeoutDetail;
let timeoutAutoBypassEvents = 0;
let timeoutAutoBypassDetail;
timeoutNode.addEventListener("process-timeout", (event) => {
  timeoutEvents += 1;
  timeoutDetail = event.detail;
});
timeoutNode.addEventListener("process-timeout-auto-bypassed", (event) => {
  timeoutAutoBypassEvents += 1;
  timeoutAutoBypassDetail = event.detail;
});
FakeAudioWorkletNode.last.port.onmessage({
  data: { type: "audio-error", error: { code: "render_timeout", message: "deadline missed" } }
});
assert(timeoutEvents === 1 && timeoutDetail?.error?.code === "render_timeout", "AudioNode emits process-timeout for render deadlines");
assert(timeoutDetail?.autoBypassed === true && timeoutDetail?.health?.unhealthyReason === "process-timeout", "process-timeout detail includes fail-dry health");
assert(timeoutAutoBypassEvents === 1 && timeoutAutoBypassDetail?.health?.bypassed === true, "AudioNode emits process-timeout auto-bypass");
assert(timeoutNode.retry() === false, "AudioNode retry refuses quarantined render timeouts");
timeoutNode.setBypassed(false);
assert(timeoutNode.health.bypassed === true && timeoutNode.health.unhealthyReason === "process-timeout", "setBypassed(false) leaves quarantined nodes dry");

const genericNode = await SoundBridgeAudioNode.createLivePerformance(fakeContext, fakeClient, {
  instanceId: "inst-generic",
  inputChannels: 2,
  outputChannels: 2,
  workletUrl: "/soundbridge-worklet.js"
});
let genericTimeoutEvents = 0;
genericNode.addEventListener("process-timeout", () => {
  genericTimeoutEvents += 1;
});
FakeAudioWorkletNode.last.port.onmessage({ data: { type: "audio-error", error: "plugin failed" } });
assert(genericTimeoutEvents === 0, "ordinary audio errors do not emit process-timeout");
assert(genericNode.health.unhealthyReason === "audio-error", "ordinary audio errors keep generic audio-error health");

console.log("Live AudioNode timeout smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
