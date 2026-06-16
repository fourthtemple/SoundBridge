export function createSecurityMidiCases({ check, request }) {
  async function expectMidiError(socket, session, instanceId, events, expectedCode, message) {
    const result = await request(
      socket,
      "sendMidiEvents",
      { instanceId, events },
      true,
      session
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(result.code === expectedCode, message);
  }

  async function checkMidiValidation(socket, session, instanceId) {
    const tooManyMidiEvents = Array.from({ length: 4097 }, () => ({ type: "noteOn", note: 60, velocity: 0.8 }));
    await expectMidiError(
      socket,
      session,
      instanceId,
      tooManyMidiEvents,
      "invalid_argument",
      "sendMidiEvents rejects oversized MIDI batches"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteOn", note: 60, velocity: 0.8, channel: 99 }],
      "invalid_argument",
      "sendMidiEvents rejects out-of-range MIDI fields"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "controlChange", controller: 999, value: 0.5 }],
      "invalid_argument",
      "sendMidiEvents rejects out-of-range MIDI CC fields"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteOn", note: 60, velocity: 0.8, busIndex: 999 }],
      "invalid_argument",
      "sendMidiEvents rejects out-of-range VST3 event-bus fields"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "pitchBend", value: 2 }],
      "invalid_argument",
      "sendMidiEvents rejects out-of-range pitch bend fields"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteExpression", typeId: 0, noteId: -1, value: 0.5 }],
      "invalid_argument",
      "sendMidiEvents rejects out-of-range VST3 note-expression fields"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteExpressionText", typeId: 6, noteId: 1, text: "x".repeat(257) }],
      "invalid_argument",
      "sendMidiEvents rejects oversized VST3 note-expression text"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteExpressionText", typeId: 6, noteId: 1, text: "a\u0000h" }],
      "invalid_argument",
      "sendMidiEvents rejects NUL VST3 note-expression text"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteExpression", typeId: 0, noteId: 1, value: 0.5 }],
      "unsupported_midi_event",
      "sendMidiEvents rejects VST3 note expressions for non-VST3 workers"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteExpressionText", typeId: 6, noteId: 1, text: "ah" }],
      "unsupported_midi_event",
      "sendMidiEvents rejects VST3 note-expression text for non-VST3 workers"
    );

    await expectMidiError(
      socket,
      session,
      instanceId,
      [{ type: "noteOn", note: 60, velocity: 0.8, busIndex: 1 }],
      "unsupported_midi_event",
      "sendMidiEvents rejects VST3 event-bus routing for non-VST3 workers"
    );
  }

  return {
    checkMidiValidation
  };
}
