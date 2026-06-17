const MAX_VST3_NOTE_EXPRESSIONS = 256;
const TEXT_NOTE_EXPRESSION_TYPE_ID = 6;

export function summarizeProbeVst3Events(plugin) {
  if (String(plugin?.format ?? "").toLowerCase() !== "vst3") {
    return { category: "skipped-format", flags: [] };
  }

  const {
    expressions,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    metadataAtLimit
  } = boundedNoteExpressionProfile(plugin?.vst3NoteExpressions);
  const eventBuses = uniqueSorted(expressions.map((expression) => expression.busIndex));
  const channels = uniqueSorted(expressions.map((expression) => expression.channel));
  const typeIds = uniqueSorted(expressions.map((expression) => expression.typeId));
  const duplicateTypeIdCount = duplicateCount(expressions.map((expression) => expression.typeId));
  const textExpressionCount = expressions.filter(isTextExpression).length;
  const flags = expressionFlags(expressions, eventBuses, channels, {
    duplicateTypeIdCount,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    metadataAtLimit
  });

  return {
    category: expressionCategory(expressions, eventBuses, channels, invalidExpressionCount),
    flags,
    noteExpressionCount: expressions.length,
    valueExpressionCount: expressions.length - textExpressionCount,
    textExpressionCount,
    invalidNoteExpressionCount: invalidExpressionCount,
    invalidNoteExpressionRouteCount: invalidRouteExpressionCount,
    duplicateNoteExpressionTypeIdCount: duplicateTypeIdCount,
    associatedParameterCount: expressions.filter((expression) => expression.hasAssociatedParameter).length,
    unitLinkedExpressionCount: expressions.filter((expression) => expression.hasUnitLink).length,
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
  { duplicateTypeIdCount, invalidExpressionCount, invalidRouteExpressionCount, metadataAtLimit }
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
  if (duplicateTypeIdCount > 0) {
    flags.push("duplicate-note-expression-type-id");
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
  if (expressions.some((expression) => !isTextExpression(expression))) {
    flags.push("value-expression");
  }
  if (expressions.some((expression) => expression.hasAssociatedParameter)) {
    flags.push("associated-parameter");
  }
  if (expressions.some((expression) => expression.hasUnitLink)) {
    flags.push("unit-linked-expression");
  }
  if (metadataAtLimit) {
    flags.push("metadata-at-limit");
  }
  return flags;
}

function isTextExpression(expression) {
  return expression.typeId === TEXT_NOTE_EXPRESSION_TYPE_ID;
}

function expressionCategory(expressions, eventBuses, channels, invalidExpressionCount) {
  if (expressions.length === 0) {
    return invalidExpressionCount > 0 ? "invalid-metadata" : "no-note-expressions";
  }
  if (eventBuses.some((busIndex) => busIndex > 0)) {
    return "non-main-event-bus";
  }
  if (channels.some((channel) => channel > 0)) {
    return "non-main-channel";
  }
  return "main-event-bus";
}

function boundedNoteExpressionProfile(value) {
  if (!Array.isArray(value)) {
    return { expressions: [], invalidExpressionCount: 0, invalidRouteExpressionCount: 0, metadataAtLimit: false };
  }
  const expressions = [];
  let invalidExpressionCount = 0;
  let invalidRouteExpressionCount = 0;
  for (const expression of value.slice(0, MAX_VST3_NOTE_EXPRESSIONS)) {
    const normalized = normalizeNoteExpression(expression);
    if (normalized) {
      expressions.push(normalized);
      if (normalized.invalidRouteMetadata) {
        invalidRouteExpressionCount += 1;
      }
    } else {
      invalidExpressionCount += 1;
    }
  }
  return {
    expressions,
    invalidExpressionCount,
    invalidRouteExpressionCount,
    metadataAtLimit: value.length >= MAX_VST3_NOTE_EXPRESSIONS
  };
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
  return {
    typeId,
    busIndex: busIndex ?? 0,
    channel: channel ?? 0,
    invalidRouteMetadata:
      (hasOwn(expression, "busIndex") && busIndex === undefined) ||
      (hasOwn(expression, "channel") && channel === undefined),
    hasAssociatedParameter: typeof expression.associatedParameterId === "string" && expression.associatedParameterId.length > 0,
    hasUnitLink: unitId !== undefined
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
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
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return undefined;
  }
  return numeric;
}
