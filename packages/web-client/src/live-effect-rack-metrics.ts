import { SoundBridgeProtocolError } from "./client";

const LIVE_EFFECT_MAX_LATENCY_SAMPLES = 1048576;
export type LiveEffectFailureReason = "processing-error" | "process-timeout";
export type LiveEffectDryReason = LiveEffectFailureReason | "backpressure" | "bypass" | "deadline-pressure" | "destroyed" | "process-budget-exceeded" | "render-budget-exceeded" | "stale-input" | "stale-output" | "state-changed";
export interface RenderDeadlineProtocolErrorLike {
  code: "render_timeout" | "render_quarantined";
  details?: unknown;
}

export interface LiveEffectRackTiming {
  sampleRate: number;
  maxBlockSize: number;
  blockDurationMs: number;
  pluginLatencySamples: number;
  transportLatencySamples: number;
  reportedLatencySamples: number;
  pluginLatencyBlocks: number;
  transportLatencyBlocks: number;
  reportedLatencyBlocks: number;
  pluginLatencyMs: number;
  transportLatencyMs: number;
  reportedLatencyMs: number;
  processBudgetMs: number;
  processBudgetBlocks: number;
  processTimeoutMs: number;
  processTimeoutBlocks: number;
  maxInputAgeMs: number;
  maxInputAgeBlocks: number;
  transitionFadeSamples: number;
  transitionFadeBlocks: number;
}

export function boundedChannelCount(value: number): number {
  const channels = Math.floor(Number(value));
  return Number.isFinite(channels) ? Math.max(1, Math.min(32, channels)) : 2;
}

export function boundedLiveEffectInteger(value: unknown, fallback: number, min: number, max: number): number {
  const integer = Math.floor(Number(value ?? fallback));
  return Number.isFinite(integer) ? Math.max(min, Math.min(max, integer)) : fallback;
}

export function boundedLiveEffectNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function liveEffectBlockDurationMs(sampleRate: number, maxBlockSize: number): number {
  const rate = Number(sampleRate);
  const frames = Number(maxBlockSize);
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(frames) && frames > 0 ? (frames / rate) * 1000 : 0;
}

export function liveEffectBlockFrames(maxBlockSize: number): number {
  const frames = Math.floor(Number(maxBlockSize));
  return Number.isFinite(frames) && frames > 0 ? Math.min(frames, 8192) : 0;
}

export function boundedOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : undefined;
}

export function boundedLatencySamples(value: unknown, fallback: number): number {
  const bounded = boundedOptionalNumber(value, 0, LIVE_EFFECT_MAX_LATENCY_SAMPLES);
  if (bounded !== undefined) {
    return Math.floor(bounded);
  }
  return Math.floor(boundedOptionalNumber(fallback, 0, LIVE_EFFECT_MAX_LATENCY_SAMPLES) ?? 0);
}

export function combinedLatencySamples(pluginLatencySamples: number, transportLatencySamples: number): number {
  return Math.min(LIVE_EFFECT_MAX_LATENCY_SAMPLES, pluginLatencySamples + transportLatencySamples);
}

export function liveEffectLatencyMilliseconds(samples: number, sampleRate: number): number {
  const boundedSamples = boundedLatencySamples(samples, 0);
  const boundedSampleRate = boundedLiveEffectInteger(sampleRate, 48000, 1, 384000);
  return Number(((boundedSamples / boundedSampleRate) * 1000).toFixed(3));
}

export function liveEffectRackTiming(sampleRate: number, maxBlockSize: number, pluginLatencySamples: number, transportLatencySamples: number, reportedLatencySamples: number, processBudgetMs: number, processTimeoutMs: number, maxInputAgeMs: number, transitionFadeSamples: number): LiveEffectRackTiming {
  const rate = boundedLiveEffectInteger(sampleRate, 48000, 1, 384000);
  const frames = liveEffectBlockFrames(maxBlockSize);
  const blockDurationMs = Number(liveEffectBlockDurationMs(rate, frames).toFixed(3));
  const pluginSamples = boundedLatencySamples(pluginLatencySamples, 0);
  const transportSamples = boundedLatencySamples(transportLatencySamples, 0);
  const reportedSamples = boundedLatencySamples(reportedLatencySamples, combinedLatencySamples(pluginSamples, transportSamples));
  const budgetMs = boundedLiveEffectNumber(processBudgetMs, 0, 0, 60000);
  const timeoutMs = boundedLiveEffectNumber(processTimeoutMs, 0, 0, 60000);
  const inputAgeMs = boundedLiveEffectNumber(maxInputAgeMs, 0, 0, 60000);
  const fadeSamples = boundedLiveEffectInteger(transitionFadeSamples, 0, 0, 4096);
  return {
    sampleRate: rate,
    maxBlockSize: frames,
    blockDurationMs,
    pluginLatencySamples: pluginSamples,
    transportLatencySamples: transportSamples,
    reportedLatencySamples: reportedSamples,
    pluginLatencyBlocks: liveEffectBlockUnits(pluginSamples, frames),
    transportLatencyBlocks: liveEffectBlockUnits(transportSamples, frames),
    reportedLatencyBlocks: liveEffectBlockUnits(reportedSamples, frames),
    pluginLatencyMs: liveEffectLatencyMilliseconds(pluginSamples, rate),
    transportLatencyMs: liveEffectLatencyMilliseconds(transportSamples, rate),
    reportedLatencyMs: liveEffectLatencyMilliseconds(reportedSamples, rate),
    processBudgetMs: budgetMs,
    processBudgetBlocks: liveEffectBlockUnits(budgetMs, blockDurationMs),
    processTimeoutMs: timeoutMs,
    processTimeoutBlocks: liveEffectBlockUnits(timeoutMs, blockDurationMs),
    maxInputAgeMs: inputAgeMs,
    maxInputAgeBlocks: liveEffectBlockUnits(inputAgeMs, blockDurationMs),
    transitionFadeSamples: fadeSamples,
    transitionFadeBlocks: liveEffectBlockUnits(fadeSamples, frames)
  };
}

export async function withLiveEffectTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(liveEffectTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function liveEffectFailureReason(error: unknown): LiveEffectFailureReason {
  return (error instanceof Error && error.name === "SoundBridgeLiveEffectTimeout") || isRenderDeadlineProtocolError(error)
    ? "process-timeout"
    : "processing-error";
}

export function liveEffectDryReason(renderEngine: unknown, fallback: unknown): LiveEffectDryReason {
  if (fallback === "processing-error" || fallback === "process-timeout" || fallback === "process-budget-exceeded" || fallback === "render-budget-exceeded" || fallback === "destroyed") return fallback;
  if (renderEngine === "dry-backpressure") return "backpressure";
  if (renderEngine === "dry-deadline-pressure") return "deadline-pressure";
  if (renderEngine === "dry-stale-input") return "stale-input";
  if (renderEngine === "dry-stale-output") return "stale-output";
  return renderEngine === "dry-state-changed" ? "state-changed" : "bypass";
}

export function isRenderDeadlineProtocolError(error: unknown): error is SoundBridgeProtocolError | RenderDeadlineProtocolErrorLike {
  const code = error instanceof SoundBridgeProtocolError ? error.code : typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "render_timeout" || code === "render_quarantined";
}

export function renderDeadlineDetails(error: SoundBridgeProtocolError | RenderDeadlineProtocolErrorLike): Record<string, unknown> {
  return typeof error.details === "object" && error.details !== null ? error.details as Record<string, unknown> : {};
}

export function isRecoverablePressureReason(reason: unknown): boolean {
  return reason === "process-budget-exceeded" || reason === "render-budget-exceeded";
}

export function liveEffectNowMs(): number {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}

function liveEffectBlockUnits(value: number, blockValue: number): number {
  return blockValue > 0 ? Number((value / blockValue).toFixed(3)) : 0;
}

function liveEffectTimeoutError(): Error {
  const error = new Error("process_block_timeout");
  error.name = "SoundBridgeLiveEffectTimeout";
  return error;
}
