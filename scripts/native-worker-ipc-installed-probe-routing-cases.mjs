import { summarizeProbeVst3Events } from "./installed-plugin-probe-events.mjs";
import { summarizeProbeBusLayout } from "./installed-plugin-probe-layouts.mjs";
import {
  midiControllerEventCount,
  midiEventsForBlock,
  summarizeProbeMidiControllerEvents,
  summarizeProbeMidiProgramChangeEvents,
  summarizeProbeMidiTiming
} from "./installed-plugin-probe-midi.mjs";
import {
  assertProbeRenderMatchesLayout,
  summarizeProbeOutputBusSignal,
  summarizeProbeRenderSignal
} from "./installed-plugin-probe-rendering.mjs";
import { summarizeProbeResults } from "./installed-plugin-probe-reporting.mjs";
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
  const saturatedBusProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 2,
      outputChannels: 2,
      inputBuses: 32,
      outputBuses: 32,
      inputBusLayouts: [
        ...Array.from({ length: 32 }, (_, index) => ({ index, channels: index === 0 ? 2 : 1, type: index === 0 ? "main" : "aux", active: index === 0 })),
        { index: 0, name: "", channels: 0, type: "sdk-custom", active: true }
      ],
      outputBusLayouts: [
        ...Array.from({ length: 32 }, (_, index) => ({ index, channels: index === 0 ? 2 : 1, type: index === 0 ? "main" : "aux", active: index === 0 })),
        { index: 0, name: "", channels: 0, type: "sdk-custom", active: true }
      ]
    }
  );
  const saturatedBusMatrix = summarizeProbeResults([{ ok: true, format: "vst3", busProfile: saturatedBusProfile }]).matrix[0];
  const weirdBusProfile = summarizeProbeBusLayout(
    { kind: "effect" },
    {
      inputChannels: 0,
      outputChannels: 1,
      inputBuses: 1,
      outputBuses: 1,
      inputBusLayouts: [{ index: 0, name: "", channels: 0, type: "main", active: true }],
      outputBusLayouts: [{ index: 0, name: "", channels: 1, type: "sdk-custom", active: true }]
    }
  );
  const weirdBusMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    busProfile: weirdBusProfile
  }]).matrix[0];
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
      saturatedBusProfile.inputBusLayoutCount === 32 &&
      saturatedBusProfile.outputBusLayoutCount === 32 &&
      saturatedBusProfile.duplicateInputBusIndexes === 1 &&
      saturatedBusProfile.duplicateOutputBusIndexes === 1 &&
      saturatedBusProfile.activeEmptyInputBuses === 1 &&
      saturatedBusProfile.activeEmptyOutputBuses === 1 &&
      saturatedBusProfile.unknownInputBusTypes === 1 &&
      saturatedBusProfile.unknownOutputBusTypes === 1 &&
      saturatedBusProfile.inputBusNameFallbacks === 1 &&
      saturatedBusProfile.outputBusNameFallbacks === 1 &&
      saturatedBusMatrix.busDuplicateInputIndexCount === 1 &&
      saturatedBusMatrix.busDuplicateOutputIndexCount === 1 &&
      saturatedBusMatrix.busActiveEmptyInputCount === 1 &&
      saturatedBusMatrix.busUnknownOutputTypeCount === 1 &&
      weirdBusProfile.flags.includes("active-empty-bus") &&
      weirdBusProfile.flags.includes("unknown-bus-type") &&
      weirdBusProfile.flags.includes("input-bus-name-fallback") &&
      weirdBusProfile.flags.includes("output-bus-name-fallback") &&
      weirdBusProfile.activeEmptyInputBuses === 1 &&
      weirdBusProfile.unknownOutputBusTypes === 1 &&
      weirdBusMatrix.busInputNameFallbackCount === 1 &&
      weirdBusMatrix.busOutputNameFallbackCount === 1 &&
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
      { typeId: 0, busIndex: 0, channel: 0, minValue: 0.5, maxValue: 0.5, defaultValue: 0.5, stepCount: 4, bipolar: true },
      { typeId: 6, name: "", busIndex: 2, channel: 3, unitId: 4, associatedParameterId: "param-1", oneShot: true },
      { typeId: 6 },
      { typeId: 7, busIndex: 99, channel: 99, minValue: 1, maxValue: 0, unitId: "bad", associatedParameterId: "4294967295", absolute: true },
      { typeId: 8, associatedParameterId: -1 },
      { typeId: 9, associatedParameterId: "" },
      { typeId: "bad", busIndex: 0, channel: 0 }
    ]
  });
  const invalidVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [{ typeId: "bad" }]
  });
  const invalidRouteOnlyVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [{ typeId: 11, busIndex: 99, channel: "bad" }]
  });
  const invalidRouteOnlyVst3EventSummary = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3EventProfile: invalidRouteOnlyVst3EventProfile
  }]);
  const cappedVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: Array.from({ length: 256 }, (_, index) => ({ typeId: index }))
  });
  const saturatedVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [
      ...Array.from({ length: 256 }, (_, index) => ({ typeId: index, busIndex: 0, channel: 0 })),
      { typeId: "bad" },
      { typeId: 300, busIndex: 99, channel: 0 },
      { typeId: 301, minValue: 1, maxValue: 0, unitId: "bad", associatedParameterId: "" }
    ]
  });
  const saturatedVst3EventMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3EventProfile: saturatedVst3EventProfile
  }]).matrix[0];
  const vst3EventMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    vst3EventProfile
  }]).matrix[0];
  const failedVst3EventSummary = summarizeProbeResults([{
    ok: false,
    format: "vst3",
    pluginId: "vst3:event-metadata-failed",
    phases: [{ name: "createInstance", ok: false, error: { code: "native_worker_failed" } }]
  }]);
  check(
    vst3EventProfile.category === "non-main-event-bus" &&
      vst3EventProfile.noteExpressionCount === 6 &&
      vst3EventProfile.valueExpressionCount === 4 &&
      vst3EventProfile.textExpressionCount === 2 &&
      vst3EventProfile.nameFallbackExpressionCount === 1 &&
      vst3EventProfile.defaultRouteExpressionCount === 3 &&
      vst3EventProfile.invalidNoteExpressionCount === 1 &&
      vst3EventProfile.invalidNoteExpressionRouteCount === 1 &&
      vst3EventProfile.invalidAssociatedParameterCount === 1 &&
      vst3EventProfile.invalidNoteExpressionValueMetadataCount === 1 &&
      vst3EventProfile.invalidNoteExpressionUnitLinkCount === 1 &&
      vst3EventProfile.noAssociatedParameterSentinelCount === 2 &&
      vst3EventProfile.duplicateNoteExpressionTypeIdCount === 1 &&
      vst3EventProfile.associatedParameterCount === 1 &&
      vst3EventProfile.unitLinkedExpressionCount === 1 &&
      vst3EventProfile.fixedValueRangeCount === 1 &&
      vst3EventProfile.steppedExpressionCount === 1 &&
      vst3EventProfile.bipolarExpressionCount === 1 &&
      vst3EventProfile.oneShotExpressionCount === 1 &&
      vst3EventProfile.absoluteExpressionCount === 1 &&
      JSON.stringify(vst3EventProfile.typeIds) === JSON.stringify([0, 6, 7, 8, 9]) &&
      JSON.stringify(vst3EventProfile.eventBuses) === JSON.stringify([0, 2]) &&
      vst3EventProfile.flags.includes("text-expression") &&
      vst3EventProfile.flags.includes("note-expression-name-fallback") &&
      vst3EventProfile.flags.includes("value-expression") &&
      vst3EventProfile.flags.includes("associated-parameter") &&
      vst3EventProfile.flags.includes("unit-linked-expression") &&
      vst3EventProfile.flags.includes("bipolar-expression") &&
      vst3EventProfile.flags.includes("one-shot-expression") &&
      vst3EventProfile.flags.includes("absolute-expression") &&
      vst3EventProfile.flags.includes("invalid-note-expression") &&
      vst3EventProfile.flags.includes("invalid-note-expression-route") &&
      vst3EventProfile.flags.includes("default-note-expression-route") &&
      vst3EventProfile.flags.includes("invalid-associated-parameter") &&
      vst3EventProfile.flags.includes("no-associated-parameter-sentinel") &&
      vst3EventProfile.flags.includes("invalid-value-metadata") &&
      vst3EventProfile.flags.includes("invalid-unit-link") &&
      vst3EventProfile.flags.includes("fixed-value-range") &&
      vst3EventProfile.flags.includes("stepped-expression") &&
      vst3EventProfile.flags.includes("duplicate-note-expression-type-id") &&
      vst3EventMatrix.vst3InvalidAssociatedNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3NoAssociatedParameterSentinelCount === 2 &&
      vst3EventMatrix.vst3NameFallbackNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3DefaultRoutedNoteExpressionCount === 3 &&
      vst3EventMatrix.vst3InvalidNoteExpressionValueMetadataCount === 1 &&
      vst3EventMatrix.vst3InvalidUnitLinkedNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3FixedNoteExpressionValueRangeCount === 1 &&
      vst3EventMatrix.vst3SteppedNoteExpressionCount === 1 &&
      failedVst3EventSummary.coverage.vst3EventProfiles.failed === 1 &&
      failedVst3EventSummary.matrix[0].vst3EventCategory === "failed" &&
      invalidVst3EventProfile.category === "invalid-metadata" &&
      invalidVst3EventProfile.invalidNoteExpressionCount === 1 &&
      invalidVst3EventProfile.flags.includes("no-valid-note-expressions") &&
      invalidRouteOnlyVst3EventProfile.category === "invalid-route-metadata" &&
      invalidRouteOnlyVst3EventProfile.invalidNoteExpressionRouteCount === 1 &&
      invalidRouteOnlyVst3EventProfile.eventBuses.length === 1 &&
      invalidRouteOnlyVst3EventProfile.eventBuses[0] === 0 &&
      invalidRouteOnlyVst3EventSummary.coverage.vst3EventProfiles["invalid-route-metadata"] === 1 &&
      invalidRouteOnlyVst3EventSummary.matrix[0].vst3EventCategory === "invalid-route-metadata" &&
      invalidRouteOnlyVst3EventSummary.matrix[0].vst3InvalidNoteExpressionRouteCount === 1 &&
      cappedVst3EventProfile.noteExpressionCount === 256 &&
      cappedVst3EventProfile.metadataAtLimit === true &&
      cappedVst3EventProfile.flags.includes("metadata-at-limit") &&
      saturatedVst3EventProfile.noteExpressionCount === 256 &&
      saturatedVst3EventProfile.invalidNoteExpressionCount === 1 &&
      saturatedVst3EventProfile.invalidNoteExpressionRouteCount === 1 &&
      saturatedVst3EventProfile.invalidNoteExpressionValueMetadataCount === 1 &&
      saturatedVst3EventProfile.invalidNoteExpressionUnitLinkCount === 1 &&
      saturatedVst3EventProfile.invalidAssociatedParameterCount === 1 &&
      saturatedVst3EventProfile.defaultRouteExpressionCount === 1 &&
      saturatedVst3EventProfile.flags.includes("metadata-at-limit") &&
      saturatedVst3EventProfile.flags.includes("invalid-note-expression") &&
      saturatedVst3EventProfile.flags.includes("invalid-note-expression-route") &&
      saturatedVst3EventProfile.flags.includes("invalid-value-metadata") &&
      saturatedVst3EventProfile.flags.includes("invalid-unit-link") &&
      saturatedVst3EventProfile.flags.includes("invalid-associated-parameter") &&
      saturatedVst3EventMatrix.vst3InvalidNoteExpressionCount === 1 &&
      saturatedVst3EventMatrix.vst3InvalidNoteExpressionRouteCount === 1 &&
      saturatedVst3EventMatrix.vst3InvalidNoteExpressionValueMetadataCount === 1 &&
      saturatedVst3EventMatrix.vst3InvalidUnitLinkedNoteExpressionCount === 1 &&
      saturatedVst3EventMatrix.vst3InvalidAssociatedNoteExpressionCount === 1,
    "installed plugin probe classifies VST3 event metadata coverage"
  );
  check(
    summarizeProbeRenderSignal({ channels: [[0, 0]], outputBuses: [{ index: 1, channels: [[0, 0.25]] }] }) === "signal" &&
      summarizeProbeRenderSignal({ channels: [[0, 0]], outputBuses: [{ index: 0, channels: [[0, 0]] }] }) === "silent" &&
      summarizeProbeRenderSignal({ channels: [], outputBuses: [] }) === "missing",
    "installed plugin probe classifies render signal coverage"
  );

  const failedRenderSummary = summarizeProbeResults([{
    ok: false,
    format: "vst3",
    pluginId: "vst3:render-failed",
    phases: [{ name: "processAudioBlock", ok: false, error: { code: "bad_render_result" } }]
  }]);
  const outputBusSignalProfile = summarizeProbeOutputBusSignal({
    channels: [[0.1, 0.2], [0, 0]],
    outputBuses: [
      { index: 0, channels: [[0.1, 0.2], [0, 0]] },
      { index: 1, channels: [[0, 0]] },
      { index: 2, channels: [[0.25, 0.5]] },
      { index: 4, channels: [[0.75, 0.5]] },
      { index: 5, channels: [[0, 0]] }
    ]
  }, {
    outputChannels: 2,
    outputBusLayouts: [
      { index: 0, channels: 2, active: true },
      { index: 1, channels: 1, active: true },
      { index: 2, channels: 1, active: true },
      { index: 2, channels: 1, active: true }
    ]
  });
  const inactiveOutputSignalProfile = summarizeProbeOutputBusSignal({
    channels: [[0, 0]],
    outputBuses: [
      { index: 0, channels: [[0, 0]] },
      { index: 1, channels: [[0.6, 0.7]] }
    ]
  }, {
    outputChannels: 1,
    outputBusLayouts: [
      { index: 0, channels: 1, active: true },
      { index: 1, channels: 1, active: false }
    ]
  });
  const missingOutputSignalProfile = summarizeProbeOutputBusSignal({
    channels: [[0.1, 0.2], [0, 0]],
    outputBuses: [
      { index: 0, channels: [[0.1, 0.2], [0, 0]] },
      { index: 1, channels: [[0, 0]] }
    ]
  }, {
    outputChannels: 2,
    outputBusLayouts: [
      { index: 0, channels: 2, active: true },
      { index: 1, channels: 1, active: true },
      { index: 3, channels: 1, active: true }
    ]
  });
  const auxOnlyOutputSignalProfile = summarizeProbeOutputBusSignal({
    channels: [[0, 0], [0, 0]],
    outputBuses: [
      { index: 0, channels: [[0, 0], [0, 0]] },
      { index: 1, channels: [[0.4, 0.6]] },
      { index: 2, channels: [[0, 0]] }
    ]
  }, {
    outputChannels: 2,
    outputBusLayouts: [
      { index: 0, channels: 2, active: true },
      { index: 1, channels: 1, active: true },
      { index: 2, channels: 1, active: true }
    ]
  });
  const extraOnlyOutputSignalProfile = summarizeProbeOutputBusSignal({
    channels: [[0, 0]],
    outputBuses: [
      { index: 4, channels: [[0.2, 0.4]] }
    ]
  }, {
    outputChannels: 1,
    outputBusLayouts: [{ index: 0, channels: 1, active: true }]
  });
  const missingOutputSignalMatrix = summarizeProbeResults([{
    ok: true,
    outputBusSignalProfile: missingOutputSignalProfile
  }]).matrix[0];
  const extraOutputSignalMatrix = summarizeProbeResults([{
    ok: true,
    outputBusSignalProfile
  }]).matrix[0];
  const auxOnlyOutputSignalMatrix = summarizeProbeResults([{
    ok: true,
    outputBusSignalProfile: auxOnlyOutputSignalProfile
  }]).matrix[0];
  const extraOnlyOutputSignalMatrix = summarizeProbeResults([{
    ok: true,
    outputBusSignalProfile: extraOnlyOutputSignalProfile
  }]).matrix[0];
  check(
    outputBusSignalProfile.category === "main-aux-signal" &&
      outputBusSignalProfile.signalOutputBusCount === 2 &&
      outputBusSignalProfile.silentOutputBusCount === 1 &&
      outputBusSignalProfile.missingOutputBusCount === 0 &&
      outputBusSignalProfile.extraOutputBusCount === 2 &&
      outputBusSignalProfile.extraSignalOutputBusCount === 1 &&
      outputBusSignalProfile.flags.includes("extra-output-bus") &&
      outputBusSignalProfile.flags.includes("extra-output-bus-signal") &&
      JSON.stringify(outputBusSignalProfile.signalOutputBusIndexes) === JSON.stringify([0, 2]) &&
      JSON.stringify(outputBusSignalProfile.silentOutputBusIndexes) === JSON.stringify([1]) &&
      JSON.stringify(outputBusSignalProfile.extraOutputBusIndexes) === JSON.stringify([4, 5]) &&
      JSON.stringify(outputBusSignalProfile.extraSignalOutputBusIndexes) === JSON.stringify([4]) &&
      inactiveOutputSignalProfile.category === "extra-signal" &&
      inactiveOutputSignalProfile.outputBusCount === 1 &&
      inactiveOutputSignalProfile.signalOutputBusCount === 0 &&
      inactiveOutputSignalProfile.silentOutputBusCount === 1 &&
      inactiveOutputSignalProfile.extraSignalOutputBusCount === 1 &&
      !inactiveOutputSignalProfile.flags.includes("aux-signal") &&
      auxOnlyOutputSignalProfile.category === "aux-signal" &&
      auxOnlyOutputSignalProfile.signalOutputBusCount === 1 &&
      auxOnlyOutputSignalProfile.silentOutputBusCount === 2 &&
      !auxOnlyOutputSignalProfile.flags.includes("main-signal") &&
      auxOnlyOutputSignalProfile.flags.includes("aux-signal") &&
      JSON.stringify(auxOnlyOutputSignalProfile.signalOutputBusIndexes) === JSON.stringify([1]) &&
      auxOnlyOutputSignalMatrix.outputBusSignal === "aux-signal" &&
      auxOnlyOutputSignalMatrix.outputBusSignalCount === 1 &&
      auxOnlyOutputSignalMatrix.outputBusSilentCount === 2 &&
      JSON.stringify(auxOnlyOutputSignalMatrix.outputBusSignalIndexes) === JSON.stringify([1]) &&
      extraOnlyOutputSignalProfile.category === "extra-signal" &&
      extraOnlyOutputSignalProfile.signalOutputBusCount === 0 &&
      extraOnlyOutputSignalProfile.missingOutputBusCount === 1 &&
      extraOnlyOutputSignalProfile.extraSignalOutputBusCount === 1 &&
      extraOnlyOutputSignalProfile.flags.includes("extra-output-bus-signal") &&
      extraOnlyOutputSignalMatrix.outputBusSignal === "extra-signal" &&
      extraOnlyOutputSignalMatrix.outputBusMissingCount === 1 &&
      extraOnlyOutputSignalMatrix.outputBusExtraSignalCount === 1 &&
      JSON.stringify(extraOnlyOutputSignalMatrix.outputBusExtraSignalIndexes) === JSON.stringify([4]) &&
      failedRenderSummary.coverage.renderSignals.failed === 1 &&
      failedRenderSummary.coverage.hostTransport.failed === 1 &&
      failedRenderSummary.matrix[0].renderSignal === "failed" &&
      failedRenderSummary.matrix[0].hostTransport === "failed" &&
      failedRenderSummary.matrix[0].featureStatus.rendering === "failed" &&
      failedRenderSummary.matrix[0].featureStatus.transport === "failed" &&
      missingOutputSignalProfile.category === "main-signal" &&
      missingOutputSignalProfile.signalOutputBusCount === 1 &&
      missingOutputSignalProfile.silentOutputBusCount === 1 &&
      missingOutputSignalProfile.missingOutputBusCount === 1 &&
      missingOutputSignalProfile.flags.includes("missing-output-bus") &&
      JSON.stringify(missingOutputSignalProfile.missingOutputBusIndexes) === JSON.stringify([3]) &&
      missingOutputSignalMatrix.outputBusMissingCount === 1 &&
      extraOutputSignalMatrix.outputBusExtraCount === 2 &&
      extraOutputSignalMatrix.outputBusExtraSignalCount === 1 &&
      JSON.stringify(extraOutputSignalMatrix.outputBusExtraIndexes) === JSON.stringify([4, 5]) &&
      JSON.stringify(extraOutputSignalMatrix.outputBusExtraSignalIndexes) === JSON.stringify([4]) &&
      JSON.stringify(missingOutputSignalMatrix.outputBusMissingIndexes) === JSON.stringify([3]),
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
        { index: 1, channels: 1, active: true },
        { index: 3, channels: 2, active: true }
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
      sidechainPayload.inputBuses.length === 3 &&
      sidechainPayload.inputBuses[0].index === 0 &&
      sidechainPayload.inputBuses[0].channels.length === 2 &&
      sidechainPayload.inputBuses[0].channels[0][0] === 0.05 &&
      sidechainPayload.inputBuses[1].index === 1 &&
      sidechainPayload.inputBuses[1].channels.length === 1 &&
      sidechainPayload.inputBuses[1].channels[0][0] > 0 &&
      sidechainPayload.inputBuses[1].channels[0][0] !== sidechainPayload.inputBuses[0].channels[0][0] &&
      sidechainPayload.inputBuses[2].index === 3 &&
      sidechainPayload.inputBuses[2].channels.length === 2 &&
      sidechainPayload.inputBuses[2].channels[0][0] !== sidechainPayload.inputBuses[1].channels[0][0] &&
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
  let mismatchedAuxCode = "";
  try {
    assertProbeRenderMatchesLayout({
      channels: [[0, 0], [0.1, 0.1]],
      outputBuses: [
        { index: 0, channels: [[0, 0], [0.1, 0.1]] },
        { index: 2, channels: [[0.2, 0.2], [0.3, 0.3]] }
      ]
    }, multiOutputLayout, 2);
  } catch (error) {
    mismatchedAuxCode = error.code;
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
  const malformedBusCodes = [];
  for (const outputBuses of [
    [null],
    [{ index: 32, channels: [[0, 0]] }],
    [
      { index: 0, channels: [[0, 0], [0.1, 0.1]] },
      { index: 2, channels: [0.2, 0.2] }
    ]
  ]) {
    try {
      assertProbeRenderMatchesLayout({
        channels: [[0, 0], [0.1, 0.1]],
        outputBuses
      }, multiOutputLayout, 2);
      malformedBusCodes.push("ok");
    } catch (error) {
      malformedBusCodes.push(error.code);
    }
  }
  check(
    goodMultiOutputCode === "ok" &&
      missingBusCode === "bad_render_layout" &&
      mismatchedMainCode === "bad_render_layout" &&
      mismatchedAuxCode === "bad_render_layout" &&
      duplicateBusCode === "bad_render_layout" &&
      malformedBusCodes.every((code) => code === "bad_render_layout"),
    "installed plugin probe validates negotiated output-bus render layouts"
  );
}

function exerciseProbeMidiCoverage({ check }) {
  const vst3MidiEvents = midiEventsForBlock("vst3", 64, 64);
  const vst3MidiControllerProfile = summarizeProbeMidiControllerEvents(vst3MidiEvents);
  const vst3MidiProgramChangeProfile = summarizeProbeMidiProgramChangeEvents(vst3MidiEvents);
  const vst3MidiTimingProfile = summarizeProbeMidiTiming(vst3MidiEvents, 64);
  const invalidTimingProfile = summarizeProbeMidiTiming([{ type: "noteOn", time: -1 }, { type: "noteOff", time: 64 }], 64);
  const invalidControllerProfile = summarizeProbeMidiControllerEvents([
    { type: "controlChange", controller: 128, channel: 16, busIndex: 32 },
    { type: "pitchBend", value: 0, channel: -1 },
    { type: "channelPressure", pressure: 0.25, busIndex: "bad" }
  ]);
  const controllerBoundaryProfile = summarizeProbeMidiControllerEvents([
    { type: "controlChange", controller: 0, value: 0, channel: 0, busIndex: 0 },
    { type: "controlChange", controller: 1, value: 0, channel: 0 },
    { type: "controlChange", controller: 74, value: 1, channel: 2, busIndex: 1 },
    { type: "controlChange", controller: 127, value: 1, channel: 15, busIndex: 31 },
    { type: "pitchBend", value: -1, channel: 0 },
    { type: "pitchBend", value: 1, channel: 2, busIndex: 1 },
    { type: "channelPressure", pressure: 2, channel: 16, busIndex: 32 }
  ]);
  const controllerBoundaryMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    midiControllerEventProfile: controllerBoundaryProfile
  }]).matrix[0];
  const invalidProgramChangeProfile = summarizeProbeMidiProgramChangeEvents([
    { type: "programChange", program: 128, channel: 16, busIndex: 32 },
    { type: "programChange", program: "bad", channel: -1 }
  ]);
  const programChangeMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    midiProgramChangeEventProfile: vst3MidiProgramChangeProfile
  }]).matrix[0];
  const failedMidiSummary = summarizeProbeResults([{
    ok: false,
    format: "vst3",
    pluginId: "vst3:failed-midi-events",
    phases: [{ name: "sendMidiEvents", ok: false, error: { code: "bad_midi_result" } }]
  }]);
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
      vst3MidiEvents.some((event) => event.type === "noteOff" && event.time === 63) &&
      vst3MidiTimingProfile.category === "block-boundary" &&
      vst3MidiTimingProfile.flags.includes("block-start") &&
      vst3MidiTimingProfile.flags.includes("block-end") &&
      vst3MidiTimingProfile.maxTime === 63 &&
      invalidTimingProfile.category === "invalid-time" &&
      invalidTimingProfile.invalidTimeCount === 2 &&
      midiControllerEventCount(vst3MidiEvents) === 6 &&
      vst3MidiControllerProfile.eventCount === 6 &&
      vst3MidiControllerProfile.controllerFamilyCount === 3 &&
      vst3MidiControllerProfile.defaultControllerRouteCount === 3 &&
      vst3MidiControllerProfile.flags.includes("multi-controller-family") &&
      vst3MidiControllerProfile.flags.includes("non-main-event-bus") &&
      vst3MidiControllerProfile.flags.includes("non-main-channel") &&
      vst3MidiControllerProfile.flags.includes("default-controller-route") &&
      vst3MidiControllerProfile.flags.includes("negative-controller-value") &&
      vst3MidiControllerProfile.flags.includes("positive-controller-value") &&
      JSON.stringify(vst3MidiControllerProfile.types) === JSON.stringify(["controlChange", "pitchBend", "channelPressure"]) &&
      JSON.stringify(vst3MidiControllerProfile.controllers) === JSON.stringify([1, 74, 128, 129]) &&
      JSON.stringify(vst3MidiControllerProfile.channels) === JSON.stringify([0, 2]) &&
      JSON.stringify(vst3MidiControllerProfile.eventBuses) === JSON.stringify([0, 1]) &&
      vst3MidiProgramChangeProfile.eventCount === 2 &&
      vst3MidiProgramChangeProfile.defaultProgramRouteCount === 1 &&
      vst3MidiProgramChangeProfile.flags.includes("non-main-event-bus") &&
      vst3MidiProgramChangeProfile.flags.includes("default-program-route") &&
      programChangeMatrix.midiProgramChangeDefaultRouteCount === 1 &&
      JSON.stringify(vst3MidiProgramChangeProfile.programs) === JSON.stringify([2, 7]) &&
      JSON.stringify(vst3MidiProgramChangeProfile.channels) === JSON.stringify([0, 2]) &&
      JSON.stringify(vst3MidiProgramChangeProfile.eventBuses) === JSON.stringify([0, 1]) &&
      invalidControllerProfile.invalidControllerNumberCount === 1 &&
      invalidControllerProfile.invalidControllerRouteCount === 3 &&
      invalidControllerProfile.flags.includes("invalid-controller-number") &&
      invalidControllerProfile.flags.includes("invalid-controller-route") &&
      invalidControllerProfile.flags.includes("invalid-controller-value") &&
      !invalidControllerProfile.flags.includes("non-main-event-bus") &&
      !invalidControllerProfile.flags.includes("non-main-channel") &&
      controllerBoundaryProfile.invalidControllerValueCount === 1 &&
      controllerBoundaryProfile.flags.includes("min-controller-value") &&
      controllerBoundaryProfile.flags.includes("max-controller-value") &&
      controllerBoundaryProfile.flags.includes("negative-controller-value") &&
      controllerBoundaryProfile.flags.includes("invalid-controller-value") &&
      JSON.stringify(controllerBoundaryProfile.controllers) === JSON.stringify([0, 1, 74, 127, 128, 129]) &&
      controllerBoundaryMatrix.midiControllerDefaultRouteCount === 2 &&
      controllerBoundaryMatrix.midiControllerInvalidValueCount === 1 &&
      JSON.stringify(controllerBoundaryMatrix.midiControllerNumbers) === JSON.stringify([0, 1, 74, 127, 128, 129]) &&
      controllerBoundaryMatrix.midiControllerFlags.includes("max-controller-value") &&
      invalidProgramChangeProfile.invalidProgramNumberCount === 2 &&
      invalidProgramChangeProfile.invalidProgramRouteCount === 2 &&
      invalidProgramChangeProfile.flags.includes("invalid-program-number") &&
      invalidProgramChangeProfile.flags.includes("invalid-program-route") &&
      !invalidProgramChangeProfile.flags.includes("non-main-event-bus") &&
      !invalidProgramChangeProfile.flags.includes("non-main-channel") &&
      failedMidiSummary.coverage.vst3MidiControllerEvents.failed === 1 &&
      failedMidiSummary.coverage.vst3MidiProgramChangeEvents.failed === 1 &&
      failedMidiSummary.coverage.midiTiming.failed === 1 &&
      failedMidiSummary.matrix[0].vst3MidiControllerEvents === "failed" &&
      failedMidiSummary.matrix[0].vst3MidiProgramChangeEvents === "failed" &&
      failedMidiSummary.matrix[0].midiTiming === "failed" &&
      failedMidiSummary.matrix[0].featureStatus.midiEvents === "failed" &&
      midiEventsForBlock("au", 64, 64).every((event) => !event.type.startsWith("noteExpression")),
    "installed plugin probe sends VST3 note-expression, MIDI-controller, and program-change coverage"
  );
}
