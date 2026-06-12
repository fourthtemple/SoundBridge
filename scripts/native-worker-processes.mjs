import { spawn } from "node:child_process";

export const DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_WORKER_STDERR_LINE_BYTES = 1024 * 1024;
export const DEFAULT_WORKER_READY_TIMEOUT_MS = 5000;
export const DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS = 1500;
export const DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS = 5000;

export function createNativeWorkerProcesses({
  nativeRenderer,
  normalizers,
  maxWorkerStdoutLineBytes = DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES,
  maxWorkerStderrLineBytes = DEFAULT_MAX_WORKER_STDERR_LINE_BYTES,
  workerReadyTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS,
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
  const workerStderrLineLimit = normalizeWorkerStderrLineLimit(maxWorkerStderrLineBytes);
  const workerReadyTimeout = normalizeWorkerReadyTimeout(workerReadyTimeoutMs);
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
      this.maxStdoutLineBytes = workerStdoutLineLimit;
      this.maxStderrLineBytes = workerStderrLineLimit;
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
          continue;
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
          pending.reject(error);
        }
      }
    }

    abortWorker(error) {
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.rejectAll(error);
      killWorkerProcess(this.process);
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
        if (this.process && !this.process.killed) {
          this.process.kill();
        }
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
      this.maxStdoutLineBytes = workerStdoutLineLimit;
      this.maxStderrLineBytes = workerStderrLineLimit;
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
          if (!this.readySettled) {
            this.setReadyError(error);
            continue;
          }
          const pending = this.pending.shift();
          pending?.reject(error);
          continue;
        }

        if (!this.readySettled) {
          if (parsed.ok === true && parsed.ready === true) {
            this.setReadyOk(parsed);
          } else {
            this.setReadyError(new Error(parsed.error ?? "worker did not report ready"));
          }
          continue;
        }

        const pending = this.pending.shift();
        if (!pending) {
          continue;
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
      this.rejectAll(error);
      killWorkerProcess(this.process);
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
        if (this.process && !this.process.killed) {
          this.process.kill();
        }
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

function normalizeWorkerStderrLineLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_MAX_WORKER_STDERR_LINE_BYTES;
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

    const message = rawLine.trim();
    if (message) {
      console.warn(`${label} stderr: ${message}`);
    }
  }
}

function workerStdoutLineError(maxBytes) {
  return new Error(`worker_stdout_too_large: worker stdout line exceeded ${maxBytes} bytes`);
}

function workerStderrLineError(maxBytes) {
  return new Error(`worker_stderr_too_large: worker stderr line exceeded ${maxBytes} bytes`);
}

function workerReadyTimeoutError(timeoutMs) {
  return new Error(`worker_ready_timeout: worker did not report ready within ${timeoutMs}ms`);
}

function workerCommandTimeoutError(timeoutMs) {
  return new Error(`worker_command_timeout: worker command timed out after ${timeoutMs}ms`);
}

function killWorkerProcess(process) {
  if (process && !process.killed) {
    process.kill();
  }
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
