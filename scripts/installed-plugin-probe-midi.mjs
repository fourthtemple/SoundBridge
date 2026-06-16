export function midiEventsForBlock(format, frames = 64, maxBlockSize = 64) {
  const frameLimit = clampInt(maxBlockSize, 1, 8192, 64);
  const boundedFrames = clampInt(frames, 1, frameLimit, frameLimit);
  const offset = (fraction) => Math.min(boundedFrames - 1, Math.max(0, Math.floor(boundedFrames * fraction)));
  const isVst3 = String(format ?? "").toLowerCase() === "vst3";
  const noteId = 77;
  const events = [
    { type: "noteOn", note: 60, velocity: 0.7, channel: 0, time: 0, ...(isVst3 ? { noteId } : {}) },
    { type: "polyPressure", note: 60, pressure: 0.35, channel: 0, time: offset(0.125), ...(isVst3 ? { noteId } : {}) },
    { type: "controlChange", controller: 1, value: 0.4, channel: 0, time: offset(0.25) },
    { type: "pitchBend", value: 0.1, channel: 0, time: offset(0.375) },
    { type: "channelPressure", pressure: 0.3, channel: 0, time: offset(0.5) }
  ];
  if (isVst3) {
    const busNoteId = 78;
    events.splice(
      2,
      0,
      { type: "noteExpression", typeId: 0, value: 0.5, noteId, channel: 0, time: offset(0.1875) },
      { type: "noteExpressionText", typeId: 6, text: "probe", noteId, channel: 0, time: offset(0.21875) }
    );
    events.push({ type: "noteOn", note: 62, velocity: 0.6, channel: 1, time: offset(0.5625), noteId: busNoteId, busIndex: 1 });
    events.push({ type: "noteExpression", typeId: 0, value: 0.4, noteId: busNoteId, channel: 1, time: offset(0.59375), busIndex: 1 });
    events.push({ type: "noteExpressionText", typeId: 6, text: "bus", noteId: busNoteId, channel: 1, time: offset(0.609375), busIndex: 1 });
    events.push({ type: "controlChange", controller: 74, value: 0.25, channel: 2, time: offset(0.625), busIndex: 1 });
    events.push({ type: "pitchBend", value: -0.2, channel: 2, time: offset(0.75), busIndex: 1 });
    events.push({ type: "channelPressure", pressure: 0.6, channel: 2, time: offset(0.875), busIndex: 1 });
    events.push({ type: "programChange", program: 2, channel: 0, time: offset(0.90625) });
    events.push({ type: "programChange", program: 7, channel: 2, time: offset(0.921875), busIndex: 1 });
    events.push({ type: "noteOff", note: 62, velocity: 0, channel: 1, time: offset(0.9375), noteId: busNoteId, busIndex: 1 });
  }
  return events;
}

export function midiControllerEventCount(events) {
  return summarizeProbeMidiControllerEvents(events).eventCount;
}

export function summarizeProbeMidiControllerEvents(events) {
  if (!Array.isArray(events)) {
    return emptyMidiControllerProfile();
  }
  const controllerEvents = events.filter((event) =>
    event?.type === "controlChange" ||
      event?.type === "pitchBend" ||
      event?.type === "channelPressure"
  );
  const types = knownControllerEventTypes(controllerEvents);
  return {
    eventCount: controllerEvents.length,
    controllerFamilyCount: types.length,
    flags: midiControllerFlags(controllerEvents, types),
    types,
    controllers: uniqueSortedIntegers(controllerEvents.map((event) => event.controller), 0, 127),
    channels: uniqueSortedIntegers(controllerEvents.map((event) => event.channel ?? 0), 0, 15),
    eventBuses: uniqueSortedIntegers(controllerEvents.map((event) => event.busIndex ?? 0), 0, 31)
  };
}

export function summarizeProbeMidiProgramChangeEvents(events) {
  if (!Array.isArray(events)) {
    return emptyMidiProgramChangeProfile();
  }
  const programEvents = events.filter((event) => event?.type === "programChange");
  if (programEvents.length === 0) {
    return emptyMidiProgramChangeProfile();
  }
  return {
    eventCount: programEvents.length,
    flags: midiProgramChangeFlags(programEvents),
    programs: uniqueSortedIntegers(programEvents.map((event) => event.program), 0, 127),
    channels: uniqueSortedIntegers(programEvents.map((event) => event.channel ?? 0), 0, 15),
    eventBuses: uniqueSortedIntegers(programEvents.map((event) => event.busIndex ?? 0), 0, 31)
  };
}

function emptyMidiControllerProfile() {
  return {
    eventCount: 0,
    controllerFamilyCount: 0,
    flags: ["no-controller-events"],
    types: [],
    controllers: [],
    channels: [],
    eventBuses: []
  };
}

function emptyMidiProgramChangeProfile() {
  return {
    eventCount: 0,
    flags: ["no-program-change-events"],
    programs: [],
    channels: [],
    eventBuses: []
  };
}

function knownControllerEventTypes(events) {
  const present = new Set(events.map((event) => event.type));
  return ["controlChange", "pitchBend", "channelPressure"].filter((type) => present.has(type));
}

function midiControllerFlags(events, types = knownControllerEventTypes(events)) {
  if (events.length === 0) {
    return ["no-controller-events"];
  }
  const flags = ["controller-events"];
  for (const type of types) {
    flags.push(`type:${type}`);
  }
  if (types.length > 1) {
    flags.push("multi-controller-family");
  }
  if (events.some((event) => Number.isInteger(event.busIndex) && event.busIndex > 0)) {
    flags.push("non-main-event-bus");
  }
  if (events.some((event) => Number.isInteger(event.channel) && event.channel > 0)) {
    flags.push("non-main-channel");
  }
  return flags;
}

function midiProgramChangeFlags(events) {
  const flags = ["program-change-events"];
  if (events.some((event) => Number.isInteger(event.busIndex) && event.busIndex > 0)) {
    flags.push("non-main-event-bus");
  }
  if (events.some((event) => Number.isInteger(event.channel) && event.channel > 0)) {
    flags.push("non-main-channel");
  }
  return flags;
}

function uniqueSortedIntegers(values, min, max) {
  return [...new Set(values.filter((value) =>
    Number.isInteger(value) && value >= min && value <= max
  ))].sort((left, right) => left - right);
}

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return fallback;
  }
  return numeric;
}
