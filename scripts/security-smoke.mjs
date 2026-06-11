// Focused security regression test for the hardened mock daemon.
// Exercises only the mock.gain path so it runs without a native build.
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOUNDBRIDGE_PORT ?? 47991);
const TOKEN = "dev-token";
const ORIGIN = "http://127.0.0.1:5173";

let passed = 0;
let seq = 0;
const failures = [];
function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ok  - ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL- ${message}`);
  }
}

const daemon = spawn("node", ["scripts/mock-daemon.mjs"], {
  env: {
    ...process.env,
    SOUNDBRIDGE_HOST: HOST,
    SOUNDBRIDGE_PORT: String(PORT),
    SOUNDBRIDGE_PAIRING_TOKEN: TOKEN,
    SOUNDBRIDGE_MAX_PAIR_ATTEMPTS: "3"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
daemon.stderr.on("data", () => {});

try {
  await waitForListen(daemon);
  await run();
} finally {
  daemon.kill("SIGKILL");
}

console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  process.exit(1);
}

async function run() {
  // A. DNS-rebinding: a non-loopback Host header must be rejected at upgrade.
  const rebind = await rawHandshake(HOST, PORT, "evil.example", ORIGIN);
  check(rebind.status !== "101", "WS upgrade with non-loopback Host header is rejected (DNS-rebinding defense)");
  rebind.socket?.destroy();

  // B. Loopback Host header upgrades normally.
  const main = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  check(Boolean(main.socket), "WS upgrade with loopback Host header succeeds");

  // C. Unpaired hello stays minimal.
  const helloUnpaired = await request(main, "hello", {}, false);
  check(helloUnpaired.pairingRequired === true, "unpaired hello reports pairingRequired");
  check(
    Object.keys(helloUnpaired.capabilities?.pluginFormats ?? {}).length === 0,
    "unpaired hello does not disclose plugin host adapters"
  );
  check(helloUnpaired.capabilities?.security?.hostHeaderValidation === true, "hello advertises hostHeaderValidation");

  // D. Wrong pairing token is rejected, and the connection locks out after the limit.
  const lockSocket = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  const r1 = await pairAttempt(lockSocket, "wrong-1");
  const r2 = await pairAttempt(lockSocket, "wrong-2");
  const r3 = await pairAttempt(lockSocket, "wrong-3");
  check(r1.code === "pairing_denied", "1st wrong token -> pairing_denied");
  check(r2.code === "pairing_denied", "2nd wrong token -> pairing_denied");
  check(r3.code === "pairing_denied" || r3.closed === true, "3rd wrong token -> denied then connection closed");
  // After the limit the connection is closed; a follow-up attempt cannot pair.
  const r4 = await pairAttempt(lockSocket, TOKEN);
  check(r4.closed === true || r4.code === "pairing_locked", "after lockout the correct token cannot pair on that connection");
  lockSocket.socket?.destroy();

  // E. Correct token pairs.
  const paired = await request(main, "pair", { origin: ORIGIN, pairingToken: TOKEN }, false);
  check(typeof paired.sessionToken === "string" && paired.sessionToken.length > 0, "correct token pairs and returns a session token");
  const session = paired.sessionToken;

  // F. createInstance rejects out-of-range sizing instead of allocating.
  const huge = await request(main, "createInstance", { pluginId: "mock.gain", outputChannels: 1e9 }, true, session).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(huge.code === "invalid_argument", "createInstance outputChannels=1e9 -> invalid_argument (no OOM)");
  for (const [field, payload] of [
    ["maxBlockSize", { pluginId: "mock.gain", maxBlockSize: 5e8 }],
    ["sampleRate", { pluginId: "mock.gain", sampleRate: -1 }],
    ["inputChannels", { pluginId: "mock.gain", inputChannels: 1e7 }]
  ]) {
    const res = await request(main, "createInstance", payload, true, session).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(res.code === "invalid_argument", `createInstance rejects out-of-range ${field}`);
  }

  // G. Valid createInstance + an oversized processAudioBlock returns quickly and bounded.
  const created = await request(
    main,
    "createInstance",
    { pluginId: "mock.gain", sampleRate: 48000, maxBlockSize: 128, inputChannels: 2, outputChannels: 2 },
    true,
    session
  );
  check(typeof created.instanceId === "string", "valid createInstance returns an instanceId");
  check(/^inst-[0-9a-f-]{36}$/.test(created.instanceId), "instanceId is a random UUID (not a guessable counter)");

  const latency = await request(
    main,
    "getLatency",
    { instanceId: created.instanceId, transportLatencySamples: 32 },
    true,
    session
  );
  check(
    latency.pluginLatencySamples === 0 &&
      latency.transportLatencySamples === 32 &&
      latency.reportedLatencySamples === 32,
    "getLatency reports bounded plugin plus transport latency"
  );

  const latencyTooLarge = await request(
    main,
    "getLatency",
    { instanceId: created.instanceId, transportLatencySamples: 1e9 },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(latencyTooLarge.code === "invalid_argument", "getLatency rejects out-of-range transport latency");

  const started = Date.now();
  const oversized = await request(
    main,
    "processAudioBlock",
    { instanceId: created.instanceId, blockId: 1, frames: 1e9, channels: [] },
    true,
    session
  );
  const elapsed = Date.now() - started;
  check(elapsed < 1500, `oversized processAudioBlock returns promptly (${elapsed}ms, no runaway allocation)`);
  check(Array.isArray(oversized.channels) && oversized.channels.length <= 2, "output channel count stays bounded");
  check((oversized.channels[0]?.length ?? 0) <= 128, "output frame count is clamped to maxBlockSize");

  // H. Happy-path gain still works.
  await request(main, "setParameter", { instanceId: created.instanceId, parameterId: "gain", normalizedValue: 0.75 }, true, session);
  const processed = await request(
    main,
    "processAudioBlock",
    { instanceId: created.instanceId, blockId: 2, sampleRate: 48000, channels: [new Array(128).fill(0.1), new Array(128).fill(0.1)] },
    true,
    session
  );
  check(Math.abs(processed.channels[0][0]) > 0.1, "gain at 0.75 boosts the signal (happy path intact)");

  // I. MIDI input is bounded even when the target plugin is not MIDI-capable.
  const tooManyMidiEvents = Array.from({ length: 4097 }, () => ({ type: "noteOn", note: 60, velocity: 0.8 }));
  const midiTooLarge = await request(
    main,
    "sendMidiEvents",
    { instanceId: created.instanceId, events: tooManyMidiEvents },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(midiTooLarge.code === "invalid_argument", "sendMidiEvents rejects oversized MIDI batches");

  const midiBadChannel = await request(
    main,
    "sendMidiEvents",
    { instanceId: created.instanceId, events: [{ type: "noteOn", note: 60, velocity: 0.8, channel: 99 }] },
    true,
    session
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(midiBadChannel.code === "invalid_argument", "sendMidiEvents rejects out-of-range MIDI fields");

  // J. Cross-session instance access is still denied.
  const other = await connect(HOST, PORT, `${HOST}:${PORT}`, ORIGIN);
  const otherPair = await request(other, "pair", { origin: ORIGIN, pairingToken: TOKEN }, false);
  const denied = await request(
    other,
    "setParameter",
    { instanceId: created.instanceId, parameterId: "gain", normalizedValue: 0.2 },
    true,
    otherPair.sessionToken
  ).then(
    () => ({ ok: true }),
    (error) => ({ code: error.code })
  );
  check(denied.code === "instance_access_denied", "another session cannot control this instance");
  other.socket?.destroy();
  main.socket?.destroy();
}

// ---- helpers ----
function waitForListen(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not start")), 8000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        setTimeout(resolve, 150);
      }
    });
    child.on("exit", (code) => reject(new Error(`daemon exited early code=${code}`)));
  });
}

function rawHandshake(host, port, hostHeader, origin) {
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
    const done = (status) => resolve({ status, socket });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n\r\n")) {
        done(buffer.startsWith("HTTP/1.1 101") ? "101" : "rejected");
      }
    });
    socket.on("close", () => done("rejected"));
    socket.on("error", () => done("rejected"));
    setTimeout(() => done("rejected"), 1200);
  });
}

function connect(host, port, hostHeader, origin) {
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
    });
    socket.on("error", () => {});
  });
}

function request(ctx, command, payload, includeSession, sessionToken) {
  const id = `sec-${++seq}`;
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
    }, 3000);
    ctx.socket.on("sb", onMessage);
    ctx.socket.on("close", onClose);
  });
}

async function pairAttempt(ctx, token) {
  if (ctx.closed) return { closed: true };
  try {
    await request(ctx, "pair", { origin: ORIGIN, pairingToken: token }, false);
    return { ok: true };
  } catch (error) {
    if (error.code === "closed" || error.code === "timeout") return { closed: true };
    return { code: error.code };
  }
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
