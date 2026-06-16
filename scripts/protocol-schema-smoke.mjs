import fs from "node:fs";

const SCHEMA_URL = new URL("../packages/protocol/schema/protocol.schema.json", import.meta.url);
const VST3_BUS_INDEX_REF = "#/$defs/vst3EventBusIndex";
const MIDI_EVENT_TYPES = new Set([
  "noteOn",
  "noteOff",
  "controlChange",
  "pitchBend",
  "channelPressure",
  "polyPressure",
  "programChange",
  "noteExpression",
  "noteExpressionText"
]);

const schema = JSON.parse(fs.readFileSync(SCHEMA_URL, "utf8"));

assert(
  schema.$defs?.vst3EventBusIndex?.type === "integer" &&
    schema.$defs.vst3EventBusIndex.minimum === 0 &&
    schema.$defs.vst3EventBusIndex.maximum === 31,
  "protocol schema declares bounded VST3 event-bus indexes"
);

const midiEventVariants = schema.$defs?.midiEvent?.oneOf;
assert(Array.isArray(midiEventVariants), "protocol schema declares MIDI event variants");

const seenTypes = new Set();
for (const variant of midiEventVariants) {
  const type = variant?.properties?.type?.const;
  if (!MIDI_EVENT_TYPES.has(type)) {
    continue;
  }
  seenTypes.add(type);
  assert(
    variant.properties?.busIndex?.$ref === VST3_BUS_INDEX_REF,
    `protocol schema declares optional VST3 busIndex for ${type} events`
  );
}

assert(
  MIDI_EVENT_TYPES.size === seenTypes.size,
  "protocol schema declares every supported MIDI event type"
);
assert(
  schema.$defs?.sendMidiEventsRequest?.properties?.events?.items?.$ref === "#/$defs/midiEvent" &&
    schema.$defs.sendMidiEventsRequest.properties.events.maxItems === 4096,
  "protocol schema routes sendMidiEvents payloads through bounded MIDI events"
);

console.log("Protocol schema smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
