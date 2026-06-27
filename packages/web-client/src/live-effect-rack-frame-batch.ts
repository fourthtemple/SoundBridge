import type { LiveEffectBlockResponse } from "./live-effect-rack-types";
import {
  boundedLatencySamples,
  boundedLiveEffectInteger,
  boundedLiveEffectNumber,
  boundedOptionalNumber,
  liveEffectNowMs
} from "./live-effect-rack-metrics";
import type {
  LiveEffectRackDeadlinePressureSkipOptions,
  LiveEffectRackScheduledBlock,
  LiveEffectRackScheduledFrame,
  LiveEffectRackScheduleOptions
} from "./live-effect-rack-scheduler";

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

export interface LiveEffectRackFrameBatchOptions {
  frame?: LiveEffectRackScheduledFrame;
  frameOptions?: LiveEffectRackScheduleOptions;
}

export interface LiveEffectRackFrameBatchProcessorOptions {
  scheduler: LiveEffectRackFrameBatchScheduler;
  maxTargets?: number;
  processBudgetMs?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  nowMs?: () => number;
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
  processBudgetMs?: number;
  processBudgetExceeded: boolean;
  processBudgetMisses: number;
  processBudgetTripped: boolean;
  recoveryDryBlocks: number;
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
  processBudgetMs?: number;
  processBudgetExceeded: boolean;
  processBudgetMisses: number;
  processBudgetTripped: boolean;
  recoveryDryBlocks: number;
  lastError?: unknown;
}

export class LiveEffectRackFrameBatchProcessor extends EventTarget {
  readonly scheduler: LiveEffectRackFrameBatchScheduler;
  readonly maxTargets: number;
  readonly processBudgetMs: number;
  readonly maxConsecutiveProcessBudgetMisses: number;
  readonly processBudgetRecoveryBlocks: number;
  private readonly nowMs: () => number;
  private processBudgetMisses = 0;
  private processBudgetTripped = false;
  private recoveryDryBlocks = 0;
  private lastError?: unknown;
  private lastResult?: LiveEffectRackFrameBatchResult;
  private lastHealthKey = "";

  constructor(options: LiveEffectRackFrameBatchProcessorOptions) {
    super();
    this.scheduler = options.scheduler;
    this.maxTargets = boundedLiveEffectInteger(options.maxTargets, LIVE_EFFECT_FRAME_BATCH_TARGETS, 1, 32);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(
      options.maxConsecutiveProcessBudgetMisses,
      0,
      0,
      1024
    );
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
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
    if (this.processBudgetTripped) {
      return this.processBudgetDryResult(frame, targets, targetCount);
    }
    const startedAt = this.nowMs();
    const results = await Promise.all(
      Array.from({ length: targetCount }, (_unused, index) => this.processTarget(frame, targets[index], index))
    );
    return this.recordProcessBudget(frame, results, this.nowMs() - startedAt);
  }

  retry(): boolean {
    if (!this.processBudgetTripped) {
      return false;
    }
    this.processBudgetTripped = false;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
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
    error: unknown
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
      renderEngine: "frame-batch-process-budget-exceeded",
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

  private recordProcessBudget(
    frame: LiveEffectRackScheduledFrame,
    results: LiveEffectRackFrameBatchTargetResult[],
    totalDurationMs: number
  ): LiveEffectRackFrameBatchResult {
    const boundedDurationMs = boundedOptionalNumber(totalDurationMs, 0, 60000) ?? 0;
    const processBudgetExceeded = this.processBudgetMs > 0 && boundedDurationMs > this.processBudgetMs;
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
        this.lastError
      );
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-exceeded", { detail: { result, health: this.health } }));
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-tripped", { detail: { result, health: this.health } }));
      return result;
    }
    const result = this.result(frame, results, boundedDurationMs, processBudgetExceeded, undefined);
    if (processBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("frame-batch-process-budget-exceeded", { detail: { result, health: this.health } }));
    }
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
    const error = this.lastError ?? new Error("frame_batch_process_budget_exceeded");
    const results = Array.from({ length: targetCount }, (_unused, index) => this.dryTargetResult(frame, targets[index], index, error));
    const result = this.result(frame, results, 0, false, error);
    this.maybeRecoverFromProcessBudget();
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

  private result(
    frame: LiveEffectRackScheduledFrame,
    results: LiveEffectRackFrameBatchTargetResult[],
    totalDurationMs: number,
    processBudgetExceeded: boolean,
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
      healthy: failedTargets === 0 && !this.processBudgetTripped,
      latencySamples: maxLatency(results, "latencySamples"),
      reportedLatencySamples: maxLatency(results, "reportedLatencySamples"),
      maxDurationMs: results.reduce((max, result) => Math.max(max, result.durationMs), 0),
      totalDurationMs: boundedOptionalNumber(totalDurationMs, 0, 60000) ?? 0,
      processBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      processBudgetExceeded,
      processBudgetMisses: this.processBudgetMisses,
      processBudgetTripped: this.processBudgetTripped,
      recoveryDryBlocks: this.recoveryDryBlocks,
      error
    };
    this.lastResult = result;
    this.dispatchHealthChangeIfNeeded();
    return result;
  }

  private healthFromResult(result: LiveEffectRackFrameBatchResult | undefined): LiveEffectRackFrameBatchHealth {
    const failedTargets = result?.failedTargets ?? 0;
    return {
      healthy: !this.processBudgetTripped && failedTargets === 0,
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
      processBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      processBudgetExceeded: result?.processBudgetExceeded === true,
      processBudgetMisses: this.processBudgetMisses,
      processBudgetTripped: this.processBudgetTripped,
      recoveryDryBlocks: this.recoveryDryBlocks,
      lastError: this.lastError ?? result?.error
    };
  }

  private dispatchHealthChangeIfNeeded(): void {
    const health = this.health;
    const key = [
      health.healthy,
      health.processBudgetMisses,
      health.processBudgetTripped,
      health.recoveryDryBlocks,
      health.failedTargets,
      health.dryTargets,
      health.skippedTargets,
      health.latencySamples,
      health.reportedLatencySamples
    ].join(":");
    if (key === this.lastHealthKey) {
      return;
    }
    this.lastHealthKey = key;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
  }
}

export function createLiveEffectRackFrameBatchProcessor(
  options: LiveEffectRackFrameBatchProcessorOptions
): LiveEffectRackFrameBatchProcessor {
  return new LiveEffectRackFrameBatchProcessor(options);
}

function maxLatency(results: LiveEffectRackFrameBatchTargetResult[], key: "latencySamples" | "reportedLatencySamples"): number {
  return results.reduce((max, result) => Math.max(max, result[key]), 0);
}
