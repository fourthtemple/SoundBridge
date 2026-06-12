import crypto from "node:crypto";
import net from "node:net";

export function createProbeRequester({ requestTimeoutMs }) {
  let requestSeq = 0;

  return function request(socket, command, payload, includeSession, sessionToken) {
    const id = `probe-${++requestSeq}`;
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
          const error = new Error(`${message.error?.code}: ${message.error?.message}`);
          error.code = message.error?.code;
          reject(error);
        }
      };
      const cleanup = () => {
        socket.off("soundbridge-message", onMessage);
        clearTimeout(timeout);
      };
      const timeout = setTimeout(() => {
        cleanup();
        const error = new Error(`timeout: timed out waiting for ${command}`);
        error.code = "timeout";
        reject(error);
      }, requestTimeoutMs);
      socket.on("soundbridge-message", onMessage);
    });
  };
}

export async function reservePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      const selectedPort = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(selectedPort));
    });
    server.on("error", reject);
  });
}

export function waitForListen(daemonProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for daemon to listen")), 10000);
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("SoundBridge mock daemon listening")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`daemon exited before listening (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      daemonProcess.stdout.off("data", onData);
      daemonProcess.off("exit", onExit);
    };
    daemonProcess.stdout.on("data", onData);
    daemonProcess.on("exit", onExit);
  });
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
      if (origin !== null) {
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
        }
      }
    });

    socket.on("error", reject);
  });
}

function encodeWebSocketFrame(payload) {
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

  header[0] = 0x81;
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
