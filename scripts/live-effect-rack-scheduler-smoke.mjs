import {
  createLiveEffectRackBlockScheduler,
  createLiveEffectRackCalibrationWindow,
  createLiveEffectRackChain,
  createLiveEffectRackChainCalibrationWindow
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let now = 1000;
const scheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  startBlockId: 10,
  startSamplePosition: 1280,
  transportLatencySamples: 256,
  maxInputAgeMs: 6,
  transport: {
    tempo: 128,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4
  },
  nowMs: () => now
});

const first = scheduler.schedule([[1, 0]]);
assert(first.request.blockId === 10, "live rack scheduler starts from the configured block id");
assert(first.samplePosition === 1280, "live rack scheduler starts from the configured sample position");
assert(first.request.timestamp === 1000 && first.captureAgeMs === 0, "live rack scheduler stamps fresh captures");
assert(first.transport.samplePosition === 1536, "live rack scheduler compensates transport latency");
assert(first.transport.tempo === 128, "live rack scheduler carries base transport metadata");
assert(first.stale === false, "live rack scheduler marks fresh captures as live");

now = 1002;
const second = scheduler.schedule([[0.5]], {
  wetMix: 0.25,
  transportOptions: { playing: false, tempo: 96 }
});
assert(second.request.blockId === 11, "live rack scheduler advances block ids");
assert(second.samplePosition === 1408, "live rack scheduler advances sample positions");
assert(second.request.wetMix === 0.25, "live rack scheduler preserves per-block wet mix");
assert(second.transport.playing === false && second.transport.tempo === 96, "live rack scheduler applies per-block transport overrides");
assert(second.transport.samplePosition === 1664, "live rack scheduler keeps latency compensation after advancing");

scheduler.updateFromRackHealth({
  transportLatencySamples: 512,
  lastResponseDeadlineLeadBlocks: 0.5,
  responseJitterBlocks: 5,
  responseDeadlineMisses: 2
});
now = 1010;
const stale = scheduler.schedule([[0.25]], { timestamp: 1000 });
assert(stale.stale === true && stale.captureAgeMs === 10, "live rack scheduler detects stale captured audio");
assert(stale.transport.samplePosition === 2048, "live rack scheduler uses updated rack transport latency");
assert(
  stale.deadlinePressure.pressure &&
    stale.deadlinePressure.reasons.includes("deadline-miss") &&
    stale.deadlinePressure.reasons.includes("low-deadline-lead") &&
    stale.deadlinePressure.reasons.includes("response-jitter"),
  "live rack scheduler carries deadline pressure into scheduled blocks"
);
scheduler.updateFromRackHealth({
  transportLatencySamples: 512,
  lastResponseDeadlineLeadBlocks: 2,
  responseJitterBlocks: 1,
  responseDeadlineMisses: 2
});
assert(scheduler.snapshot().deadlinePressure.pressure === false, "live rack scheduler clears pressure after stable rack health");

const rackWindow = createLiveEffectRackCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  processBudgetMs: 12,
  processTimeoutMs: 16,
  safetyMarginBlocks: 0
});
rackWindow.record({
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  dryOutputBlocks: 0
});
const rackCalibration = rackWindow.record({
  lastProcessDurationMs: 0.5,
  lastRenderDurationMs: 0.4,
  responseJitterBlocks: 0,
  lastResponseDeadlineLeadBlocks: 1,
  dryOutputBlocks: 1
}).calibration;
const rackCalibrationScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  nowMs: () => now
});
rackCalibrationScheduler.updateFromRackCalibration({
  lastResponseDeadlineLeadBlocks: 1,
  responseJitterBlocks: 0,
  responseDeadlineMisses: 0
}, rackCalibration);
const calibratedRack = rackCalibrationScheduler.schedule([[0.1]], { samplePosition: 0, timestamp: now });
assert(
  calibratedRack.transport.samplePosition === 128 &&
    rackCalibrationScheduler.snapshot().deadlinePressure.reasons.includes("dry-output-pressure") &&
    rackCalibrationScheduler.snapshot().deadlinePressure.reasons.includes("increase-transport-latency"),
  "live rack scheduler applies calibrated single-rack latency and pressure recommendations"
);

const chain = createLiveEffectRackChain({
  stages: [{
    async processBlock(request) {
      return {
        blockId: request.blockId,
        channels: request.channels,
        latencySamples: 640,
        renderEngine: "latency-stage",
        bypassed: false,
        healthy: true
      };
    }
  }],
  sampleRate: 48000,
  maxBlockSize: 128
});
await chain.processBlock({ blockId: 99, channels: [[0.1]], sampleRate: 48000 });
scheduler.updateFromChainHealth(chain.health);
now = 1011;
const chainCompensated = scheduler.schedule([[0.2]], { timestamp: now });
assert(chainCompensated.transport.samplePosition === 2304, "live rack scheduler can compensate from chain aggregate latency");

const chainWindow = createLiveEffectRackChainCalibrationWindow({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 128,
  processBudgetMs: 12,
  processTimeoutMs: 16,
  safetyMarginBlocks: 1
});
const chainCalibration = chainWindow.record(chain.health).calibration;
scheduler.updateFromChainCalibration(chain.health, chainCalibration);
now = 1012;
const calibratedChain = scheduler.schedule([[0.3]], { timestamp: now });
assert(calibratedChain.transport.samplePosition === 2560, "live rack scheduler applies calibrated chain latency compensation");

const pressureScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  nowMs: () => now
});
pressureScheduler.updateFromChainCalibration(
  {
    latencySamples: 0,
    lastResponseDeadlineLeadBlocks: 0.25,
    responseJitterBlocks: 3,
    responseDeadlineMisses: 1
  },
  {
    recommendedTransportLatencySamples: 512,
    warnings: ["deadline-miss", "dry-output-pressure", "response-jitter", "increase-transport-latency"]
  }
);
const pressuredSnapshot = pressureScheduler.snapshot();
assert(
  pressuredSnapshot.transportLatencyBlocks === 4 &&
    pressuredSnapshot.deadlinePressure.reasons.includes("dry-output-pressure") &&
    pressuredSnapshot.deadlinePressure.reasons.includes("increase-transport-latency"),
  "live rack scheduler exposes calibrated dry-output and latency pressure recommendations"
);
pressureScheduler.updateFromChainHealth({
  latencySamples: 512,
  lastResponseDeadlineLeadBlocks: 2,
  responseJitterBlocks: 1,
  responseDeadlineMisses: 1
});
assert(
  pressureScheduler.snapshot().deadlinePressure.pressure === false,
  "live rack scheduler resolves chain pressure when added latency covers jitter and lead"
);

const overrideScheduler = createLiveEffectRackBlockScheduler({
  sampleRate: 48000,
  maxBlockSize: 128,
  transportLatencySamples: 0,
  nowMs: () => now
});
overrideScheduler.updateFromRackHealth({
  transportLatencySamples: 0,
  lastResponseDeadlineLeadBlocks: 2,
  responseJitterBlocks: 3,
  responseDeadlineMisses: 0
});
const overrideLatencyBlock = overrideScheduler.schedule([[0.1]], { transportLatencySamples: 512 });
assert(
  overrideScheduler.snapshot().deadlinePressure.pressure === true &&
    overrideLatencyBlock.deadlinePressure.pressure === false &&
    overrideLatencyBlock.deadlinePressure.transportLatencyBlocks === 4,
  "live rack scheduler evaluates per-block pressure against per-block transport latency"
);

const explicitTransport = { playing: false, samplePosition: 7 };
const explicit = scheduler.schedule([[0.1]], { transport: explicitTransport, timestamp: now });
assert(explicit.transport === explicitTransport, "live rack scheduler preserves explicit host transport");
assert(explicit.request.transport === explicitTransport, "live rack scheduler passes explicit transport into the request");

scheduler.reset({ nextBlockId: 4, nextSamplePosition: 512 });
const reset = scheduler.schedule([[0.2]]);
assert(reset.blockId === 4 && reset.samplePosition === 512, "live rack scheduler reset sets the next block position");
assert(scheduler.snapshot().nextBlockId === 5, "live rack scheduler snapshot reports the next block id");
assert(scheduler.snapshot().transportLatencySamples === 768, "live rack scheduler snapshot reports current latency compensation");

console.log("Live effect rack scheduler smoke checks passed.");
