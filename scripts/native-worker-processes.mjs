import { spawn } from "node:child_process";
import {
  DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_WORKER_COMMAND_BYTES,
  DEFAULT_MAX_WORKER_DIAGNOSTIC_LOG_CHARS,
  DEFAULT_MAX_WORKER_PENDING_COMMAND_BYTES,
  DEFAULT_MAX_WORKER_PENDING_COMMANDS,
  DEFAULT_MAX_WORKER_STDERR_BYTES,
  DEFAULT_MAX_WORKER_STDERR_LINE_BYTES,
  DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES,
  DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS,
  DEFAULT_WORKER_READY_TIMEOUT_MS,
  DEFAULT_WORKER_TERMINATION_GRACE_MS,
  encodeAudioChannels,
  encodeTransportState,
  encodeWorkerText,
  formatNativeHostName,
  handleWorkerStderr,
  nativeHostWorkerArgs,
  normalizeWorkerCommandLimit,
  normalizeWorkerCommandTimeout,
  normalizeWorkerDiagnosticLogLimit,
  normalizeWorkerFileGrantResult,
  normalizeWorkerRenderChannels,
  normalizeWorkerPendingCommandByteLimit,
  normalizeWorkerPendingCommandLimit,
  normalizeWorkerReadyTimeout,
  normalizeWorkerStderrBudget,
  normalizeWorkerStderrLineLimit,
  normalizeWorkerStdoutLineLimit,
  normalizeWorkerTerminationGrace,
  sanitizeWorkerDiagnosticMessage,
  terminateWorkerProcess,
  workerCommandBytes,
  workerCommandTimeoutError,
  workerCommandTooLargeError,
  workerLineTooLarge,
  workerPendingCommandBytesError,
  workerPendingCommandsError,
  workerProcessError,
  workerReadyHandshakeError,
  workerReadyTimeoutError,
  workerStdoutLineError,
  workerStdoutParseError,
  workerUnexpectedStdoutError
} from "./native-worker-process-support.mjs";

export {
  DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_WORKER_COMMAND_BYTES,
  DEFAULT_MAX_WORKER_DIAGNOSTIC_LOG_CHARS,
  DEFAULT_MAX_WORKER_PENDING_COMMAND_BYTES,
  DEFAULT_MAX_WORKER_PENDING_COMMANDS,
  DEFAULT_MAX_WORKER_STDERR_BYTES,
  DEFAULT_MAX_WORKER_STDERR_LINE_BYTES,
  DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES,
  DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS,
  DEFAULT_WORKER_READY_TIMEOUT_MS,
  DEFAULT_WORKER_TERMINATION_GRACE_MS
};

export function createNativeWorkerProcesses({
  nativeRenderer,
  normalizers,
  maxWorkerStdoutLineBytes = DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES,
  maxWorkerCommandBytes = DEFAULT_MAX_WORKER_COMMAND_BYTES,
  maxWorkerPendingCommandBytes = DEFAULT_MAX_WORKER_PENDING_COMMAND_BYTES,
  maxWorkerStderrLineBytes = DEFAULT_MAX_WORKER_STDERR_LINE_BYTES,
  maxWorkerStderrBytes = DEFAULT_MAX_WORKER_STDERR_BYTES,
  maxWorkerPendingCommands = DEFAULT_MAX_WORKER_PENDING_COMMANDS,
  workerReadyTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS,
  workerTerminationGraceMs = DEFAULT_WORKER_TERMINATION_GRACE_MS,
  exampleWorkerCommandTimeoutMs = DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS,
  nativeWorkerCommandTimeoutMs = DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS,
  maxWorkerDiagnosticLogChars = DEFAULT_MAX_WORKER_DIAGNOSTIC_LOG_CHARS
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
    normalizeVst3ProgramData,
    normalizeVst3NoteExpressions,
    normalizeVst3ProgramLists,
    normalizeWorkerParameter,
    normalizeWorkerParameters,
    normalizeWorkerState
  } = normalizers;
  const workerStdoutLineLimit = normalizeWorkerStdoutLineLimit(maxWorkerStdoutLineBytes);
  const workerCommandLimit = normalizeWorkerCommandLimit(maxWorkerCommandBytes);
  const workerPendingCommandByteLimit = normalizeWorkerPendingCommandByteLimit(maxWorkerPendingCommandBytes);
  const workerStderrLineLimit = normalizeWorkerStderrLineLimit(maxWorkerStderrLineBytes);
  const workerStderrBudget = normalizeWorkerStderrBudget(maxWorkerStderrBytes);
  const workerPendingCommandLimit = normalizeWorkerPendingCommandLimit(maxWorkerPendingCommands);
  const workerDiagnosticLogLimit = normalizeWorkerDiagnosticLogLimit(maxWorkerDiagnosticLogChars);
  const workerReadyTimeout = normalizeWorkerReadyTimeout(workerReadyTimeoutMs);
  const workerTerminationGrace = normalizeWorkerTerminationGrace(workerTerminationGraceMs);
  const exampleCommandTimeout = normalizeWorkerCommandTimeout(exampleWorkerCommandTimeoutMs, DEFAULT_EXAMPLE_WORKER_COMMAND_TIMEOUT_MS);
  const nativeCommandTimeout = normalizeWorkerCommandTimeout(nativeWorkerCommandTimeoutMs, DEFAULT_NATIVE_WORKER_COMMAND_TIMEOUT_MS);

  function requestWorkerQuit(process) {
    const stdin = process?.stdin;
    if (!process || process.killed || !stdin?.writable || stdin.destroyed || stdin.writableEnded) return;
    stdin.once("error", () => {});
    try { stdin.write("quit\n", "utf8", () => {
      if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
    }); } catch {}
  }

  class ExampleInstrumentWorker {
    constructor(executablePath) {
      this.executablePath = executablePath;
      this.renderEngine = "bundle-worker";
      this.pending = [];
      this.pendingCommandBytes = 0;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.maxStdoutLineBytes = workerStdoutLineLimit;
      this.maxCommandBytes = workerCommandLimit;
      this.maxPendingCommandBytes = workerPendingCommandByteLimit;
      this.maxStderrLineBytes = workerStderrLineLimit;
      this.maxStderrBytes = workerStderrBudget;
      this.maxPendingCommands = workerPendingCommandLimit;
      this.maxDiagnosticLogChars = workerDiagnosticLogLimit;
      this.workerTerminationGraceMs = workerTerminationGrace;
      this.commandTimeoutMs = exampleCommandTimeout;
      this.process = spawn(executablePath, ["--worker"], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.process.stdout.setEncoding("utf8");
      this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
      this.process.stderr.setEncoding("utf8");
      this.process.stderr.on("data", (chunk) => handleWorkerStderr(this, chunk, "Example instrument worker"));
      this.process.on("error", (error) => this.rejectAll(workerProcessError(error, this.maxDiagnosticLogChars)));
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

      const command = `render ${request.frames} ${request.sampleRate} ${request.gain} ${request.tone} ${request.detune}`;

      return this.request(command, request.renderTimeoutMs).then((parsed) => {
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

    request(command, timeoutMs = this.commandTimeoutMs) {
      if (!this.process || this.process.killed || !this.process.stdin.writable) {
        return Promise.reject(new Error("worker is not writable"));
      }
      if (this.pending.length >= this.maxPendingCommands) {
        return Promise.reject(workerPendingCommandsError(this.maxPendingCommands));
      }
      const commandBytes = workerCommandBytes(command);
      if (commandBytes > this.maxCommandBytes) {
        return Promise.reject(workerCommandTooLargeError(this.maxCommandBytes));
      }
      if (this.pendingCommandBytes + commandBytes > this.maxPendingCommandBytes) {
        return Promise.reject(workerPendingCommandBytesError(this.maxPendingCommandBytes));
      }

      const commandTimeoutMs = Math.min(normalizeWorkerCommandTimeout(timeoutMs, this.commandTimeoutMs), this.commandTimeoutMs);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.abortWorker(workerCommandTimeoutError(commandTimeoutMs));
        }, commandTimeoutMs);
        this.pending.push({ resolve, reject, timeout, commandBytes });
        this.pendingCommandBytes += commandBytes;
        this.process.stdin.write(`${command}\n`, "utf8", (error) => {
          if (error) {
            clearTimeout(timeout);
            this.removePending(resolve);
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
        this.pendingCommandBytes -= pending.commandBytes;

        clearTimeout(pending.timeout);
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            pending.reject(new Error(sanitizeWorkerDiagnosticMessage(parsed.error, this.maxDiagnosticLogChars)));
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
      this.pendingCommandBytes = 0;
      this.rejectAll(error);
      terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
    }

    removePending(resolve) {
      const index = this.pending.findIndex((pending) => pending.resolve === resolve);
      if (index < 0) {
        return;
      }
      const [pending] = this.pending.splice(index, 1);
      this.pendingCommandBytes -= pending.commandBytes;
    }

    rejectAll(error) {
      for (const pending of this.pending.splice(0)) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pendingCommandBytes = 0;
    }

    destroy() {
      if (!this.process || this.process.killed) {
        return;
      }
      requestWorkerQuit(this.process);
      setTimeout(() => {
        terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
      }, 250).unref?.();
    }
  }

  class NativeHostWorker {
    constructor(nativeHost, instance) {
      this.nativeHost = nativeHost;
      this.fallbackLayout = clonePluginLayout(instance.layout);
      this.outputBusChannelsByIndex = new Array(limits.maxPluginBuses);
      for (const bus of this.fallbackLayout?.outputBusLayouts ?? []) {
        const index = normalizeBusIndex(bus?.index);
        if (index !== undefined && this.outputBusChannelsByIndex[index] === undefined) {
          this.outputBusChannelsByIndex[index] = bus.channels;
        }
      }
      this.renderEngine = nativeHost.renderEngine;
      this.pending = [];
      this.pendingCommandBytes = 0;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.maxStdoutLineBytes = workerStdoutLineLimit;
      this.maxCommandBytes = workerCommandLimit;
      this.maxPendingCommandBytes = workerPendingCommandByteLimit;
      this.maxStderrLineBytes = workerStderrLineLimit;
      this.maxStderrBytes = workerStderrBudget;
      this.maxPendingCommands = workerPendingCommandLimit;
      this.maxDiagnosticLogChars = workerDiagnosticLogLimit;
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
      this.process.on("error", (error) => this.rejectAll(workerProcessError(error, this.maxDiagnosticLogChars)));
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

      const command = `render ${request.frames} ${request.sampleRate} ` +
        `${encodeAudioChannels(request.channels, request.frames)} ` +
        `${encodeAudioBuses(request.inputBuses, request.frames)} ${encodeTransportState(request.transport)}`;

      return this.request(command, request.renderTimeoutMs).then((parsed) => {
        if (!Array.isArray(parsed.channels)) {
          throw new Error("worker returned invalid channels");
        }
        const preferTypedOutput = request.preferTypedOutput === true;
        const channels = normalizeWorkerRenderChannels(
          parsed.channels,
          this.fallbackLayout?.outputChannels ?? limits.maxAudioChannels,
          request.frames,
          limits.maxAudioChannels,
          preferTypedOutput
        );
        return {
          channels,
          outputBuses: normalizeWorkerOutputBuses(parsed.outputBuses, channels, this.outputBusChannelsByIndex, request.frames, preferTypedOutput)
        };
      });
    }

    async sendMidiEvents(events) {
      if (["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        const parsed = await this.request(`midi ${encodeMidiEvents(events, this.nativeHost.format)}`);
        if (parsed.ok !== true || parsed.eventCount !== events.length) {
          throw new Error("worker returned invalid MIDI acknowledgement");
        }
        return {
          accepted: true,
          eventCount: parsed.eventCount
        };
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

    async getVst3NoteExpressions() {
      if (this.nativeHost.format !== "vst3") {
        return [];
      }
      const parsed = await this.request("noteExpressions");
      return normalizeVst3NoteExpressions(parsed.vst3NoteExpressions);
    }

    async getVst3ProgramLists() {
      if (this.nativeHost.format !== "vst3") {
        return [];
      }
      const parsed = await this.request("programLists");
      return normalizeVst3ProgramLists(parsed.vst3ProgramLists);
    }

    async getVst3ProgramData(programListId, programIndex) {
      if (this.nativeHost.format !== "vst3") {
        return undefined;
      }
      const safeProgramListId = normalizeInt(programListId, -2147483648, 2147483647, 0);
      const safeProgramIndex = normalizeInt(programIndex, 0, limits.maxPluginPrograms - 1, 0);
      const parsed = await this.request(`getProgramData ${safeProgramListId} ${safeProgramIndex}`);
      return normalizeVst3ProgramData(parsed.programData);
    }

    async setVst3ProgramData(programListId, programIndex, data) {
      if (this.nativeHost.format !== "vst3") {
        return undefined;
      }
      const programData = normalizeVst3ProgramData({ programListId, programIndex, data });
      if (!programData) {
        return undefined;
      }
      const parsed = await this.request(
        `setProgramData ${programData.programListId} ${programData.programIndex} ${programData.data || "-"}`
      );
      if (parsed.ok !== true) {
        throw new Error("worker returned invalid VST3 program-data restore acknowledgement");
      }
      return parsed;
    }

    async setParameter(parameterId, normalizedValue, sampleOffset = 0) {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return undefined;
      }
      const parsed = await this.request(`setParameter ${encodeWorkerText(parameterId)} ${normalizedValue} ${sampleOffset}`);
      if (!parsed.parameter) {
        return undefined;
      }
      return normalizeWorkerParameter(parsed.parameter);
    }

    async setParameterDisplayValue(parameterId, displayValue) {
      if (!["au", "vst3"].includes(this.nativeHost.format)) {
        return undefined;
      }
      const parsed = await this.request(
        `setParameterDisplayValue ${encodeWorkerText(parameterId)} ${encodeWorkerText(displayValue)}`
      );
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

    async useFileGrant({ grant, operation }) {
      if (!["au", "vst3", "lv2"].includes(this.nativeHost.format)) {
        return undefined;
      }
      const parsed = await this.request([
        "fileGrant",
        operation,
        grant.purpose,
        grant.access,
        grant.kind,
        grant.grantId,
        encodeWorkerText(grant.displayName),
        encodeWorkerText(grant.absolutePath)
      ].join(" "));
      return normalizeWorkerFileGrantResult(parsed);
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

    request(command, timeoutMs = this.commandTimeoutMs) {
      if (!this.process || this.process.killed || !this.process.stdin.writable) {
        return Promise.reject(new Error("worker is not writable"));
      }
      if (this.pending.length >= this.maxPendingCommands) {
        return Promise.reject(workerPendingCommandsError(this.maxPendingCommands));
      }
      const commandBytes = workerCommandBytes(command);
      if (commandBytes > this.maxCommandBytes) {
        return Promise.reject(workerCommandTooLargeError(this.maxCommandBytes));
      }
      if (this.pendingCommandBytes + commandBytes > this.maxPendingCommandBytes) {
        return Promise.reject(workerPendingCommandBytesError(this.maxPendingCommandBytes));
      }

      const commandTimeoutMs = Math.min(normalizeWorkerCommandTimeout(timeoutMs, this.commandTimeoutMs), this.commandTimeoutMs);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.abortWorker(workerCommandTimeoutError(commandTimeoutMs));
        }, commandTimeoutMs);
        this.pending.push({ resolve, reject, timeout, commandBytes });
        this.pendingCommandBytes += commandBytes;
        this.process.stdin.write(`${command}\n`, "utf8", (error) => {
          if (error) {
            clearTimeout(timeout);
            this.removePending(resolve);
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
            this.pendingCommandBytes -= pending.commandBytes;
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
            this.abortWorker(workerReadyHandshakeError(parsed.error ?? "worker did not report ready", this.maxDiagnosticLogChars));
            return;
          }
          continue;
        }

        const pending = this.pending.shift();
        if (!pending) {
          this.abortWorker(workerUnexpectedStdoutError());
          return;
        }
        this.pendingCommandBytes -= pending.commandBytes;

        clearTimeout(pending.timeout);
        if (parsed.error) {
          pending.reject(new Error(sanitizeWorkerDiagnosticMessage(parsed.error, this.maxDiagnosticLogChars)));
        } else {
          pending.resolve(parsed);
        }
      }
    }

    abortWorker(error) {
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stderrBytes = 0;
      this.pendingCommandBytes = 0;
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
      this.pendingCommandBytes = 0;
    }

    removePending(resolve) {
      const index = this.pending.findIndex((pending) => pending.resolve === resolve);
      if (index < 0) {
        return;
      }
      const [pending] = this.pending.splice(index, 1);
      this.pendingCommandBytes -= pending.commandBytes;
    }

    destroy() {
      if (!this.process || this.process.killed) {
        return;
      }
      requestWorkerQuit(this.process);
      setTimeout(() => {
        terminateWorkerProcess(this.process, this.workerTerminationGraceMs);
      }, 250).unref?.();
    }
  }

  function encodeAudioBuses(buses, frames) {
    if (!Array.isArray(buses) || buses.length === 0) {
      return "-";
    }
    const encodedByIndex = new Array(limits.maxPluginBuses);
    const busCount = Math.min(buses.length, limits.maxPluginBuses);
    for (let busPosition = 0; busPosition < busCount; busPosition += 1) {
      const bus = buses[busPosition];
      if (!bus || typeof bus !== "object" || Array.isArray(bus)) continue;
      const index = normalizeBusIndex(bus.index);
      if (index === undefined) continue;
      if (encodedByIndex[index] === undefined) {
        encodedByIndex[index] = encodeAudioChannels(bus.channels, frames);
      }
    }
    let encoded = "";
    for (let index = 0; index < encodedByIndex.length; index += 1) {
      const channels = encodedByIndex[index];
      if (channels === undefined) continue;
      encoded += `${encoded ? ";" : ""}${index}=${channels}`;
    }
    return encoded || "-";
  }

  function normalizeWorkerOutputBuses(value, mainChannels, outputBusChannelsByIndex, frames, preferTypedOutput = false) {
    const mainBus = { index: 0, channels: mainChannels };
    if (!Array.isArray(value) || value.length === 0) {
      return [mainBus];
    }
    let byIndex;
    const busCount = Math.min(value.length, limits.maxPluginBuses);
    for (let busPosition = 0; busPosition < busCount; busPosition += 1) {
      const bus = value[busPosition];
      if (!bus || typeof bus !== "object" || Array.isArray(bus)) continue;
      const index = normalizeBusIndex(bus.index);
      if (index === undefined || index === 0) continue;
      byIndex ??= new Array(limits.maxPluginBuses);
      if (byIndex[index] !== undefined) {
        continue;
      }
      const layoutChannels = outputBusChannelsByIndex[index] ?? limits.maxAudioChannels;
      byIndex[index] = {
        index,
        channels: normalizeWorkerRenderChannels(bus.channels, layoutChannels, frames, limits.maxAudioChannels, preferTypedOutput)
      };
    }
    if (byIndex === undefined) return [mainBus];
    byIndex[0] = mainBus;
    const outputBuses = [];
    for (const bus of byIndex) if (bus !== undefined) outputBuses.push(bus);
    return outputBuses;
  }

  function normalizeBusIndex(value) {
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    if (typeof value === "string" && value.trim().length === 0) return undefined;
    return normalizeInt(value, 0, limits.maxPluginBuses - 1, 0);
  }

  return {
    ExampleInstrumentWorker,
    NativeHostWorker,
    formatNativeHostName
  };
}
