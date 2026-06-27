import { createLivePerformanceAudioNodeRecreateController } from "../packages/web-client/dist/soundbridge-client.js";

let health = audioNodeHealth({ fallbackOutputBlocks: 10 });
const target = {
  get health() {
    return health;
  }
};
let recreateCalls = 0;
const controller = createLivePerformanceAudioNodeRecreateController({
  node: target,
  recreateBlocks: 2,
  maxRecreateAttempts: 1,
  async recreate(recreateHealth) {
    recreateCalls += 1;
    assert(recreateHealth.unhealthyReason === "process-timeout", "AudioNode recreate receives timeout health");
    health = audioNodeHealth({ bypassed: false, unhealthyReason: undefined, fallbackOutputBlocks: recreateHealth.fallbackOutputBlocks });
    return { instanceId: `inst-recreated-${recreateCalls}` };
  }
});

let snapshot = await controller.record();
assert(snapshot.active === true && snapshot.applied === false && snapshot.dryBlocks === 0, "AudioNode recreate controller starts a timeout dry window");
health = audioNodeHealth({ fallbackOutputBlocks: 11 });
snapshot = await controller.record();
assert(snapshot.active === true && snapshot.recreateBlocksRemaining === 1 && recreateCalls === 0, "AudioNode recreate controller waits through dry cooldown blocks");
health = audioNodeHealth({ fallbackOutputBlocks: 12 });
snapshot = await controller.record();
assert(snapshot.applied === true && snapshot.result?.instanceId === "inst-recreated-1", "AudioNode recreate controller applies bounded recreation");
assert(snapshot.exhausted === true && recreateCalls === 1 && target.health.unhealthyReason === undefined, "AudioNode recreate controller caps attempts and observes recreated health");

health = audioNodeHealth({ fallbackOutputBlocks: 12 });
snapshot = await controller.record();
health = audioNodeHealth({ fallbackOutputBlocks: 14 });
snapshot = await controller.record();
assert(snapshot.applied === false && snapshot.exhausted === true && recreateCalls === 1, "AudioNode recreate controller refuses repeated timeout recreates past the cap");

controller.reset();
snapshot = await controller.record(audioNodeHealth({ bypassed: false, unhealthyReason: undefined, fallbackOutputBlocks: 14 }));
assert(snapshot.active === false && snapshot.recreateAttempts === 0, "AudioNode recreate controller reset clears attempts outside timeout pressure");

const failingController = createLivePerformanceAudioNodeRecreateController({
  node: target,
  recreateBlocks: 0,
  maxRecreateAttempts: 1,
  async recreate() {
    throw new Error("recreate failed");
  }
});
health = audioNodeHealth({ fallbackOutputBlocks: 20 });
snapshot = await failingController.record();
assert(snapshot.applied === false && snapshot.exhausted === true && /recreate failed/.test(String(snapshot.error?.message)), "AudioNode recreate controller reports recreate errors");

console.log("Live AudioNode recreate smoke checks passed.");

function audioNodeHealth(overrides = {}) {
  return {
    bypassed: true,
    unhealthyReason: "process-timeout",
    fallbackOutputBlocks: 0,
    ...overrides
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
