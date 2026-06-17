import { summarizeProbeVst3Events } from "./installed-plugin-probe-events.mjs";
import { summarizeProbeBusLayout } from "./installed-plugin-probe-layouts.mjs";
import {
  midiControllerEventCount,
  midiEventsForBlock,
  summarizeProbeMidiControllerEvents,
  summarizeProbeMidiProgramChangeEvents
} from "./installed-plugin-probe-midi.mjs";
import {
  assertProbeRenderMatchesLayout,
  summarizeProbeOutputBusSignal,
  summarizeProbeRenderSignal
} from "./installed-plugin-probe-rendering.mjs";
import { renderPayloadForLayout } from "./installed-plugin-probe-render-payload.mjs";

export function exerciseInstalledProbeRoutingSupport({ check }) {
  const sidechainProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 3,
      outputBuses: 2,
      inputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 1, channels: 1, type: "aux", active: true },
        { index: 3, channels: 1, type: "aux", active: false }
      ],
      outputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 1, channels: 2, type: "aux", active: false }
      ]
    }
  );
  const nonsequentialOutputProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 3,
      inputBuses: 1,
      outputBuses: 2,
      inputBusLayouts: [{ index: 0, channels: 2, type: "main", active: true }],
      outputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 2, channels: 1, type: "aux", active: true },
        { index: 2, channels: 1, type: "aux", active: true }
      ]
    }
  );
  const multiOutputInstrumentProfile = summarizeProbeBusLayout(
    { kind: "instrument" },
    {
      inputChannels: 0,
      outputChannels: 2,
      inputBuses: 0,
      outputBuses: 2,
      outputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 1, channels: 2, type: "aux", active: true }
      ]
    }
  );
  const cappedBusProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 32,
      outputBuses: 32,
      inputBusLayouts: Array.from({ length: 32 }, (_, index) => ({
        index,
        channels: index === 0 ? 2 : 1,
        type: index === 0 ? "main" : "aux",
        active: index < 2
      })),
      outputBusLayouts: Array.from({ length: 32 }, (_, index) => ({
        index,
        channels: index === 0 ? 2 : 1,
        type: index === 0 ? "main" : "aux",
        active: index === 0
      }))
    }
  );
  const weirdBusProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 0,
      outputChannels: 1,
      inputBuses: 1,
      outputBuses: 1,
      inputBusLayouts: [{ index: 0, channels: 0, type: "main", active: true }],
      outputBusLayouts: [{ index: 0, channels: 1, type: "sdk-custom", active: true }]
    }
  );
  const mismatchedCountProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 1,
      outputBuses: 3,
      inputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 2, channels: 1, type: "aux", active: true }
      ],
      outputBusLayouts: [{ index: 0, channels: 2, type: "main", active: true }]
    }
  );
  check(
    sidechainProfile.category === "sidechain" &&
      sidechainProfile.flags.includes("sidechain-input") &&
      sidechainProfile.flags.includes("inactive-input-bus") &&
      sidechainProfile.flags.includes("inactive-output-bus") &&
      sidechainProfile.nonsequentialInputBuses === 1 &&
      sidechainProfile.nonsequentialOutputBuses === 0 &&
      JSON.stringify(sidechainProfile.activeInputBusIndexes) === JSON.stringify([0, 1]) &&
      JSON.stringify(sidechainProfile.inactiveInputBusIndexes) === JSON.stringify([3]) &&
      JSON.stringify(sidechainProfile.inactiveOutputBusIndexes) === JSON.stringify([1]) &&
      nonsequentialOutputProfile.flags.includes("nonsequential-bus-indexes") &&
      nonsequentialOutputProfile.flags.includes("duplicate-bus-indexes") &&
      nonsequentialOutputProfile.nonsequentialOutputBuses === 1 &&
      nonsequentialOutputProfile.duplicateOutputBusIndexes === 1 &&
      JSON.stringify(nonsequentialOutputProfile.activeOutputBusIndexes) === JSON.stringify([0, 2]) &&
      multiOutputInstrumentProfile.category === "multi-output-instrument" &&
      multiOutputInstrumentProfile.flags.includes("multi-output-instrument") &&
      JSON.stringify(multiOutputInstrumentProfile.activeOutputBusIndexes) === JSON.stringify([0, 1]) &&
      cappedBusProfile.inputBusMetadataAtLimit === true &&
      cappedBusProfile.outputBusMetadataAtLimit === true &&
      cappedBusProfile.flags.includes("input-bus-metadata-at-limit") &&
      cappedBusProfile.flags.includes("output-bus-metadata-at-limit") &&
      weirdBusProfile.flags.includes("active-empty-bus") &&
      weirdBusProfile.flags.includes("unknown-bus-type") &&
      weirdBusProfile.activeEmptyInputBuses === 1 &&
      weirdBusProfile.unknownOutputBusTypes === 1 &&
      mismatchedCountProfile.flags.includes("bus-count-mismatch") &&
      mismatchedCountProfile.inputBusLayoutCount === 2 &&
      mismatchedCountProfile.outputBusLayoutCount === 1 &&
      mismatchedCountProfile.inputBusCountMismatch === true &&
      mismatchedCountProfile.outputBusCountMismatch === true,
    "installed plugin probe classifies bus-layout coverage"
  );

  const vst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [
      { typeId: 0, busIndex: 0, channel: 0 },
      { typeId: 6, busIndex: 2, channel: 3, unitId: 4, associatedParameterId: "param-1" },
      { typeId: 6, busIndex: 2, channel: 3 },
      { typeId: 7, busIndex: 99, channel: 99 },
      { typeId: "bad", busIndex: 0, channel: 0 }
    ]
  });
  const invalidVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [{ typeId: "bad" }]
  });
  const cappedVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: Array.from({ length: 256 }, (_, index) => ({ typeId: index }))
  });
  check(
    vst3EventProfile.category === "non-main-event-bus" &&
      vst3EventProfile.noteExpressionCount === 4 &&
      vst3EventProfile.valueExpressionCount === 2 &&
      vst3EventProfile.textExpressionCount === 2 &&
      vst3EventProfile.invalidNoteExpressionCount === 1 &&
      vst3EventProfile.invalidNoteExpressionRouteCount === 1 &&
      vst3EventProfile.duplicateNoteExpressionTypeIdCount === 1 &&
      vst3EventProfile.associatedParameterCount === 1 &&
      vst3EventProfile.unitLinkedExpressionCount === 1 &&
      JSON.stringify(vst3EventProfile.typeIds) === JSON.stringify([0, 6, 7]) &&
      JSON.stringify(vst3EventProfile.eventBuses) === JSON.stringify([0, 2]) &&
      vst3EventProfile.flags.includes("text-expression") &&
      vst3EventProfile.flags.includes("value-expression") &&
      vst3EventProfile.flags.includes("associated-parameter") &&
      vst3EventProfile.flags.includes("unit-linked-expression") &&
      vst3EventProfile.flags.includes("invalid-note-expression") &&
      vst3EventProfile.flags.includes("invalid-note-expression-route") &&
      vst3EventProfile.flags.includes("duplicate-note-expression-type-id") &&
      invalidVst3EventProfile.category === "invalid-metadata" &&
      invalidVst3EventProfile.invalidNoteExpressionCount === 1 &&
      invalidVst3EventProfile.flags.includes("no-valid-note-expressions") &&
      cappedVst3EventProfile.noteExpressionCount === 256 &&
      cappedVst3EventProfile.metadataAtLimit === true &&
      cappedVst3EventProfile.flags.includes("metadata-at-limit"),
    "installed plugin probe classifies VST3 event metadata coverage"
  );
  check(
    summarizeProbeRenderSignal({ channels: [[0, 0]], outputBuses: [{ index: 1, channels: [[0, 0.25]] }] }) === "signal" &&
      summarizeProbeRenderSignal({ channels: [[0, 0]], outputBuses: [{ index: 0, channels: [[0, 0]] }] }) === "silent" &&
      summarizeProbeRenderSignal({ channels: [], outputBuses: [] }) === "missing",
    "installed plugin probe classifies render signal coverage"
  );

  const outputBusSignalProfile = summarizeProbeOutputBusSignal({
    channels: [[0.1, 0.2], [0, 0]],
    outputBuses: [
      { index: 0, channels: [[0.1, 0.2], [0, 0]] },
      { index: 1, channels: [[0, 0]] },
      { index: 2, channels: [[0.25, 0.5]] }
    ]
  }, {
    outputChannels: 2,
    outputBusLayouts: [
      { index: 0, channels: 2, active: true },
      { index: 1, channels: 1, active: true },
      { index: 2, channels: 1, active: true }
    ]
  });
  check(
    outputBusSignalProfile.category === "main-aux-signal" &&
      outputBusSignalProfile.signalOutputBusCount === 2 &&
      outputBusSignalProfile.silentOutputBusCount === 1 &&
      JSON.stringify(outputBusSignalProfile.signalOutputBusIndexes) === JSON.stringify([0, 2]) &&
      JSON.stringify(outputBusSignalProfile.silentOutputBusIndexes) === JSON.stringify([1]),
    "installed plugin probe classifies output-bus render signal coverage"
  );

  exerciseRenderPayloadCoverage({ check });
  exerciseRenderLayoutValidation({ check });
  exerciseProbeMidiCoverage({ check });
}

function exerciseRenderPayloadCoverage({ check }) {
  const sidechainPayload = renderPayloadForLayout(
    "inst-sidechain",
    {
      inputChannels: 2,
      inputBusLayouts: [
        { index: 0, channels: 2, active: true },
        { index: 1, channels: 1, active: true },
        { index: 2, channels: 1, active: false },
        { index: 1, channels: 1, active: true }
      ],
      maxBlockSize: 4
    },
    { maxBlockSize: 64, sampleRate: 48000 }
  );
  const clampedPayload = renderPayloadForLayout(
    "inst-clamp",
    { inputChannels: 1, maxBlockSize: 4096 },
    { maxBlockSize: 64 }
  );
  check(
    sidechainPayload.frames === 4 &&
      sidechainPayload.sampleRate === 48000 &&
      sidechainPayload.channels.length === 2 &&
      sidechainPayload.channels[0].every((sample) => sample === 0) &&
      sidechainPayload.inputBuses.length === 2 &&
      sidechainPayload.inputBuses[0].index === 0 &&
      sidechainPayload.inputBuses[0].channels.length === 2 &&
      sidechainPayload.inputBuses[0].channels[0][0] === 0.05 &&
      sidechainPayload.inputBuses[1].index === 1 &&
      sidechainPayload.inputBuses[1].channels.length === 1 &&
      sidechainPayload.inputBuses[1].channels[0][0] > 0 &&
      sidechainPayload.inputBuses[1].channels[0][0] !== sidechainPayload.inputBuses[0].channels[0][0] &&
      clampedPayload.frames === 64,
    "installed plugin probe builds explicit sidechain render payloads"
  );
}

function exerciseRenderLayoutValidation({ check }) {
  const multiOutputLayout = {
    outputChannels: 2,
    outputBusLayouts: [
      { index: 0, channels: 2, active: true },
      { index: 2, channels: 1, active: true }
    ]
  };
  let goodMultiOutputCode = "ok";
  try {
    assertProbeRenderMatchesLayout({
      channels: [[0, 0], [0.1, 0.1]],
      outputBuses: [
        { index: 0, channels: [[0, 0], [0.1, 0.1]] },
        { index: 2, channels: [[0.2, 0.2]] }
      ]
    }, multiOutputLayout, 2);
  } catch (error) {
    goodMultiOutputCode = error.code;
  }
  let missingBusCode = "";
  try {
    assertProbeRenderMatchesLayout({
      channels: [[0, 0], [0.1, 0.1]],
      outputBuses: [{ index: 0, channels: [[0, 0], [0.1, 0.1]] }]
    }, multiOutputLayout, 2);
  } catch (error) {
    missingBusCode = error.code;
  }
  let mismatchedMainCode = "";
  try {
    assertProbeRenderMatchesLayout({
      channels: [[0, 0], [0.1, 0.1]],
      outputBuses: [
        { index: 0, channels: [[0, 0], [0, 0]] },
        { index: 2, channels: [[0.2, 0.2]] }
      ]
    }, multiOutputLayout, 2);
  } catch (error) {
    mismatchedMainCode = error.code;
  }
  let duplicateBusCode = "";
  try {
    assertProbeRenderMatchesLayout({
      channels: [[0, 0], [0.1, 0.1]],
      outputBuses: [
        { index: 0, channels: [[0, 0], [0.1, 0.1]] },
        { index: 2, channels: [[0.2, 0.2]] },
        { index: 2, channels: [[0.3, 0.3]] }
      ]
    }, multiOutputLayout, 2);
  } catch (error) {
    duplicateBusCode = error.code;
  }
  check(
    goodMultiOutputCode === "ok" &&
      missingBusCode === "bad_render_layout" &&
      mismatchedMainCode === "bad_render_layout" &&
      duplicateBusCode === "bad_render_layout",
    "installed plugin probe validates negotiated output-bus render layouts"
  );
}

function exerciseProbeMidiCoverage({ check }) {
  const vst3MidiEvents = midiEventsForBlock("vst3", 64, 64);
  const vst3MidiControllerProfile = summarizeProbeMidiControllerEvents(vst3MidiEvents);
  const vst3MidiProgramChangeProfile = summarizeProbeMidiProgramChangeEvents(vst3MidiEvents);
  const invalidControllerProfile = summarizeProbeMidiControllerEvents([
    { type: "controlChange", controller: 128, channel: 16, busIndex: 32 },
    { type: "pitchBend", value: 0, channel: -1 },
    { type: "channelPressure", pressure: 0.25, busIndex: "bad" }
  ]);
  const invalidProgramChangeProfile = summarizeProbeMidiProgramChangeEvents([
    { type: "programChange", program: 128, channel: 16, busIndex: 32 },
    { type: "programChange", program: "bad", channel: -1 }
  ]);
  check(
    vst3MidiEvents.length === 16 &&
      vst3MidiEvents.some((event) => event.type === "noteExpression" && event.noteId === 77) &&
      vst3MidiEvents.some((event) => event.type === "noteExpressionText" && event.text === "probe" && event.noteId === 77) &&
      vst3MidiEvents.some((event) => event.type === "noteExpression" && event.noteId === 78 && event.busIndex === 1) &&
      vst3MidiEvents.some((event) => event.type === "noteExpressionText" && event.text === "bus" && event.busIndex === 1) &&
      vst3MidiEvents.some((event) => event.type === "noteOff" && event.noteId === 78 && event.busIndex === 1) &&
      vst3MidiEvents.some((event) => event.type === "controlChange" && event.controller === 74 && event.busIndex === 1) &&
      vst3MidiEvents.some((event) => event.type === "pitchBend" && event.busIndex === 1) &&
      vst3MidiEvents.some((event) => event.type === "channelPressure" && event.busIndex === 1) &&
      vst3MidiEvents.some((event) => event.type === "programChange" && event.program === 7 && event.busIndex === 1) &&
      midiControllerEventCount(vst3MidiEvents) === 6 &&
      vst3MidiControllerProfile.eventCount === 6 &&
      vst3MidiControllerProfile.controllerFamilyCount === 3 &&
      vst3MidiControllerProfile.flags.includes("multi-controller-family") &&
      vst3MidiControllerProfile.flags.includes("non-main-event-bus") &&
      vst3MidiControllerProfile.flags.includes("non-main-channel") &&
      JSON.stringify(vst3MidiControllerProfile.types) === JSON.stringify(["controlChange", "pitchBend", "channelPressure"]) &&
      JSON.stringify(vst3MidiControllerProfile.controllers) === JSON.stringify([1, 74]) &&
      JSON.stringify(vst3MidiControllerProfile.channels) === JSON.stringify([0, 2]) &&
      JSON.stringify(vst3MidiControllerProfile.eventBuses) === JSON.stringify([0, 1]) &&
      vst3MidiProgramChangeProfile.eventCount === 2 &&
      vst3MidiProgramChangeProfile.flags.includes("non-main-event-bus") &&
      JSON.stringify(vst3MidiProgramChangeProfile.programs) === JSON.stringify([2, 7]) &&
      JSON.stringify(vst3MidiProgramChangeProfile.channels) === JSON.stringify([0, 2]) &&
      JSON.stringify(vst3MidiProgramChangeProfile.eventBuses) === JSON.stringify([0, 1]) &&
      invalidControllerProfile.invalidControllerNumberCount === 1 &&
      invalidControllerProfile.invalidControllerRouteCount === 3 &&
      invalidControllerProfile.flags.includes("invalid-controller-number") &&
      invalidControllerProfile.flags.includes("invalid-controller-route") &&
      !invalidControllerProfile.flags.includes("non-main-event-bus") &&
      !invalidControllerProfile.flags.includes("non-main-channel") &&
      invalidProgramChangeProfile.invalidProgramNumberCount === 2 &&
      invalidProgramChangeProfile.invalidProgramRouteCount === 2 &&
      invalidProgramChangeProfile.flags.includes("invalid-program-number") &&
      invalidProgramChangeProfile.flags.includes("invalid-program-route") &&
      !invalidProgramChangeProfile.flags.includes("non-main-event-bus") &&
      !invalidProgramChangeProfile.flags.includes("non-main-channel") &&
      midiEventsForBlock("au", 64, 64).every((event) => !event.type.startsWith("noteExpression")),
    "installed plugin probe sends VST3 note-expression, MIDI-controller, and program-change coverage"
  );
}
