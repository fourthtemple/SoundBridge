export function createMidiEventEncoder({ limits, protocolError }) {
  function encodeMidiEvents(events, format = "unknown") {
    if (!Array.isArray(events) || events.length === 0) {
      return "-";
    }

    return events.map((event) => eventToken(event, format)).join(";");
  }

  function eventToken(event, format) {
    if (event.type === "noteOn") {
      return noteEventToken("on", event, boundedMidiNumber(event.velocity ?? 0.8, 0, 1, "velocity"), format);
    }
    if (event.type === "noteOff") {
      return noteEventToken("off", event, boundedMidiNumber(event.velocity ?? 0, 0, 1, "velocity"), format);
    }
    if (event.type === "controlChange") {
      return busEventToken([
        "cc",
        boundedMidiInteger(event.controller, 0, 127, "controller"),
        boundedMidiNumber(event.value, 0, 1, "value"),
        boundedChannel(event),
        boundedTime(event)
      ], event, format);
    }
    if (event.type === "pitchBend") {
      return busEventToken([
        "bend",
        boundedMidiNumber(event.value, -1, 1, "pitch bend value"),
        boundedChannel(event),
        boundedTime(event)
      ], event, format);
    }
    if (event.type === "channelPressure") {
      return busEventToken([
        "pressure",
        boundedMidiNumber(event.pressure, 0, 1, "pressure"),
        boundedChannel(event),
        boundedTime(event)
      ], event, format);
    }
    if (event.type === "polyPressure") {
      return noteEventToken("poly", event, boundedMidiNumber(event.pressure, 0, 1, "pressure"), format);
    }
    if (event.type === "programChange") {
      return busEventToken([
        "program",
        boundedMidiInteger(event.program, 0, 127, "program"),
        boundedChannel(event),
        boundedTime(event)
      ], event, format);
    }
    if (event.type === "noteExpression" && format === "vst3") {
      return busEventToken([
        "expr",
        boundedVst3NoteExpressionInteger(event.typeId, 0, 4_294_967_295, "typeId"),
        boundedVst3NoteExpressionValue(event.value),
        boundedVst3NoteExpressionInteger(event.noteId, 0, 2_147_483_647, "noteId"),
        boundedChannel(event),
        boundedTime(event)
      ], event, format);
    }
    if (event.type === "noteExpressionText" && format === "vst3") {
      return busEventToken([
        "exprText",
        boundedVst3NoteExpressionInteger(event.typeId, 0, 4_294_967_295, "typeId"),
        encodeVst3NoteExpressionText(event.text),
        boundedVst3NoteExpressionInteger(event.noteId, 0, 2_147_483_647, "noteId"),
        boundedChannel(event),
        boundedTime(event)
      ], event, format);
    }
    throw protocolError("invalid_argument", `Unsupported MIDI event type: ${event.type}`);
  }

  function noteEventToken(kind, event, value, format) {
    const token = [
      kind,
      boundedMidiInteger(event.note, 0, 127, "note"),
      value,
      boundedChannel(event),
      boundedTime(event)
    ];
    const noteId = optionalVst3NoteId(event);
    if (format === "vst3" && noteId !== undefined) {
      token.push(noteId);
    }
    return busEventToken(token, event, format);
  }

  function busEventToken(parts, event, format) {
    const token = [...parts];
    const busIndex = optionalVst3BusIndex(event, format);
    if (busIndex !== undefined) {
      token.push(`bus=${busIndex}`);
    }
    return token.join(":");
  }

  function boundedChannel(event) {
    return boundedMidiInteger(event.channel ?? 0, 0, 15, "channel");
  }

  function boundedTime(event) {
    return boundedMidiInteger(event.time ?? 0, 0, maxWorkerEventTime(), "time");
  }

  function optionalVst3BusIndex(event, format) {
    if (event.busIndex === undefined) {
      return undefined;
    }
    if (format !== "vst3") {
      throw protocolError("invalid_argument", "VST3 event-bus routing is only supported for VST3 workers.");
    }
    return boundedMidiInteger(event.busIndex, 0, Math.max(1, limits.maxPluginBuses) - 1, "busIndex");
  }

  function optionalVst3NoteId(event) {
    if (event.noteId === undefined) {
      return undefined;
    }
    return boundedMidiInteger(event.noteId, 0, 2_147_483_647, "noteId");
  }

  function encodeVst3NoteExpressionText(value) {
    if (typeof value !== "string") {
      throw protocolError("invalid_argument", "VST3 note-expression text must be a string.");
    }
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength === 0 || byteLength > limits.maxPluginNoteExpressionTextBytes || value.includes("\u0000")) {
      throw protocolError(
        "invalid_argument",
        `VST3 note-expression text must be 1..${limits.maxPluginNoteExpressionTextBytes} UTF-8 bytes without NUL characters.`
      );
    }
    return Buffer.from(value, "utf8").toString("base64");
  }

  function boundedVst3NoteExpressionInteger(value, min, max, field) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw protocolError("invalid_argument", `VST3 note-expression ${field} must be an integer in ${min}..${max}.`);
    }
    return value;
  }

  function boundedVst3NoteExpressionValue(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw protocolError("invalid_argument", "VST3 note-expression value must be a number in 0..1.");
    }
    return value;
  }

  function boundedMidiInteger(value, min, max, field) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw protocolError("invalid_argument", `MIDI ${field} must be an integer in ${min}..${max}.`);
    }
    return value;
  }

  function boundedMidiNumber(value, min, max, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw protocolError("invalid_argument", `MIDI ${field} must be a number in ${min}..${max}.`);
    }
    return value;
  }

  function maxWorkerEventTime() {
    return Math.max(0, Math.min(8192, limits.maxBlockSize) - 1);
  }

  return {
    encodeMidiEvents
  };
}
