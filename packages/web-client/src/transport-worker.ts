import {
  __soundBridgeDecodeBinaryAudioEnvelope as decodeBinaryAudioEnvelope,
  __soundBridgeEncodeBinaryAudioEnvelope as encodeBinaryAudioEnvelope
} from "./client";

let socket: WebSocket | undefined;
let audioRequestSeq = 0;
const pendingAudioPorts = new Map<string, MessagePort>();

interface AudioPortConfig {
  instanceId: string;
  sampleRate: number;
  sessionToken: string;
  audioTransport: "binary" | "json";
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "connect") {
    connect(String(message.url ?? ""));
    return;
  }
  if (message.type === "request") {
    sendRequest(message.envelope, message.binaryAudioChannels);
    return;
  }
  if (message.type === "audio-port" && message.port) {
    connectAudioPort(message.port, {
      instanceId: String(message.instanceId ?? ""),
      sampleRate: Number(message.sampleRate ?? 48000),
      sessionToken: String(message.sessionToken ?? ""),
      audioTransport: message.audioTransport === "json" ? "json" : "binary"
    });
    return;
  }
  if (message.type === "close") {
    socket?.close();
  }
};

function connect(url: string): void {
  socket?.close();
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    post({ type: "connected" });
  });
  socket.addEventListener("error", () => {
    post({ type: "connect-error", message: `Unable to connect to ${url}` });
  });
  socket.addEventListener("close", () => {
    post({ type: "closed" });
  });
  socket.addEventListener("message", (event) => {
    try {
      const envelope = typeof event.data === "string" ? JSON.parse(event.data) : decodeBinaryAudioEnvelope(event.data);
      if (routeAudioResponse(envelope)) {
        return;
      }
      post({ type: "message", envelope });
    } catch {
      post({ type: "protocol-error", message: "SoundBridge worker transport received an invalid message." });
    }
  });
}

function connectAudioPort(port: MessagePort, config: AudioPortConfig): void {
  port.onmessage = (event) => {
    const message = event.data;
    if (message?.type === "destroy") {
      port.close();
      return;
    }
    if (message?.type === "process") {
      sendAudioProcess(port, config, message);
    }
  };
}

function sendAudioProcess(port: MessagePort, config: AudioPortConfig, message: { blockId?: number; frames?: number; channels?: ArrayLike<number>[] }): void {
  const channels = Array.isArray(message.channels) ? message.channels : [];
  const frames = boundedFrames(message.frames ?? channels[0]?.length ?? 128);
  const blockId = Math.floor(Number(message.blockId ?? 0));
  const samplePosition = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, blockId * frames));
  const binary = config.audioTransport === "binary";
  const payload = {
    instanceId: config.instanceId,
    blockId,
    sampleRate: config.sampleRate,
    ...(binary ? {} : { channels: channels.map((channel) => Array.from(channel)) }),
    transport: { playing: true, samplePosition },
    timestamp: performance.now()
  };
  const envelope = {
    type: "request",
    id: `audio-${++audioRequestSeq}`,
    command: "processAudioBlock",
    sessionToken: config.sessionToken,
    payload
  };
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    port.postMessage({ type: "audio-error", blockId, error: "SoundBridge worker transport is not connected." });
    return;
  }
  try {
    pendingAudioPorts.set(envelope.id, port);
    socket.send(binary ? encodeBinaryAudioEnvelope(envelope, channels) : JSON.stringify(envelope));
  } catch (error) {
    pendingAudioPorts.delete(envelope.id);
    port.postMessage({ type: "audio-error", blockId, error: String(error instanceof Error ? error.message : error) });
  }
}

function routeAudioResponse(envelope: { id?: string; ok?: boolean; payload?: unknown; error?: unknown }): boolean {
  const port = envelope.id ? pendingAudioPorts.get(envelope.id) : undefined;
  if (!port) {
    return false;
  }
  pendingAudioPorts.delete(envelope.id ?? "");
  if (envelope.ok && envelope.payload && typeof envelope.payload === "object") {
    const payload = envelope.payload as { blockId?: number; channels?: Float32Array[]; latencySamples?: number; renderEngine?: string };
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    port.postMessage(
      {
        type: "processed",
        blockId: payload.blockId,
        channels,
        latencySamples: payload.latencySamples,
        renderEngine: payload.renderEngine
      },
      channels.map((channel) => channel.buffer)
    );
  } else {
    port.postMessage({ type: "audio-error", error: envelope.error });
  }
  return true;
}

function boundedFrames(value: unknown): number {
  const frames = Math.floor(Number(value));
  return Number.isFinite(frames) ? Math.max(1, Math.min(8192, frames)) : 128;
}

function sendRequest(envelope: unknown, binaryAudioChannels?: ArrayLike<number>[]): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    post({ type: "send-error", id: requestId(envelope), message: "SoundBridge worker transport is not connected." });
    return;
  }
  try {
    socket.send(binaryAudioChannels ? encodeBinaryAudioEnvelope(envelope, binaryAudioChannels) : JSON.stringify(envelope));
  } catch (error) {
    post({ type: "send-error", id: requestId(envelope), message: String(error instanceof Error ? error.message : error) });
  }
}

function requestId(envelope: unknown): string | undefined {
  return envelope && typeof envelope === "object" ? String((envelope as { id?: unknown }).id ?? "") : undefined;
}

function post(message: unknown): void {
  self.postMessage(message);
}
