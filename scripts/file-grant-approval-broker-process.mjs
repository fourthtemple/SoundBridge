import { spawn } from "node:child_process";
import path from "node:path";
import { redactLocalPaths } from "./local-path-redaction.mjs";

const DEFAULT_MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_COMMAND_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_CHARS = 2048;
const DEFAULT_READY_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_TERMINATION_GRACE_MS = 250;

export function createConfiguredFileGrantApprovalBroker({ env = process.env, limits = {} } = {}) {
  const executablePath = String(env.SOUNDBRIDGE_FILE_GRANT_BROKER_PATH ?? "").trim();
  if (!executablePath) {
    return undefined;
  }
  if (!path.isAbsolute(executablePath)) {
    throw new Error("SOUNDBRIDGE_FILE_GRANT_BROKER_PATH must be an absolute executable path.");
  }

  return new FileGrantApprovalBroker({
    args: parseBrokerArgs(env.SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS),
    executablePath,
    limits
  });
}

export class FileGrantApprovalBroker {
  constructor({ executablePath, args = [], limits = {} }) {
    this.executablePath = executablePath;
    this.args = args;
    this.limits = normalizeLimits(limits);
  }

  get available() {
    return true;
  }

  async requestFileGrant({ request, session }) {
    const brokerSession = new FileGrantApprovalBrokerSession({
      args: this.args,
      executablePath: this.executablePath,
      limits: this.limits
    });
    try {
      await brokerSession.ready;
      const response = await brokerSession.request({
        command: "requestFileGrant",
        origin: session.origin,
        purpose: request.purpose,
        access: request.access,
        kind: request.kind
      });
      if (typeof response.path !== "string" || response.path.length === 0) {
        throw new Error("file_grant_broker_missing_path");
      }
      return {
        path: response.path,
        displayName: typeof response.displayName === "string" ? response.displayName : undefined
      };
    } finally {
      brokerSession.destroy();
    }
  }
}

class FileGrantApprovalBrokerSession {
  constructor({ executablePath, args, limits }) {
    this.pending = [];
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stderrBytes = 0;
    this.limits = limits;
    this.readySettled = false;
    this.process = spawn(executablePath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimeout = setTimeout(() => {
      this.abort(new Error(`file_grant_broker_ready_timeout: ${limits.readyTimeoutMs}ms`));
    }, limits.readyTimeoutMs);
    this.readyTimeout.unref?.();

    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.process.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.process.on("error", (error) => {
      this.rejectAll(new Error(sanitizeDiagnostic(error?.message ?? error, this.limits.maxDiagnosticChars)));
    });
    this.process.on("exit", (code, signal) => {
      this.rejectAll(new Error(`file_grant_broker_exited: code=${code ?? "none"} signal=${signal ?? "none"}`));
    });
  }

  request(payload) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      return Promise.reject(new Error("file_grant_broker_not_writable"));
    }
    if (this.pending.length >= 1) {
      return Promise.reject(new Error("file_grant_broker_pending_command"));
    }
    const command = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(command, "utf8") > this.limits.maxCommandBytes) {
      return Promise.reject(new Error("file_grant_broker_command_too_large"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.abort(new Error(`file_grant_broker_command_timeout: ${this.limits.commandTimeoutMs}ms`));
      }, this.limits.commandTimeoutMs);
      this.pending.push({ resolve, reject, timeout });
      this.process.stdin.write(command, "utf8", (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.shift();
          reject(error);
        }
      });
    });
  }

  destroy() {
    if (!this.process || this.process.killed) {
      return;
    }
    try {
      this.process.stdin.write(`${JSON.stringify({ command: "quit" })}\n`);
      this.process.stdin.end();
    } catch {}
    terminateProcess(this.process, this.limits.terminationGraceMs);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        this.abortIfLineTooLarge(this.stdoutBuffer, this.limits.maxStdoutLineBytes);
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (this.abortIfLineTooLarge(line, this.limits.maxStdoutLineBytes)) {
        return;
      }
      this.handleStdoutLine(line);
    }
  }

  handleStdoutLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line.trim());
    } catch (error) {
      this.abort(new Error(`file_grant_broker_stdout_malformed: ${String(error?.message ?? error)}`));
      return;
    }

    if (!this.readySettled) {
      if (parsed.ok === true && parsed.ready === true) {
        this.readySettled = true;
        clearTimeout(this.readyTimeout);
        this.resolveReady(parsed);
      } else {
        this.abort(new Error("file_grant_broker_ready_invalid"));
      }
      return;
    }

    const pending = this.pending.shift();
    if (!pending) {
      this.abort(new Error("file_grant_broker_stdout_unexpected"));
      return;
    }
    clearTimeout(pending.timeout);
    if (parsed.error) {
      pending.reject(new Error(sanitizeDiagnostic(parsed.error, this.limits.maxDiagnosticChars)));
    } else {
      pending.resolve(parsed);
    }
  }

  handleStderr(chunk) {
    this.stderrBuffer += chunk;
    while (true) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline < 0) {
        this.abortIfLineTooLarge(this.stderrBuffer, this.limits.maxStderrLineBytes);
        return;
      }
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (this.abortIfLineTooLarge(line, this.limits.maxStderrLineBytes)) {
        return;
      }
      this.stderrBytes += Buffer.byteLength(`${line}\n`, "utf8");
      if (this.stderrBytes > this.limits.maxStderrBytes) {
        this.abort(new Error("file_grant_broker_stderr_budget_exceeded"));
        return;
      }
      const message = sanitizeDiagnostic(line, this.limits.maxDiagnosticChars);
      if (message) {
        console.warn(`File grant broker stderr: ${message}`);
      }
    }
  }

  abortIfLineTooLarge(line, limit) {
    if (Buffer.byteLength(line, "utf8") <= limit) {
      return false;
    }
    this.abort(new Error("file_grant_broker_line_too_large"));
    return true;
  }

  abort(error) {
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.rejectAll(error);
    terminateProcess(this.process, this.limits.terminationGraceMs);
  }

  rejectAll(error) {
    if (!this.readySettled) {
      this.readySettled = true;
      clearTimeout(this.readyTimeout);
      this.rejectReady(error);
    }
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

function parseBrokerArgs(rawArgs) {
  if (!rawArgs || !String(rawArgs).trim()) {
    return [];
  }
  const parsed = JSON.parse(String(rawArgs));
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new Error("SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS must be a JSON array of up to 16 strings.");
  }
  return parsed.map((arg) => {
    if (typeof arg !== "string") {
      throw new Error("SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS must contain only strings.");
    }
    const value = arg;
    if (Buffer.byteLength(value, "utf8") > 4096) {
      throw new Error("SOUNDBRIDGE_FILE_GRANT_BROKER_ARGS contains an oversized argument.");
    }
    return value;
  });
}

function normalizeLimits(limits) {
  return {
    maxStdoutLineBytes: positiveInt(limits.maxWorkerStdoutLineBytes, DEFAULT_MAX_STDOUT_LINE_BYTES),
    maxCommandBytes: positiveInt(limits.maxWorkerCommandBytes, DEFAULT_MAX_COMMAND_BYTES),
    maxStderrLineBytes: positiveInt(limits.maxWorkerStderrLineBytes, DEFAULT_MAX_STDERR_LINE_BYTES),
    maxStderrBytes: positiveInt(limits.maxWorkerStderrBytes, DEFAULT_MAX_STDERR_BYTES),
    maxDiagnosticChars: positiveInt(limits.maxWorkerDiagnosticLogChars, DEFAULT_MAX_DIAGNOSTIC_CHARS),
    readyTimeoutMs: positiveInt(limits.workerReadyTimeoutMs, DEFAULT_READY_TIMEOUT_MS),
    commandTimeoutMs: positiveInt(limits.nativeWorkerCommandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
    terminationGraceMs: nonNegativeInt(limits.workerTerminationGraceMs, DEFAULT_TERMINATION_GRACE_MS)
  };
}

function positiveInt(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function sanitizeDiagnostic(value, maxChars) {
  const text = redactLocalPaths(value);
  let sanitized = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    sanitized += codePoint < 0x20 || codePoint === 0x7f
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : char;
    if (sanitized.length > maxChars) {
      return `${sanitized.slice(0, maxChars)}...`;
    }
  }
  return sanitized;
}

function terminateProcess(process, graceMs) {
  if (!process || process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  try {
    process.kill("SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill("SIGKILL");
    } catch {}
  }, graceMs);
  timer.unref?.();
}
