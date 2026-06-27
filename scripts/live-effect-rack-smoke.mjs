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
    this.latencyRequests = [];
    this.parameterRequests = [];
    this.parameterSets = [];
    this.parameterEvents = [];
    this.parameterCurves = [];
    this.automationLanes = [];
    this.clearedAutomationLanes = [];
    this.presets = [];
    this.midiEvents = [];
    this.failProcessing = false;
    this.processingDelayMs = 0;
    this.renderDurationMs = 0.5;
    this.renderBudgetMs = 2.667;
    this.renderBudgetExceeded = false;
    this.latencySamples = 12;
    this.protocolErrorCode = undefined;
    this.protocolErrorDetails = {};
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
      latencySamples: this.latencySamples,
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
      throw new SoundBridgeProtocolError(this.protocolErrorCode, "native render deadline missed", this.protocolErrorDetails);
    }
    if (this.failProcessing) {
      throw new Error("plugin worker crashed");
    }
    return {
      blockId: request.blockId,
      channels: request.channels.map((channel) => channel.map((sample) => sample * 0.5)),
      latencySamples: this.latencySamples,
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
    this.latencyRequests.push(transportLatencySamples);
    return {
      pluginLatencySamples: this.latencySamples,
      transportLatencySamples,
      reportedLatencySamples: this.latencySamples + transportLatencySamples
    };
  }

  async getParameters(instanceId) { this.parameterRequests.push(instanceId); return { parameters: [this.parameter("filter", 0.5)] }; }

  async setPreset(instanceId, presetId) { this.presets.push({ instanceId, presetId }); return { applied: true, presetId, parameterCount: 1, parameters: [this.parameter("filter", 0.5)] }; }

  async setParameter(instanceId, parameterId, normalizedValue) { this.parameterSets.push({ instanceId, parameterId, normalizedValue }); return { parameter: this.parameter(parameterId, normalizedValue) }; }

  async setParameterEvents(instanceId, events) {
    this.parameterEvents.push({ instanceId, events });
    return { accepted: true, eventCount: events.length, parameters: events.map((event) => this.parameter(event.parameterId, event.normalizedValue)) };
  }

  async setParameterCurve(instanceId, parameterId, points, interpolation = "linear") {
    this.parameterCurves.push({ instanceId, parameterId, points, interpolation });
    return { accepted: true, eventCount: points.length, parameter: this.parameter(parameterId, points.at(-1)?.normalizedValue ?? 0) };
  }

  async setAutomationLane(instanceId, parameterId, points) { this.automationLanes.push({ instanceId, parameterId, points }); return { accepted: true, parameterId, pointCount: points.length, laneCount: 1, parameter: this.parameter(parameterId, points.at(-1)?.normalizedValue ?? 0) }; }

  async clearAutomationLane(instanceId, parameterId) { this.clearedAutomationLanes.push({ instanceId, parameterId }); return { cleared: true, parameterId, laneCount: 0 }; }

  async sendMidiEvents(instanceId, events) { this.midiEvents.push({ instanceId, events }); return { accepted: true, eventCount: events.length }; }

  async destroyInstance(instanceId) {
    this.destroyed.push(instanceId);
    return { destroyed: true };
  }

  parameter(id, normalizedValue) { return { id, name: id, normalizedValue, automatable: true, readOnly: false }; }
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
assert(near(livePerformanceOptions.processBudgetMs, 128 / 48000 * 1000), "live performance preset tracks one-block processing budget");
assert(livePerformanceOptions.maxConsecutiveProcessBudgetMisses === 3, "live performance preset fails dry after repeated process budget misses");
assert(livePerformanceOptions.processBudgetRecoveryBlocks === 16, "live performance preset allows bounded process-budget recovery");
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
  processBudgetBlocks: 2,
  processTimeoutBlocks: 3,
  transitionFadeBlocks: 1,
  maxInFlightBlocks: 3,
  maxConsecutiveProcessBudgetMisses: 5,
  maxConsecutiveRenderBudgetMisses: 5,
  processBudgetRecoveryBlocks: 7,
  renderBudgetRecoveryBlocks: 6,
  processTimeoutRecoveryBlocks: 4,
  maxProcessTimeoutRecoveries: 2
});
assert(overriddenLivePerformance.audioTransport === "json", "live performance preset preserves explicit transport overrides");
assert(overriddenLivePerformance.maxInFlightBlocks === 3, "live performance preset preserves explicit in-flight overrides");
assert(overriddenLivePerformance.maxConsecutiveProcessBudgetMisses === 5, "live performance preset preserves explicit process budget miss overrides");
assert(overriddenLivePerformance.maxConsecutiveRenderBudgetMisses === 5, "live performance preset preserves explicit budget miss overrides");
assert(overriddenLivePerformance.processBudgetRecoveryBlocks === 7, "live performance preset preserves process budget recovery overrides");
assert(overriddenLivePerformance.renderBudgetRecoveryBlocks === 6, "live performance preset preserves explicit recovery overrides");
assert(overriddenLivePerformance.processTimeoutRecoveryBlocks === 4, "live performance preset preserves process-timeout recovery overrides");
assert(overriddenLivePerformance.maxProcessTimeoutRecoveries === 2, "live performance preset preserves process-timeout recovery attempt overrides");
assert(overriddenLivePerformance.transitionFadeSamples === 128, "live performance preset derives fade overrides from block size");
assert(near(overriddenLivePerformance.maxInputAgeMs, (128 / 48000) * 1000 * 2), "live performance preset derives freshness overrides from block time");
assert(near(overriddenLivePerformance.processBudgetMs, (128 / 48000) * 1000 * 2), "live performance preset derives process budget overrides from block time");
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
assert(rack.health.healthy === true && rack.health.latencySamples === 12 && rack.health.lastDryReason === undefined, "live effect rack starts healthy");
assert(rack.health.wetMix === 1, "live effect rack starts fully wet");
assert(
  rack.health.pluginLatencySamples === 12 &&
    rack.health.transportLatencySamples === 0 &&
    rack.health.reportedLatencySamples === 12 &&
    rack.health.reportedLatencyMs === 0.25,
  "live effect rack starts with plugin-only latency health"
);
assert(rack.health.renderBudgetMisses === 0 && rack.health.renderBudgetExceeded === false, "live effect rack starts without budget pressure");
assert(
  rack.health.processBudgetMs === 0 &&
    rack.health.processBudgetMisses === 0 &&
    rack.health.processBudgetExceeded === false,
  "live effect rack starts without process budget pressure"
);

const refreshedLatency = await rack.refreshLatency(128);
assert(
  refreshedLatency.pluginLatencySamples === 12 &&
    refreshedLatency.transportLatencySamples === 128 &&
    refreshedLatency.reportedLatencySamples === 140,
  "live effect rack reports plugin plus transport latency for host compensation"
);

const rackParameters = await rack.getParameters();
await rack.setPreset("dub-delay");
await rack.setParameter("filter", 0.75);
await rack.setParameterEvents([{ parameterId: "filter", normalizedValue: 0.25, time: 16 }]);
await rack.setParameterCurve("filter", [{ time: 0, normalizedValue: 0.1 }, { time: 64, normalizedValue: 0.9 }], "linear");
await rack.setAutomationLane("filter", [{ samplePosition: 0, normalizedValue: 0.2 }, { samplePosition: 128, normalizedValue: 0.8 }]);
await rack.clearAutomationLane("filter");
await rack.sendMidiEvents([{ type: "controlChange", controller: 1, value: 0.5, channel: 0 }]);
assert(rackParameters.parameters[0]?.id === "filter", "live rack exposes rack-owned parameter metadata");
const rackControlTargets = [client.parameterRequests.at(-1), client.presets.at(-1)?.instanceId, client.parameterSets.at(-1)?.instanceId, client.parameterEvents.at(-1)?.instanceId, client.parameterCurves.at(-1)?.instanceId, client.automationLanes.at(-1)?.instanceId, client.clearedAutomationLanes.at(-1)?.instanceId, client.midiEvents.at(-1)?.instanceId];
assert(rackControlTargets.every((instanceId) => instanceId === rack.instanceId), "live rack binds control helpers to its owned instance");

let latencyEvents = 0;
rack.addEventListener("latencychange", () => {
  latencyEvents += 1;
});
let wetMixEvents = 0;
rack.addEventListener("wetmixchange", () => {
  wetMixEvents += 1;
});
const refreshedTransportLatency = await rack.refreshLatency(256.9);
assert(client.latencyRequests.at(-1) === 256, "live rack bounds transport latency before requesting compensation");
assert(
  refreshedTransportLatency.pluginLatencySamples === 12 &&
    refreshedTransportLatency.transportLatencySamples === 256 &&
    refreshedTransportLatency.reportedLatencySamples === 268 &&
    refreshedTransportLatency.reportedLatencyMs === 5.583,
  "live rack refresh normalizes plugin plus transport latency for host compensation"
);
const rackTiming = rack.timing;
assert(rackTiming.blockDurationMs === 2.667 && rackTiming.transportLatencyBlocks === 2 && rackTiming.reportedLatencyBlocks === 2.094, "live rack exposes bounded timing snapshots for host schedulers");
assert(latencyEvents === 1, "live rack emits latencychange when refreshed latency changes");

const inputChannels = [
  [1, 0.5, -0.5, 0, Number.NaN],
  [0.25, -0.25, 0.75, -0.75, Number.POSITIVE_INFINITY, ...Array(129).fill(-0.1)]
];
const wet = await rack.processBlock({
  blockId: 1,
  channels: inputChannels,
  inputBuses: [{ index: 1, channels: inputChannels }],
  transport: { playing: true, samplePosition: 0 }
});
assert(wet.bypassed === false && wet.healthy === true, "healthy live rack returns processed audio");
assert(wet.channels[0].length === 128 && wet.channels[0][0] === 0.5 && wet.channels[1][3] === -0.375, "processed audio comes from the plugin with bounded live block frames");
assert(rack.health.lastRenderBudgetMs === 2.667, "live rack records render budget telemetry");
assert(client.binaryProcessed.length === 1 && client.binaryProcessed.at(-1).channels[0].length === 128 && client.binaryProcessed.at(-1).channels[0][4] === 0 && client.binaryProcessed.at(-1).inputBuses?.[0]?.channels[0]?.length === 128, "healthy live rack uses bounded binary processAudioBlock by default");
assert(client.processed.length === 1, "binary live rack still reaches the fake processor");

client.latencySamples = 48;
const dynamicLatency = await rack.processBlock({ blockId: 2, channels: inputChannels });
assert(dynamicLatency.latencySamples === 48, "live rack receives dynamic plugin latency from render responses");
assert(
  rack.health.pluginLatencySamples === 48 &&
    rack.health.transportLatencySamples === 256 &&
    rack.health.reportedLatencySamples === 304 &&
    rack.health.reportedLatencyMs === 6.333,
  "live rack updates plugin plus transport latency from render responses"
);
assert(latencyEvents === 2, "live rack emits a latencychange event when render latency changes");
client.latencySamples = 12;

const processedBeforeMix = client.processed.length;
rack.setWetMix(0.25);
const mixed = await rack.processBlock({ blockId: 3, channels: inputChannels });
assert(rack.health.wetMix === 0.25 && wetMixEvents === 1, "setWetMix updates bounded live rack mix health");
assert(mixed.bypassed === false && near(mixed.channels[0][0], 0.875), "live rack blends wet plugin output with dry input");
const dryMixed = await rack.processBlock({ blockId: 4, channels: inputChannels, wetMix: 0 });
assert(dryMixed.bypassed === false && dryMixed.channels[0][0] === 1, "per-block wetMix zero outputs dry audio without bypassing");
assert(client.processed.length === processedBeforeMix + 2, "wetMix still allows plugin processing for state continuity");
rack.setWetMix(4);
assert(rack.health.wetMix === 1 && wetMixEvents === 2, "setWetMix clamps over-range mix values");

rack.setBypassed(true);
await rack.setParameter("filter", 0.33);
assert(client.parameterSets.at(-1)?.normalizedValue === 0.33, "manual bypass still allows live control changes");
const processedBeforeBypass = client.processed.length;
const bypassed = await rack.processBlock({ blockId: 2, channels: inputChannels });
assert(bypassed.bypassed === true && bypassed.channels[0][0] === 1, "manual bypass returns dry audio");
assert(client.processed.length === processedBeforeBypass, "manual bypass avoids plugin processing");

rack.setBypassed(false);
client.processingDelayMs = 5;
const processedBeforeInFlightBypass = client.processed.length;
const inFlightBypass = rack.processBlock({ blockId: 3, channels: inputChannels });
rack.setBypassed(true);
const bypassedAfterStart = await inFlightBypass;
assert(bypassedAfterStart.bypassed === true && bypassedAfterStart.renderEngine === "dry-bypass", "live rack drops wet output after in-flight bypass");
assert(bypassedAfterStart.channels[0][0] === 1, "in-flight bypass preserves dry input");
assert(client.processed.length === processedBeforeInFlightBypass + 1, "in-flight bypass can finish native rendering without returning it wet");
client.processingDelayMs = 0;

let errorEvents = 0;
rack.addEventListener("effect-error", () => {
  errorEvents += 1;
});
rack.setBypassed(false);
const processedBeforeFailure = client.processed.length;
client.failProcessing = true;
const failed = await rack.processBlock({ blockId: 3, channels: inputChannels });
assert(failed.bypassed === true && failed.healthy === false, "processing failure fails closed to dry audio");
assert(failed.channels[1][2] === 0.75, "failure fallback preserves dry input");
assert(errorEvents === 1, "processing failure emits one effect-error event");
assert(rack.health.unhealthyReason === "processing-error", "processing failure records a non-recoverable reason");

const stillDry = await rack.processBlock({ blockId: 4, channels: inputChannels });
assert(stillDry.bypassed === true && client.processed.length === processedBeforeFailure + 1, "unhealthy rack stays dry until recreated");
assert(rack.health.healthy === false, "processing-error rack does not auto-recover");
let controlRejected = false;
try {
  await rack.setParameter("filter", 0.1);
} catch (error) {
  controlRejected = /not controllable/.test(String(error?.message));
}
assert(controlRejected === true, "unhealthy live rack rejects control helpers until recreated");

client.failProcessing = false;
await rack.recreate();
const recovered = await rack.processBlock({ blockId: 5, channels: inputChannels });
assert(rack.instanceId === "inst-live-2", "recreate replaces the effect instance");
assert(recovered.bypassed === false && recovered.channels[0][1] === 0.25, "recreated rack processes audio again");

client.processingDelayMs = 5;
client.failProcessing = true;
const staleFailureDuringRecreate = rack.processBlock({ blockId: 6, channels: inputChannels });
await rack.recreate();
const staleFailureDry = await staleFailureDuringRecreate;
assert(staleFailureDry.bypassed === true && staleFailureDry.renderEngine === "dry-state-changed", "recreate drops stale rejected render output dry");
assert(rack.health.healthy === true && errorEvents === 1, "stale rejected renders after recreate do not poison the current rack");
client.failProcessing = false;
client.processingDelayMs = 0;
const afterStaleFailureRecreate = await rack.processBlock({ blockId: 7, channels: inputChannels });
assert(afterStaleFailureRecreate.bypassed === false, "rack keeps processing after a stale rejected render from a retired instance");

await rack.processBlock({
  blockId: 8,
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

const processPressureRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  processBudgetMs: 25,
  maxConsecutiveProcessBudgetMisses: 2,
  processBudgetRecoveryBlocks: 2
});
let processBudgetEvents = 0;
let processBudgetRecoveredEvents = 0;
processPressureRack.addEventListener("process-budget-exceeded", () => {
  processBudgetEvents += 1;
});
processPressureRack.addEventListener("process-budget-recovered", () => {
  processBudgetRecoveredEvents += 1;
});
client.processingDelayMs = 35;
const processPressured = await processPressureRack.processBlock({ blockId: 15, channels: inputChannels });
assert(processPressured.bypassed === false && processPressureRack.health.processBudgetMisses === 1, "first process budget miss stays wet");
assert(processPressureRack.health.lastProcessBudgetMs === 25 && processPressureRack.health.processBudgetExceeded === true, "process budget telemetry records slow bridge trips");
const processOverloaded = await processPressureRack.processBlock({ blockId: 16, channels: inputChannels });
assert(processOverloaded.bypassed === true && processOverloaded.healthy === false, "repeated process budget misses fail closed to dry audio");
assert(processPressureRack.health.unhealthyReason === "process-budget-exceeded", "process budget pressure records a recoverable reason");
assert(processBudgetEvents === 2, "process budget misses emit host-visible events");
client.processingDelayMs = 0;
const processCooldownOne = await processPressureRack.processBlock({ blockId: 17, channels: inputChannels });
assert(processCooldownOne.bypassed === true && processPressureRack.health.recoveryDryBlocks === 1, "process budget recovery waits through dry cooldown blocks");
const processCooldownTwo = await processPressureRack.processBlock({ blockId: 18, channels: inputChannels });
assert(processCooldownTwo.bypassed === true && processCooldownTwo.healthy === false, "final process budget cooldown block stays dry");
assert(processPressureRack.health.healthy === true && processBudgetRecoveredEvents === 1, "process budget rack recovers after bounded dry cooldown");
const processRecovered = await processPressureRack.processBlock({ blockId: 19, channels: inputChannels });
assert(processRecovered.bypassed === false && processPressureRack.health.processBudgetMisses === 0, "recovered process budget rack resumes wet processing");
await processPressureRack.destroy();

const manualRetryRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  maxConsecutiveRenderBudgetMisses: 1
});
let retryEvents = 0;
manualRetryRack.addEventListener("retry", () => {
  retryEvents += 1;
});
client.renderDurationMs = 5;
client.renderBudgetMs = 2;
client.renderBudgetExceeded = true;
const retryPressure = await manualRetryRack.processBlock({ blockId: 20, channels: inputChannels });
assert(retryPressure.bypassed === true && manualRetryRack.health.unhealthyReason === "render-budget-exceeded", "manual retry rack starts dry after recoverable pressure");
assert(manualRetryRack.retry() === true, "manual retry clears recoverable live pressure without recreating");
assert(manualRetryRack.health.healthy === true && manualRetryRack.health.renderBudgetMisses === 0, "manual retry clears pressure health");
assert(retryEvents === 1, "manual retry emits a host-visible event");
client.renderDurationMs = 0.5;
client.renderBudgetMs = 2.667;
client.renderBudgetExceeded = false;
const retryWet = await manualRetryRack.processBlock({ blockId: 21, channels: inputChannels });
assert(retryWet.bypassed === false, "manual retry resumes wet processing without replacing the instance");
client.failProcessing = true;
const retryFailure = await manualRetryRack.processBlock({ blockId: 22, channels: inputChannels });
assert(retryFailure.bypassed === true && manualRetryRack.retry() === false, "manual retry refuses non-recoverable processing errors");
client.failProcessing = false;
await manualRetryRack.destroy();

const backpressureRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128,
  maxInFlightBlocks: 1
});
const backpressureEvents = { input: 0, health: 0 };
backpressureRack.addEventListener("input-backpressure", () => { backpressureEvents.input += 1; });
backpressureRack.addEventListener("healthchange", () => { backpressureEvents.health += 1; });
client.processingDelayMs = 20;
const slowBlock = backpressureRack.processBlock({ blockId: 12, channels: inputChannels });
const backpressured = await backpressureRack.processBlock({ blockId: 13, channels: inputChannels });
assert(backpressured.bypassed === true && backpressured.healthy === true, "live rack returns dry when its in-flight limit is full");
assert(backpressured.renderEngine === "dry-backpressure", "in-flight pressure reports a dry backpressure render engine");
assert(backpressureRack.health.droppedInputBlocks === 1 && backpressureRack.health.inFlightBlocks === 1 && backpressureRack.health.lastDryReason === "backpressure", "live rack tracks in-flight pressure");
assert(backpressureEvents.input === 1 && backpressureEvents.health === 1, "in-flight pressure emits host-visible events");
client.processingDelayMs = 0;
const slowProcessed = await slowBlock;
assert(slowProcessed.bypassed === false && backpressureRack.health.inFlightBlocks === 0 && backpressureRack.health.lastDryReason === undefined && backpressureEvents.health === 2, "first slow block completes after backpressure drop");
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
assert(staleRack.health.staleInputBlocks === 1 && staleEvents === 1 && staleRack.health.lastDryReason === "stale-input", "live rack reports stale input pressure");
assert(client.processed.length === beforeStaleProcessed, "stale input avoids plugin processing");
const fresh = await staleRack.processBlock({ blockId: 15, channels: inputChannels, timestamp: liveEffectTestNowMs() });
assert(fresh.bypassed === false && staleRack.health.lastDryReason === undefined && client.processed.length === beforeStaleProcessed + 1, "fresh timestamped input still processes");
let staleOutputEvents = 0;
staleRack.addEventListener("stale-output", () => {
  staleOutputEvents += 1;
});
client.processingDelayMs = 5;
const beforeStaleOutputProcessed = client.processed.length;
const staleOutput = await staleRack.processBlock({ blockId: 16, channels: inputChannels, timestamp: liveEffectTestNowMs() });
assert(staleOutput.bypassed === true && staleOutput.healthy === true, "live rack drops late render output to dry");
assert(staleOutput.renderEngine === "dry-stale-output", "late render output reports a dry stale-output render engine");
assert(staleRack.health.staleOutputBlocks === 1 && staleOutputEvents === 1 && staleRack.health.lastDryReason === "stale-output", "live rack reports stale output pressure");
assert(client.processed.length === beforeStaleOutputProcessed + 1, "stale output still records that native rendering happened");
client.processingDelayMs = 0;
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
client.protocolErrorDetails = {
  renderTimeoutMs: 4,
  renderBudgetMs: 2.667,
  renderTimeoutBudgetDeltaMs: 1.333,
  renderTimeouts: 2,
  consecutiveRenderTimeouts: 1,
  renderQuarantined: true
};
const daemonTimedOut = await daemonTimeoutRack.processBlock({ blockId: 25, channels: inputChannels });
assert(
  daemonTimedOut.bypassed === true && daemonTimeoutRack.health.unhealthyReason === "process-timeout",
  "daemon render_timeout errors use live process-timeout policy"
);
assert(
  daemonTimeoutRack.health.lastRenderTimeoutMs === 4 &&
    daemonTimeoutRack.health.lastRenderTimeoutBudgetMs === 2.667 &&
    daemonTimeoutRack.health.lastRenderTimeoutBudgetDeltaMs === 1.333,
  "daemon render_timeout details are exposed in live rack health"
);
assert(
  daemonTimeoutRack.health.renderTimeouts === 2 &&
    daemonTimeoutRack.health.consecutiveRenderTimeouts === 1 &&
    daemonTimeoutRack.health.renderQuarantined === true,
  "daemon render_timeout counts are exposed in live rack health"
);
client.protocolErrorCode = undefined;
client.protocolErrorDetails = {};
await daemonTimeoutRack.destroy();

const daemonQuarantineRack = await SoundBridgeLiveEffectRack.create({
  client,
  plugin,
  sampleRate: 48000,
  maxBlockSize: 128
});
client.protocolErrorCode = "render_quarantined";
client.protocolErrorDetails = {
  renderTimeoutMs: 5,
  renderBudgetMs: 2.667,
  renderTimeoutBudgetDeltaMs: 2.333,
  renderTimeouts: 3,
  consecutiveRenderTimeouts: 2,
  renderQuarantined: true
};
const daemonQuarantined = await daemonQuarantineRack.processBlock({ blockId: 26, channels: inputChannels });
assert(
  daemonQuarantined.bypassed === true && daemonQuarantineRack.health.unhealthyReason === "process-timeout",
  "daemon render_quarantined errors use live process-timeout policy"
);
assert(
  daemonQuarantineRack.health.renderQuarantined === true &&
    daemonQuarantineRack.health.renderTimeouts === 3 &&
    daemonQuarantineRack.health.lastRenderTimeoutBudgetDeltaMs === 2.333,
  "daemon render_quarantined details are exposed in live rack health"
);
client.protocolErrorCode = undefined;
client.protocolErrorDetails = {};
await daemonQuarantineRack.destroy();

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
