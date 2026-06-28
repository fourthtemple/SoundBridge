import { createLiveEffectRackChain } from "../packages/web-client/dist/soundbridge-client.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let nowMs = 0;

class TimedStage {
  constructor(durationMs) {
    this.durationMs = durationMs;
    this.health = { healthy: true };
  }

  async processBlock(request) {
    nowMs += this.durationMs;
    return {
      blockId: request.blockId,
      channels: request.channels,
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "chain-deadline-event-stage",
      bypassed: false,
      healthy: true
    };
  }
}

const stage = new TimedStage(3);
const chain = createLiveEffectRackChain({
  stages: [stage],
  outputChannels: 1,
  maxBlockSize: 128,
  processBudgetMs: 2,
  maxConsecutiveProcessBudgetMisses: 0,
  nowMs: () => nowMs
});
let deadlineEvents = 0;
let deadlineDetail;
chain.addEventListener("chain-response-deadline-missed", (event) => {
  deadlineEvents += 1;
  deadlineDetail = event.detail;
});
const missed = await chain.processBlock({ blockId: 1, channels: [[0.5]], sampleRate: 48000 });
assert(missed.bypassed === false && chain.health.healthy === true, "chain deadline observation does not fail dry by itself");
assert(deadlineEvents === 1, "live rack chain emits one deadline miss event");
assert(deadlineDetail.durationMs === 3 && deadlineDetail.budgetMs === 2, "chain deadline event includes aggregate duration and budget");
assert(deadlineDetail.leadMs === -1 && deadlineDetail.leadBlocks < 0, "chain deadline event reports negative deadline lead");
assert(deadlineDetail.health.responseDeadlineMisses === 1, "chain deadline event includes updated health counters");

stage.durationMs = 1;
const recovered = await chain.processBlock({ blockId: 2, channels: [[0.25]], sampleRate: 48000 });
assert(recovered.bypassed === false, "chain keeps processing after an observed deadline miss");
assert(deadlineEvents === 1, "chain does not emit deadline events for in-budget blocks");
assert(chain.health.responseDeadlineMisses === 1, "chain deadline miss counter is retained for scheduler calibration");

console.log("Live effect rack chain deadline event smoke checks passed.");
