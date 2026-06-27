import crypto from "node:crypto";
import net from "node:net";
import { decodeBinaryAudioEnvelope, encodeBinaryAudioEnvelope } from "./binary-audio-frames.mjs";

export function createRequestClient({ timeoutMs = 3000 } = {}) {
  let requestSeq = 0;

  return function request(socket, command, payload, includeSession, sessionToken) {
    const id = `smoke-${++requestSeq}`;
    const envelope = {
      type: "request",
      id,
      command,
      payload
    };
    if (includeSession) {
      envelope.sessionToken = sessionToken;
    }
    socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(envelope), "utf8")));

    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message.id !== id) {
          return;
        }
        cleanup();
        if (message.ok) {
          resolve(message.payload);
        } else {
          reject(new Error(`${message.error?.code}: ${message.error?.message}`));
        }
      };
      const cleanup = () => {
        socket.off("soundbridge-message", onMessage);
        clearTimeout(timeout);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${command}`));
      }, timeoutMs);
      socket.on("soundbridge-message", onMessage);
    });
  };
}

export function createBinaryAudioRequestClient({ timeoutMs = 3000 } = {}) {
  let requestSeq = 0;

  return function requestBinaryAudio(socket, command, payload, includeSession, sessionToken) {
    const id = `binary-${++requestSeq}`;
    const envelope = {
      type: "request",
      id,
      command,
      payload
    };
    if (includeSession) {
      envelope.sessionToken = sessionToken;
    }
    socket.write(encodeWebSocketFrame(encodeBinaryAudioEnvelope(envelope), 0x2));

    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message.id !== id) {
          return;
        }
        cleanup();
        if (message.ok) {
          resolve(message.payload);
        } else {
          reject(new Error(`${message.error?.code}: ${message.error?.message}`));
        }
      };
      const cleanup = () => {
        socket.off("soundbridge-message", onMessage);
        clearTimeout(timeout);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for binary ${command}`));
      }, timeoutMs);
      socket.on("soundbridge-message", onMessage);
    });
  };
}

export function connectWebSocket(host, port, origin) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host, port }, () => {
      const headers = [
        "GET /bridge HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13"
      ];
      if (origin !== null && origin !== undefined) {
        headers.push(`Origin: ${origin}`);
      }
      headers.push("\r\n");
      socket.write(headers.join("\r\n"));
    });

    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }

        const header = buffer.subarray(0, headerEnd).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101")) {
          reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }

        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        resolve(socket);
      }

      while (buffer.length > 0) {
        const parsed = decodeWebSocketFrame(buffer);
        if (!parsed) {
          return;
        }

        buffer = buffer.subarray(parsed.frameLength);
        if (parsed.opcode === 0x1) {
          socket.emit("soundbridge-message", JSON.parse(parsed.payload.toString("utf8")));
        } else if (parsed.opcode === 0x2) {
          socket.emit("soundbridge-message", decodeBinaryAudioEnvelope(parsed.payload));
        }
      }
    });

    socket.on("error", reject);
  });
}

function encodeWebSocketFrame(payload, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }

  header[0] = 0x80 | opcode;
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    payloadLength = buffer.readUInt32BE(offset) * 2 ** 32 + buffer.readUInt32BE(offset + 4);
    offset += 8;
  }

  const frameLength = offset + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  return {
    opcode,
    payload: buffer.subarray(offset, frameLength),
    frameLength
  };
}
