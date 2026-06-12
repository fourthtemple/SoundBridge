import { spawn } from "node:child_process";

export const DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_WORKER_COMMAND_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_WORKER_STDERR_LINE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_WORKER_STDERR_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_WORKER_PENDING_COMMANDS = 64;
export const DEFAULT_WORKER_READY_TIMEOUT_MS = 5000;
export const DEFAULT_WORKER_TERMINATION_GRACE_MS = 250;
export const DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS = 1500;
export const DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS = 5000;

export function createNativeWorkerProcesses({
  nativeRenderer,
  normalizers,
  maxWorkerStdoutLineBytes = DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES,
  maxWorkerCommandBytes = DEFAULT_MAX_WORKER_COMMAND_BYTES,
  maxWorkerStderrLineBytes = DEFAULT_MAX_WORKER_STDERR_LINE_BYTES,
  maxWorkerStderrBytes = DEFAULT_MAX_WORKER_STDERR_BYTES,
  maxWorkerPendingCommands = DEFAULT_MAX_WORKER_PENDING_COMMANDS,
  workerReadyTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS,
  workerTerminationGraceMs = DEFAULT_WORKER_TERMINATION_GRACE_MS,
  exampleWorkerCommandTimeoutMs = DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS,
  nativeWorkerCommandTimeoutMs = DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS
}) {
  const {
    clonePluginLayout,
    encodeMidiEvents,
    limits,
    normalizeInt,
    normalizeLatencySamples,
    normalizeNativeState,
    normalizePluginLayout,
    normalizeTailReport,
    normalizeWorkerParameter,
    normalizeWorkerParameters,
    normalizeWorkerState
  } = normalizers;
  const workerStdoutLineLimit = normalizeWorkerStdoutLineLimit(maxWorkerStdoutLineBytes);
  const workerCommandLimit = normalizeWorkerCommandLimit(maxWorkerCommandBytes);
  const workerStderrLineLimit = normalizeWorkerStderrLineLimit(maxWorkerStderrLineBytes);
  const workerStderrBudget = normalizeWorkerStderrBudget(maxWorkerStderrBytes);
  const workerPendingCommandLimit = normalizeWorkerPendingCommandLimit(maxWorkerPendingCommands);
  const workerReadyTimeout = normalizeWorkerReadyTimeout(workerReadyTimeoutMs);
  const workerTerminationGrace = normalizeWorkerTerminationGrace(workerTerminationGraceMs);
  const exampleCommandTimeout = normalizeWorkerCommandTimeout(
    exampleWorkerCommandTimeoutMs,
    DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS
  );
  const nativeCommandTimeout = normalizeWorkerCommandTimeout(
    nativeWorkerCommandTimeoutMs,
    DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS
  );

  class ExampleInstrumentWorker {
    constructor(executablePath) {
      this.executablePath = executablePath;
      this.renderEngine = "bundle-worker";
      this.pending = [];
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.maxStdoutLineBytes = workerStdoutLineLimit;
      this.maxCommandBytes = workerCommandLimit;
      this.maxStderrLineBytes = workerStderrLineLimit;
      this.maxStderrBytes = workerStderrBudget;
      this.maxPendingCommands = workerPendingCommandLimit;
      this.workerTerminationGraceMs = workerTerminationGrace;
      this.commandTimeoutMs = exampleCommandTimeout;
      this.process = spawn(executablePath, ["--worker"], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.process.stdout.setEncoding("utf8");
      this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
      this.process.stderr.setEncoding("utf8");
      this.process.stderr.on("data", (chunk) => handleWorkerStderr(this, chunk, "Example instrument worker"));
      this.process.on("error", (error) => this.rejectAll(error));
      this.process.on("exit", (code, signal) => {
        if (this.pending.length > 0) {
          this.rejectAll(new Error(`worker exited code=${code ?? "none"} signal=${signal ?? "none"}`));
        }
      });
    }

    render(request) {
      if (!this.process || this.process.killed || !this.process.stdin.writable) {
        return Promise.reject(new Error("worker is not writable"));
      }

      const command = [
        "render",
        request.frames,
        request.sampleRate,
        request.gain,
        request.tone,
        request.detune
      ].join(" ");

      return this.request(command).then((parsed) => {
        if (!Array.isArray(parsed.channels)) {
          throw new Error("worker returned invalid channels");
        }
        return parsed.channels;
      });
    }

    async sendMidiEvents(events) {
      for (const event of events) {
        if (event.type === "noteOn" && event.velocity > 0) {
          await this.request(`noteOn ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
        } else if (event.type === "noteOff" || event.type === "noteOn") {
          await this.request(`noteOff ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
        }
      }
    }

    request(command) {
      if (!this.process || this.process.killed || !this.process.stdin.writable) {
        return Promise.reject(new Error("worker is not writable"));
      }
      if (this.pending.length >= this.maxPendingCommands) {
        return Promise.reject(workerPendingCommandsError(this.maxPendingCommands));
      }
      if (workerLineTooLarge(command, this.maxCommandBytes)) {
        return Promise.reject(workerCommandTooLargeError(this.maxCommandBytes));
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.abortWorker(workerCommandTimeoutError(this.commandTimeoutMs));
        }, this.commandTimeoutMs);
        this.pending.push({ resolve, reject, timeout });
        this.process.stdin.write(`${command}\n`, "utf8", (error) => {
          if (error) {
            clearTimeout(timeout);
            this.pending = this.pending.filter((pending) => pending.resolve !== resolve);
            reject(error);
          }
        });
      });
    }

    handleStdout(chunk) {
      this.stdoutBuffer += chunk;
      while (true) {
        const newline = this.stdoutBuffer.indexOf("\n");
        if (newline < 0) {
          if (workerLineTooLarge(this.stdoutBuffer, this.maxStdoutLineBytes)) {
            this.abortWorker(workerStdoutLineError(this.maxStdoutLineBytes));
          }
          return;
        }

        const rawLine = this.stdoutBuffer.slice(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (workerLineTooLarge(rawLine, this.maxStdoutLineBytes)) {
          this.abortWorker(workerStdoutLineError(this.maxStdoutLineBytes));
          return;
        }
        const line = rawLine.trim();
        const pending = this.pending.shift();
        if (!pending) {
          this.abortWorker(workerUnexpectedStdoutError());
          return;
        }

        clearTimeout(pending.timeout);
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            pending.reject(new Error(parsed.error));
          } else {
            pending.resolve(parsed);
          }
        } catch (error) {
          const protocolError = workerStdoutParseError(error);
          pending.reject(protocolError);
          this.abortWorker(protocolError);
          return;
        }
      }
    }

    abortWorker(error) {
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.rejectAll(error);
      terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
    }

    rejectAll(error) {
      for (const pending of this.pending.splice(0)) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
    }

    destroy() {
      if (!this.process || this.process.killed) {
        return;
      }
      try {
        this.process.stdin.write("quit\n");
        this.process.stdin.end();
      } catch {}
      setTimeout(() => {
        terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
      }, 250).unref?.();
    }
  }

  class NativeHostWorker {
    constructor(nativeHost, instance) {
      this.nativeHost = nativeHost;
      this.fallbackLayout = clonePluginLayout(instance.layout);
      this.renderEngine = nativeHost.renderEngine;
      this.pending = [];
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.maxStdoutLineBytes = workerStdoutLineLimit;
      this.maxCommandBytes = workerCommandLimit;
      this.maxStderrLineBytes = workerStderrLineLimit;
      this.maxStderrBytes = workerStderrBudget;
      this.maxPendingCommands = workerPendingCommandLimit;
      this.workerTerminationGraceMs = workerTerminationGrace;
      this.commandTimeoutMs = nativeCommandTimeout;
      this.readySettled = false;
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.readyTimeout = setTimeout(() => {
        this.abortWorker(workerReadyTimeoutError(workerReadyTimeout));
      }, workerReadyTimeout);
      this.readyTimeout.unref?.();

      this.process = spawn(nativeRenderer, nativeHostWorkerArgs(nativeHost, instance), {
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.process.stdout.setEncoding("utf8");
      this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
      this.process.stderr.setEncoding("utf8");
      this.process.stderr.on("data", (chunk) => handleWorkerStderr(this, chunk, "Native host worker"));
      this.process.on("error", (error) => this.rejectAll(error));
      this.process.on("exit", (code, signal) => {
        const error = new Error(`worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
        if (!this.readySettled) {
          this.setReadyError(error);
        }
        if (this.pending.length > 0) {
          this.rejectAll(error);
        }
      });
    }

    render(request) {
      if (!this.process || this.process.killed || !this.process.stdin.writable) {
        return Promise.reject(new Error("worker is not writable"));
      }

      const command = [
        "render",
        request.frames,
        request.sampleRate,
        encodeAudioChannels(request.channels, request.frames),
        encodeAudioBuses(request.inputBuses, request.frames),
        encodeTransportState(request.transport)
      ].join(" ");

      return this.request(command).then((parsed) => {
        if (!Array.isArray(parsed.channels)) {
          throw new Error("worker returned invalid channels");
        }
        return {
          channels: parsed.channels,
          outputBuses: Array.isArray(parsed.outputBuses) ? parsed.outputBuses : undefined
        };
      });
    }

    async sendMidiEvents(events) {
      if (["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        await this.request(`midi ${encodeMidiEvents(events)}`);
        return;
      }

      for (const event of events) {
        if (event.type === "noteOn" && event.velocity > 0) {
          await this.request(`noteOn ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
        } else if (event.type === "noteOff" || event.type === "noteOn") {
          await this.request(`noteOff ${event.note} ${event.velocity} ${event.channel} ${event.time}`);
        }
      }
    }

    async getParameters() {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return [];
      }
      const parsed = await this.request("parameters");
      return normalizeWorkerParameters(parsed.parameters);
    }

    async setParameter(parameterId, normalizedValue, sampleOffset = 0) {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return undefined;
      }
      const parsed = await this.request(`setParameter ${parameterId} ${normalizedValue} ${sampleOffset}`);
      if (!parsed.parameter) {
        return undefined;
      }
      return normalizeWorkerParameter(parsed.parameter);
    }

    async getState() {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return undefined;
      }
      const parsed = await this.request("getState");
      return normalizeWorkerState(this.nativeHost.format, parsed.state);
    }

    async setState(nativeState) {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return undefined;
      }
      const state = normalizeNativeState(nativeState, this.nativeHost.format);
      if (!state) {
        return undefined;
      }
      if (this.nativeHost.format === "au" || this.nativeHost.format === "lv2") {
        return this.request(`setState ${state.state || "-"}`);
      }
      return this.request(`setState ${state.component || "-"} ${state.controller || "-"}`);
    }

    async getLatency() {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return 0;
      }
      const parsed = await this.request("latency");
      return normalizeLatencySamples(parsed.latencySamples);
    }

    async getTailTime() {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return { tailSamples: 0, infiniteTail: false };
      }
      const parsed = await this.request("tail");
      return normalizeTailReport(parsed);
    }

    async getLayout() {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return clonePluginLayout(this.fallbackLayout);
      }
      const parsed = await this.request("layout");
      return normalizePluginLayout(parsed, this.fallbackLayout);
    }

    request(command) {
      if (!this.process || this.process.killed || !this.process.stdin.writable) {
        return Promise.reject(new Error("worker is not writable"));
      }
      if (this.pending.length >= this.maxPendingCommands) {
        return Promise.reject(workerPendingCommandsError(this.maxPendingCommands));
      }
      if (workerLineTooLarge(command, this.maxCommandBytes)) {
        return Promise.reject(workerCommandTooLargeError(this.maxCommandBytes));
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.abortWorker(workerCommandTimeoutError(this.commandTimeoutMs));
        }, this.commandTimeoutMs);
        this.pending.push({ resolve, reject, timeout });
        this.process.stdin.write(`${command}\n`, "utf8", (error) => {
          if (error) {
            clearTimeout(timeout);
            this.pending = this.pending.filter((pending) => pending.resolve !== resolve);
            reject(error);
          }
        });
      });
    }

    handleStdout(chunk) {
      this.stdoutBuffer += chunk;
      while (true) {
        const newline = this.stdoutBuffer.indexOf("\n");
        if (newline < 0) {
          if (workerLineTooLarge(this.stdoutBuffer, this.maxStdoutLineBytes)) {
            this.abortWorker(workerStdoutLineError(this.maxStdoutLineBytes));
          }
          return;
        }

        const rawLine = this.stdoutBuffer.slice(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (workerLineTooLarge(rawLine, this.maxStdoutLineBytes)) {
          this.abortWorker(workerStdoutLineError(this.maxStdoutLineBytes));
          return;
        }
        const line = rawLine.trim();
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const protocolError = workerStdoutParseError(error);
          const pending = this.pending.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(protocolError);
          }
          this.abortWorker(protocolError);
          return;
        }

        if (!this.readySettled) {
          if (parsed.ok === true && parsed.ready === true) {
            this.setReadyOk(parsed);
          } else {
            this.abortWorker(workerReadyHandshakeError(parsed.error ?? "worker did not report ready"));
            return;
          }
          continue;
        }

        const pending = this.pending.shift();
        if (!pending) {
          this.abortWorker(workerUnexpectedStdoutError());
          return;
        }

        clearTimeout(pending.timeout);
        if (parsed.error) {
          pending.reject(new Error(parsed.error));
        } else {
          pending.resolve(parsed);
        }
      }
    }

    abortWorker(error) {
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.rejectAll(error);
      terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
    }

    setReadyOk(payload) {
      if (this.readySettled) {
        return;
      }
      this.readySettled = true;
      clearTimeout(this.readyTimeout);
      this.resolveReady(payload);
    }

    setReadyError(error) {
      if (this.readySettled) {
        return;
      }
      this.readySettled = true;
      clearTimeout(this.readyTimeout);
      this.rejectReady(error);
    }

    rejectAll(error) {
      this.setReadyError(error);
      for (const pending of this.pending.splice(0)) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
    }

    destroy() {
      if (!this.process || this.process.killed) {
        return;
      }
      try {
        this.process.stdin.write("quit\n");
        this.process.stdin.end();
      } catch {}
      setTimeout(() => {
        terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
      }, 250).unref?.();
    }
  }

  function encodeAudioBuses(buses, frames) {
    if (!Array.isArray(buses) || buses.length === 0) {
      return "-";
    }
    const encoded = buses
      .slice(0, limits.maxPluginBuses)
      .map((bus) => `${normalizeInt(bus?.index, 0, limits.maxPluginBuses - 1, 0)}=${encodeAudioChannels(bus?.channels, frames)}`)
      .join(";");
    return encoded || "-";
  }

  return {
    ExampleInstrumentWorker,
    NativeHostWorker,
    formatNativeHostName
  };
}

function encodeAudioChannels(channels, frames) {
  if (!Array.isArray(channels) || channels.length === 0) {
    return "-";
  }

  return channels
    .map((channel) => {
      const samples = Array.from({ length: frames }, (_, frame) => {
        const value = Number(Array.isArray(channel) ? channel[frame] : 0);
        return Number.isFinite(value) ? String(Math.max(-1, Math.min(1, value))) : "0";
      });
      return samples.join(",");
    })
    .join("|");
}

function normalizeWorkerStdoutLineLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES;
  }
  return number;
}

function normalizeWorkerCommandLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_WORKER_COMMAND_BYTES;
  }
  return number;
}

function normalizeWorkerStderrLineLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_WORKER_STDERR_LINE_BYTES;
  }
  return number;
}

function normalizeWorkerStderrBudget(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_WORKER_STDERR_BYTES;
  }
  return number;
}

function normalizeWorkerPendingCommandLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_WORKER_PENDING_COMMANDS;
  }
  return number;
}

function normalizeWorkerReadyTimeout(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_WORKER_READY_TIMEOUT_MS;
  }
  return number;
}

function normalizeWorkerTerminationGrace(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) {
    return DEFAULT_WORKER_TERMINATION_GRACE_MS;
  }
  return number;
}

function normalizeWorkerCommandTimeout(value, fallback) {
  const fallbackNumber = Math.floor(Number(fallback));
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? fallbackNumber
      : DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS;
  }
  return number;
}

function workerLineTooLarge(line, maxBytes) {
  return Buffer.byteLength(line, "utf8") > maxBytes;
}

function handleWorkerStderr(worker, chunk, label) {
  worker.stderrBuffer += chunk;
  while (true) {
    const newline = worker.stderrBuffer.indexOf("\n");
    if (newline < 0) {
      if (workerLineTooLarge(worker.stderrBuffer, worker.maxStderrLineBytes)) {
        worker.abortWorker(workerStderrLineError(worker.maxStderrLineBytes));
      }
      return;
    }

    const rawLine = worker.stderrBuffer.slice(0, newline);
    worker.stderrBuffer = worker.stderrBuffer.slice(newline + 1);
    if (workerLineTooLarge(rawLine, worker.maxStderrLineBytes)) {
      worker.abortWorker(workerStderrLineError(worker.maxStderrLineBytes));
      return;
    }
    if (!accountWorkerStderr(worker, `${rawLine}\n`)) {
      return;
    }

    const message = rawLine.trim();
    if (message) {
      console.warn(`${label} stderr: ${message}`);
    }
  }
}

function accountWorkerStderr(worker, rawText) {
  worker.stderrBytes += Buffer.byteLength(rawText, "utf8");
  if (worker.stderrBytes > worker.maxStderrBytes) {
    worker.abortWorker(workerStderrBudgetError(worker.maxStderrBytes));
    return false;
  }
  return true;
}

function workerStdoutLineError(maxBytes) {
  return new Error(`worker_stdout_too_large: worker stdout line exceeded ${maxBytes} bytes`);
}

function workerCommandTooLargeError(maxBytes) {
  return new Error(`worker_command_too_large: worker command exceeded ${maxBytes} bytes`);
}

function workerStdoutParseError(error) {
  return new Error(`worker_stdout_malformed: worker stdout was not valid JSON (${String(error?.message ?? error)})`);
}

function workerUnexpectedStdoutError() {
  return new Error("worker_stdout_unexpected: worker emitted stdout without a pending command");
}

function workerStderrLineError(maxBytes) {
  return new Error(`worker_stderr_too_large: worker stderr line exceeded ${maxBytes} bytes`);
}

function workerStderrBudgetError(maxBytes) {
  return new Error(`worker_stderr_budget_exceeded: worker stderr exceeded ${maxBytes} bytes`);
}

function workerReadyTimeoutError(timeoutMs) {
  return new Error(`worker_ready_timeout: worker did not report ready within ${timeoutMs}ms`);
}

function workerReadyHandshakeError(message) {
  return new Error(`worker_ready_invalid: ${message}`);
}

function workerPendingCommandsError(maxCommands) {
  return new Error(`worker_pending_commands_exceeded: worker has ${maxCommands} pending commands`);
}

function workerCommandTimeoutError(timeoutMs) {
  return new Error(`worker_command_timeout: worker command timed out after ${timeoutMs}ms`);
}

function terminateWorkerProcess(process, graceMs) {
  if (!process || workerProcessExited(process)) {
    return;
  }
  try {
    process.kill();
  } catch {
    return;
  }
  setTimeout(() => {
    if (!workerProcessExited(process)) {
      try {
        process.kill("SIGKILL");
      } catch {}
    }
  }, graceMs).unref?.();
}

function workerProcessExited(process) {
  return process.exitCode !== null || process.signalCode !== null;
}

function encodeTransportState(transport) {
  if (!transport || typeof transport !== "object") {
    return "-";
  }
  const parts = [];
  const addBoolean = (encodedName, property) => {
    if (Object.hasOwn(transport, property)) {
      parts.push(`${encodedName}=${transport[property] ? "1" : "0"}`);
    }
  };
  const addNumber = (encodedName, property) => {
    if (Object.hasOwn(transport, property)) {
      parts.push(`${encodedName}=${Number(transport[property])}`);
    }
  };

  addBoolean("playing", "playing");
  addBoolean("recording", "recording");
  addBoolean("loop", "loopActive");
  addNumber("tempo", "tempo");
  addNumber("num", "timeSignatureNumerator");
  addNumber("den", "timeSignatureDenominator");
  addNumber("ppq", "projectTimeMusic");
  addNumber("bar", "barPositionMusic");
  addNumber("cycleStart", "cycleStartMusic");
  addNumber("cycleEnd", "cycleEndMusic");
  addNumber("sample", "samplePosition");
  return parts.length > 0 ? parts.join(",") : "-";
}

function nativeHostWorkerArgs(nativeHost, instance) {
  const common = [
    String(instance.sampleRate),
    String(instance.maxBlockSize),
    String(instance.inputChannels),
    String(instance.outputChannels),
    String(instance.kind ?? "unknown")
  ];

  if (nativeHost.format === "au") {
    return [
      "--host-au-worker",
      nativeHost.componentType,
      nativeHost.componentSubType,
      nativeHost.componentManufacturer,
      ...common
    ];
  }

  if (nativeHost.format === "vst3") {
    return [
      "--host-vst3-worker",
      nativeHost.bundlePath,
      ...common
    ];
  }

  if (nativeHost.format === "lv2") {
    return [
      "--host-lv2-worker",
      nativeHost.bundlePath,
      ...common
    ];
  }

  throw new Error(`Unsupported native host format: ${nativeHost.format}`);
}

function formatNativeHostName(format) {
  switch (format) {
    case "au":
      return "Audio Unit";
    case "vst3":
      return "VST3";
    case "lv2":
      return "LV2";
    default:
      return String(format ?? "native");
  }
}
