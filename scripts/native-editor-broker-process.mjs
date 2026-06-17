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

export function createConfiguredNativeEditorBroker({ env = process.env, limits = {} } = {}) {
  const executablePath = String(env.SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH ?? "").trim();
  if (!executablePath) {
    return undefined;
  }
  if (!path.isAbsolute(executablePath)) {
    throw new Error("SOUNDBRIDGE_NATIVE_EDITOR_BROKER_PATH must be an absolute executable path.");
  }

  const args = parseBrokerArgs(env.SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS);
  return new NativeEditorBroker({
    args,
    executablePath,
    limits,
    policy: nativeEditorPolicyFromEnv(env)
  });
}

export class NativeEditorBroker {
  constructor({ executablePath, args = [], limits = {}, policy = {} }) {
    this.executablePath = executablePath;
    this.args = args;
    this.limits = normalizeLimits(limits);
    this.policy = normalizePolicy(policy);
  }

  get available() {
    return true;
  }

  get capabilityPolicy() {
    return { ...this.policy };
  }

  async openEditor({ editor, fileGrants = [], instance }) {
    const session = new NativeEditorBrokerSession({
      args: this.args,
      executablePath: this.executablePath,
      limits: this.limits
    });
    try {
      await session.ready;
      const opened = await session.request({
        command: "openEditor",
        editorId: editor.editorId,
        instanceId: instance.instanceId,
        pluginId: instance.pluginId,
        format: instance.format,
        kind: instance.kind,
        sampleRate: instance.sampleRate,
        maxBlockSize: instance.maxBlockSize,
        capabilityPolicy: { ...this.policy },
        fileGrants: normalizeBrokerFileGrants(fileGrants),
        nativeHost: normalizeBrokerNativeHost(instance.nativeHost)
      });
      const normalized = normalizeOpenResponse(opened, this.policy);
      return {
        brokerSession: session,
        brokerSessionId: normalized.brokerSessionId,
        capabilities: normalized.capabilities
      };
    } catch (error) {
      session.destroy();
      throw error;
    }
  }
}

class NativeEditorBrokerSession {
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
      this.abort(new Error(`native_editor_broker_ready_timeout: ${limits.readyTimeoutMs}ms`));
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
      this.rejectAll(new Error(`native_editor_broker_exited: code=${code ?? "none"} signal=${signal ?? "none"}`));
    });
  }

  request(payload) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      return Promise.reject(new Error("native_editor_broker_not_writable"));
    }
    if (this.pending.length >= 1) {
      return Promise.reject(new Error("native_editor_broker_pending_command"));
    }
    const command = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(command, "utf8") > this.limits.maxCommandBytes) {
      return Promise.reject(new Error("native_editor_broker_command_too_large"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.abort(new Error(`native_editor_broker_command_timeout: ${this.limits.commandTimeoutMs}ms`));
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

  async close(editorId) {
    try {
      await this.request({ command: "closeEditor", editorId });
    } catch {
    } finally {
      this.destroy();
    }
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
      this.abort(new Error(`native_editor_broker_stdout_malformed: ${String(error?.message ?? error)}`));
      return;
    }

    if (!this.readySettled) {
      if (parsed.ok === true && parsed.ready === true) {
        this.readySettled = true;
        clearTimeout(this.readyTimeout);
        this.resolveReady(parsed);
      } else {
        this.abort(new Error("native_editor_broker_ready_invalid"));
      }
      return;
    }

    const pending = this.pending.shift();
    if (!pending) {
      this.abort(new Error("native_editor_broker_stdout_unexpected"));
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
        this.abort(new Error("native_editor_broker_stderr_budget_exceeded"));
        return;
      }
      const message = sanitizeDiagnostic(line, this.limits.maxDiagnosticChars);
      if (message) {
        console.warn(`Native editor broker stderr: ${message}`);
      }
    }
  }

  abortIfLineTooLarge(line, limit) {
    if (Buffer.byteLength(line, "utf8") <= limit) {
      return false;
    }
    this.abort(new Error("native_editor_broker_line_too_large"));
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
    throw new Error("SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS must be a JSON array of up to 16 strings.");
  }
  return parsed.map((arg) => {
    if (typeof arg !== "string") {
      throw new Error("SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS must contain only strings.");
    }
    const value = arg;
    if (Buffer.byteLength(value, "utf8") > 4096) {
      throw new Error("SOUNDBRIDGE_NATIVE_EDITOR_BROKER_ARGS contains an oversized argument.");
    }
    return value;
  });
}

function normalizeBrokerCapabilities(capabilities, policy) {
  const value = capabilities && typeof capabilities === "object" ? capabilities : {};
  return {
    parameterEditing: value.parameterEditing === true,
    nativeWindow: true,
    fileDialogs: value.fileDialogs === true && policy.fileDialogs === true,
    clipboard: value.clipboard === true && policy.clipboard === true,
    dragAndDrop: value.dragAndDrop === true && policy.dragAndDrop === true
  };
}

function normalizeOpenResponse(response, policy) {
  if (!response || typeof response !== "object" || response.ok !== true) {
    throw new Error("native_editor_broker_open_invalid");
  }
  const brokerSessionId = requiredSafeText(
    response.brokerSessionId,
    80,
    "native_editor_broker_invalid_session_id"
  );
  return {
    brokerSessionId,
    capabilities: normalizeBrokerCapabilities(response.capabilities, policy)
  };
}

function nativeEditorPolicyFromEnv(env) {
  return {
    fileDialogs: env.SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_FILE_DIALOGS === "1",
    clipboard: env.SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_CLIPBOARD === "1",
    dragAndDrop: env.SOUNDBRIDGE_NATIVE_EDITOR_ALLOW_DRAG_DROP === "1"
  };
}

function normalizePolicy(policy) {
  return {
    fileDialogs: policy.fileDialogs === true,
    clipboard: policy.clipboard === true,
    dragAndDrop: policy.dragAndDrop === true
  };
}

function normalizeBrokerFileGrants(fileGrants) {
  if (!Array.isArray(fileGrants)) {
    return [];
  }
  return fileGrants.slice(0, 64).map((grant) => ({
    grantId: safeText(grant?.grantId, 80),
    purpose: safeText(grant?.purpose, 32),
    access: safeText(grant?.access, 32),
    kind: safeText(grant?.kind, 32),
    displayName: safeText(grant?.displayName, 256),
    absolutePath: safeText(grant?.absolutePath, 4096),
    createdAt: Number.isFinite(Number(grant?.createdAt)) ? Number(grant.createdAt) : 0,
    expiresAt: Number.isFinite(Number(grant?.expiresAt)) ? Number(grant.expiresAt) : 0
  }));
}

function normalizeBrokerNativeHost(nativeHost) {
  if (!nativeHost || typeof nativeHost !== "object") {
    return undefined;
  }
  const format = safeText(nativeHost.format, 16);
  const normalized = {
    format,
    renderEngine: safeText(nativeHost.renderEngine, 32)
  };
  if (format === "vst3" || format === "lv2") {
    normalized.bundlePath = safeText(nativeHost.bundlePath, 4096);
  }
  if (format === "au") {
    normalized.componentType = safeText(nativeHost.componentType, 16);
    normalized.componentSubType = safeText(nativeHost.componentSubType, 16);
    normalized.componentManufacturer = safeText(nativeHost.componentManufacturer, 16);
    normalized.hostProfile = safeText(nativeHost.hostProfile, 64);
  }
  if (format === "lv2") {
    normalized.blockSizeProfile = safeText(nativeHost.blockSizeProfile, 32);
  }
  return normalized;
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

function safeText(value, maxBytes) {
  const text = String(value ?? "");
  let output = "";
  for (const char of text) {
    if (Buffer.byteLength(output + char, "utf8") > maxBytes) {
      break;
    }
    output += char;
  }
  return output;
}

function requiredSafeText(value, maxBytes, errorCode) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(errorCode);
  }
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new Error(errorCode);
    }
  }
  return value;
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
    process.kill();
  } catch {
    return;
  }
  setTimeout(() => {
    if (process.exitCode === null && process.signalCode === null) {
      try {
        process.kill("SIGKILL");
      } catch {}
    }
  }, graceMs).unref?.();
}
