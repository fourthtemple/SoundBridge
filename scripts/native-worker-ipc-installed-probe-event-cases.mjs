import { summarizeProbeVst3Events } from "./installed-plugin-probe-events.mjs";
import { summarizeProbeResults } from "./installed-plugin-probe-reporting.mjs";

export function exerciseInstalledProbeEventSupport({ check }) {
  const profile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [
      {
        typeId: 0,
        name: "Velocity",
        minValue: 0.5,
        maxValue: 0.5,
        defaultValue: 0.5,
        stepCount: 4,
        bipolar: true
      },
      {
        typeId: 6,
        name: "",
        minValue: 0,
        maxValue: 1,
        defaultValue: 0.25,
        oneShot: true,
        absolute: true
      },
      {
        typeId: 7,
        minValue: 0.8,
        maxValue: 0.2,
        defaultValue: 0.9
      }
    ]
  });
  const summary = summarizeProbeResults([{ ok: true, format: "vst3", vst3EventProfile: profile }]);
  const matrix = summary.matrix[0];
  check(
    profile.noteExpressionCount === 3 &&
      profile.valueExpressionCount === 2 &&
      profile.textExpressionCount === 1 &&
      profile.fixedValueRangeCount === 1 &&
      profile.steppedExpressionCount === 1 &&
      profile.nameFallbackExpressionCount === 1 &&
      profile.invalidNoteExpressionValueMetadataCount === 1 &&
      profile.flags.includes("text-expression") &&
      profile.flags.includes("value-expression") &&
      profile.flags.includes("invalid-value-metadata") &&
      summary.coverage.vst3EventProfiles["flag:fixed-value-range"] === 1 &&
      summary.coverage.vst3EventProfiles["flag:stepped-expression"] === 1 &&
      matrix.vst3FixedNoteExpressionValueRangeCount === 1 &&
      matrix.vst3SteppedNoteExpressionCount === 1 &&
      matrix.vst3NameFallbackNoteExpressionCount === 1 &&
      matrix.vst3InvalidNoteExpressionValueMetadataCount === 1,
    "installed plugin probe reports VST3 note-expression text/value metadata"
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
      { typeId: 10, associatedParameterId: 123 },
      { typeId: "bad", busIndex: 0, channel: 0 }
    ]
  });
  const invalidVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [{ typeId: "bad" }]
  });
  const typedVst3EventProfile = summarizeProbeVst3Events({
    format: "vst3",
    vst3NoteExpressions: [
      { typeId: true },
      { typeId: "" },
      { typeId: "   " },
      { typeId: "6" }
    ]
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
      vst3EventProfile.noteExpressionCount === 7 &&
      vst3EventProfile.valueExpressionCount === 5 &&
      vst3EventProfile.textExpressionCount === 2 &&
      vst3EventProfile.nameFallbackExpressionCount === 1 &&
      vst3EventProfile.defaultRouteExpressionCount === 4 &&
      vst3EventProfile.invalidNoteExpressionCount === 1 &&
      vst3EventProfile.invalidNoteExpressionRouteCount === 1 &&
      vst3EventProfile.invalidAssociatedParameterCount === 1 &&
      vst3EventProfile.invalidNoteExpressionValueMetadataCount === 1 &&
      vst3EventProfile.invalidNoteExpressionUnitLinkCount === 1 &&
      vst3EventProfile.noAssociatedParameterSentinelCount === 2 &&
      vst3EventProfile.duplicateNoteExpressionTypeIdCount === 1 &&
      vst3EventProfile.associatedParameterCount === 2 &&
      vst3EventProfile.unitLinkedExpressionCount === 1 &&
      vst3EventProfile.fixedValueRangeCount === 1 &&
      vst3EventProfile.steppedExpressionCount === 1 &&
      vst3EventProfile.bipolarExpressionCount === 1 &&
      vst3EventProfile.oneShotExpressionCount === 1 &&
      vst3EventProfile.absoluteExpressionCount === 1 &&
      JSON.stringify(vst3EventProfile.typeIds) === JSON.stringify([0, 6, 7, 8, 9, 10]) &&
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
      vst3EventMatrix.vst3AssociatedNoteExpressionCount === 2 &&
      vst3EventMatrix.vst3NoAssociatedParameterSentinelCount === 2 &&
      vst3EventMatrix.vst3NameFallbackNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3DefaultRoutedNoteExpressionCount === 4 &&
      vst3EventMatrix.vst3InvalidNoteExpressionValueMetadataCount === 1 &&
      vst3EventMatrix.vst3InvalidUnitLinkedNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3FixedNoteExpressionValueRangeCount === 1 &&
      vst3EventMatrix.vst3SteppedNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3BipolarNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3OneShotNoteExpressionCount === 1 &&
      vst3EventMatrix.vst3AbsoluteNoteExpressionCount === 1 &&
      failedVst3EventSummary.coverage.vst3EventProfiles.failed === 1 &&
      failedVst3EventSummary.matrix[0].vst3EventCategory === "failed" &&
      invalidVst3EventProfile.category === "invalid-metadata" &&
      invalidVst3EventProfile.invalidNoteExpressionCount === 1 &&
      invalidVst3EventProfile.flags.includes("no-valid-note-expressions") &&
      typedVst3EventProfile.noteExpressionCount === 1 &&
      typedVst3EventProfile.invalidNoteExpressionCount === 3 &&
      JSON.stringify(typedVst3EventProfile.typeIds) === JSON.stringify([6]) &&
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
}
