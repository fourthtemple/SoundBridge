import {
  SoundBridgeProtocolError,
  SoundBridgeLiveEffectRack,
  createLivePerformanceRackOptions
} from "../packages/web-client/dist/soundbridge-client.js";

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
    this.processTimeouts = [];
    this.binaryProcessTimeouts = [];
    this.failProcessing = false;
    this.processingDelayMs = 0;
    this.renderDurationMs = 0.5;
    this.renderBudgetMs = 2.667;
    this.renderBudgetExceeded = false;
    this.protocolErrorCode = undefined;
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

  async processAudioBlock(request, timeoutMs) {
    this.processed.push(request);
    this.processTimeouts.push(timeoutMs);
    if (this.processingDelayMs > 0) {
      await delay(this.processingDelayMs);
    }
    if (this.protocolErrorCode) {
      throw new SoundBridgeProtocolError(this.protocolErrorCode, "native render deadline missed", {});
    }
    if (this.failProcessing) {
      throw new Error("plugin worker crashed");
    }
    return {
      blockId: request.blockId,
      channels: request.channels.map((channel) => channel.map((sample) => sample * 0.5)),
      latencySamples: 12,
      tailSamples: 0,
      infiniteTail: false,
      renderDurationMs: this.renderDurationMs,
      renderBudgetMs: this.renderBudgetMs,
      renderBudgetExceeded: this.renderBudgetExceeded,
      renderEngine: "fake-live-effect"
    };
  }

  async processAudioBlockBinary(request, timeoutMs) {
    this.binaryProcessed.push(request);
    this.binaryProcessTimeouts.push(timeoutMs);
    return this.processAudioBlock(request, timeoutMs);
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
const livePerformanceOptions = createLivePerformanceRackOptions({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128
});
assert(livePerformanceOptions.audioTransport === "binary", "live performance preset uses binary audio by default");
assert(livePerformanceOptions.maxInFlightBlocks === 1, "live performance preset bounds in-flight processing");
assert(livePerformanceOptions.maxConsecutiveRenderBudgetMisses === 2, "live performance preset fails dry after repeated budget misses");
assert(livePerformanceOptions.renderBudgetRecoveryBlocks === 16, "live performance preset allows bounded render-pressure recovery");
assert(livePerformanceOptions.processTimeoutRecoveryBlocks === 16, "live performance preset cools down before process-timeout recovery");
assert(livePerformanceOptions.maxProcessTimeoutRecoveries === 1, "live performance preset bounds process-timeout recovery attempts");
assert(livePerformanceOptions.transitionFadeSamples === 64, "live performance preset fades wet/dry transitions");
assert(near(livePerformanceOptions.maxInputAgeMs, (128 / 48000) * 1000 * 4), "live performance preset bounds stale input age by block time");
assert(near(livePerformanceOptions.processTimeoutMs, (128 / 48000) * 1000 * 4), "live performance preset bounds processing time by block time");
const overriddenLivePerformance = createLivePerformanceRackOptions({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  audioTransport: "json",
  maxInputAgeBlocks: 2,
  processTimeoutBlocks: 3,
  transitionFadeBlocks: 1,
  maxInFlightBlocks: 3,
  maxConsecutiveRenderBudgetMisses: 5,
  renderBudgetRecoveryBlocks: 6,
  processTimeoutRecoveryBlocks: 4,
  maxProcessTimeoutRecoveries: 2
});
assert(overriddenLivePerformance.audioTransport === "json", "live performance preset preserves explicit transport overrides");
assert(overriddenLivePerformance.maxInFlightBlocks === 3, "live performance preset preserves explicit in-flight overrides");
assert(overriddenLivePerformance.maxConsecutiveRenderBudgetMisses === 5, "live performance preset preserves explicit budget miss overrides");
assert(overriddenLivePerformance.renderBudgetRecoveryBlocks === 6, "live performance preset preserves explicit recovery overrides");
assert(overriddenLivePerformance.processTimeoutRecoveryBlocks === 4, "live performance preset preserves process-timeout recovery overrides");
assert(overriddenLivePerformance.maxProcessTimeoutRecoveries === 2, "live performance preset preserves process-timeout recovery attempt overrides");
assert(overriddenLivePerformance.transitionFadeSamples === 128, "live performance preset derives fade overrides from block size");
assert(near(overriddenLivePerformance.maxInputAgeMs, (128 / 48000) * 1000 * 2), "live performance preset derives freshness overrides from block time");
assert(near(overriddenLivePerformance.processTimeoutMs, (128 / 48000) * 1000 * 3), "live performance preset derives timeout overrides from block time");

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
assert(rack.health.renderBudgetMisses === 0 && rack.health.renderBudgetExceeded === false, "live effect rack starts without budget pressure");

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
assert(rack.health.lastRenderBudgetMs === 2.667, "live rack records render budget telemetry");
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
assert(rack.health.unhealthyReason === "processing-error", "processing failure records a non-recoverable reason");

const stillDry = await rack.processBlock({ blockId: 4, channels: inputChannels });
assert(stillDry.bypassed === true && client.processed.length === 2, "unhealthy rack stays dry until recreated");
assert(rack.health.healthy === false, "processing-error rack does not auto-recover");

client.failProcessing = false;
await rack.recreate();
const recovered = await rack.processBlock({ blockId: 5, channels: inputChannels });
assert(rack.instanceId === "inst-live-2", "recreate replaces the effect instance");
assert(recovered.bypassed === false && recovered.channels[0][1] === 0.25, "recreated rack processes audio again");

await rack.processBlock({
  blockId: 6,
  channels: inputChannels,
  inputBuses: [{ index: 1, channels: [Float32Array.from([0.1, 0.2, 0.3, 0.4])] }]
});
assert(client.binaryProcessed.at(-1)?.inputBuses?.[0]?.index === 1, "binary live rack forwards indexed input buses");

const fadeRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  maxInputAgeMs: 1,
  transitionFadeSamples: 2
});
const fadeInput = [
  [1, 1, 1, 1],
  [1, 1, 1, 1]
];
await fadeRack.processBlock({ blockId: 7, channels: fadeInput });
fadeRack.setBypassed(true);
const fadedDry = await fadeRack.processBlock({ blockId: 8, channels: fadeInput });
assert(near(fadedDry.channels[0][0], 2 / 3) && near(fadedDry.channels[0][1], 5 / 6), "live rack fades wet-to-dry transitions");
fadeRack.setBypassed(false);
const staleDry = await fadeRack.processBlock({ blockId: 9, channels: [[0, 0, 0, 0]], timestamp: -1000 });
assert(staleDry.channels[0][0] === 0 && staleDry.channels[0][1] === 0, "live rack does not fade between dry fallback reasons");
const fadedWet = await fadeRack.processBlock({ blockId: 10, channels: fadeInput });
assert(near(fadedWet.channels[0][0], 1 / 6) && near(fadedWet.channels[0][1], 1 / 3), "live rack fades dry-to-wet transitions");
await fadeRack.destroy();

const pressureRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  maxConsecutiveRenderBudgetMisses: 2,
  renderBudgetRecoveryBlocks: 2
});
let budgetEvents = 0;
let recoveredEvents = 0;
pressureRack.addEventListener("render-budget-exceeded", () => {
  budgetEvents += 1;
});
pressureRack.addEventListener("render-budget-recovered", () => {
  recoveredEvents += 1;
});
client.renderDurationMs = 5;
client.renderBudgetMs = 2;
client.renderBudgetExceeded = true;
const pressured = await pressureRack.processBlock({ blockId: 10, channels: inputChannels });
assert(pressured.bypassed === false && pressureRack.health.renderBudgetMisses === 1, "first render budget miss stays wet");
const overloaded = await pressureRack.processBlock({ blockId: 11, channels: inputChannels });
assert(overloaded.bypassed === true && overloaded.healthy === false, "repeated render budget misses fail closed to dry audio");
assert(overloaded.channels[0][0] === 1, "render budget fallback preserves dry input");
assert(pressureRack.health.unhealthyReason === "render-budget-exceeded", "render pressure records a recoverable reason");
assert(budgetEvents === 2, "render budget misses emit host-visible events");
const cooldownOne = await pressureRack.processBlock({ blockId: 12, channels: inputChannels });
assert(cooldownOne.bypassed === true && pressureRack.health.recoveryDryBlocks === 1, "render pressure recovery waits through dry cooldown blocks");
const cooldownTwo = await pressureRack.processBlock({ blockId: 13, channels: inputChannels });
assert(cooldownTwo.bypassed === true && cooldownTwo.healthy === false, "final cooldown block is still dry");
assert(pressureRack.health.healthy === true && recoveredEvents === 1, "render pressure rack recovers after bounded dry cooldown");
client.renderDurationMs = 0.5;
client.renderBudgetMs = 2.667;
client.renderBudgetExceeded = false;
const pressureRecovered = await pressureRack.processBlock({ blockId: 14, channels: inputChannels });
assert(pressureRecovered.bypassed === false && pressureRack.health.renderBudgetMisses === 0, "recovered render pressure rack resumes wet processing");
await pressureRack.destroy();

const backpressureRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  maxInFlightBlocks: 1
});
let backpressureEvents = 0;
backpressureRack.addEventListener("input-backpressure", () => {
  backpressureEvents += 1;
});
client.processingDelayMs = 20;
const slowBlock = backpressureRack.processBlock({ blockId: 12, channels: inputChannels });
const backpressured = await backpressureRack.processBlock({ blockId: 13, channels: inputChannels });
assert(backpressured.bypassed === true && backpressured.healthy === true, "live rack returns dry when its in-flight limit is full");
assert(backpressured.renderEngine === "dry-backpressure", "in-flight pressure reports a dry backpressure render engine");
assert(backpressureRack.health.droppedInputBlocks === 1 && backpressureRack.health.inFlightBlocks === 1, "live rack tracks in-flight pressure");
assert(backpressureEvents === 1, "in-flight pressure emits a host-visible event");
client.processingDelayMs = 0;
const slowProcessed = await slowBlock;
assert(slowProcessed.bypassed === false && backpressureRack.health.inFlightBlocks === 0, "first slow block completes after backpressure drop");
await backpressureRack.destroy();

const staleRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  maxInputAgeMs: 1
});
let staleEvents = 0;
staleRack.addEventListener("stale-input", () => {
  staleEvents += 1;
});
const beforeStaleProcessed = client.processed.length;
const stale = await staleRack.processBlock({ blockId: 14, channels: inputChannels, timestamp: liveEffectTestNowMs() - 20 });
assert(stale.bypassed === true && stale.healthy === true, "live rack drops stale timestamped input to dry");
assert(stale.renderEngine === "dry-stale-input", "stale input reports a dry stale render engine");
assert(staleRack.health.staleInputBlocks === 1 && staleEvents === 1, "live rack reports stale input pressure");
assert(client.processed.length === beforeStaleProcessed, "stale input avoids plugin processing");
const fresh = await staleRack.processBlock({ blockId: 15, channels: inputChannels, timestamp: liveEffectTestNowMs() });
assert(fresh.bypassed === false && client.processed.length === beforeStaleProcessed + 1, "fresh timestamped input still processes");
await staleRack.destroy();

const timeoutRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  processTimeoutMs: 1
});
client.processingDelayMs = 20;
const timedOut = await timeoutRack.processBlock({ blockId: 16, channels: inputChannels });
assert(timedOut.bypassed === true && timedOut.healthy === false, "live rack fails dry when processBlock exceeds its timeout");
assert(timeoutRack.health.unhealthyReason === "process-timeout", "live rack records process timeout as its health reason");
assert(client.binaryProcessTimeouts.at(-1) === 1, "live rack passes process timeout to binary audio requests");
const afterTimeout = await timeoutRack.processBlock({ blockId: 17, channels: inputChannels });
assert(afterTimeout.bypassed === true && timeoutRack.health.healthy === false, "process timeout does not auto-recover");
client.processingDelayMs = 0;
await timeoutRack.destroy();

const timeoutRecoveryRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  processTimeoutMs: 1,
  processTimeoutRecoveryBlocks: 2,
  maxProcessTimeoutRecoveries: 1
});
let timeoutRecoveryStarted = 0;
let timeoutRecovered = 0;
timeoutRecoveryRack.addEventListener("process-timeout-recovery-started", () => {
  timeoutRecoveryStarted += 1;
});
timeoutRecoveryRack.addEventListener("process-timeout-recovered", () => {
  timeoutRecovered += 1;
});
client.processingDelayMs = 20;
const recoverableTimeout = await timeoutRecoveryRack.processBlock({ blockId: 18, channels: inputChannels });
assert(recoverableTimeout.bypassed === true && timeoutRecoveryRack.health.unhealthyReason === "process-timeout", "recoverable timeout starts dry and unhealthy");
client.processingDelayMs = 0;
const recoveryDryOne = await timeoutRecoveryRack.processBlock({ blockId: 19, channels: inputChannels });
assert(recoveryDryOne.bypassed === true && timeoutRecoveryRack.health.recoveryDryBlocks === 1, "process-timeout recovery observes dry cooldown blocks");
const createdBeforeTimeoutRecovery = client.created;
const recoveryDryTwo = await timeoutRecoveryRack.processBlock({ blockId: 20, channels: inputChannels });
assert(recoveryDryTwo.bypassed === true && recoveryDryTwo.healthy === false, "final process-timeout cooldown block stays dry");
await waitUntil(() => timeoutRecovered === 1, "process-timeout recovery completes");
assert(timeoutRecoveryStarted === 1 && timeoutRecovered === 1, "process-timeout recovery recreates the effect instance");
assert(timeoutRecoveryRack.health.healthy === true && client.created === createdBeforeTimeoutRecovery + 1, "process-timeout recovery restores rack health");
const timeoutRecoveredWet = await timeoutRecoveryRack.processBlock({ blockId: 21, channels: inputChannels });
assert(timeoutRecoveredWet.bypassed === false, "recovered process-timeout rack resumes wet processing");
client.processingDelayMs = 20;
const secondRecoverableTimeout = await timeoutRecoveryRack.processBlock({ blockId: 22, channels: inputChannels });
assert(secondRecoverableTimeout.bypassed === true && timeoutRecoveryRack.health.processTimeoutRecoveryAttempts === 1, "process-timeout recovery attempts stay bounded");
client.processingDelayMs = 0;
await timeoutRecoveryRack.processBlock({ blockId: 23, channels: inputChannels });
await timeoutRecoveryRack.processBlock({ blockId: 24, channels: inputChannels });
await flushAsync();
assert(timeoutRecovered === 1 && timeoutRecoveryRack.health.healthy === false, "process-timeout recovery cap leaves repeated failures dry");
await timeoutRecoveryRack.destroy();

const daemonTimeoutRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128
});
client.protocolErrorCode = "render_timeout";
const daemonTimedOut = await daemonTimeoutRack.processBlock({ blockId: 25, channels: inputChannels });
assert(
  daemonTimedOut.bypassed === true && daemonTimeoutRack.health.unhealthyReason === "process-timeout",
  "daemon render_timeout errors use live process-timeout policy"
);
client.protocolErrorCode = undefined;
await daemonTimeoutRack.destroy();

const livePerformanceRack = await SoundBridgeLiveEffectRack.createLivePerformance({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128
});
assert(livePerformanceRack.audioTransport === "binary", "createLivePerformance creates a binary live rack");
assert(livePerformanceRack.processTimeoutMs === livePerformanceOptions.processTimeoutMs, "createLivePerformance applies process timeout defaults");
assert(livePerformanceRack.maxInputAgeMs === livePerformanceOptions.maxInputAgeMs, "createLivePerformance applies input freshness defaults");
assert(livePerformanceRack.renderBudgetRecoveryBlocks === 16, "createLivePerformance applies recovery defaults");
const livePerformanceWet = await livePerformanceRack.processBlock({ blockId: 18, channels: inputChannels, timestamp: liveEffectTestNowMs() });
assert(livePerformanceWet.bypassed === false && livePerformanceWet.healthy === true, "live performance rack processes fresh audio");
assert(
  client.binaryProcessTimeouts.at(-1) === livePerformanceOptions.processTimeoutMs,
  "live performance rack passes block-derived timeouts to binary audio requests"
);
assert(
  client.binaryProcessed.at(-1)?.renderTimeoutMs === livePerformanceOptions.processTimeoutMs,
  "live performance rack passes render deadlines to the daemon"
);
await livePerformanceRack.destroy();

const jsonRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  audioTransport: "json",
  processTimeoutMs: 7
});
const beforeJsonProcessed = client.processed.length;
const beforeJsonBinaryProcessed = client.binaryProcessed.length;
await jsonRack.processBlock({
  blockId: 20,
  channels: inputChannels,
  inputBuses: [{ index: 1, channels: [Float32Array.from([0.4, 0.3, 0.2, 0.1])] }]
});
assert(client.processed.length === beforeJsonProcessed + 1, "json live rack calls processAudioBlock");
assert(client.binaryProcessed.length === beforeJsonBinaryProcessed, "json live rack avoids processAudioBlockBinary");
assert(Array.isArray(client.processed.at(-1)?.inputBuses?.[0]?.channels?.[0]), "json live rack clones input bus channels to arrays");
assert(client.processTimeouts.at(-1) === 7, "json live rack passes process timeout to audio requests");
assert(client.processed.at(-1)?.renderTimeoutMs === 7, "json live rack passes render deadlines to the daemon");
await jsonRack.destroy();

await rack.destroy();
assert(client.destroyed.includes("inst-live-2"), "destroy tears down the live effect instance");
assert(rack.health.unhealthyReason === "destroyed", "destroy records a distinct health reason");

console.log("Live effect rack smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function near(actual, expected, epsilon = 0.000001) {
  return Math.abs(Number(actual) - expected) < epsilon;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(condition, message) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (condition()) return;
    await delay(1);
  }
  assert(condition(), message);
}

function liveEffectTestNowMs() {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}
