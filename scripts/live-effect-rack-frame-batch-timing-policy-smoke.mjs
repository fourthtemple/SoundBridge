import {
  createLiveEffectRackFrameBatchProcessor,
  createLivePerformanceFrameBatchProcessorOptions
} from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let now = 0;
let blockId = 0;
const scheduler = {
  captureFrame() {
    return { blockId: ++blockId, samplePosition: blockId * 128, timestamp: now, stale: false };
  },
  scheduleFromFrame(frame, channels) {
    return {
      blockId: frame.blockId,
      stale: false,
      request: { blockId: frame.blockId, channels, sampleRate: 48000 }
    };
  }
};
const target = {
  health: { healthy: true, latencySamples: 8, reportedLatencySamples: 12 },
  async processScheduledBlock(scheduled) {
    now += 3;
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 8,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "frame-batch-timing-policy",
      bypassed: false,
      healthy: true
    };
  }
};

const processor = createLiveEffectRackFrameBatchProcessor({
  scheduler,
  sampleRate: 96000,
  maxBlockSize: 64,
  processBudgetMs: 2,
  processTimeoutMs: 4,
  nowMs: () => now
});
const performanceOptions = createLivePerformanceFrameBatchProcessorOptions({
  scheduler,
  sampleRate: 96000,
  maxBlockSize: 64,
  processBudgetBlocks: 2,
  processTimeoutBlocks: 3
});
assert(performanceOptions.sampleRate === 96000 && performanceOptions.maxBlockSize === 64, "live frame batch performance options preserve timing dimensions");

let timingEvents = 0;
let healthEvents = 0;
let lastTimingEvent;
processor.addEventListener("timingpolicychange", (event) => {
  timingEvents += 1;
  lastTimingEvent = event.detail;
});
processor.addEventListener("healthchange", () => {
  healthEvents += 1;
});

const unchanged = processor.setTimingPolicy({ processBudgetMs: 2, processTimeoutMs: 4 });
assert(unchanged.processBudgetMs === 2 && timingEvents === 0 && healthEvents === 0, "live frame batch timing policy ignores unchanged values");

const updated = processor.setTimingPolicy({ processBudgetMs: 6, processTimeoutMs: 12 });
assert(updated.processBudgetMs === 6 && updated.processTimeoutMs === 12, "live frame batch timing policy updates budget and timeout health");
assert(timingEvents === 1 && healthEvents === 1, "live frame batch timing policy emits bounded host-visible events");
assert(lastTimingEvent.previous.processTimeoutMs === 4 && lastTimingEvent.health.processTimeoutMs === 12, "live frame batch timing policy event includes previous and current health");

const result = await processor.process([{ id: "deck-a", target, channels: [[0.1, 0.2]] }]);
assert(result.processBudgetMs === 6, "live frame batch timing policy applies refreshed process budget to future results");
assert(result.processTimeoutMs === 12, "live frame batch timing policy applies refreshed timeout to future results");
assert(processor.health.processBudgetMs === 6 && processor.health.processBudgetExceeded === false, "live frame batch timing policy applies refreshed process budget to future health");
const timing = processor.timing;
assert(timing.sampleRate === 96000 && timing.maxBlockSize === 64 && timing.blockDurationMs === 0.667, "live frame batch exposes host-readable block timing");
assert(timing.pluginLatencySamples === 8 && timing.reportedLatencySamples === 12 && timing.reportedLatencyBlocks === 0.188, "live frame batch timing exposes aggregate latency");
assert(timing.processBudgetMs === 6 && timing.processTimeoutMs === 12, "live frame batch timing follows refreshed budget and timeout");

const bounded = processor.setTimingPolicy({ processBudgetMs: -1, processTimeoutMs: 100000 });
assert(bounded.processBudgetMs === undefined, "live frame batch timing policy clamps negative process budgets to disabled");
assert(bounded.processTimeoutMs === 60000, "live frame batch timing policy clamps process timeouts");

console.log("Live effect rack frame batch timing policy smoke checks passed.");
