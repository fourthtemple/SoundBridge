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

globalThis.Worker = FakeWorker;

const { SoundBridgeClient } = await import("../packages/web-client/dist/soundbridge-client.js");
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

const audioPort = client.createAudioWorkletTransportPort({
  instanceId: "inst-1",
  sampleRate: 48000,
  audioTransport: "binary"
});
const audioPortMessage = FakeWorker.last.messages.at(-1);
assert(audioPort, "worker transport creates an audio worklet port after pairing");
assert(audioPortMessage.type === "audio-port", "worker transport registers audio worklet ports with the worker");
assert(audioPortMessage.instanceId === "inst-1", "worker audio port registration includes instance id");
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
assert(Array.isArray(audioMessage.binaryAudioChannels), "worker transport carries binary audio channels separately");
assert(audioMessage.envelope.payload.inputBuses[0].index === 1, "worker transport preserves bus metadata");
assert(!("channels" in audioMessage.envelope.payload), "worker transport keeps main channels out of JSON payload");
assert(processed.channels[0][0] === 0.5, "worker transport resolves processed audio response");

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
