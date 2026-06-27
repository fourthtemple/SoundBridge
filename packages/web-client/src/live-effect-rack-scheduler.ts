import type { HostTransportState } from "../../protocol/src/messages";
import type { LiveEffectBlockRequest, LiveEffectRackHealth } from "./live-effect-rack";
import {
  boundedLatencySamples,
  boundedLiveEffectInteger,
  boundedLiveEffectNumber,
  boundedOptionalNumber,
  combinedLatencySamples,
  liveEffectNowMs
} from "./live-effect-rack-metrics";
import type { LiveEffectRackCalibration } from "./live-effect-rack-policy";
import { liveTransportForBlock } from "./live-transport";
import type { LiveTransportBlockOptions } from "./live-transport";

const LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID = 9_007_199_254_740_991;
const LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION = 9_007_199_254_740_991;
const LIVE_EFFECT_SCHEDULER_DEADLINE_LEAD_TARGET_BLOCKS = 1;

export type LiveEffectRackDeadlinePressureReason =
  | "deadline-miss"
  | "dry-output-pressure"
  | "increase-transport-latency"
  | "low-deadline-lead"
  | "response-jitter";

export interface LiveEffectRackDeadlinePressure {
  pressure: boolean;
  reasons: LiveEffectRackDeadlinePressureReason[];
  lastResponseDeadlineLeadBlocks?: number;
  responseJitterBlocks: number;
  responseDeadlineMisses: number;
  responseDeadlineMissesSinceLastUpdate: number;
  transportLatencySamples: number;
  transportLatencyBlocks: number;
}

export interface LiveEffectRackBlockSchedulerOptions {
  sampleRate: number;
  maxBlockSize: number;
  startBlockId?: number;
  startSamplePosition?: number;
  transportLatencySamples?: number;
  maxInputAgeMs?: number;
  compensateOutputLatency?: boolean;
  deadlineLeadTargetBlocks?: number;
  responseJitterThresholdBlocks?: number;
  nowMs?: () => number;
  transport?: Partial<LiveTransportBlockOptions>;
}

export interface LiveEffectRackScheduledBlock {
  request: LiveEffectBlockRequest;
  blockId: number;
  samplePosition?: number;
  timestamp: number;
  captureAgeMs: number;
  stale: boolean;
  deadlinePressure: LiveEffectRackDeadlinePressure;
  transport: HostTransportState;
}

export interface LiveEffectRackScheduleOptions extends Omit<Partial<LiveEffectBlockRequest>, "channels"> {
  transportLatencySamples?: number;
  samplePosition?: number;
  transportOptions?: Partial<LiveTransportBlockOptions>;
}

export interface LiveEffectRackDeadlinePressureHealth {
  lastResponseDeadlineLeadBlocks?: unknown;
  responseJitterBlocks?: unknown;
  responseDeadlineMisses?: unknown;
}

export class LiveEffectRackBlockScheduler {
  readonly sampleRate: number;
  readonly maxBlockSize: number;
  readonly maxInputAgeMs: number;
  readonly compensateOutputLatency: boolean;
  readonly deadlineLeadTargetBlocks: number;
  readonly responseJitterThresholdBlocks: number;
  private readonly nowMs: () => number;
  private readonly baseTransport: Partial<LiveTransportBlockOptions>;
  private nextBlockId: number;
  private nextSamplePosition?: number;
  private transportLatencySamples: number;
  private lastResponseDeadlineLeadBlocks?: number;
  private responseJitterBlocks = 0;
  private responseDeadlineMisses = 0;
  private responseDeadlineMissesSinceLastUpdate = 0;
  private deadlinePressureWarnings: string[] = [];

  constructor(options: LiveEffectRackBlockSchedulerOptions) {
    this.sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
    this.maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
    this.nextBlockId = boundedLiveEffectInteger(options.startBlockId, 0, 0, LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID);
    this.nextSamplePosition = optionalSchedulerInteger(options.startSamplePosition, 0, LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION);
    this.transportLatencySamples = boundedLatencySamples(options.transportLatencySamples, 0);
    this.maxInputAgeMs = boundedLiveEffectNumber(options.maxInputAgeMs, 0, 0, 60000);
    this.compensateOutputLatency = options.compensateOutputLatency !== false;
    this.deadlineLeadTargetBlocks = boundedLiveEffectNumber(
      options.deadlineLeadTargetBlocks,
      LIVE_EFFECT_SCHEDULER_DEADLINE_LEAD_TARGET_BLOCKS,
      0,
      64
    );
    this.responseJitterThresholdBlocks = boundedLiveEffectNumber(options.responseJitterThresholdBlocks, 0, 0, 64);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
    this.baseTransport = { ...options.transport };
  }

  schedule(channels: ArrayLike<number>[], options: LiveEffectRackScheduleOptions = {}): LiveEffectRackScheduledBlock {
    const now = this.nowMs();
    const blockId = boundedLiveEffectInteger(options.blockId, this.nextBlockId, 0, LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID);
    const samplePosition = optionalSchedulerInteger(
      options.samplePosition ?? this.nextSamplePosition,
      0,
      LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION
    );
    const timestamp = finiteSchedulerNumber(options.timestamp, now);
    const transportLatencySamples = boundedLatencySamples(options.transportLatencySamples, this.transportLatencySamples);
    const transport = options.transport ?? liveTransportForBlock({
      ...this.baseTransport,
      ...options.transportOptions,
      sampleRate: options.sampleRate ?? this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      blockId,
      samplePosition,
      reportedLatencySamples: transportLatencySamples,
      compensateOutputLatency: this.compensateOutputLatency
    });
    this.advance(blockId, samplePosition);
    const request: LiveEffectBlockRequest = {
      blockId,
      channels,
      inputBuses: options.inputBuses,
      sampleRate: options.sampleRate ?? this.sampleRate,
      transport,
      timestamp,
      wetMix: options.wetMix
    };
    const captureAgeMs = Math.max(0, now - timestamp);
    return {
      request,
      blockId,
      samplePosition,
      timestamp,
      captureAgeMs,
      stale: this.maxInputAgeMs > 0 && captureAgeMs > this.maxInputAgeMs,
      deadlinePressure: this.deadlinePressureSnapshot(transportLatencySamples),
      transport
    };
  }

  updateLatency(transportLatencySamples: unknown): number {
    this.transportLatencySamples = boundedLatencySamples(transportLatencySamples, this.transportLatencySamples);
    return this.transportLatencySamples;
  }

  updateFromRackHealth(
    health: Pick<LiveEffectRackHealth, "transportLatencySamples"> & LiveEffectRackDeadlinePressureHealth
  ): number {
    this.updateLatency(health.transportLatencySamples);
    this.updateDeadlinePressure(health);
    return this.transportLatencySamples;
  }

  updateFromRackCalibration(
    health: LiveEffectRackDeadlinePressureHealth,
    calibration: Pick<LiveEffectRackCalibration, "recommendedTransportLatencySamples" | "warnings">
  ): number {
    this.updateLatency(calibration.recommendedTransportLatencySamples);
    this.updateDeadlinePressure(health, calibration);
    return this.transportLatencySamples;
  }

  updateFromChainHealth(health: { latencySamples: unknown } & LiveEffectRackDeadlinePressureHealth): number {
    this.updateLatency(health.latencySamples);
    this.updateDeadlinePressure(health);
    return this.transportLatencySamples;
  }

  updateFromChainCalibration(
    health: { latencySamples: unknown } & LiveEffectRackDeadlinePressureHealth,
    calibration: Pick<LiveEffectRackCalibration, "recommendedTransportLatencySamples" | "warnings">
  ): number {
    this.updateLatency(combinedLatencySamples(
      boundedLatencySamples(health.latencySamples, 0),
      boundedLatencySamples(calibration.recommendedTransportLatencySamples, 0)
    ));
    this.updateDeadlinePressure(health, calibration);
    return this.transportLatencySamples;
  }

  updateDeadlinePressureFromHealth(
    health: LiveEffectRackDeadlinePressureHealth,
    calibration?: Pick<LiveEffectRackCalibration, "warnings">
  ): LiveEffectRackDeadlinePressure {
    return this.updateDeadlinePressure(health, calibration);
  }

  reset(options: { nextBlockId?: number; nextSamplePosition?: number } = {}): void {
    this.nextBlockId = boundedLiveEffectInteger(options.nextBlockId, 0, 0, LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID);
    this.nextSamplePosition = optionalSchedulerInteger(options.nextSamplePosition, 0, LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION);
  }

  snapshot(): {
    nextBlockId: number;
    nextSamplePosition?: number;
    transportLatencySamples: number;
    transportLatencyBlocks: number;
    maxInputAgeMs: number;
    deadlineLeadTargetBlocks: number;
    responseJitterThresholdBlocks: number;
    deadlinePressure: LiveEffectRackDeadlinePressure;
  } {
    return {
      nextBlockId: this.nextBlockId,
      nextSamplePosition: this.nextSamplePosition,
      transportLatencySamples: this.transportLatencySamples,
      transportLatencyBlocks: this.transportLatencyBlocks(),
      maxInputAgeMs: this.maxInputAgeMs,
      deadlineLeadTargetBlocks: this.deadlineLeadTargetBlocks,
      responseJitterThresholdBlocks: this.responseJitterThresholdBlocks,
      deadlinePressure: this.deadlinePressureSnapshot()
    };
  }

  private advance(blockId: number, samplePosition?: number): void {
    this.nextBlockId = Math.min(LIVE_EFFECT_SCHEDULER_MAX_BLOCK_ID, blockId + 1);
    if (samplePosition !== undefined) {
      this.nextSamplePosition = Math.min(LIVE_EFFECT_SCHEDULER_MAX_SAMPLE_POSITION, samplePosition + this.maxBlockSize);
    }
  }

  private updateDeadlinePressure(
    health: LiveEffectRackDeadlinePressureHealth,
    calibration?: Pick<LiveEffectRackCalibration, "warnings">
  ): LiveEffectRackDeadlinePressure {
    const lead = boundedOptionalNumber(health.lastResponseDeadlineLeadBlocks, -64, 64);
    const jitter = boundedOptionalNumber(health.responseJitterBlocks, 0, 64);
    if (lead !== undefined) this.lastResponseDeadlineLeadBlocks = lead;
    if (jitter !== undefined) this.responseJitterBlocks = jitter;
    if (health.responseDeadlineMisses !== undefined) {
      const nextMisses = boundedLiveEffectInteger(health.responseDeadlineMisses, this.responseDeadlineMisses, 0, Number.MAX_SAFE_INTEGER);
      this.responseDeadlineMissesSinceLastUpdate = pressureCounterDelta(nextMisses, this.responseDeadlineMisses);
      this.responseDeadlineMisses = nextMisses;
    }
    this.deadlinePressureWarnings = calibration?.warnings?.slice() ?? [];
    return this.deadlinePressureSnapshot();
  }

  private deadlinePressureReasonsForLatency(transportLatencySamples: number): LiveEffectRackDeadlinePressureReason[] {
    const reasons: LiveEffectRackDeadlinePressureReason[] = [];
    const warnings = this.deadlinePressureWarnings;
    if (this.responseDeadlineMissesSinceLastUpdate > 0 || warnings.includes("deadline-miss")) reasons.push("deadline-miss");
    if (this.lastResponseDeadlineLeadBlocks !== undefined && this.lastResponseDeadlineLeadBlocks < this.deadlineLeadTargetBlocks) {
      reasons.push("low-deadline-lead");
    }
    if (this.responseJitterBlocks > this.transportLatencyBlocks(transportLatencySamples) + this.responseJitterThresholdBlocks || warnings.includes("response-jitter")) {
      reasons.push("response-jitter");
    }
    if (warnings.includes("dry-output-pressure")) reasons.push("dry-output-pressure");
    if (warnings.includes("increase-transport-latency")) reasons.push("increase-transport-latency");
    return Array.from(new Set(reasons));
  }

  private deadlinePressureSnapshot(transportLatencySamples = this.transportLatencySamples): LiveEffectRackDeadlinePressure {
    const reasons = this.deadlinePressureReasonsForLatency(transportLatencySamples);
    return {
      pressure: reasons.length > 0,
      reasons,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      responseDeadlineMissesSinceLastUpdate: this.responseDeadlineMissesSinceLastUpdate,
      transportLatencySamples,
      transportLatencyBlocks: this.transportLatencyBlocks(transportLatencySamples)
    };
  }

  private transportLatencyBlocks(transportLatencySamples = this.transportLatencySamples): number {
    return this.maxBlockSize > 0 ? Number((transportLatencySamples / this.maxBlockSize).toFixed(3)) : 0;
  }
}

export function createLiveEffectRackBlockScheduler(options: LiveEffectRackBlockSchedulerOptions): LiveEffectRackBlockScheduler {
  return new LiveEffectRackBlockScheduler(options);
}

function optionalSchedulerInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedLiveEffectInteger(value, 0, min, max);
}

function finiteSchedulerNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pressureCounterDelta(current: number, baseline: number): number {
  return current >= baseline ? current - baseline : current;
}
