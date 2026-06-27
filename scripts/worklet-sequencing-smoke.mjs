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

deliver(1, [101, 101]);
assert(equal(renderBlock([2, 2]), [2, 2]), "out-of-order block 1 is not played in block 0's slot");

deliver(0, [100, 100]);
assert(processor.responseDeadlineMisses === 1, "late worklet responses count deadline misses");
deliver(2, [102, 102]);
assert(processor.staleOutputBlocks === 1, "late block 0 is counted as stale");
assert(equal(renderBlock([3, 3]), [101, 101]), "block 1 plays in its scheduled output slot");
assert(equal(renderBlock([4, 4]), [102, 102]), "block 2 plays in its scheduled output slot");

lastPort.onmessage({ data: { type: "dropped", blockId: 99 } });
assert(processor.droppedInputBlocks === 1, "dropped input blocks are counted");

const processIds = postedMessages.filter((message) => message.type === "process").map((message) => message.blockId);
assert(equal(processIds, [0, 1, 2, 3, 4]), "worklet emits monotonic process block ids");

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
  directMainPort.messages.some((message) => message.type === "process-diagnostics" && message.renderEngine === "direct-worker"),
  "direct worklet transport forwards render diagnostics to the page port"
);
directProcessor.process([[Float32Array.from([6, 6])]], [[new Float32Array(2)]]);
assert(
  directTransportPort.messages[1]?.channels?.[0] === recycledInput,
  "direct worklet transport reuses recycled input buffers for later process blocks"
);
assert(directProcessor.inputBufferReuses === 1, "direct worklet transport counts input buffer reuse");

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
sharedTransportPort.onmessage({ data: { type: "shared-audio-status", wakeMode: "atomics" } });
assert(sharedProcessor.sharedAudioWakeMode === "atomics", "shared worklet transport records the worker wake mode");
const sharedWarmup = [new Float32Array(2)];
sharedProcessor.process([[Float32Array.from([7, 7])]], [sharedWarmup]);
assert(sharedTransportPort.messages.length === 0, "shared worklet transport avoids per-block port messages");
assert(Atomics.load(new Int32Array(sharedAudio.inputControl), 2) === 1, "shared worklet transport writes input blocks to shared memory");
writeSharedOutput(sharedAudio, 0, [Float32Array.from([70, 70])]);
const sharedOutput = [new Float32Array(2)];
sharedProcessor.process([[Float32Array.from([8, 8])]], [sharedOutput]);
assert(equal(Array.from(sharedOutput[0]), [70, 70]), "shared worklet transport drains shared output blocks");
assert(sharedProcessor.responseBlocks === 1, "shared worklet transport counts returned response blocks");
assert(sharedProcessor.responseDeadlineLeadBlocks === 0, "shared worklet transport records shared deadline lead");

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
assert(typeof statsMessage?.consecutiveLowDeadlineLeadBlocks === "number", "worklet stats report low deadline pressure");
assert(typeof statsMessage?.latencySafetyBlocks === "number", "worklet stats report pending safety latency blocks");
assert(typeof statsMessage?.latencySafetyInsertions === "number", "worklet stats report safety latency insertions");
assert(typeof statsMessage?.sharedAudioEnabled === "boolean", "worklet stats report shared audio enablement");
assert(typeof statsMessage?.sharedAudioWakeMode === "string", "worklet stats report shared audio wake mode");
assert(typeof statsMessage?.sharedInputDroppedBlocks === "number", "worklet stats report shared input drops");
assert(typeof statsMessage?.sharedOutputDroppedBlocks === "number", "worklet stats report shared output drops");
assert(typeof statsMessage?.inputBufferAllocations === "number", "worklet stats report input buffer allocations");
assert(typeof statsMessage?.inputBufferReuses === "number", "worklet stats report input buffer reuse");
assert(typeof statsMessage?.pooledInputBuffers === "number", "worklet stats report pooled input buffers");
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
