import fs from "node:fs";

const SCHEMA_URL = new URL("../packages/protocol/schema/protocol.schema.json", import.meta.url);
const SCHEMA_DEF_URLS = [
  new URL("../packages/protocol/schema/defs/hello-response.schema.json", import.meta.url),
  new URL("../packages/protocol/schema/defs/midi-event.schema.json", import.meta.url),
  new URL("../packages/protocol/schema/defs/plugin-metadata.schema.json", import.meta.url),
  new URL("../packages/protocol/schema/defs/request-envelope.schema.json", import.meta.url)
];
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
const NOTE_EXPRESSION_TEXT_PATTERN = "^[^\\u0000]+$";

assertAllRefsResolve([SCHEMA_URL, ...SCHEMA_DEF_URLS]);

const requestEnvelope = resolveRef(schema.$defs?.requestEnvelope?.$ref, SCHEMA_URL);
assert(
  requestEnvelope?.properties?.command?.$ref === "#/$defs/command",
  "protocol schema keeps request-envelope command validation anchored"
);

const helloResponse = resolveRef(schema.$defs?.helloResponse?.$ref, SCHEMA_URL);
assert(
  helloResponse?.required?.includes("capabilities"),
  "protocol schema resolves split hello response definitions"
);

const pluginMetadata = resolveRef(schema.$defs?.pluginMetadata?.$ref, SCHEMA_URL);
assert(
  pluginMetadata?.properties?.vst3NoteExpressions?.maxItems === 256,
  "protocol schema resolves split plugin metadata definitions"
);
const pluginVst3Unit = resolveRef(schema.$defs?.pluginVst3Unit?.$ref, SCHEMA_URL);
assert(
  pluginVst3Unit?.properties?.programListId?.not?.const === -1,
  "protocol schema excludes the VST3 no-program-list unit sentinel"
);

const vst3EventBusIndex = resolveRef(schema.$defs?.vst3EventBusIndex?.$ref, SCHEMA_URL);
assert(
  vst3EventBusIndex?.type === "integer" &&
    vst3EventBusIndex.minimum === 0 &&
    vst3EventBusIndex.maximum === 31,
  "protocol schema declares bounded VST3 event-bus indexes"
);

const midiEventVariants = resolveRef(schema.$defs?.midiEvent?.$ref, SCHEMA_URL)?.oneOf;
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
const noteExpressionTextVariant = midiEventVariants.find(
  (variant) => variant?.properties?.type?.const === "noteExpressionText"
);
assert(
  noteExpressionTextVariant?.properties?.text?.minLength === 1 &&
    noteExpressionTextVariant.properties.text.maxLength === 256 &&
    noteExpressionTextVariant.properties.text.pattern === NOTE_EXPRESSION_TEXT_PATTERN,
  "protocol schema declares bounded NUL-free VST3 note-expression text"
);
assert(
  schema.$defs?.sendMidiEventsRequest?.properties?.events?.items?.$ref === "#/$defs/midiEvent" &&
    schema.$defs.sendMidiEventsRequest.properties.events.maxItems === 4096,
  "protocol schema routes sendMidiEvents payloads through bounded MIDI events"
);
const requestEnvelopeDefs = loadJson(new URL("../packages/protocol/schema/defs/request-envelope.schema.json", import.meta.url)).$defs;
assert(
  schema.$defs?.getVst3ProgramDataRequest?.properties?.programListId?.not?.const === -1 &&
    requestEnvelopeDefs?.getVst3ProgramDataRequest?.properties?.programListId?.not?.const === -1,
  "protocol schema excludes the VST3 no-program-list program-data sentinel"
);

console.log("Protocol schema smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertAllRefsResolve(urls) {
  for (const url of urls) {
    const document = loadJson(url);
    for (const ref of schemaRefs(document)) {
      assert(
        resolveRef(ref, url) !== undefined,
        `protocol schema reference did not resolve: ${ref} from ${url.pathname}`
      );
    }
  }
}

function* schemaRefs(value) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (typeof value.$ref === "string") {
    yield value.$ref;
  }
  for (const entry of Object.values(value)) {
    yield* schemaRefs(entry);
  }
}

function resolveRef(ref, baseUrl) {
  assert(typeof ref === "string", "protocol schema references must be strings");
  const [pathPart, fragment = ""] = ref.split("#");
  const targetUrl = pathPart ? new URL(pathPart, baseUrl) : baseUrl;
  const target = loadJson(targetUrl);
  if (!fragment) {
    return target;
  }
  return fragment
    .replace(/^\//, "")
    .split("/")
    .reduce((value, rawPart) => value?.[rawPart.replace(/~1/g, "/").replace(/~0/g, "~")], target);
}

function loadJson(url) {
  return JSON.parse(fs.readFileSync(url, "utf8"));
}
