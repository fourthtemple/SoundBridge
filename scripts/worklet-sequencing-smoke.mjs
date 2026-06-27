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
  AudioWorkletProcessor: TestAudioWorkletProcessor,
  Float32Array,
  Map,
  Math,
  Number,
  Array,
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
directTransportPort.onmessage({
  data: {
    type: "processed",
    blockId: 0,
    channels: [[50, 50]],
    renderEngine: "direct-worker"
  }
});
assert(directProcessor.inFlightBlocks === 0, "direct worklet transport releases in-flight blocks on response");
assert(
  directMainPort.messages.some((message) => message.type === "process-diagnostics" && message.renderEngine === "direct-worker"),
  "direct worklet transport forwards render diagnostics to the page port"
);

console.log("Worklet sequencing smoke checks passed.");

function equal(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
