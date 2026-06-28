import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const workletPath = resolve("packages/web-client/dist/soundbridge-worklet.js");
const workletSource = readFileSync(workletPath, "utf8");
const postedMessages = [];
let processorCtor;
let lastPort;

class TestPort {
  onmessage = undefined;
  messages = [];

  postMessage(message) {
    this.messages.push(message);
    postedMessages.push(message);
  }
}

class TestAudioWorkletProcessor {
  constructor() {
    lastPort = new TestPort();
    this.port = lastPort;
  }
}

vm.runInNewContext(workletSource, {
  ArrayBuffer,
  AudioWorkletProcessor: TestAudioWorkletProcessor,
  Atomics,
  Float32Array,
  Int32Array,
  Map,
  Math,
  Number,
  Array,
  SharedArrayBuffer,
  registerProcessor(name, constructor) {
    assert(name === "soundbridge-audio-processor", "worklet registers the expected processor name");
    processorCtor = constructor;
  }
});

assert(typeof processorCtor === "function", "worklet processor constructor was captured");
const processor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 2
  }
});

function renderBlock(samples) {
  const output = [new Float32Array(samples.length)];
  processor.process([[Float32Array.from(samples)]], [output]);
  return Array.from(output[0]);
}

function deliver(blockId, samples) {
  lastPort.onmessage({
    data: {
      type: "processed",
      blockId,
      channels: [samples]
    }
  });
}

assert(equal(renderBlock([0, 0]), [0, 0]), "block 0 starts as dry warmup");
assert(equal(renderBlock([1, 1]), [1, 1]), "block 1 starts as dry warmup");
assert(processor.fallbackOutputBlocks === 2 && processor.lastFallbackReason === "underrun", "worklet counts initial fallback output blocks");

deliver(1, [101, 101]);
assert(equal(renderBlock([2, 2]), [2, 2]), "out-of-order block 1 is not played in block 0's slot");

deliver(0, [100, 100]);
assert(processor.responseDeadlineMisses === 1, "late worklet responses count deadline misses");
deliver(2, [102, 102]);
assert(processor.staleOutputBlocks === 1, "late block 0 is counted as stale");
assert(equal(renderBlock([3, 3]), [101, 101]), "block 1 plays in its scheduled output slot");
assert(processor.lastFallbackReason === "none", "worklet clears the fallback reason after wet output");
assert(equal(renderBlock([4, 4]), [102, 102]), "block 2 plays in its scheduled output slot");

lastPort.onmessage({ data: { type: "dropped", blockId: 99 } });
assert(processor.droppedInputBlocks === 1, "dropped input blocks are counted");

const processIds = postedMessages.filter((message) => message.type === "process").map((message) => message.blockId);
assert(equal(processIds, [0, 1, 2, 3, 4]), "worklet emits monotonic process block ids");

const fallbackProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxInFlightBlocks: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 1
  }
});
const fallbackPort = lastPort;
fallbackProcessor.process([[Float32Array.from([20])]], [[new Float32Array(1)]]);
fallbackProcessor.process([[Float32Array.from([21])]], [[new Float32Array(1)]]);
assert(
  equal(fallbackPort.messages.filter((message) => message.type === "process").map((message) => message.blockId), [0]),
  "fallback worklet transport drops input before posting past its in-flight limit"
);
assert(fallbackProcessor.droppedInputBlocks === 1 && fallbackProcessor.inFlightBlocks === 1, "fallback worklet transport tracks bounded in-flight pressure");
fallbackPort.onmessage({ data: { type: "audio-error", blockId: 0, error: "failed" } });
assert(fallbackProcessor.inFlightBlocks === 0, "fallback worklet transport releases in-flight blocks on errors");
fallbackProcessor.process([[Float32Array.from([22])]], [[new Float32Array(1)]]);
assert(
  equal(fallbackPort.messages.filter((message) => message.type === "process").map((message) => message.blockId), [0, 2]),
  "fallback worklet transport resumes posting after an error releases capacity"
);

const directProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxInFlightBlocks: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 1
  }
});
const directMainPort = lastPort;
const directTransportPort = new TestPort();
directMainPort.onmessage({ data: { type: "connect-transport", port: directTransportPort } });
directProcessor.process([[Float32Array.from([5, 5])]], [[new Float32Array(2)]]);
assert(directTransportPort.messages[0]?.type === "process", "direct worklet transport posts process blocks to the transport port");
assert(directTransportPort.messages[0]?.transportLatencySamples === 2, "direct worklet transport posts current output latency samples");
assert(!directMainPort.messages.some((message) => message.type === "process"), "direct worklet transport avoids page-thread process messages");
const recycledInput = directTransportPort.messages[0].channels[0];
directTransportPort.onmessage({
  data: {
    type: "recycle-input",
    frames: 2,
    channels: [recycledInput]
  }
});
assert(directProcessor.pooledInputBuffers === 1, "direct worklet transport pools recycled input buffers");
const transferredOutput = Float32Array.from([50, 50]);
directTransportPort.onmessage({
  data: {
    type: "processed",
    blockId: 0,
    channels: [transferredOutput],
    latencySamples: 64,
    renderDurationMs: 0.75,
    renderBudgetMs: 1.333,
    renderBudgetExceeded: false,
    renderEngine: "direct-worker"
  }
});
assert(directProcessor.inFlightBlocks === 0, "direct worklet transport releases in-flight blocks on response");
assert(directProcessor.responseBlocks === 1, "direct worklet transport counts returned response blocks");
assert(directProcessor.responseDeadlineLeadBlocks === 0, "direct worklet transport records just-in-time deadline lead");
assert(
  directProcessor.outputBlocks.get(0)?.[0] === transferredOutput,
  "direct worklet transport queues transferred Float32Array output without an extra copy"
);
assert(
  directMainPort.messages.some((message) =>
    message.type === "process-diagnostics" &&
    message.renderEngine === "direct-worker" &&
    message.latencySamples === 64 &&
    message.renderDurationMs === 0.75 &&
    message.renderBudgetMs === 1.333 &&
    message.renderBudgetExceeded === false
  ),
  "direct worklet transport forwards render timing diagnostics to the page port"
);
directProcessor.process([[Float32Array.from([6, 6])]], [[new Float32Array(2)]]);
assert(
  directTransportPort.messages[1]?.channels?.[0] === recycledInput,
  "direct worklet transport reuses recycled input buffers for later process blocks"
);
assert(directProcessor.inputBufferReuses === 1, "direct worklet transport counts input buffer reuse");

const bypassProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 1,
    statsIntervalBlocks: 8,
    bypassed: true
  }
});
const bypassMainPort = lastPort;
const bypassTransportPort = new TestPort();
bypassMainPort.onmessage({ data: { type: "connect-transport", port: bypassTransportPort } });
const bypassOutput = [new Float32Array(2)];
bypassProcessor.process([[Float32Array.from([30, 31])]], [bypassOutput]);
assert(equal(Array.from(bypassOutput[0]), [30, 31]), "bypassed worklet outputs dry input");
assert(bypassProcessor.fallbackOutputBlocks === 1 && bypassProcessor.lastFallbackReason === "bypass", "bypassed worklet counts dry fallback output");
assert(bypassTransportPort.messages.length === 0, "bypassed worklet does not post render work");
for (let index = 0; index < 7; index += 1) bypassProcessor.process([[Float32Array.from([30])]], [[new Float32Array(1)]]);
assert(bypassMainPort.messages.some((message) => message.type === "stats" && message.fallbackOutputBlocks === 8 && message.lastFallbackReason === "bypass"), "bypassed worklet emits fallback stats at bounded cadence");
assert(bypassTransportPort.messages.length === 0, "bypassed worklet still avoids render work while reporting stats");
bypassTransportPort.onmessage({ data: { type: "processed", blockId: 0, channels: [Float32Array.from([300, 300])] } });
assert(bypassProcessor.outputBlocks.size === 0, "bypassed worklet ignores late wet responses");
bypassMainPort.onmessage({ data: { type: "set-bypassed", bypassed: false } });
bypassProcessor.process([[Float32Array.from([32, 33])]], [[new Float32Array(2)]]);
assert(bypassTransportPort.messages.at(-1)?.type === "process", "unbypassed worklet resumes render work");

const bypassLeakProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxInFlightBlocks: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 2
  }
});
const bypassLeakMainPort = lastPort;
const bypassLeakTransportPort = new TestPort();
bypassLeakMainPort.onmessage({ data: { type: "connect-transport", port: bypassLeakTransportPort } });
bypassLeakProcessor.process([[Float32Array.from([40])]], [[new Float32Array(1)]]);
assert(bypassLeakProcessor.inFlightBlocks === 1, "worklet tracks pre-bypass in-flight render work");
bypassLeakMainPort.onmessage({ data: { type: "set-bypassed", bypassed: true } });
assert(bypassLeakProcessor.inFlightBlocks === 0, "bypassed worklet releases stale in-flight render accounting");
bypassLeakProcessor.process([[Float32Array.from([41])]], [[new Float32Array(1)]]);
bypassLeakMainPort.onmessage({ data: { type: "set-bypassed", bypassed: false } });
bypassLeakTransportPort.onmessage({ data: { type: "processed", blockId: 0, channels: [Float32Array.from([400])] } });
assert(bypassLeakProcessor.outputBlocks.size === 0, "unbypassed worklet drops wet responses requested before bypass");

directMainPort.onmessage({ data: { type: "destroy" } });
assert(directTransportPort.messages.at(-1)?.type === "destroy", "worklet destroy notifies the transport port");
const directMessagesBeforeDestroyedProcess = directTransportPort.messages.length;
directTransportPort.onmessage({ data: { type: "processed", blockId: 99, channels: [Float32Array.from([99, 99])] } });
const destroyedOutput = [new Float32Array(2)];
assert(directProcessor.process([[Float32Array.from([99, 99])]], [destroyedOutput]) === false, "destroyed worklet asks the browser to stop processing");
assert(equal(Array.from(destroyedOutput[0]), [0, 0]), "destroyed worklet outputs silence");
assert(directTransportPort.messages.length === directMessagesBeforeDestroyedProcess, "destroyed worklet does not post new render work");

const sharedProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 1
  }
});
const sharedMainPort = lastPort;
const sharedTransportPort = new TestPort();
const sharedAudio = createSharedAudio(4, 1, 2);
sharedMainPort.onmessage({ data: { type: "connect-transport", port: sharedTransportPort, sharedAudio } });
sharedTransportPort.onmessage({ data: { type: "shared-audio-status", wakeMode: "atomics", sharedTransportInFlightBlocks: 2 } });
assert(sharedProcessor.sharedAudioWakeMode === "atomics", "shared worklet transport records the worker wake mode");
assert(sharedProcessor.sharedTransportStats.sharedTransportInFlightBlocks === 2, "shared worklet transport records bounded worker status");
const sharedWarmup = [new Float32Array(2)];
sharedProcessor.process([[Float32Array.from([7, 7])]], [sharedWarmup]);
assert(sharedTransportPort.messages.length === 0, "shared worklet transport avoids per-block port messages");
assert(Atomics.load(new Int32Array(sharedAudio.inputControl), 2) === 1, "shared worklet transport writes input blocks to shared memory");
assert(Atomics.load(new Int32Array(sharedAudio.inputControl), 11) === 2, "shared worklet transport writes current output latency samples");
writeSharedOutput(sharedAudio, 0, [Float32Array.from([70, 70])]);
const sharedOutput = [new Float32Array(2)];
sharedProcessor.process([[Float32Array.from([8, 8])]], [sharedOutput]);
assert(equal(Array.from(sharedOutput[0]), [70, 70]), "shared worklet transport drains shared output blocks");
assert(sharedProcessor.responseBlocks === 1, "shared worklet transport counts returned response blocks");
assert(sharedProcessor.responseDeadlineLeadBlocks === 0, "shared worklet transport records shared deadline lead");
assert(sharedProcessor.outputBufferAllocations === 1, "shared worklet transport allocates its first shared output buffer");
writeSharedOutput(sharedAudio, 1, [Float32Array.from([71, 71])]);
const sharedOutputReuse = [new Float32Array(2)];
sharedProcessor.process([[Float32Array.from([9, 9])]], [sharedOutputReuse]);
assert(equal(Array.from(sharedOutputReuse[0]), [71, 71]), "shared worklet transport plays reused output buffers");
assert(sharedProcessor.outputBufferReuses === 1, "shared worklet transport reuses pooled output buffers");
sharedProcessor.process([[Float32Array.from([10, 10])]], [[new Float32Array(2)]]);
sharedProcessor.process([[Float32Array.from([11, 11])]], [[new Float32Array(2)]]);
const sharedInputControl = new Int32Array(sharedAudio.inputControl);
const sharedInputAudio = new Float32Array(sharedAudio.inputAudio);
assert(Atomics.load(sharedInputControl, 2) === 4, "shared worklet transport keeps a full input ring bounded");
assert(Atomics.load(sharedInputControl, 0) === 1 && Atomics.load(sharedInputControl, 1) === 1, "shared worklet transport advances a full input ring after overwrite");
assert(Atomics.load(sharedInputControl, 3) === 1, "shared worklet transport records overwritten shared input blocks");
assert(Atomics.load(sharedInputControl, 8) === 4, "shared worklet transport overwrites the oldest input slot with the newest block");
assert(equal(Array.from(sharedInputAudio.subarray(0, 2)), [11, 11]), "shared worklet transport keeps the newest audio under input pressure");
assert(sharedProcessor.sharedInputDroppedBlocks === 1, "shared worklet transport counts overwritten input pressure");

const sharedInputPressureProcessor = new processorCtor({
  processorOptions: { outputChannels: 1, maxQueuedOutputBlocks: 6, outputLatencyBlocks: 4, maxOutputLatencyBlocks: 6, latencyMissThresholdBlocks: 1 }
});
const sharedInputPressureMainPort = lastPort;
const sharedInputPressureTransportPort = new TestPort();
const sharedInputPressureAudio = createSharedAudio(2, 1, 2);
sharedInputPressureMainPort.onmessage({ data: { type: "connect-transport", port: sharedInputPressureTransportPort, sharedAudio: sharedInputPressureAudio } });
sharedInputPressureProcessor.process([[Float32Array.from([1, 1])]], [[new Float32Array(2)]]);
sharedInputPressureProcessor.process([[Float32Array.from([2, 2])]], [[new Float32Array(2)]]);
sharedInputPressureProcessor.process([[Float32Array.from([3, 3])]], [[new Float32Array(2)]]);
assert(sharedInputPressureProcessor.sharedInputDroppedBlocks === 1, "shared input pressure fixture overwrites one block");
assert(sharedInputPressureProcessor.outputLatencyBlocks === 5, "shared input overwrite pressure raises adaptive output latency");
assert(sharedInputPressureProcessor.latencySafetyBlocks === 1, "shared input overwrite pressure schedules controlled safety latency");

const sharedOutputPressureProcessor = new processorCtor({
  processorOptions: { outputChannels: 1, maxQueuedOutputBlocks: 4, outputLatencyBlocks: 1, maxOutputLatencyBlocks: 3, latencyMissThresholdBlocks: 1 }
});
const sharedOutputPressureMainPort = lastPort;
const sharedOutputPressureTransportPort = new TestPort();
const sharedOutputPressureAudio = createSharedAudio(2, 1, 2);
sharedOutputPressureMainPort.onmessage({ data: { type: "connect-transport", port: sharedOutputPressureTransportPort, sharedAudio: sharedOutputPressureAudio } });
Atomics.store(new Int32Array(sharedOutputPressureAudio.outputControl), 3, 1);
sharedOutputPressureProcessor.process([[Float32Array.from([12, 12])]], [[new Float32Array(2)]]);
assert(sharedOutputPressureProcessor.sharedOutputDroppedBlocks === 1, "shared worklet transport counts overwritten output pressure");
assert(sharedOutputPressureProcessor.outputLatencyBlocks === 2, "shared output overwrite pressure raises adaptive output latency");
assert(sharedOutputPressureProcessor.latencySafetyInsertions === 1, "shared output overwrite pressure inserts a controlled safety block");

const adaptiveProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 1,
    maxOutputLatencyBlocks: 3,
    latencyMissThresholdBlocks: 2
  }
});
const adaptiveMainPort = lastPort;
const adaptiveTransportPort = new TestPort();
adaptiveMainPort.onmessage({ data: { type: "connect-transport", port: adaptiveTransportPort } });
adaptiveProcessor.process([[Float32Array.from([0])]], [[new Float32Array(1)]]);
adaptiveProcessor.process([[Float32Array.from([1])]], [[new Float32Array(1)]]);
adaptiveProcessor.process([[Float32Array.from([2])]], [[new Float32Array(1)]]);
assert(adaptiveProcessor.outputLatencyBlocks === 2, "direct worklet transport raises output latency after repeated misses");
assert(adaptiveProcessor.latencyIncreases === 1, "direct worklet transport counts adaptive latency raises");
assert(adaptiveProcessor.transportLatencySamples() === 2, "direct worklet transport reports adaptive transport latency samples");
assert(adaptiveProcessor.latencySafetyBlocks === 1, "miss-driven adaptive latency raises schedule a safety block");
const adaptiveUnderrunsBeforeSafety = adaptiveProcessor.underruns;
adaptiveProcessor.process([[Float32Array.from([3])]], [[new Float32Array(1)]]);
assert(adaptiveProcessor.latencySafetyInsertions === 1, "miss-driven adaptive latency raises insert a controlled safety block");
assert(adaptiveProcessor.underruns === adaptiveUnderrunsBeforeSafety, "miss-driven safety blocks are not counted as underruns");
assert(adaptiveProcessor.lastFallbackReason === "latency-safety", "miss-driven safety blocks report fallback reason");

const recoveryProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 2,
    minOutputLatencyBlocks: 1,
    latencyRecoveryBlocks: 32,
    targetResponseDeadlineLeadBlocks: 0
  }
});
const recoveryMainPort = lastPort;
const recoveryTransportPort = new TestPort();
recoveryMainPort.onmessage({ data: { type: "connect-transport", port: recoveryTransportPort } });
for (let blockIndex = 0; blockIndex < 34; blockIndex += 1) {
  if (blockIndex >= 2) {
    recoveryTransportPort.onmessage({ data: { type: "processed", blockId: blockIndex - 2, channels: [Float32Array.from([blockIndex])] } });
  }
  recoveryProcessor.process([[Float32Array.from([blockIndex])]], [[new Float32Array(1)]]);
}
assert(recoveryProcessor.outputLatencyBlocks === 1, "worklet honors configured adaptive latency recovery window");
assert(recoveryProcessor.latencyDecreases === 1, "worklet counts adaptive latency recovery decreases");

const pressureProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 6,
    outputLatencyBlocks: 1,
    maxOutputLatencyBlocks: 3,
    targetResponseDeadlineLeadBlocks: 1,
    latencyPressureThresholdBlocks: 2
  }
});
const pressureMainPort = lastPort;
const pressureTransportPort = new TestPort();
pressureMainPort.onmessage({ data: { type: "connect-transport", port: pressureTransportPort } });
pressureProcessor.process([[Float32Array.from([10])]], [[new Float32Array(1)]]);
pressureTransportPort.onmessage({ data: { type: "processed", blockId: 0, channels: [Float32Array.from([10])] } });
assert(pressureProcessor.consecutiveLowDeadlineLeadBlocks === 1, "worklet records low response deadline lead pressure");
pressureProcessor.process([[Float32Array.from([11])]], [[new Float32Array(1)]]);
pressureTransportPort.onmessage({ data: { type: "processed", blockId: 1, channels: [Float32Array.from([11])] } });
assert(pressureProcessor.outputLatencyBlocks === 2, "worklet raises latency before underrun after repeated low deadline lead");
assert(pressureProcessor.latencyIncreases === 1, "worklet counts preemptive deadline-pressure latency raises");
assert(pressureProcessor.latencySafetyBlocks === 1, "worklet schedules a safety block when preemptively raising latency");
const underrunsBeforeSafety = pressureProcessor.underruns;
pressureProcessor.process([[Float32Array.from([12])]], [[new Float32Array(1)]]);
assert(pressureProcessor.latencySafetyInsertions === 1, "worklet inserts a controlled safety block to grow latency");
assert(pressureProcessor.underruns === underrunsBeforeSafety, "worklet does not count safety latency growth as an underrun");

const jitterProcessor = new processorCtor({
  processorOptions: { outputChannels: 1, maxQueuedOutputBlocks: 8, outputLatencyBlocks: 1, maxOutputLatencyBlocks: 3, latencyMissThresholdBlocks: 32, targetResponseDeadlineLeadBlocks: 0, responseJitterThresholdBlocks: 2, statsIntervalBlocks: 8 }
});
const jitterMainPort = lastPort;
const jitterTransportPort = new TestPort();
jitterMainPort.onmessage({ data: { type: "connect-transport", port: jitterTransportPort } });
jitterProcessor.process([[Float32Array.from([0])]], [[new Float32Array(1)]]);
jitterTransportPort.onmessage({ data: { type: "processed", blockId: 4, channels: [Float32Array.from([4])] } });
jitterTransportPort.onmessage({ data: { type: "processed", blockId: 0, channels: [Float32Array.from([0])] } });
for (let blockIndex = 1; blockIndex < 8; blockIndex += 1) {
  jitterProcessor.process([[Float32Array.from([blockIndex])]], [[new Float32Array(1)]]);
}
assert(jitterProcessor.outputLatencyBlocks === 2, "worklet raises latency when response jitter crosses the bounded threshold");
assert(jitterProcessor.latencyIncreases === 1, "worklet counts jitter-driven adaptive latency raises");

const statsProcessor = new processorCtor({
  processorOptions: {
    outputChannels: 1,
    maxQueuedOutputBlocks: 4,
    outputLatencyBlocks: 1
  }
});
const statsPort = lastPort;
for (let index = 0; index < 128; index += 1) {
  statsProcessor.process([[Float32Array.from([index])]], [[new Float32Array(1)]]);
}
const statsMessage = statsPort.messages.find((message) => message.type === "stats");
assert(typeof statsMessage?.inFlightBlocks === "number", "worklet stats report in-flight blocks");
assert(typeof statsMessage?.transportLatencySamples === "number", "worklet stats report transport latency samples");
assert(typeof statsMessage?.latencyIncreases === "number", "worklet stats report adaptive latency increases");
assert(typeof statsMessage?.latencyDecreases === "number", "worklet stats report adaptive latency decreases");
assert(typeof statsMessage?.targetResponseDeadlineLeadBlocks === "number", "worklet stats report target response deadline lead");
assert(typeof statsMessage?.latencyPressureThresholdBlocks === "number", "worklet stats report latency pressure threshold");
assert(typeof statsMessage?.latencyMissThresholdBlocks === "number", "worklet stats report latency miss threshold");
assert(typeof statsMessage?.latencyRecoveryBlocks === "number", "worklet stats report latency recovery window");
assert(typeof statsMessage?.consecutiveLowDeadlineLeadBlocks === "number", "worklet stats report low deadline pressure");
assert(typeof statsMessage?.latencySafetyBlocks === "number", "worklet stats report pending safety latency blocks");
assert(typeof statsMessage?.latencySafetyInsertions === "number", "worklet stats report safety latency insertions");
assert(typeof statsMessage?.sharedAudioEnabled === "boolean", "worklet stats report shared audio enablement");
assert(typeof statsMessage?.sharedAudioWakeMode === "string", "worklet stats report shared audio wake mode");
assert(typeof statsMessage?.sharedInputDroppedBlocks === "number", "worklet stats report shared input drops");
assert(typeof statsMessage?.sharedOutputDroppedBlocks === "number", "worklet stats report shared output drops");
assert(typeof statsMessage?.fallbackOutputBlocks === "number", "worklet stats report fallback output blocks");
assert(typeof statsMessage?.lastFallbackReason === "string", "worklet stats report the last fallback reason");
assert(typeof statsMessage?.inputBufferAllocations === "number", "worklet stats report input buffer allocations");
assert(typeof statsMessage?.inputBufferReuses === "number", "worklet stats report input buffer reuse");
assert(typeof statsMessage?.pooledInputBuffers === "number", "worklet stats report pooled input buffers");
assert(typeof statsMessage?.outputBufferAllocations === "number", "worklet stats report output buffer allocations");
assert(typeof statsMessage?.outputBufferReuses === "number", "worklet stats report output buffer reuse");
assert(typeof statsMessage?.pooledOutputBuffers === "number", "worklet stats report pooled output buffers");
assert(typeof statsMessage?.responseBlocks === "number", "worklet stats report response blocks");
assert(typeof statsMessage?.responseBlocksSinceLastStats === "number", "worklet stats report windowed response blocks");
assert(typeof statsMessage?.responseDeadlineLeadBlocks === "number", "worklet stats report latest response deadline lead");
assert(typeof statsMessage?.responseDeadlineLeadMinBlocks === "number", "worklet stats report minimum response deadline lead");
assert(typeof statsMessage?.responseDeadlineLeadMaxBlocks === "number", "worklet stats report maximum response deadline lead");
assert(typeof statsMessage?.responseDeadlineLeadSamples === "number", "worklet stats report response deadline lead samples");
assert(typeof statsMessage?.responseJitterBlocks === "number", "worklet stats report response jitter blocks");
assert(typeof statsMessage?.responseJitterSamples === "number", "worklet stats report response jitter samples");
assert(typeof statsMessage?.responseDeadlineMisses === "number", "worklet stats report response deadline misses");
assert(typeof statsMessage?.responseDeadlineMissesSinceLastStats === "number", "worklet stats report windowed deadline misses");

const sharedStatsProcessor = new processorCtor({ processorOptions: { outputChannels: 1, statsIntervalBlocks: 8 } });
const sharedStatsPort = lastPort;
const sharedStatsTransportPort = new TestPort();
sharedStatsPort.onmessage({ data: { type: "connect-transport", port: sharedStatsTransportPort, sharedAudio: createSharedAudio(4, 1, 1) } });
sharedStatsTransportPort.onmessage({ data: { type: "shared-audio-status", wakeMode: "timer", sharedTransportInFlightBlocks: 3, sharedInputBufferAllocations: 5, sharedInputBufferReuses: 4, sharedPooledInputBuffers: 2 } });
for (let index = 0; index < 8; index += 1) {
  sharedStatsProcessor.process([[Float32Array.from([index])]], [[new Float32Array(1)]]);
}
const sharedStatsMessage = sharedStatsPort.messages.find((message) => message.type === "stats");
assert(sharedStatsMessage?.sharedTransportInFlightBlocks === 3 && sharedStatsMessage.sharedInputBufferAllocations === 5, "worklet stats include shared transport worker status");
assert(sharedStatsMessage.sharedInputQueuedMaxBlocks === 4 && sharedStatsMessage.sharedOutputQueuedMaxBlocks === 0, "worklet stats include peak shared ring queue depth");

const fastStatsProcessor = new processorCtor({ processorOptions: { outputChannels: 1, statsIntervalBlocks: 8 } });
const fastStatsPort = lastPort;
for (let index = 0; index < 8; index += 1) {
  fastStatsProcessor.process([[Float32Array.from([index])]], [[new Float32Array(1)]]);
}
assert(fastStatsPort.messages.some((message) => message.type === "stats"), "worklet honors bounded stats interval overrides");

console.log("Worklet sequencing smoke checks passed.");

function equal(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function createSharedAudio(slots, channels, frames) {
  const controlInts = 8 + slots * 4;
  const audioSamples = slots * channels * frames;
  return {
    version: 1,
    slots,
    channels,
    frames,
    inputControl: new SharedArrayBuffer(controlInts * Int32Array.BYTES_PER_ELEMENT),
    inputAudio: new SharedArrayBuffer(audioSamples * Float32Array.BYTES_PER_ELEMENT),
    outputControl: new SharedArrayBuffer(controlInts * Int32Array.BYTES_PER_ELEMENT),
    outputAudio: new SharedArrayBuffer(audioSamples * Float32Array.BYTES_PER_ELEMENT)
  };
}

function writeSharedOutput(sharedAudio, blockId, channels) {
  const control = new Int32Array(sharedAudio.outputControl);
  const audio = new Float32Array(sharedAudio.outputAudio);
  const writeIndex = Atomics.load(control, 0);
  const metadataOffset = 8 + writeIndex * 4;
  Atomics.store(control, metadataOffset, blockId);
  Atomics.store(control, metadataOffset + 1, channels[0].length);
  Atomics.store(control, metadataOffset + 2, channels.length);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    audio.set(channels[channelIndex], writeIndex * sharedAudio.channels * sharedAudio.frames + channelIndex * sharedAudio.frames);
  }
  Atomics.store(control, 0, (writeIndex + 1) % sharedAudio.slots);
  Atomics.add(control, 2, 1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
