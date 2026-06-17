import {
  safeMatrixArray,
  safeMatrixInteger,
  safeMatrixIntegerArray,
  safeMatrixText
} from "./installed-plugin-probe-reporting-safety.mjs";

export function vst3EventMatrixFields(result) {
  const profile = result.vst3EventProfile;
  const defaultCategory = String(result.format ?? "").toLowerCase() === "vst3" ? "missing" : "skipped-format";
  return {
    vst3EventCategory: safeMatrixText(profile?.category ?? defaultCategory, 64),
    vst3EventFlags: safeMatrixArray(profile?.flags, 64),
    vst3NoteExpressionCount: safeMatrixInteger(profile?.noteExpressionCount, 0, 256),
    vst3ValueNoteExpressionCount: safeMatrixInteger(profile?.valueExpressionCount, 0, 256),
    vst3TextNoteExpressionCount: safeMatrixInteger(profile?.textExpressionCount, 0, 256),
    vst3NameFallbackNoteExpressionCount: safeMatrixInteger(profile?.nameFallbackExpressionCount, 0, 256),
    vst3DefaultRoutedNoteExpressionCount: safeMatrixInteger(profile?.defaultRouteExpressionCount, 0, 256),
    vst3InvalidAssociatedNoteExpressionCount: safeMatrixInteger(profile?.invalidAssociatedParameterCount, 0, 256),
    vst3InvalidNoteExpressionCount: safeMatrixInteger(profile?.invalidNoteExpressionCount, 0, 256),
    vst3InvalidNoteExpressionRouteCount: safeMatrixInteger(profile?.invalidNoteExpressionRouteCount, 0, 256),
    vst3InvalidNoteExpressionValueMetadataCount: safeMatrixInteger(profile?.invalidNoteExpressionValueMetadataCount, 0, 256),
    vst3InvalidUnitLinkedNoteExpressionCount: safeMatrixInteger(profile?.invalidNoteExpressionUnitLinkCount, 0, 256),
    vst3DuplicateNoteExpressionTypeIdCount: safeMatrixInteger(profile?.duplicateNoteExpressionTypeIdCount, 0, 256),
    vst3AssociatedNoteExpressionCount: safeMatrixInteger(profile?.associatedParameterCount, 0, 256),
    vst3UnitLinkedNoteExpressionCount: safeMatrixInteger(profile?.unitLinkedExpressionCount, 0, 256),
    vst3FixedNoteExpressionValueRangeCount: safeMatrixInteger(profile?.fixedValueRangeCount, 0, 256),
    vst3SteppedNoteExpressionCount: safeMatrixInteger(profile?.steppedExpressionCount, 0, 256),
    vst3BipolarNoteExpressionCount: safeMatrixInteger(profile?.bipolarExpressionCount, 0, 256),
    vst3OneShotNoteExpressionCount: safeMatrixInteger(profile?.oneShotExpressionCount, 0, 256),
    vst3AbsoluteNoteExpressionCount: safeMatrixInteger(profile?.absoluteExpressionCount, 0, 256),
    vst3NoteExpressionMetadataAtLimit: typeof profile?.metadataAtLimit === "boolean" ? profile.metadataAtLimit : undefined,
    vst3NoteExpressionTypeIds: safeMatrixIntegerArray(profile?.typeIds, 0, 4_294_967_295),
    vst3EventBuses: safeMatrixIntegerArray(profile?.eventBuses, 0, 31),
    vst3EventChannels: safeMatrixIntegerArray(profile?.channels, 0, 15)
  };
}
