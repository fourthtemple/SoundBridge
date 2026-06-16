import { summarizeProbeVst3Events } from "./installed-plugin-probe-events.mjs";
import { summarizeProbeBusLayout } from "./installed-plugin-probe-layouts.mjs";
import {
  midiControllerEventCount,
  midiEventsForBlock,
  summarizeProbeMidiControllerEvents
} from "./installed-plugin-probe-midi.mjs";
import {
  assertProbeRenderMatchesLayout,
  summarizeProbeOutputBusSignal,
  summarizeProbeRenderSignal
} from "./installed-plugin-probe-rendering.mjs";

export function exerciseInstalledProbeRoutingSupport({ check }) {
  const sidechainProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 2,
      outputBuses: 1,
      inputBusLayouts: [
        { index: 0, channels: 2, type: "main", active: true },
        { index: 1, channels: 1, type: "aux", active: true }
      ],
      outputBusLayouts: [{ index: 0, channels: 2, type: "main", active: true }]
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
  check(
    sidechainProfile.category === "sidechain" &&
      sidechainProfile.flags.includes("sidechain-input") &&
      JSON.stringify(sidechainProfile.activeInputBusIndexes) === JSON.stringify([0, 1]) &&
      nonsequentialOutputProfile.flags.includes("nonsequential-bus-indexes") &&
      nonsequentialOutputProfile.flags.includes("duplicate-bus-indexes") &&
      JSON.stringify(nonsequentialOutputProfile.activeOutputBusIndexes) === JSON.stringify([0, 2]) &&
      multiOutputInstrumentProfile.category === "multi-output-instrument" &&
      multiOutputInstrumentProfile.flags.includes("multi-output-instrument") &&
      JSON.stringify(multiOutputInstrumentProfile.activeOutputBusIndexes) === JSON.stringify([0, 1]),
    "installed plugin probe classifies bus-layout coverage"
  );

  const vst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [
      { typeId: 0, busIndex: 0, channel: 0 },
      { typeId: 6, busIndex: 2, channel: 3, associatedParameterId: "param-1" }
    ]
  });
  check(
    vst3EventProfile.category === "non-main-event-bus" &&
      vst3EventProfile.noteExpressionCount === 2 &&
      vst3EventProfile.valueExpressionCount === 1 &&
      vst3EventProfile.textExpressionCount === 1 &&
      vst3EventProfile.associatedParameterCount === 1 &&
      JSON.stringify(vst3EventProfile.typeIds) === JSON.stringify([0, 6]) &&
      JSON.stringify(vst3EventProfile.eventBuses) === JSON.stringify([0, 2]) &&
      vst3EventProfile.flags.includes("text-expression") &&
      vst3EventProfile.flags.includes("value-expression") &&
      vst3EventProfile.flags.includes("associated-parameter"),
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

  exerciseRenderLayoutValidation({ check });
  exerciseProbeMidiCoverage({ check });
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
  check(
    vst3MidiEvents.some((event) => event.type === "noteExpression" && event.noteId === 77) &&
      vst3MidiEvents.some((event) => event.type === "noteExpressionText" && event.text === "probe" && event.noteId === 77) &&
      midiControllerEventCount(vst3MidiEvents) === 3 &&
      vst3MidiControllerProfile.eventCount === 3 &&
      JSON.stringify(vst3MidiControllerProfile.types) === JSON.stringify(["controlChange", "pitchBend", "channelPressure"]) &&
      JSON.stringify(vst3MidiControllerProfile.controllers) === JSON.stringify([1]) &&
      JSON.stringify(vst3MidiControllerProfile.channels) === JSON.stringify([0]) &&
      JSON.stringify(vst3MidiControllerProfile.eventBuses) === JSON.stringify([0]) &&
      midiEventsForBlock("au", 64, 64).every((event) => !event.type.startsWith("noteExpression")),
    "installed plugin probe sends VST3 note-expression and MIDI-controller coverage"
  );
}
