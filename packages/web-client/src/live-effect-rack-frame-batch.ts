import type { LiveEffectBlockResponse } from "./live-effect-rack-types";
import {
  boundedLatencySamples,
  boundedLiveEffectInteger,
  boundedLiveEffectNumber,
  boundedOptionalNumber,
  liveEffectBlockDurationMs,
  liveEffectNowMs,
  withLiveEffectTimeout
} from "./live-effect-rack-metrics";
import type {
  LiveEffectRackDeadlinePressureSkipOptions,
  LiveEffectRackScheduledBlock,
  LiveEffectRackScheduledFrame,
  LiveEffectRackScheduleOptions
} from "./live-effect-rack-scheduler";
import { shouldSkipLiveEffectDeadlinePressure } from "./live-effect-rack-scheduler";
import { createLiveEffectRackPolicy } from "./live-effect-rack-policy";

const LIVE_EFFECT_FRAME_BATCH_TARGETS = 16;

export interface LiveEffectRackFrameBatchScheduler {
  captureFrame(options?: LiveEffectRackScheduleOptions): LiveEffectRackScheduledFrame;
  scheduleFromFrame(
    frame: LiveEffectRackScheduledFrame,
    channels: ArrayLike<number>[],
    options?: LiveEffectRackScheduleOptions
  ): LiveEffectRackScheduledBlock;
}

export interface LiveEffectRackFrameBatchTargetHealth {
  healthy?: boolean;
  latencySamples?: unknown;
  reportedLatencySamples?: unknown;
}

export interface LiveEffectRackFrameBatchProcessOptions extends LiveEffectRackDeadlinePressureSkipOptions {
  wetMix?: number;
  stageWetMixes?: ArrayLike<number>;
}

export interface LiveEffectRackFrameBatchTarget {
  readonly health?: LiveEffectRackFrameBatchTargetHealth;
  processScheduledBlock(
    scheduled: LiveEffectRackScheduledBlock,
    options?: LiveEffectRackFrameBatchProcessOptions
  ): Promise<LiveEffectBlockResponse>;
}

export interface LiveEffectRackFrameBatchTargetRequest {
  id?: string;
  target: LiveEffectRackFrameBatchTarget;
  channels: ArrayLike<number>[];
  scheduleOptions?: LiveEffectRackScheduleOptions;
  processOptions?: LiveEffectRackFrameBatchProcessOptions;
}

export interface LiveEffectRackFrameBatchOptions extends LiveEffectRackDeadlinePressureSkipOptions {
  frame?: LiveEffectRackScheduledFrame;
  frameOptions?: LiveEffectRackScheduleOptions;
}

export interface LiveEffectRackFrameBatchProcessorOptions {
  scheduler: LiveEffectRackFrameBatchScheduler;
  maxTargets?: number;
  processBudgetMs?: number;
  processTimeoutMs?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  processTimeoutRecoveryBlocks?: number;
  nowMs?: () => number;
}

export interface LivePerformanceFrameBatchProcessorOptions extends LiveEffectRackFrameBatchProcessorOptions {
  sampleRate: number;
  maxBlockSize: number;
  processBudgetBlocks?: number;
  processTimeoutBlocks?: number;
}

export interface LiveEffectRackFrameBatchTargetResult {
  id?: string;
  index: number;
  scheduled: LiveEffectRackScheduledBlock;
  response?: LiveEffectBlockResponse;
  error?: unknown;
  bypassed: boolean;
  dry: boolean;
  skipped: boolean;
  healthy: boolean;
  latencySamples: number;
  reportedLatencySamples: number;
  durationMs: number;
}

export interface LiveEffectRackFrameBatchResult {
  frame: LiveEffectRackScheduledFrame;
  results: LiveEffectRackFrameBatchTargetResult[];
  targetCount: number;
  processedTargets: number;
  skippedTargets: number;
  failedTargets: number;
  dryTargets: number;
  bypassedTargets: number;
  healthy: boolean;
  latencySamples: number;
  reportedLatencySamples: number;
  maxDurationMs: number;
  totalDurationMs: number;
  lastResponseDeadlineLeadMs?: number;
  lastResponseDeadlineLeadBlocks?: number;
  responseJitterBlocks: number;
  responseDeadlineMisses: number;
  processBudgetMs?: number;
  processTimeoutMs?: number;
  processBudgetExceeded: boolean;
  processTimedOut: boolean;
  processBudgetMisses: number;
  processBudgetTripped: boolean;
  processTimeouts: number;
  processTimeoutTripped: boolean;
  recoveryDryBlocks: number;
  timeoutRecoveryDryBlocks: number;
  error?: unknown;
}

export interface LiveEffectRackFrameBatchHealth {
  healthy: boolean;
  targetCount: number;
  processedTargets: number;
  skippedTargets: number;
  failedTargets: number;
  dryTargets: number;
  bypassedTargets: number;
  latencySamples: number;
  reportedLatencySamples: number;
  maxDurationMs: number;
  totalDurationMs: number;
  lastResponseDeadlineLeadMs?: number;
  lastResponseDeadlineLeadBlocks?: number;
  responseJitterBlocks: number;
  responseDeadlineMisses: number;
  processBudgetMs?: number;
  processTimeoutMs?: number;
  processBudgetExceeded: boolean;
  processTimedOut: boolean;
  processBudgetMisses: number;
  processBudgetTripped: boolean;
  processTimeouts: number;
  processTimeoutTripped: boolean;
  recoveryDryBlocks: number;
  timeoutRecoveryDryBlocks: number;
  lastError?: unknown;
}

export class LiveEffectRackFrameBatchProcessor extends EventTarget {
  readonly scheduler: LiveEffectRackFrameBatchScheduler;
  readonly maxTargets: number;
  readonly processBudgetMs: number;
  readonly processTimeoutMs: number;
  readonly maxConsecutiveProcessBudgetMisses: number;
  readonly processBudgetRecoveryBlocks: number;
  readonly processTimeoutRecoveryBlocks: number;
  private readonly nowMs: () => number;
  private processBudgetMisses = 0;
  private processBudgetTripped = false;
  private processTimeouts = 0;
  private processTimeoutTripped = false;
  private recoveryDryBlocks = 0;
  private timeoutRecoveryDryBlocks = 0;
  private lastError?: unknown;
  private lastResult?: LiveEffectRackFrameBatchResult;
  private lastHealthKey = "";
  private lastResponseDeadlineLeadMs?: number;
  private lastResponseDeadlineLeadBlocks?: number;
  private responseDeadlineLeadMinBlocks?: number;
  private responseDeadlineLeadMaxBlocks?: number;
  private responseJitterBlocks = 0;
  private responseDeadlineMisses = 0;

  constructor(options: LiveEffectRackFrameBatchProcessorOptions) {
    super();
    this.scheduler = options.scheduler;
    this.maxTargets = boundedLiveEffectInteger(options.maxTargets, LIVE_EFFECT_FRAME_BATCH_TARGETS, 1, 32);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(
      options.maxConsecutiveProcessBudgetMisses,
      0,
      0,
      1024
    );
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.processTimeoutRecoveryBlocks = boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, 0, 0, 4096);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
  }

  get health(): LiveEffectRackFrameBatchHealth {
    return this.healthFromResult(this.lastResult);
  }

  async process(
    targets: ArrayLike<LiveEffectRackFrameBatchTargetRequest>,
    options: LiveEffectRackFrameBatchOptions = {}
  ): Promise<LiveEffectRackFrameBatchResult> {
    const frame = options.frame ?? this.scheduler.captureFrame(options.frameOptions);
    const targetCount = boundedLiveEffectInteger(targets?.length, 0, 0, this.maxTargets);
    if (shouldSkipLiveEffectDeadlinePressure(frame.deadlinePressure, options)) {
      return this.deadlinePressureDryResult(frame, targets, targetCount);
    }
    if (this.processBudgetTripped || this.processTimeoutTripped) {
      return this.processPressureDryResult(frame, targets, targetCount);
    }
    const startedAt = this.nowMs();
    const processing = Promise.all(
      Array.from({ length: targetCount }, (_unused, index) => this.processTarget(frame, targets[index], index))
    );
    try {
      const results = await withLiveEffectTimeout(processing, this.processTimeoutMs);
      return this.recordProcessBudget(frame, results, this.nowMs() - startedAt);
    } catch (error) {
      processing.catch(() => undefined);
      return this.recordProcessTimeout(frame, targets, targetCount, this.nowMs() - startedAt, error);
    }
  }

  retry(): boolean {
    if (!this.processBudgetTripped && !this.processTimeoutTripped) {
      return false;
    }
    this.processBudgetTripped = false;
    this.processTimeoutTripped = false;
    this.processBudgetMisses = 0;
    this.processTimeouts = 0;
    this.recoveryDryBlocks = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastError = undefined;
    this.lastResult = undefined;
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchHealthChangeIfNeeded();
    return true;
  }

  private async processTarget(
    frame: LiveEffectRackScheduledFrame,
    targetRequest: LiveEffectRackFrameBatchTargetRequest | undefined,
    index: number
  ): Promise<LiveEffectRackFrameBatchTargetResult> {
    const startedAt = this.nowMs();
    const scheduled = this.scheduler.scheduleFromFrame(
      frame,
      targetRequest?.channels ?? [],
      targetRequest?.scheduleOptions
    );
    if (typeof targetRequest?.target?.processScheduledBlock !== "function") {
      return this.targetResult(targetRequest, index, scheduled, undefined, new Error("invalid_frame_batch_target"), this.nowMs() - startedAt);
    }
    try {
      const response = await targetRequest.target.processScheduledBlock(scheduled, targetRequest.processOptions);
      return this.targetResult(targetRequest, index, scheduled, response, undefined, this.nowMs() - startedAt);
    } catch (error) {
      return this.targetResult(targetRequest, index, scheduled, undefined, error, this.nowMs() - startedAt);
    }
  }

  private targetResult(
    targetRequest: LiveEffectRackFrameBatchTargetRequest | undefined,
    index: number,
    scheduled: LiveEffectRackScheduledBlock,
    response: LiveEffectBlockResponse | undefined,
    error: unknown,
    durationMs: number
  ): LiveEffectRackFrameBatchTargetResult {
    const responseLatencySamples = boundedLatencySamples(response?.latencySamples, 0);
    const health = targetRequest?.target.health;
    const reportedLatencySamples = boundedLatencySamples(
      health?.reportedLatencySamples,
      boundedLatencySamples(health?.latencySamples, responseLatencySamples)
    );
    const bypassed = response?.bypassed === true;
    return {
      id: targetRequest?.id,
      index,
      scheduled,
      response,
      error,
      bypassed,
      dry: bypassed,
      skipped: false,
      healthy: error === undefined && response?.healthy !== false && health?.healthy !== false,
      latencySamples: responseLatencySamples,
      reportedLatencySamples,
      durationMs: boundedOptionalNumber(durationMs, 0, 60000) ?? 0
    };
  }

  private dryTargetResult(
    frame: LiveEffectRackScheduledFrame,
    targetRequest: LiveEffectRackFrameBatchTargetRequest | undefined,
    index: number,
    error: unknown,
    renderEngine = "frame-batch-process-budget-exceeded"
  ): LiveEffectRackFrameBatchTargetResult {
    const scheduled = this.scheduler.scheduleFromFrame(
      frame,
      targetRequest?.channels ?? [],
      targetRequest?.scheduleOptions
    );
    const response: LiveEffectBlockResponse = {
      blockId: scheduled.blockId,
      channels: scheduled.request.channels,
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy: false,
      error
    };
    return {
      id: targetRequest?.id,
      index,
      scheduled,
      response,
      error,
      bypassed: true,
      dry: true,
      skipped: true,
      healthy: false,
      latencySamples: 0,
      reportedLatencySamples: 0,
      durationMs: 0
    };
  }

  private deadlinePressureTargetResult(
    frame: LiveEffectRackScheduledFrame,
    targetRequest: LiveEffectRackFrameBatchTargetRequest | undefined,
    index: number
  ): LiveEffectRackFrameBatchTargetResult {
    const scheduled = this.scheduler.scheduleFromFrame(frame, targetRequest?.channels ?? [], targetRequest?.scheduleOptions);
    const health = targetRequest?.target.health;
    const reportedLatencySamples = boundedLatencySamples(health?.reportedLatencySamples, boundedLatencySamples(health?.latencySamples, 0));
    return {
      id: targetRequest?.id,
      index,
      scheduled,
      response: {
        blockId: scheduled.blockId,
        channels: scheduled.request.channels,
        latencySamples: 0,
        tailSamples: 0,
        infiniteTail: false,
        renderEngine: "frame-batch-deadline-pressure",
        bypassed: true,
        healthy: health?.healthy !== false
      },
      bypassed: true,
      dry: true,
      skipped: true,
      healthy: health?.healthy !== false,
      latencySamples: 0,
      reportedLatencySamples,
      durationMs: 0
    };
  }

  private recordProcessBudget(
    frame: LiveEffectRackScheduledFrame,
    results: LiveEffectRackFrameBatchTargetResult[],
    totalDurationMs: number
  ): LiveEffectRackFrameBatchResult {
    const boundedDurationMs = boundedOptionalNumber(totalDurationMs, 0, 60000) ?? 0;
    const processBudgetExceeded = this.processBudgetMs > 0 && boundedDurationMs > this.processBudgetMs;
    this.recordResponseDeadlineLead(results, boundedDurationMs);
    this.processBudgetMisses = processBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    if (
      processBudgetExceeded &&
      this.maxConsecutiveProcessBudgetMisses > 0 &&
      this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses
    ) {
      this.processBudgetTripped = true;
      this.recoveryDryBlocks = 0;
      this.lastError = new Error("frame_batch_process_budget_exceeded");
      const result = this.result(
        frame,
        results.map((result) => this.dryTargetFromScheduledResult(result, this.lastError)),
        boundedDurationMs,
        true,
        false,
        this.lastError
      );
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-exceeded", { detail: { result, health: this.health } }));
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-tripped", { detail: { result, health: this.health } }));
      return result;
    }
    const result = this.result(frame, results, boundedDurationMs, processBudgetExceeded, false, undefined);
    if (processBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-exceeded", { detail: { result, health: this.health } }));
    }
    return result;
  }

  private recordProcessTimeout(
    frame: LiveEffectRackScheduledFrame,
    targets: ArrayLike<LiveEffectRackFrameBatchTargetRequest>,
    targetCount: number,
    totalDurationMs: number,
    error: unknown
  ): LiveEffectRackFrameBatchResult {
    this.processTimeouts = Math.min(1024, this.processTimeouts + 1);
    this.processTimeoutTripped = true;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastError = error;
    const boundedDurationMs = Math.max(
      this.processTimeoutMs,
      boundedOptionalNumber(totalDurationMs, 0, 60000) ?? 0
    );
    const results = Array.from({ length: targetCount }, (_unused, index) =>
      this.dryTargetResult(frame, targets[index], index, error, "frame-batch-process-timeout")
    );
    this.recordResponseDeadlineLead(results, boundedDurationMs);
    const result = this.result(frame, results, boundedDurationMs, false, true, error);
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout", { detail: { result, health: this.health } }));
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout-tripped", { detail: { result, health: this.health } }));
    return result;
  }

  private dryTargetFromScheduledResult(
    result: LiveEffectRackFrameBatchTargetResult,
    error: unknown
  ): LiveEffectRackFrameBatchTargetResult {
    const response: LiveEffectBlockResponse = {
      blockId: result.scheduled.blockId,
      channels: result.scheduled.request.channels,
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine: "frame-batch-process-budget-exceeded",
      bypassed: true,
      healthy: false,
      error
    };
    return {
      ...result,
      response,
      error,
      bypassed: true,
      dry: true,
      skipped: true,
      healthy: false,
      latencySamples: 0,
      reportedLatencySamples: 0
    };
  }

  private processBudgetDryResult(
    frame: LiveEffectRackScheduledFrame,
    targets: ArrayLike<LiveEffectRackFrameBatchTargetRequest>,
    targetCount: number
  ): LiveEffectRackFrameBatchResult {
    return this.processPressureDryResult(frame, targets, targetCount);
  }

  private processPressureDryResult(
    frame: LiveEffectRackScheduledFrame,
    targets: ArrayLike<LiveEffectRackFrameBatchTargetRequest>,
    targetCount: number
  ): LiveEffectRackFrameBatchResult {
    const timeoutActive = this.processTimeoutTripped;
    const error = this.lastError ?? new Error(timeoutActive ? "frame_batch_process_timeout" : "frame_batch_process_budget_exceeded");
    const renderEngine = timeoutActive ? "frame-batch-process-timeout" : "frame-batch-process-budget-exceeded";
    const results = Array.from({ length: targetCount }, (_unused, index) =>
      this.dryTargetResult(frame, targets[index], index, error, renderEngine)
    );
    const result = this.result(frame, results, 0, false, false, error);
    this.maybeRecoverFromProcessBudget();
    this.maybeRecoverFromProcessTimeout();
    return result;
  }

  private deadlinePressureDryResult(
    frame: LiveEffectRackScheduledFrame,
    targets: ArrayLike<LiveEffectRackFrameBatchTargetRequest>,
    targetCount: number
  ): LiveEffectRackFrameBatchResult {
    const results = Array.from({ length: targetCount }, (_unused, index) =>
      this.deadlinePressureTargetResult(frame, targets[index], index)
    );
    const result = this.result(frame, results, 0, false, false, undefined);
    this.dispatchEvent(new CustomEvent("frame-batch-deadline-pressure", { detail: { result, health: this.health } }));
    return result;
  }

  private maybeRecoverFromProcessBudget(): void {
    if (!this.processBudgetTripped || this.processBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processBudgetRecoveryBlocks) {
      return;
    }
    this.processBudgetTripped = false;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
    this.lastError = undefined;
    this.lastResult = undefined;
    this.dispatchEvent(new CustomEvent("frame-batch-process-budget-recovered", { detail: { health: this.health } }));
    this.dispatchHealthChangeIfNeeded();
  }

  private maybeRecoverFromProcessTimeout(): void {
    if (!this.processTimeoutTripped || this.processTimeoutRecoveryBlocks <= 0) {
      return;
    }
    this.timeoutRecoveryDryBlocks = Math.min(4096, this.timeoutRecoveryDryBlocks + 1);
    if (this.timeoutRecoveryDryBlocks < this.processTimeoutRecoveryBlocks) {
      return;
    }
    this.processTimeoutTripped = false;
    this.processTimeouts = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastError = undefined;
    this.lastResult = undefined;
    this.dispatchEvent(new CustomEvent("frame-batch-process-timeout-recovered", { detail: { health: this.health } }));
    this.dispatchHealthChangeIfNeeded();
  }

  private result(
    frame: LiveEffectRackScheduledFrame,
    results: LiveEffectRackFrameBatchTargetResult[],
    totalDurationMs: number,
    processBudgetExceeded: boolean,
    processTimedOut: boolean,
    error: unknown
  ): LiveEffectRackFrameBatchResult {
    const failedTargets = results.filter((result) => result.error !== undefined || result.healthy === false).length;
    const dryTargets = results.filter((result) => result.dry).length;
    const bypassedTargets = results.filter((result) => result.bypassed).length;
    const skippedTargets = results.filter((result) => result.skipped).length;
    const result = {
      frame,
      results,
      targetCount: results.length,
      processedTargets: results.filter((result) => result.response !== undefined && !result.skipped).length,
      skippedTargets,
      failedTargets,
      dryTargets,
      bypassedTargets,
      healthy: failedTargets === 0 && !this.processBudgetTripped && !this.processTimeoutTripped,
      latencySamples: maxLatency(results, "latencySamples"),
      reportedLatencySamples: maxLatency(results, "reportedLatencySamples"),
      maxDurationMs: results.reduce((max, result) => Math.max(max, result.durationMs), 0),
      totalDurationMs: boundedOptionalNumber(totalDurationMs, 0, 60000) ?? 0,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      processBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      processTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined,
      processBudgetExceeded,
      processTimedOut,
      processBudgetMisses: this.processBudgetMisses,
      processBudgetTripped: this.processBudgetTripped,
      processTimeouts: this.processTimeouts,
      processTimeoutTripped: this.processTimeoutTripped,
      recoveryDryBlocks: this.recoveryDryBlocks,
      timeoutRecoveryDryBlocks: this.timeoutRecoveryDryBlocks,
      error
    };
    this.lastResult = result;
    this.dispatchHealthChangeIfNeeded();
    return result;
  }

  private healthFromResult(result: LiveEffectRackFrameBatchResult | undefined): LiveEffectRackFrameBatchHealth {
    const failedTargets = result?.failedTargets ?? 0;
    return {
      healthy: !this.processBudgetTripped && !this.processTimeoutTripped && failedTargets === 0,
      targetCount: result?.targetCount ?? 0,
      processedTargets: result?.processedTargets ?? 0,
      skippedTargets: result?.skippedTargets ?? 0,
      failedTargets,
      dryTargets: result?.dryTargets ?? 0,
      bypassedTargets: result?.bypassedTargets ?? 0,
      latencySamples: boundedLatencySamples(result?.latencySamples, 0),
      reportedLatencySamples: boundedLatencySamples(result?.reportedLatencySamples, 0),
      maxDurationMs: boundedOptionalNumber(result?.maxDurationMs, 0, 60000) ?? 0,
      totalDurationMs: boundedOptionalNumber(result?.totalDurationMs, 0, 60000) ?? 0,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      processBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      processTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined,
      processBudgetExceeded: result?.processBudgetExceeded === true,
      processTimedOut: result?.processTimedOut === true,
      processBudgetMisses: this.processBudgetMisses,
      processBudgetTripped: this.processBudgetTripped,
      processTimeouts: this.processTimeouts,
      processTimeoutTripped: this.processTimeoutTripped,
      recoveryDryBlocks: this.recoveryDryBlocks,
      timeoutRecoveryDryBlocks: this.timeoutRecoveryDryBlocks,
      lastError: this.lastError ?? result?.error
    };
  }

  private dispatchHealthChangeIfNeeded(): void {
    const health = this.health;
    const key = [
      health.healthy,
      health.processBudgetMisses,
      health.processBudgetTripped,
      health.processTimeouts,
      health.processTimeoutTripped,
      health.recoveryDryBlocks,
      health.timeoutRecoveryDryBlocks,
      health.failedTargets,
      health.dryTargets,
      health.skippedTargets,
      health.latencySamples,
      health.reportedLatencySamples,
      health.lastResponseDeadlineLeadBlocks,
      health.responseJitterBlocks,
      health.responseDeadlineMisses
    ].join(":");
    if (key === this.lastHealthKey) {
      return;
    }
    this.lastHealthKey = key;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
  }

  private recordResponseDeadlineLead(results: LiveEffectRackFrameBatchTargetResult[], totalDurationMs: number): void {
    if (this.processBudgetMs <= 0) return;
    const blockDurationMs = frameBatchBlockDurationMs(results);
    this.lastResponseDeadlineLeadMs = boundedOptionalNumber(this.processBudgetMs - totalDurationMs, -60000, 60000);
    this.lastResponseDeadlineLeadBlocks = this.lastResponseDeadlineLeadMs === undefined || blockDurationMs <= 0
      ? undefined
      : Number((this.lastResponseDeadlineLeadMs / blockDurationMs).toFixed(3));
    this.responseDeadlineLeadMinBlocks = Math.min(
      this.responseDeadlineLeadMinBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0,
      this.lastResponseDeadlineLeadBlocks ?? 0
    );
    this.responseDeadlineLeadMaxBlocks = Math.max(
      this.responseDeadlineLeadMaxBlocks ?? this.lastResponseDeadlineLeadBlocks ?? 0,
      this.lastResponseDeadlineLeadBlocks ?? 0
    );
    this.responseJitterBlocks = Number(((this.responseDeadlineLeadMaxBlocks ?? 0) - (this.responseDeadlineLeadMinBlocks ?? 0)).toFixed(3));
    if ((this.lastResponseDeadlineLeadMs ?? 0) < 0) this.responseDeadlineMisses = Math.min(1024, this.responseDeadlineMisses + 1);
  }
}

export function createLiveEffectRackFrameBatchProcessor(
  options: LiveEffectRackFrameBatchProcessorOptions
): LiveEffectRackFrameBatchProcessor {
  return new LiveEffectRackFrameBatchProcessor(options);
}

export function createLivePerformanceFrameBatchProcessorOptions(
  options: LivePerformanceFrameBatchProcessorOptions
): LiveEffectRackFrameBatchProcessorOptions {
  const {
    sampleRate,
    maxBlockSize,
    processBudgetBlocks,
    processTimeoutBlocks,
    ...processorOptions
  } = options;
  const policy = createLiveEffectRackPolicy({
    ...options,
    sampleRate,
    maxBlockSize,
    processBudgetBlocks,
    processTimeoutBlocks
  });
  return {
    ...processorOptions,
    processBudgetMs: policy.processBudgetMs,
    processTimeoutMs: policy.processTimeoutMs,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks
  };
}

export function createLivePerformanceFrameBatchProcessor(
  options: LivePerformanceFrameBatchProcessorOptions
): LiveEffectRackFrameBatchProcessor {
  return createLiveEffectRackFrameBatchProcessor(createLivePerformanceFrameBatchProcessorOptions(options));
}

function maxLatency(results: LiveEffectRackFrameBatchTargetResult[], key: "latencySamples" | "reportedLatencySamples"): number {
  return results.reduce((max, result) => Math.max(max, result[key]), 0);
}

function frameBatchBlockDurationMs(results: LiveEffectRackFrameBatchTargetResult[]): number {
  const firstRate = results.find((result) => result.scheduled.request.sampleRate !== undefined)?.scheduled.request.sampleRate;
  const sampleRate = boundedLiveEffectInteger(firstRate, 48000, 1, 384000);
  const frames = boundedLiveEffectInteger(
    results.reduce((max, result) => Math.max(max, ...result.scheduled.request.channels.map((channel) => channel.length)), 0),
    128,
    1,
    8192
  );
  return liveEffectBlockDurationMs(sampleRate, frames);
}
