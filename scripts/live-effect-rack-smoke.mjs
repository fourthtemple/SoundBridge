import { SoundBridgeLiveEffectRack } from "../packages/web-client/dist/soundbridge-client.js";

const plugin = {
  pluginId: "mock.live-effect",
  format: "mock",
  name: "Live Effect",
  vendor: "SoundBridge",
  category: "Effect",
  kind: "effect",
  inputs: 2,
  outputs: 2,
  parameters: []
};

class FakeLiveClient {
  constructor() {
    this.created = 0;
    this.destroyed = [];
    this.processed = [];
    this.binaryProcessed = [];
    this.failProcessing = false;
  }

  async createInstance(request) {
    this.created += 1;
    return {
      instanceId: `inst-live-${this.created}`,
      plugin,
      layout: {
        requestedInputChannels: request.inputChannels,
        requestedOutputChannels: request.outputChannels,
        inputChannels: request.inputChannels,
        outputChannels: request.outputChannels,
        inputBuses: 1,
        outputBuses: 1,
        inputBusLayouts: [],
        outputBusLayouts: [],
        sampleRate: request.sampleRate,
        maxBlockSize: request.maxBlockSize
      },
      latencySamples: 12,
      tailSamples: 0,
      infiniteTail: false
    };
  }

  async processAudioBlock(request) {
    this.processed.push(request);
    if (this.failProcessing) {
      throw new Error("plugin worker crashed");
    }
    return {
      blockId: request.blockId,
      channels: request.channels.map((channel) => channel.map((sample) => sample * 0.5)),
      latencySamples: 12,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "fake-live-effect"
    };
  }

  async processAudioBlockBinary(request) {
    this.binaryProcessed.push(request);
    return this.processAudioBlock(request);
  }

  async getLatency(_instanceId, transportLatencySamples = 0) {
    return {
      pluginLatencySamples: 12,
      transportLatencySamples,
      reportedLatencySamples: 12 + transportLatencySamples
    };
  }

  async destroyInstance(instanceId) {
    this.destroyed.push(instanceId);
    return { destroyed: true };
  }
}

const client = new FakeLiveClient();
const rack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  inputChannels: 2,
  outputChannels: 2
});

assert(rack.instanceId === "inst-live-1", "live effect rack creates a plugin instance");
assert(rack.health.healthy === true && rack.health.latencySamples === 12, "live effect rack starts healthy");

const inputChannels = [
  [1, 0.5, -0.5, 0],
  [0.25, -0.25, 0.75, -0.75]
];
const wet = await rack.processBlock({
  blockId: 1,
  channels: inputChannels,
  transport: { playing: true, samplePosition: 0 }
});
assert(wet.bypassed === false && wet.healthy === true, "healthy live rack returns processed audio");
assert(wet.channels[0][0] === 0.5 && wet.channels[1][3] === -0.375, "processed audio comes from the plugin");
assert(client.binaryProcessed.length === 1, "healthy live rack uses binary processAudioBlock by default");
assert(client.processed.length === 1, "binary live rack still reaches the fake processor");

rack.setBypassed(true);
const bypassed = await rack.processBlock({ blockId: 2, channels: inputChannels });
assert(bypassed.bypassed === true && bypassed.channels[0][0] === 1, "manual bypass returns dry audio");
assert(client.processed.length === 1, "manual bypass avoids plugin processing");

let errorEvents = 0;
rack.addEventListener("effect-error", () => {
  errorEvents += 1;
});
rack.setBypassed(false);
client.failProcessing = true;
const failed = await rack.processBlock({ blockId: 3, channels: inputChannels });
assert(failed.bypassed === true && failed.healthy === false, "processing failure fails closed to dry audio");
assert(failed.channels[1][2] === 0.75, "failure fallback preserves dry input");
assert(errorEvents === 1, "processing failure emits one effect-error event");

const stillDry = await rack.processBlock({ blockId: 4, channels: inputChannels });
assert(stillDry.bypassed === true && client.processed.length === 2, "unhealthy rack stays dry until recreated");

client.failProcessing = false;
await rack.recreate();
const recovered = await rack.processBlock({ blockId: 5, channels: inputChannels });
assert(rack.instanceId === "inst-live-2", "recreate replaces the effect instance");
assert(recovered.bypassed === false && recovered.channels[0][1] === 0.25, "recreated rack processes audio again");

const jsonRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  audioTransport: "json"
});
const beforeJsonProcessed = client.processed.length;
const beforeJsonBinaryProcessed = client.binaryProcessed.length;
await jsonRack.processBlock({ blockId: 6, channels: inputChannels });
assert(client.processed.length === beforeJsonProcessed + 1, "json live rack calls processAudioBlock");
assert(client.binaryProcessed.length === beforeJsonBinaryProcessed, "json live rack avoids processAudioBlockBinary");
await jsonRack.destroy();

await rack.destroy();
assert(client.destroyed.includes("inst-live-2"), "destroy tears down the live effect instance");

console.log("Live effect rack smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
