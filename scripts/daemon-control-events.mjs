export function createDaemonControlEvents({
  clamp01,
  limits,
  makeProtocolError,
  validators
}) {
  const {
    maxAutomationCurvePoints,
    maxAutomationLanePoints,
    maxBlockSize,
    maxMidiEventsPerRequest,
    maxNoteExpressionTextBytes,
    maxParameterEventsPerRequest,
    maxPluginParameterTextBytes,
    maxPluginBuses,
    maxTransportSamplePosition
  } = limits;
  const {
    requireIntInRange,
    requireIntegerInRange,
    requireNumberInRange
  } = validators;

  function normalizeMidiEvents(events, maxBlockSizeForInstance) {
    if (events == null) {
      return [];
    }
    if (!Array.isArray(events)) {
      throw makeProtocolError("invalid_argument", "events must be an array.");
    }
    if (events.length > maxMidiEventsPerRequest) {
      throw makeProtocolError("invalid_argument", `events must contain at most ${maxMidiEventsPerRequest} MIDI events.`, {
        maxMidiEventsPerRequest
      });
    }

    const maxOffset = Math.max(0, Math.min(maxBlockSize, Number(maxBlockSizeForInstance) || maxBlockSize) - 1);
    return events.map((event, index) => {
      if (!event || typeof event !== "object") {
        throw makeProtocolError("invalid_argument", `events[${index}] must be an object.`);
      }

      const type = String(event.type ?? "");
      const channel = requireIntInRange(event.channel ?? 0, 0, 15, `events[${index}].channel`);
      const time = requireIntInRange(event.time ?? 0, 0, maxOffset, `events[${index}].time`);
      const busIndex = optionalBusIndex(event, index);
      if (type === "noteOn" || type === "noteOff") {
        const note = requireIntInRange(event.note, 0, 127, `events[${index}].note`);
        const velocity = requireNumberInRange(
          event.velocity ?? (type === "noteOn" ? 0.8 : 0),
          0,
          1,
          `events[${index}].velocity`
        );
        const normalized = { type, note, velocity, channel, time };
        addOptionalNoteId(normalized, event, index);
        addOptionalBusIndex(normalized, busIndex);
        return normalized;
      }
      if (type === "controlChange") {
        return addOptionalBusIndex({
          type,
          controller: requireIntInRange(event.controller, 0, 127, `events[${index}].controller`),
          value: requireNumberInRange(event.value, 0, 1, `events[${index}].value`),
          channel,
          time
        }, busIndex);
      }
      if (type === "pitchBend") {
        return addOptionalBusIndex({
          type,
          value: requireNumberInRange(event.value, -1, 1, `events[${index}].value`),
          channel,
          time
        }, busIndex);
      }
      if (type === "channelPressure") {
        return addOptionalBusIndex({
          type,
          pressure: requireNumberInRange(event.pressure, 0, 1, `events[${index}].pressure`),
          channel,
          time
        }, busIndex);
      }
      if (type === "polyPressure") {
        const normalized = {
          type,
          note: requireIntInRange(event.note, 0, 127, `events[${index}].note`),
          pressure: requireNumberInRange(event.pressure, 0, 1, `events[${index}].pressure`),
          channel,
          time
        };
        addOptionalNoteId(normalized, event, index);
        addOptionalBusIndex(normalized, busIndex);
        return normalized;
      }
      if (type === "programChange") {
        return addOptionalBusIndex({
          type,
          program: requireIntInRange(event.program, 0, 127, `events[${index}].program`),
          channel,
          time
        }, busIndex);
      }
      if (type === "noteExpression") {
        return addOptionalBusIndex({
          type,
          typeId: requireIntegerInRange(event.typeId, 0, 4_294_967_295, `events[${index}].typeId`),
          noteId: requireIntegerInRange(event.noteId, 0, 2_147_483_647, `events[${index}].noteId`),
          value: requireNumberInRange(event.value, 0, 1, `events[${index}].value`),
          channel,
          time
        }, busIndex);
      }
      if (type === "noteExpressionText") {
        return addOptionalBusIndex({
          type,
          typeId: requireIntegerInRange(event.typeId, 0, 4_294_967_295, `events[${index}].typeId`),
          noteId: requireIntegerInRange(event.noteId, 0, 2_147_483_647, `events[${index}].noteId`),
          text: requireBoundedEventText(event.text, maxNoteExpressionTextBytes, `events[${index}].text`),
          channel,
          time
        }, busIndex);
      }
      throw makeProtocolError(
        "invalid_argument",
        `events[${index}].type must be noteOn, noteOff, controlChange, pitchBend, channelPressure, polyPressure, programChange, noteExpression, or noteExpressionText.`
      );
    });
  }

  function requireBoundedEventText(value, maxBytes, fieldName) {
    if (typeof value !== "string") {
      throw makeProtocolError("invalid_argument", `${fieldName} must be a string.`);
    }
    const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 256;
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength === 0 || byteLength > limit || value.includes("\u0000")) {
      throw makeProtocolError("invalid_argument", `${fieldName} must be 1..${limit} UTF-8 bytes without NUL characters.`, {
        maxNoteExpressionTextBytes: limit
      });
    }
    return value;
  }

  function addOptionalNoteId(normalized, event, index) {
    if (event.noteId !== undefined) {
      normalized.noteId = requireIntegerInRange(event.noteId, 0, 2_147_483_647, `events[${index}].noteId`);
    }
  }

  function optionalBusIndex(event, index) {
    if (event.busIndex === undefined) {
      return undefined;
    }
    const maxBusIndex = Math.max(1, Number(maxPluginBuses) || 32) - 1;
    return requireIntInRange(event.busIndex, 0, maxBusIndex, `events[${index}].busIndex`);
  }

  function addOptionalBusIndex(normalized, busIndex) {
    if (busIndex !== undefined) {
      normalized.busIndex = busIndex;
    }
    return normalized;
  }

  function normalizeParameterEvents(events, maxBlockSizeForInstance) {
    if (events == null) {
      return [];
    }
    if (!Array.isArray(events)) {
      throw makeProtocolError("invalid_argument", "events must be an array.");
    }
    if (events.length > maxParameterEventsPerRequest) {
      throw makeProtocolError("invalid_argument", `events must contain at most ${maxParameterEventsPerRequest} parameter events.`, {
        maxParameterEventsPerRequest
      });
    }

    const maxOffset = Math.max(0, Math.min(maxBlockSize, Number(maxBlockSizeForInstance) || maxBlockSize) - 1);
    return events
      .map((event, index) => {
        if (!event || typeof event !== "object") {
          throw makeProtocolError("invalid_argument", `events[${index}] must be an object.`);
        }
        return {
          parameterId: requireParameterId(event.parameterId, `events[${index}].parameterId`),
          normalizedValue: requireNumberInRange(event.normalizedValue, 0, 1, `events[${index}].normalizedValue`),
          time: requireIntInRange(event.time ?? 0, 0, maxOffset, `events[${index}].time`),
          order: index
        };
      })
      .sort((left, right) => left.time - right.time || left.order - right.order);
  }

  function normalizeParameterCurve(parameterId, points, interpolation, maxBlockSizeForInstance) {
    if (!Array.isArray(points)) {
      throw makeProtocolError("invalid_argument", "points must be an array.");
    }
    if (points.length < 1 || points.length > maxAutomationCurvePoints) {
      throw makeProtocolError("invalid_argument", `points must contain 1..${maxAutomationCurvePoints} automation points.`, {
        maxAutomationCurvePoints
      });
    }
    const mode = interpolation == null ? "linear" : String(interpolation);
    if (mode !== "linear" && mode !== "step") {
      throw makeProtocolError("invalid_argument", "interpolation must be linear or step.");
    }

    const maxOffset = Math.max(0, Math.min(maxBlockSize, Number(maxBlockSizeForInstance) || maxBlockSize) - 1);
    const normalizedPoints = points.map((point, index) => {
      if (!point || typeof point !== "object") {
        throw makeProtocolError("invalid_argument", `points[${index}] must be an object.`);
      }
      return {
        time: requireIntInRange(point.time, 0, maxOffset, `points[${index}].time`),
        normalizedValue: requireNumberInRange(point.normalizedValue, 0, 1, `points[${index}].normalizedValue`)
      };
    });

    for (let index = 1; index < normalizedPoints.length; ++index) {
      if (normalizedPoints[index].time <= normalizedPoints[index - 1].time) {
        throw makeProtocolError("invalid_argument", "curve point times must be strictly increasing.");
      }
    }

    if (mode === "step" || normalizedPoints.length === 1) {
      return normalizedPoints.map((point) => ({
        parameterId,
        normalizedValue: point.normalizedValue,
        time: point.time
      }));
    }

    const first = normalizedPoints[0];
    const last = normalizedPoints[normalizedPoints.length - 1];
    const span = Math.max(0, last.time - first.time);
    const explicitTimes = new Set(normalizedPoints.map((point) => point.time));
    const availableInterpolatedPoints = Math.max(1, maxParameterEventsPerRequest - normalizedPoints.length);
    const stride = Math.max(1, Math.ceil((span + 1) / availableInterpolatedPoints));
    const times = new Set(explicitTimes);
    for (let time = first.time; time <= last.time; time += stride) {
      times.add(time);
    }
    times.add(last.time);

    let sortedTimes = [...times].sort((left, right) => left - right);
    if (sortedTimes.length > maxParameterEventsPerRequest) {
      sortedTimes = sortedTimes.filter((time) => explicitTimes.has(time));
      if (sortedTimes.length > maxParameterEventsPerRequest) {
        throw makeProtocolError("invalid_argument", `expanded curve must contain at most ${maxParameterEventsPerRequest} parameter events.`, {
          maxParameterEventsPerRequest
        });
      }
    }

    let segmentIndex = 0;
    return sortedTimes.map((time) => {
      while (
        segmentIndex + 1 < normalizedPoints.length - 1 &&
        normalizedPoints[segmentIndex + 1].time < time
      ) {
        segmentIndex += 1;
      }
      const left = normalizedPoints[segmentIndex];
      const right = normalizedPoints[Math.min(segmentIndex + 1, normalizedPoints.length - 1)];
      const ratio = right.time === left.time ? 0 : (time - left.time) / (right.time - left.time);
      return {
        parameterId,
        normalizedValue: clamp01(left.normalizedValue + (right.normalizedValue - left.normalizedValue) * ratio),
        time
      };
    });
  }

  function normalizeAutomationLanePoints(points) {
    if (!Array.isArray(points)) {
      throw makeProtocolError("invalid_argument", "points must be an array.");
    }
    if (points.length < 1 || points.length > maxAutomationLanePoints) {
      throw makeProtocolError("invalid_argument", `points must contain 1..${maxAutomationLanePoints} automation lane points.`, {
        maxAutomationLanePoints
      });
    }

    const normalizedPoints = points.map((point, index) => {
      if (!point || typeof point !== "object") {
        throw makeProtocolError("invalid_argument", `points[${index}] must be an object.`);
      }
      return {
        samplePosition: requireIntegerInRange(
          point.samplePosition,
          0,
          maxTransportSamplePosition,
          `points[${index}].samplePosition`
        ),
        normalizedValue: requireNumberInRange(point.normalizedValue, 0, 1, `points[${index}].normalizedValue`)
      };
    });

    for (let index = 1; index < normalizedPoints.length; ++index) {
      if (normalizedPoints[index].samplePosition <= normalizedPoints[index - 1].samplePosition) {
        throw makeProtocolError("invalid_argument", "automation lane sample positions must be strictly increasing.");
      }
    }

    return normalizedPoints;
  }

  function collectAutomationLaneEvents(instance, transport, frames) {
    if (!instance.automationLanes || instance.automationLanes.size === 0 || !Object.hasOwn(transport ?? {}, "samplePosition")) {
      return [];
    }

    const blockStart = transport.samplePosition;
    const maxOffset = Math.max(0, frames - 1);
    const blockEndInclusive =
      blockStart > maxTransportSamplePosition - maxOffset ? maxTransportSamplePosition : blockStart + maxOffset;
    const events = [];
    let laneOrder = 0;

    for (const [parameterId, points] of instance.automationLanes) {
      for (const point of points) {
        if (point.samplePosition < blockStart) {
          continue;
        }
        if (point.samplePosition > blockEndInclusive) {
          break;
        }
        events.push({
          parameterId,
          normalizedValue: point.normalizedValue,
          time: point.samplePosition - blockStart,
          laneOrder
        });
        if (events.length > maxParameterEventsPerRequest) {
          throw makeProtocolError("invalid_argument", "automation lanes produced too many events for one render block.", {
            maxParameterEventsPerRequest
          });
        }
      }
      laneOrder += 1;
    }

    return events.sort((left, right) => left.time - right.time || left.laneOrder - right.laneOrder);
  }

  function requireParameterId(value, label) {
    const text = String(value ?? "");
    if (!text || Buffer.byteLength(text, "utf8") > 64) {
      throw makeProtocolError("invalid_argument", `${label} must be a non-empty string up to 64 bytes.`);
    }
    return text;
  }

  function requirePresetId(value, label) {
    const text = String(value ?? "");
    if (!text || Buffer.byteLength(text, "utf8") > 64) {
      throw makeProtocolError("invalid_argument", `${label} must be a non-empty string up to 64 bytes.`);
    }
    return text;
  }

  function requireParameterDisplayValue(value, label) {
    const limit = Number.isInteger(maxPluginParameterTextBytes) && maxPluginParameterTextBytes > 0
      ? Math.min(maxPluginParameterTextBytes, 1024)
      : 160;
    if (typeof value !== "string") {
      throw makeProtocolError("invalid_argument", `${label} must be a string.`);
    }
    if (Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > limit || value.includes("\u0000")) {
      throw makeProtocolError("invalid_argument", `${label} must be 1..${limit} UTF-8 bytes without NUL characters.`, {
        maxPluginParameterTextBytes: limit
      });
    }
    return value;
  }

  function assertParameterWritable(parameter) {
    if (parameter?.readOnly === true) {
      throw makeProtocolError("parameter_read_only", `Parameter is read-only: ${parameter.id}`, {
        parameterId: parameter.id
      });
    }
  }

  function assertParameterAutomatable(parameter) {
    assertParameterWritable(parameter);
    if (parameter?.automatable === false) {
      throw makeProtocolError("parameter_not_automatable", `Parameter is not automatable: ${parameter.id}`, {
        parameterId: parameter.id
      });
    }
  }

  return {
    assertParameterAutomatable,
    assertParameterWritable,
    collectAutomationLaneEvents,
    normalizeAutomationLanePoints,
    normalizeMidiEvents,
    normalizeParameterCurve,
    normalizeParameterEvents,
    requireParameterId,
    requireParameterDisplayValue,
    requirePresetId
  };
}
