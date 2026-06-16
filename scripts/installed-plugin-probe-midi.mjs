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
    events.splice(
      2,
      0,
      { type: "noteExpression", typeId: 0, value: 0.5, noteId, channel: 0, time: offset(0.1875) },
      { type: "noteExpressionText", typeId: 6, text: "probe", noteId, channel: 0, time: offset(0.21875) }
    );
    events.push({ type: "controlChange", controller: 74, value: 0.25, channel: 2, time: offset(0.625), busIndex: 1 });
    events.push({ type: "pitchBend", value: -0.2, channel: 2, time: offset(0.75), busIndex: 1 });
    events.push({ type: "channelPressure", pressure: 0.6, channel: 2, time: offset(0.875), busIndex: 1 });
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
  return {
    eventCount: controllerEvents.length,
    flags: midiControllerFlags(controllerEvents),
    types: knownControllerEventTypes(controllerEvents),
    controllers: uniqueSortedIntegers(controllerEvents.map((event) => event.controller), 0, 127),
    channels: uniqueSortedIntegers(controllerEvents.map((event) => event.channel ?? 0), 0, 15),
    eventBuses: uniqueSortedIntegers(controllerEvents.map((event) => event.busIndex ?? 0), 0, 31)
  };
}

function emptyMidiControllerProfile() {
  return {
    eventCount: 0,
    flags: ["no-controller-events"],
    types: [],
    controllers: [],
    channels: [],
    eventBuses: []
  };
}

function knownControllerEventTypes(events) {
  const present = new Set(events.map((event) => event.type));
  return ["controlChange", "pitchBend", "channelPressure"].filter((type) => present.has(type));
}

function midiControllerFlags(events) {
  if (events.length === 0) {
    return ["no-controller-events"];
  }
  const flags = ["controller-events"];
  for (const type of knownControllerEventTypes(events)) {
    flags.push(`type:${type}`);
  }
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
