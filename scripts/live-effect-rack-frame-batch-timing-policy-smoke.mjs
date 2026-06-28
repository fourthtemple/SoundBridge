import { createLiveEffectRackFrameBatchProcessor } from "../packages/web-client/dist/soundbridge-client.js";

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
  health: { healthy: true, latencySamples: 0, reportedLatencySamples: 0 },
  async processScheduledBlock(scheduled) {
    now += 3;
    return {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 0,
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
  processBudgetMs: 2,
  processTimeoutMs: 4,
  nowMs: () => now
});

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

const bounded = processor.setTimingPolicy({ processBudgetMs: -1, processTimeoutMs: 100000 });
assert(bounded.processBudgetMs === undefined, "live frame batch timing policy clamps negative process budgets to disabled");
assert(bounded.processTimeoutMs === 60000, "live frame batch timing policy clamps process timeouts");

console.log("Live effect rack frame batch timing policy smoke checks passed.");
