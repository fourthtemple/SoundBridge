import crypto from "node:crypto";

export function envInteger(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function envList(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function assertLoopbackHost(host, hostEnvName, allowEnvName) {
  if (isLoopbackHost(host) || process.env[allowEnvName] === "1") {
    return;
  }

  console.error(
    `${hostEnvName}=${host} would expose SoundBridge off this machine. ` +
      `Use 127.0.0.1, localhost, or ::1, or set ${allowEnvName}=1 if you are intentionally testing a non-loopback bind.`
  );
  process.exit(1);
}

export function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return false;
  }
  let host = hostHeader.trim();
  const bracketed = host.match(/^\[(.+)\]/);
  if (bracketed) {
    host = bracketed[1];
  } else {
    const lastColon = host.lastIndexOf(":");
    if (lastColon !== -1 && host.indexOf(":") === lastColon) {
      host = host.slice(0, lastColon);
    }
  }
  return isLoopbackHost(host);
}

export function tokenEquals(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function protocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function sendError(send, id, code, message, details) {
  send({
    type: "response",
    id,
    ok: false,
    error: {
      code,
      message,
      details
    }
  });
}

export function createDaemonValidators({ minSampleRate, maxSampleRate, makeProtocolError = protocolError }) {
  function requireIntInRange(value, min, max, label) {
    const number = Math.floor(requestNumber(value));
    if (!Number.isFinite(number) || number < min || number > max) {
      throw makeProtocolError("invalid_argument", `${label} must be an integer in ${min}..${max}.`, {
        value
      });
    }
    return number;
  }

  function requireIntegerInRange(value, min, max, label) {
    const number = requestNumber(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw makeProtocolError("invalid_argument", `${label} must be an integer in ${min}..${max}.`, {
        value
      });
    }
    return number;
  }

  function requireSampleRate(value, label = "sampleRate") {
    const number = requestNumber(value);
    if (!Number.isFinite(number) || number < minSampleRate || number > maxSampleRate) {
      throw makeProtocolError("invalid_argument", `${label} must be a number in ${minSampleRate}..${maxSampleRate} Hz.`, {
        value
      });
    }
    return number;
  }

  function requireNumberInRange(value, min, max, label) {
    const number = requestNumber(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw makeProtocolError("invalid_argument", `${label} must be a number in ${min}..${max}.`, {
        value
      });
    }
    return number;
  }

  function requireBoolean(value, label) {
    if (typeof value !== "boolean") {
      throw makeProtocolError("invalid_argument", `${label} must be a boolean.`, {
        value
      });
    }
    return value;
  }

  function requestNumber(value) {
    if (typeof value !== "number" && typeof value !== "string") {
      return Number.NaN;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      return Number.NaN;
    }
    return Number(value);
  }

  return {
    boundedFrames,
    isPowerOfTwo,
    requireBoolean,
    requireIntInRange,
    requireIntegerInRange,
    requireNumberInRange,
    requireSampleRate
  };
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function boundedFrames(requested, maxBlockSize) {
  const number = Math.floor(Number(requested));
  if (!Number.isFinite(number) || number < 1) {
    return 1;
  }
  return Math.min(number, maxBlockSize);
}
