import crypto from "node:crypto";
import http from "node:http";

export function createDaemonWebSocketServer({
  host,
  port,
  maxWebSocketMessageBytes,
  isLoopbackHostHeader,
  createConnectionContext,
  handleRequest,
  cleanupConnection
}) {
  const server = http.createServer((request, response) => {
    if (!isLoopbackHostHeader(request.headers.host)) {
      writeJson(response, 403, {
        ok: false,
        error: "forbidden_host"
      });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

    if (url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true
      });
      return;
    }

    writeJson(response, 404, {
      ok: false,
      error: "not_found"
    });
  });

  server.on("upgrade", (request, socket) => {
    if (!isLoopbackHostHeader(request.headers.host)) {
      socket.destroy();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (url.pathname !== "/bridge") {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n")
    );

    attachWebSocket({
      socket,
      requestOrigin: request.headers.origin ?? "unknown-origin",
      maxWebSocketMessageBytes,
      createConnectionContext,
      handleRequest,
      cleanupConnection
    });
  });

  return server;
}

function attachWebSocket({
  socket,
  requestOrigin,
  maxWebSocketMessageBytes,
  createConnectionContext,
  handleRequest,
  cleanupConnection
}) {
  let buffer = Buffer.alloc(0);
  const context = createConnectionContext({
    requestOrigin: String(requestOrigin),
    terminate: () => socket.destroy()
  });

  const send = (message) => {
    socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(message), "utf8"), 0x1));
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxWebSocketMessageBytes + 14) {
      socket.destroy();
      return;
    }

    while (buffer.length > 0) {
      const parsed = decodeWebSocketFrame(buffer, maxWebSocketMessageBytes);
      if (!parsed) {
        return;
      }
      if (parsed.tooLarge) {
        socket.destroy();
        return;
      }

      buffer = buffer.subarray(parsed.frameLength);

      if (parsed.opcode === 0x8) {
        socket.end();
        return;
      }

      if (parsed.opcode === 0x9) {
        socket.write(encodeWebSocketFrame(parsed.payload, 0xA));
        continue;
      }

      if (parsed.opcode !== 0x1) {
        continue;
      }

      void handleRequest(parsed.payload.toString("utf8"), context, send);
    }
  });

  socket.on("error", () => {});
  socket.on("close", () => cleanupConnection(context));
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function decodeWebSocketFrame(buffer, maxWebSocketMessageBytes) {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
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
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    payloadLength = high * 2 ** 32 + low;
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (payloadLength > maxWebSocketMessageBytes) {
    return {
      tooLarge: true
    };
  }

  const frameLength = offset + maskLength + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  let payload = buffer.subarray(offset + maskLength, frameLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    frameLength
  };
}

function encodeWebSocketFrame(payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
