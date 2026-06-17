const MAX_VST3_NOTE_EXPRESSIONS = 256;
const MAX_VST3_NOTE_EXPRESSION_SCAN = MAX_VST3_NOTE_EXPRESSIONS * 2;
const MAX_VST3_NOTE_EXPRESSION_STEPS = 1_000_000;
const VST3_NO_PARAM_IDS = new Set(["4294967295", "-1"]);
const TEXT_NOTE_EXPRESSION_TYPE_ID = 6;

export function summarizeProbeVst3Events(plugin) {
  if (String(plugin?.format ?? "").toLowerCase() !== "vst3") {
    return { category: "skipped-format", flags: [] };
  }

  const {
    expressions,
    defaultRouteExpressionCount,
    invalidAssociatedParameterCount,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    invalidValueMetadataCount,
    invalidUnitLinkCount,
    noAssociatedParameterSentinelCount,
    metadataAtLimit
  } = boundedNoteExpressionProfile(plugin?.vst3NoteExpressions);
  const eventBuses = uniqueSorted(expressions.map((expression) => expression.busIndex));
  const channels = uniqueSorted(expressions.map((expression) => expression.channel));
  const typeIds = uniqueSorted(expressions.map((expression) => expression.typeId));
  const duplicateTypeIdCount = duplicateCount(expressions.map((expression) => expression.typeId));
  const textExpressionCount = expressions.filter(isTextExpression).length;
  const nameFallbackExpressionCount = expressions.filter((expression) => expression.nameFallback).length;
  const flags = expressionFlags(expressions, eventBuses, channels, {
    defaultRouteExpressionCount,
    duplicateTypeIdCount,
    invalidAssociatedParameterCount,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    invalidValueMetadataCount,
    invalidUnitLinkCount,
    noAssociatedParameterSentinelCount,
    metadataAtLimit
  });

  return {
    category: expressionCategory(expressions, eventBuses, channels, invalidExpressionCount, invalidRouteExpressionCount),
    flags,
    noteExpressionCount: expressions.length,
    valueExpressionCount: expressions.length - textExpressionCount,
    textExpressionCount,
    nameFallbackExpressionCount,
    defaultRouteExpressionCount,
    invalidAssociatedParameterCount,
    invalidNoteExpressionCount: invalidExpressionCount,
    invalidNoteExpressionRouteCount: invalidRouteExpressionCount,
    invalidNoteExpressionValueMetadataCount: invalidValueMetadataCount,
    invalidNoteExpressionUnitLinkCount: invalidUnitLinkCount,
    noAssociatedParameterSentinelCount,
    duplicateNoteExpressionTypeIdCount: duplicateTypeIdCount,
    associatedParameterCount: expressions.filter((expression) => expression.hasAssociatedParameter).length,
    unitLinkedExpressionCount: expressions.filter((expression) => expression.hasUnitLink).length,
    fixedValueRangeCount: expressions.filter((expression) => expression.fixedValueRange).length,
    steppedExpressionCount: expressions.filter((expression) => expression.steppedValue).length,
    bipolarExpressionCount: expressions.filter((expression) => expression.bipolar).length,
    oneShotExpressionCount: expressions.filter((expression) => expression.oneShot).length,
    absoluteExpressionCount: expressions.filter((expression) => expression.absolute).length,
    metadataAtLimit,
    eventBuses,
    channels,
    typeIds
  };
}

function expressionFlags(
  expressions,
  eventBuses,
  channels,
  {
    defaultRouteExpressionCount,
    duplicateTypeIdCount,
    invalidAssociatedParameterCount,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    invalidValueMetadataCount,
    invalidUnitLinkCount,
    noAssociatedParameterSentinelCount,
    metadataAtLimit
  }
) {
  if (expressions.length === 0) {
    const flags = invalidExpressionCount > 0 || invalidRouteExpressionCount > 0
      ? ["invalid-note-expression", "no-valid-note-expressions"]
      : ["no-note-expressions"];
    if (invalidRouteExpressionCount > 0) {
      flags.push("invalid-note-expression-route");
    }
    if (metadataAtLimit) {
      flags.push("metadata-at-limit");
    }
    return flags;
  }

  const flags = ["note-expressions"];
  if (invalidExpressionCount > 0) {
    flags.push("invalid-note-expression");
  }
  if (invalidRouteExpressionCount > 0) {
    flags.push("invalid-note-expression-route");
  }
  if (invalidValueMetadataCount > 0) {
    flags.push("invalid-value-metadata");
  }
  if (invalidAssociatedParameterCount > 0) {
    flags.push("invalid-associated-parameter");
  }
  if (noAssociatedParameterSentinelCount > 0) {
    flags.push("no-associated-parameter-sentinel");
  }
  if (invalidUnitLinkCount > 0) {
    flags.push("invalid-unit-link");
  }
  if (duplicateTypeIdCount > 0) {
    flags.push("duplicate-note-expression-type-id");
  }
  if (defaultRouteExpressionCount > 0) {
    flags.push("default-note-expression-route");
  }
  if (eventBuses.some((busIndex) => busIndex > 0)) {
    flags.push("non-main-event-bus");
  }
  if (eventBuses.length > 1) {
    flags.push("multi-event-bus");
  }
  if (channels.some((channel) => channel > 0)) {
    flags.push("non-main-channel");
  }
  if (channels.length > 1) {
    flags.push("multi-channel");
  }
  if (expressions.some((expression) => expression.typeId === TEXT_NOTE_EXPRESSION_TYPE_ID)) {
    flags.push("text-expression");
  }
  if (expressions.some((expression) => expression.nameFallback)) {
    flags.push("note-expression-name-fallback");
  }
  if (expressions.some((expression) => !isTextExpression(expression))) {
    flags.push("value-expression");
  }
  if (expressions.some((expression) => expression.hasAssociatedParameter)) {
    flags.push("associated-parameter");
  }
  if (expressions.some((expression) => expression.hasUnitLink)) {
    flags.push("unit-linked-expression");
  }
  if (expressions.some((expression) => expression.fixedValueRange)) {
    flags.push("fixed-value-range");
  }
  if (expressions.some((expression) => expression.steppedValue)) {
    flags.push("stepped-expression");
  }
  if (expressions.some((expression) => expression.bipolar)) {
    flags.push("bipolar-expression");
  }
  if (expressions.some((expression) => expression.oneShot)) {
    flags.push("one-shot-expression");
  }
  if (expressions.some((expression) => expression.absolute)) {
    flags.push("absolute-expression");
  }
  if (metadataAtLimit) {
    flags.push("metadata-at-limit");
  }
  return flags;
}

function isTextExpression(expression) {
  return expression.typeId === TEXT_NOTE_EXPRESSION_TYPE_ID;
}

function expressionCategory(expressions, eventBuses, channels, invalidExpressionCount, invalidRouteExpressionCount) {
  if (expressions.length === 0) {
    return invalidExpressionCount > 0 ? "invalid-metadata" : "no-note-expressions";
  }
  if (eventBuses.some((busIndex) => busIndex > 0)) {
    return "non-main-event-bus";
  }
  if (channels.some((channel) => channel > 0)) {
    return "non-main-channel";
  }
  if (invalidRouteExpressionCount > 0) {
    return "invalid-route-metadata";
  }
  return "main-event-bus";
}

function boundedNoteExpressionProfile(value) {
  if (!Array.isArray(value)) {
    return {
      expressions: [],
      defaultRouteExpressionCount: 0,
      invalidAssociatedParameterCount: 0,
      invalidExpressionCount: 0,
      invalidRouteExpressionCount: 0,
      invalidValueMetadataCount: 0,
      invalidUnitLinkCount: 0,
      noAssociatedParameterSentinelCount: 0,
      metadataAtLimit: false
    };
  }
  const expressions = [];
  let defaultRouteExpressionCount = 0;
  let invalidAssociatedParameterCount = 0;
  let invalidExpressionCount = 0;
  let invalidRouteExpressionCount = 0;
  let invalidValueMetadataCount = 0;
  let invalidUnitLinkCount = 0;
  let noAssociatedParameterSentinelCount = 0;
  for (const expression of value.slice(0, MAX_VST3_NOTE_EXPRESSION_SCAN)) {
    const normalized = normalizeNoteExpression(expression);
    if (normalized) {
      if (expressions.length < MAX_VST3_NOTE_EXPRESSIONS) {
        expressions.push(normalized);
      }
      if (normalized.invalidRouteMetadata) {
        invalidRouteExpressionCount = cappedNoteExpressionCount(invalidRouteExpressionCount + 1);
      }
      if (normalized.defaultRouteMetadata) {
        defaultRouteExpressionCount = cappedNoteExpressionCount(defaultRouteExpressionCount + 1);
      }
      if (normalized.invalidValueMetadata) {
        invalidValueMetadataCount = cappedNoteExpressionCount(invalidValueMetadataCount + 1);
      }
      if (normalized.invalidAssociatedParameterMetadata) {
        invalidAssociatedParameterCount = cappedNoteExpressionCount(invalidAssociatedParameterCount + 1);
      }
      if (normalized.noAssociatedParameterSentinel) {
        noAssociatedParameterSentinelCount = cappedNoteExpressionCount(noAssociatedParameterSentinelCount + 1);
      }
      if (normalized.invalidUnitLinkMetadata) {
        invalidUnitLinkCount = cappedNoteExpressionCount(invalidUnitLinkCount + 1);
      }
    } else {
      invalidExpressionCount = cappedNoteExpressionCount(invalidExpressionCount + 1);
    }
  }
  return {
    expressions,
    defaultRouteExpressionCount,
    invalidAssociatedParameterCount,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    invalidValueMetadataCount,
    invalidUnitLinkCount,
    noAssociatedParameterSentinelCount,
    metadataAtLimit: value.length >= MAX_VST3_NOTE_EXPRESSIONS
  };
}

function cappedNoteExpressionCount(value) {
  return Math.min(MAX_VST3_NOTE_EXPRESSIONS, value);
}

function normalizeNoteExpression(expression) {
  if (!expression || typeof expression !== "object") {
    return undefined;
  }
  const typeId = boundedInt(expression.typeId, 0, 4_294_967_295);
  if (typeId === undefined) {
    return undefined;
  }
  const busIndex = boundedInt(expression.busIndex, 0, 31);
  const channel = boundedInt(expression.channel, 0, 15);
  const unitId = boundedInt(expression.unitId, -2_147_483_648, 2_147_483_647);
  const associatedParameterId = normalizeAssociatedParameterId(expression.associatedParameterId);
  const noAssociatedParameterSentinel = isNoAssociatedParameterSentinel(expression.associatedParameterId);
  const valueMetadata = normalizeValueMetadata(expression);
  return {
    typeId,
    busIndex: busIndex ?? 0,
    channel: channel ?? 0,
    invalidRouteMetadata:
      (hasOwn(expression, "busIndex") && busIndex === undefined) ||
      (hasOwn(expression, "channel") && channel === undefined),
    defaultRouteMetadata: !hasOwn(expression, "busIndex") || !hasOwn(expression, "channel"),
    invalidValueMetadata: valueMetadata.invalid,
    invalidAssociatedParameterMetadata:
      hasOwn(expression, "associatedParameterId") && associatedParameterId === undefined && !noAssociatedParameterSentinel,
    noAssociatedParameterSentinel,
    invalidUnitLinkMetadata: hasOwn(expression, "unitId") && unitId === undefined,
    fixedValueRange: valueMetadata.fixedRange,
    steppedValue: valueMetadata.stepped,
    nameFallback: expression.nameFallback === true || hasEmptyName(expression),
    hasAssociatedParameter: associatedParameterId !== undefined,
    hasUnitLink: unitId !== undefined,
    bipolar: expression.bipolar === true,
    oneShot: expression.oneShot === true,
    absolute: expression.absolute === true
  };
}

function normalizeValueMetadata(expression) {
  const minValue = optionalBoundedNumber(expression.minValue, 0, 1);
  const maxValue = optionalBoundedNumber(expression.maxValue, 0, 1);
  const defaultValue = optionalBoundedNumber(expression.defaultValue, 0, 1);
  const stepCount = optionalBoundedInt(expression.stepCount, 0, MAX_VST3_NOTE_EXPRESSION_STEPS);
  const invalid =
    (hasOwn(expression, "minValue") && minValue === undefined) ||
    (hasOwn(expression, "maxValue") && maxValue === undefined) ||
    (hasOwn(expression, "defaultValue") && defaultValue === undefined) ||
    (hasOwn(expression, "stepCount") && stepCount === undefined) ||
    (minValue !== undefined && maxValue !== undefined && minValue > maxValue) ||
    (defaultValue !== undefined && minValue !== undefined && defaultValue < minValue) ||
    (defaultValue !== undefined && maxValue !== undefined && defaultValue > maxValue);
  return {
    invalid,
    fixedRange: minValue !== undefined && maxValue !== undefined && minValue === maxValue,
    stepped: stepCount !== undefined && stepCount > 0
  };
}

function normalizeAssociatedParameterId(value) {
  const id = typeof value === "string"
    ? value
    : Number.isInteger(value) && value >= 0 && value < 4_294_967_295
      ? String(value)
      : "";
  if (id.length === 0 || isNoAssociatedParameterSentinel(id)) {
    return undefined;
  }
  return id;
}

function isNoAssociatedParameterSentinel(value) {
  return VST3_NO_PARAM_IDS.has(String(value ?? ""));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasEmptyName(value) {
  return hasOwn(value, "name") && String(value.name ?? "").length === 0;
}

function uniqueSorted(values) {
  return [...new Set(values)]
    .sort((left, right) => left - right);
}

function duplicateCount(values) {
  const seen = new Set();
  let duplicates = 0;
  for (const value of values) {
    if (seen.has(value)) {
      duplicates += 1;
    }
    seen.add(value);
  }
  return duplicates;
}

function boundedInt(value, min, max) {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return undefined;
  }
  return numeric;
}

function optionalBoundedInt(value, min, max) {
  return value === undefined ? undefined : boundedInt(value, min, max);
}

function optionalBoundedNumber(value, min, max) {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : undefined;
}
