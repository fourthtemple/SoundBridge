const MAX_RENDER_DIAGNOSTIC_MS = 60000;
const MAX_RENDER_TIMEOUT_COUNT = 1_000_000;
const WORKER_COMMAND_TIMEOUT_PREFIX = "worker_command_timeout:";

export function renderTimestampMs() {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}

export function boundedRenderDurationMs(startedAt) {
  const elapsed = renderTimestampMs() - startedAt;
  return boundedRenderNumber(elapsed, MAX_RENDER_DIAGNOSTIC_MS);
}

export function renderBudgetDiagnostics(renderDurationMs, frames, sampleRate) {
  const budget = (Number(frames) / Number(sampleRate)) * 1000;
  const renderBudgetMs = boundedRenderNumber(budget, MAX_RENDER_DIAGNOSTIC_MS);
  return { renderBudgetMs, renderBudgetExceeded: renderBudgetMs > 0 && renderDurationMs > renderBudgetMs };
}

export function boundedRenderTimeoutMs(value) {
  const timeout = Math.floor(Number(value));
  return Number.isFinite(timeout) && timeout > 0 ? Math.max(1, Math.min(MAX_RENDER_DIAGNOSTIC_MS, timeout)) : undefined;
}

export function recordRenderSuccess(instance) {
  if (instance) {
    instance.consecutiveRenderTimeouts = 0;
  }
}

export function renderTimeoutProtocolError(instance, error, context, makeProtocolError) {
  if (!isWorkerCommandTimeout(error) || boundedRenderTimeoutMs(context?.renderTimeoutMs) === undefined) {
    return undefined;
  }
  const details = recordRenderTimeout(instance, context);
  return makeProtocolError(
    "render_timeout",
    "Plugin render missed its live deadline; the native worker was terminated.",
    details
  );
}

function recordRenderTimeout(instance, context = {}) {
  if (instance) {
    instance.renderTimeouts = boundedRenderCount((instance.renderTimeouts ?? 0) + 1);
    instance.consecutiveRenderTimeouts = boundedRenderCount((instance.consecutiveRenderTimeouts ?? 0) + 1);
    instance.lastRenderTimeoutMs = boundedRenderTimeoutMs(context.renderTimeoutMs);
  }
  return {
    instanceId: boundedRenderText(instance?.instanceId, 96),
    pluginId: boundedRenderText(instance?.pluginId, 256),
    format: boundedRenderText(instance?.format, 16),
    renderEngine: boundedRenderText(instance?.renderEngine ?? instance?.worker?.renderEngine, 64),
    renderTimeoutMs: boundedRenderTimeoutMs(context.renderTimeoutMs),
    renderTimeouts: boundedRenderCount(instance?.renderTimeouts ?? 1),
    consecutiveRenderTimeouts: boundedRenderCount(instance?.consecutiveRenderTimeouts ?? 1),
    frames: boundedRenderInteger(context.frames, 0, 8192),
    sampleRate: boundedRenderNumber(context.sampleRate, 384000),
    blockId: boundedOptionalRenderInteger(context.blockId),
    workerTerminated: true
  };
}

function isWorkerCommandTimeout(error) {
  return String(error?.message ?? error ?? "").startsWith(WORKER_COMMAND_TIMEOUT_PREFIX);
}

function boundedRenderCount(value) {
  const count = Math.floor(Number(value));
  return Number.isFinite(count) ? Math.max(0, Math.min(MAX_RENDER_TIMEOUT_COUNT, count)) : 0;
}

function boundedRenderInteger(value, min, max) {
  const integer = Math.floor(Number(value));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : min;
}

function boundedOptionalRenderInteger(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return boundedRenderInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function boundedRenderNumber(value, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.round(number * 1000) / 1000)) : 0;
}

function boundedRenderText(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let output = "";
  for (const char of text) {
    if (Buffer.byteLength(output + char, "utf8") > maxBytes) break;
    output += char;
  }
  return output;
}
