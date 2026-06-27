import {
  SoundBridgeLiveEffectRack,
  createLiveEffectRackBlockScheduler
} from "../packages/web-client/dist/soundbridge-client.js";

const plugin = {
  pluginId: "mock.live-effect-scheduled",
  format: "mock",
  name: "Live Scheduled Effect",
  vendor: "SoundBridge",
  category: "Effect",
  kind: "effect",
  inputs: 2,
  outputs: 2,
  parameters: []
};

class FakeScheduledClient {
  constructor() {
    this.created = 0;
    this.destroyed = [];
    this.processed = [];
    this.binaryProcessed = [];
  }

  async createInstance(request) {
    this.created += 1;
    return {
      instanceId: `inst-scheduled-${this.created}`,
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
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false
    };
  }

  async processAudioBlock(request) {
    this.processed.push(request);
    return {
      blockId: request.blockId,
      channels: request.channels.map((channel) => Array.from(channel, (sample) => sample * 0.5)),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "scheduled-fake"
    };
  }

  async processAudioBlockBinary(request) {
    this.binaryProcessed.push(request);
    return this.processAudioBlock(request);
  }

  async destroyInstance(instanceId) {
    this.destroyed.push(instanceId);
    return { destroyed: true };
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const inputChannels = [[1, 0.5], [0.25, -0.25]];
const client = new FakeScheduledClient();
const rack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128
});
assert(rack.health.dryOutputBlocks === 0, "live rack scheduled smoke starts without dry output pressure");
const dryOutputEvents = [];
rack.addEventListener("dry-output", (event) => {
  dryOutputEvents.push(event.detail);
});

const staleScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  maxInputAgeMs: 1,
  nowMs: () => 100
});
let staleEvents = 0;
rack.addEventListener("stale-input", () => {
  staleEvents += 1;
});
const staleScheduled = staleScheduler.schedule(inputChannels, { timestamp: 90 });
const scheduledStale = await rack.processScheduledBlock(staleScheduled);
assert(
  scheduledStale.bypassed === true &&
    scheduledStale.renderEngine === "dry-stale-input" &&
    rack.health.staleInputBlocks === 1 &&
    rack.health.dryOutputBlocks === 1 &&
    rack.health.lastDryReason === "stale-input",
  "live rack scheduled stale blocks fail dry without plugin processing"
);
assert(staleEvents === 1 && client.processed.length === 0, "live rack scheduled stale blocks emit stale pressure without plugin work");
assert(
  dryOutputEvents.length === 1 &&
    dryOutputEvents[0].reason === "stale-input" &&
    dryOutputEvents[0].health.dryOutputBlocks === 1,
  "live rack emits every scheduled stale dry output"
);

const freshScheduled = staleScheduler.schedule(inputChannels, { timestamp: 100 });
const scheduledWet = await rack.processScheduledBlock(freshScheduled);
assert(
  scheduledWet.bypassed === false &&
    scheduledWet.channels[0][0] === 0.5 &&
    rack.health.dryOutputBlocks === 1 &&
    rack.health.lastDryReason === undefined,
  "live rack scheduled fresh blocks process normally"
);
assert(dryOutputEvents.length === 1, "live rack does not emit dry-output for wet scheduled blocks");

const pressureScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128
});
pressureScheduler.updateDeadlinePressureFromHealth(
  {
    lastResponseDeadlineLeadBlocks: 0.25,
    responseJitterBlocks: 4,
    responseDeadlineMisses: 1
  },
  { warnings: ["deadline-miss", "increase-transport-latency"] }
);
let deadlinePressureEvents = 0;
rack.addEventListener("deadline-pressure", () => {
  deadlinePressureEvents += 1;
});
const processedBeforePressure = client.processed.length;
const pressureWet = await rack.processScheduledBlock(pressureScheduler.schedule(inputChannels));
const pressureFilteredWet = await rack.processScheduledBlock(
  pressureScheduler.schedule(inputChannels),
  { skipOnDeadlinePressure: true, skipOnDeadlinePressureReasons: ["dry-output-pressure"] }
);
const pressureDry = await rack.processScheduledBlock(
  pressureScheduler.schedule(inputChannels),
  { skipOnDeadlinePressure: true, skipOnDeadlinePressureReasons: ["deadline-miss"] }
);
assert(pressureWet.bypassed === false, "live rack scheduled pressure blocks process unless the host opts into dry skip");
assert(pressureFilteredWet.bypassed === false, "live rack scheduled pressure reason filters keep unmatched pressure wet");
assert(
  pressureDry.bypassed === true &&
    pressureDry.renderEngine === "dry-deadline-pressure" &&
    pressureDry.deadlinePressure?.reasons.includes("deadline-miss") &&
    rack.health.dryOutputBlocks === 2 &&
    rack.health.lastDryReason === "deadline-pressure",
  "live rack can fail dry before processing scheduler deadline-pressure blocks"
);
assert(
  deadlinePressureEvents === 1 &&
    client.processed.length === processedBeforePressure + 2,
  "live rack deadline-pressure dry skips are host-visible and avoid plugin work"
);
assert(
  dryOutputEvents.length === 2 &&
    dryOutputEvents[1].reason === "deadline-pressure" &&
    dryOutputEvents[1].deadlinePressure?.reasons.includes("deadline-miss") &&
    dryOutputEvents[1].health.dryOutputBlocks === 2,
  "live rack emits every scheduler deadline-pressure dry output"
);

await rack.destroy();
assert(client.destroyed.includes("inst-scheduled-1"), "scheduled rack smoke tears down the live effect instance");

console.log("Live effect rack scheduled smoke checks passed.");
