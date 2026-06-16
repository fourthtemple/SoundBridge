export type Vst3EventBusIndex = number;

interface MidiTimedChannelEvent {
  time?: number;
  channel?: number;
  busIndex?: Vst3EventBusIndex;
}

interface MidiNoteEvent extends MidiTimedChannelEvent {
  note: number;
  noteId?: number;
}

export type MidiEvent =
  | ({
      type: "noteOn";
      velocity: number;
    } & MidiNoteEvent)
  | ({
      type: "noteOff";
      velocity?: number;
    } & MidiNoteEvent)
  | ({
      type: "controlChange";
      controller: number;
      value: number;
    } & MidiTimedChannelEvent)
  | ({
      type: "pitchBend";
      value: number;
    } & MidiTimedChannelEvent)
  | ({
      type: "channelPressure";
      pressure: number;
    } & MidiTimedChannelEvent)
  | ({
      type: "polyPressure";
      note: number;
      pressure: number;
      noteId?: number;
    } & MidiTimedChannelEvent)
  | ({
      type: "programChange";
      program: number;
    } & MidiTimedChannelEvent)
  | ({
      type: "noteExpression";
      typeId: number;
      noteId: number;
      value: number;
    } & MidiTimedChannelEvent)
  | ({
      type: "noteExpressionText";
      typeId: number;
      noteId: number;
      text: string;
    } & MidiTimedChannelEvent);

export interface SendMidiEventsRequest {
  instanceId: string;
  events: MidiEvent[];
}

export interface SendMidiEventsResponse {
  accepted: boolean;
  eventCount: number;
}
