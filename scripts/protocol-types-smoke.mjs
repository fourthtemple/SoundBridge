import fs from "node:fs";

const MIDI_TYPES_URL = new URL("../packages/protocol/src/midi-events.ts", import.meta.url);
const MESSAGES_URL = new URL("../packages/protocol/src/messages.ts", import.meta.url);
const MIDI_EVENT_TYPES = [
  "noteOn",
  "noteOff",
  "controlChange",
  "pitchBend",
  "channelPressure",
  "polyPressure",
  "programChange",
  "noteExpression",
  "noteExpressionText"
];

const midiTypes = fs.readFileSync(MIDI_TYPES_URL, "utf8");
const messages = fs.readFileSync(MESSAGES_URL, "utf8");

assert(
  /interface MidiTimedChannelEvent\s*{[\s\S]*busIndex\?: Vst3EventBusIndex;[\s\S]*}/.test(midiTypes),
  "protocol MIDI types expose optional bounded VST3 busIndex on timed channel events"
);
for (const type of MIDI_EVENT_TYPES) {
  assert(
    midiTypes.includes(`type: "${type}";`),
    `protocol MIDI types declare ${type} events`
  );
}
assert(
  messages.includes('} from "./midi-events";') &&
    messages.includes("MidiEvent") &&
    messages.includes("SendMidiEventsRequest") &&
    messages.includes("Vst3EventBusIndex"),
  "protocol messages re-export MIDI event types"
);
assert(
  messages.includes("interface PluginVst3MidiMapping") &&
    messages.includes("vst3MidiMappings?: PluginVst3MidiMapping[];"),
  "protocol messages type optional VST3 MIDI-controller parameter mappings"
);

console.log("Protocol type smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
