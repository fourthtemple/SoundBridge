import crypto from "node:crypto";
import net from "node:net";

export function rawHandshake(host, port, hostHeader, origin) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host, port }, () => {
      socket.write(
        [
          "GET /bridge HTTP/1.1",
          `Host: ${hostHeader}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Origin: ${origin}`,
          "\r\n"
        ].join("\r\n")
      );
    });
    let buffer = "";
    let settled = false;
    let timer;
    const done = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, socket });
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n\r\n")) {
        done(buffer.startsWith("HTTP/1.1 101") ? "101" : "rejected");
      }
    });
    socket.on("close", () => done("rejected"));
    socket.on("error", () => done("rejected"));
    timer = setTimeout(() => done("rejected"), 1200);
  });
}

export function connect(host, port, hostHeader, origin) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const ctx = { socket: null, closed: false };
    const socket = net.createConnection({ host, port }, () => {
      socket.write(
        [
          "GET /bridge HTTP/1.1",
          `Host: ${hostHeader}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Origin: ${origin}`,
          "\r\n"
        ].join("\r\n")
      );
    });
    ctx.socket = socket;
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101")) {
          reject(new Error(`upgrade failed: ${header.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        resolve(ctx);
      }
      while (buffer.length > 0) {
        const parsed = decodeFrame(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.frameLength);
        if (parsed.opcode === 0x1) {
          socket.emit("sb", JSON.parse(parsed.payload.toString("utf8")));
        }
      }
    });
    socket.on("close", () => {
      ctx.closed = true;
      if (!upgraded) {
        reject(new Error("upgrade failed: socket closed"));
      }
    });
    socket.on("error", (error) => {
      if (!upgraded) {
        reject(error);
      }
    });
  });
}

export function createRequestClient({ idPrefix = "sec", timeoutMs = 3000 } = {}) {
  let seq = 0;
  return function request(ctx, command, payload, includeSession, sessionToken) {
    const id = `${idPrefix}-${++seq}`;
    const envelope = { type: "request", id, command, payload };
    if (includeSession) envelope.sessionToken = sessionToken;
    ctx.socket.write(encodeFrame(Buffer.from(JSON.stringify(envelope), "utf8")));
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message.id !== id) return;
        cleanup();
        if (message.ok) resolve(message.payload);
        else reject(Object.assign(new Error(message.error?.code), { code: message.error?.code }));
      };
      const onClose = () => {
        cleanup();
        reject(Object.assign(new Error("closed"), { code: "closed" }));
      };
      const cleanup = () => {
        ctx.socket.off("sb", onMessage);
        ctx.socket.off("close", onClose);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error("timeout"), { code: "timeout" }));
      }, timeoutMs);
      ctx.socket.on("sb", onMessage);
      ctx.socket.on("close", onClose);
    });
  };
}

function encodeFrame(payload) {
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
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < offset + 2) return null;
    len = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buffer.length < offset + 8) return null;
    len = buffer.readUInt32BE(offset) * 2 ** 32 + buffer.readUInt32BE(offset + 4);
    offset += 8;
  }
  const frameLength = offset + len;
  if (buffer.length < frameLength) return null;
  return { opcode, payload: buffer.subarray(offset, frameLength), frameLength };
}
