import { decodeBinaryAudioEnvelope, encodeBinaryAudioEnvelope } from "./binary-audio-frames.mjs";
import { requestEnvelopeError, requestEnvelopeResponseId } from "./daemon-request-envelope.mjs";
import { sendError } from "./daemon-security-helpers.mjs";

export function createDaemonRequestHandler({ dispatchCommand }) {
  return async function handleRequest(rawMessage, context, send) {
    let envelope;
    const binaryAudioRequest = Buffer.isBuffer(rawMessage);
    try {
      envelope = binaryAudioRequest ? decodeBinaryAudioEnvelope(rawMessage) : JSON.parse(rawMessage);
    } catch {
      sendError(
        send,
        "unknown",
        binaryAudioRequest ? "bad_binary_audio" : "bad_json",
        binaryAudioRequest ? "Request was not a valid binary audio frame." : "Request was not valid JSON."
      );
      return;
    }

    const envelopeError = requestEnvelopeError(envelope);
    if (envelopeError) {
      const { code, details, message } = envelopeError;
      sendError(send, requestEnvelopeResponseId(envelope), code, message, details);
      return;
    }

    try {
      const payload = await dispatchCommand(envelope, context);
      const response = {
        type: "response",
        id: envelope.id,
        ok: true,
        payload
      };
      send(binaryAudioRequest && envelope.command === "processAudioBlock" ? encodeBinaryAudioEnvelope(response) ?? response : response);
    } catch (error) {
      sendError(
        send,
        envelope.id,
        error.code ?? "internal_error",
        error.message ?? "SoundBridge mock daemon error.",
        error.details
      );
    }
  };
}
