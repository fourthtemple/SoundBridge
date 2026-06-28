import type { LiveEffectBlockRequest, LiveEffectBlockResponse, LiveEffectRackHealth } from "./live-effect-rack";
import { boundedLiveEffectChannels, dryChannels, outputTail, transitionOutputChannels, wetMixedChannels } from "./live-effect-rack-audio";
import { boundedLatencySamples, boundedLiveEffectInteger, boundedLiveEffectNumber, boundedOptionalNumber, liveEffectLatencyMilliseconds, liveEffectNowMs, liveEffectRackTiming, withLiveEffectTimeout } from "./live-effect-rack-metrics";
import type { LiveEffectRackTiming } from "./live-effect-rack-metrics";
import { createLiveEffectRackPolicy } from "./live-effect-rack-policy";
import { boundedFailedStageIndex, boundedWetMix, chainDryReason, isChainTimeoutError, isIntentionalChainBypassResponse, stageErrorResult, stageResult, stageWetMix } from "./live-effect-rack-chain-utils";
import { shouldSkipLiveEffectDeadlinePressure } from "./live-effect-rack-scheduler";
import type { LiveEffectRackDeadlinePressure, LiveEffectRackDeadlinePressureSkipOptions, LiveEffectRackScheduledBlock } from "./live-effect-rack-scheduler";

const LIVE_EFFECT_CHAIN_MAX_STAGES = 16;

export type LiveEffectRackChainDryReason =
  | "chain-bypass"
  | "chain-deadline-pressure"
  | "chain-empty"
  | "chain-process-budget-exceeded"
  | "chain-process-timeout"
  | "chain-stage-bypass"
  | "chain-stage-error"
  | "chain-stale-input";

export interface LiveEffectRackChainStage {
  readonly health?: Partial<LiveEffectRackHealth>;
  processBlock(request: LiveEffectBlockRequest): Promise<LiveEffectBlockResponse>;
}

export interface LiveEffectRackChainOptions {
  stages: ArrayLike<LiveEffectRackChainStage>;
  bypassed?: boolean;
  wetMix?: number;
  sampleRate?: number;
  maxStages?: number;
  outputChannels?: number;
  maxBlockSize?: number;
  processBudgetMs?: number;
  processTimeoutMs?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  processTimeoutRecoveryBlocks?: number;
  transitionFadeSamples?: number;
  nowMs?: () => number;
}

export interface LivePerformanceRackChainOptions extends LiveEffectRackChainOptions {
  processBudgetBlocks?: number;
  processTimeoutBlocks?: number;
  transitionFadeBlocks?: number;
}

export interface LiveEffectRackChainProcessOptions extends LiveEffectRackDeadlinePressureSkipOptions {
  wetMix?: number;
  stageWetMixes?: ArrayLike<number>;
}

export interface LiveEffectRackChainStageResult {
  index: number;
  bypassed: boolean;
  healthy: boolean;
  instanceId?: string;
  renderEngine?: string;
  lastDryReason?: string;
  durationMs?: number;
  error?: unknown;
}

export interface LiveEffectRackChainResponse extends LiveEffectBlockResponse {
  stageCount: number;
  processedStages: number;
  failedStageIndex?: number;
  stageResults: LiveEffectRackChainStageResult[];
  chainProcessDurationMs?: number;
  chainProcessBudgetMs?: number;
  chainProcessBudgetExceeded: boolean;
  chainProcessTimeoutMs?: number;
  chainProcessTimedOut: boolean;
  chainProcessBudgetMisses: number;
  chainProcessBudgetTripped: boolean;
  chainUnhealthyReason?: "process-budget-exceeded" | "process-timeout";
}

export interface LiveEffectRackChainHealth {
  bypassed: boolean;
  wetMix: number;
  sampleRate: number;
  latencySamples: number;
  latencyMs: number;
  tailSamples: number;
  tailMs: number;
  infiniteTail: boolean;
  healthy: boolean;
  stageHealthy: boolean;
  stageCount: number;
  processedStages: number;
  failedStageIndex?: number;
  stageResults: LiveEffectRackChainStageResult[];
  lastStageError?: unknown;
  lastDryReason?: LiveEffectRackChainDryReason;
  dryOutputBlocks: number;
  bypassDryOutputBlocks: number;
  processBudgetMs: number;
  processTimeoutMs: number;
  maxConsecutiveProcessBudgetMisses: number;
  processBudgetRecoveryBlocks: number;
  processTimeoutRecoveryBlocks: number;
  transitionFadeSamples: number;
  processBudgetMisses: number;
  lastProcessDurationMs?: number;
  lastProcessBudgetMs?: number;
  processBudgetExceeded: boolean;
  processTimedOut: boolean;
  lastResponseDeadlineLeadMs?: number;
  lastResponseDeadlineLeadBlocks?: number;
  responseJitterBlocks: number;
  responseDeadlineMisses: number;
  processBudgetTripped: boolean;
  processTimeoutTripped: boolean;
  recoveryDryBlocks: number;
  timeoutRecoveryDryBlocks: number;
  unhealthyReason?: "process-budget-exceeded" | "process-timeout";
  lastError?: unknown;
}

export interface LiveEffectRackChainDryOutputEventDetail {
  response: LiveEffectRackChainResponse;
  health: LiveEffectRackChainHealth;
  reason: LiveEffectRackChainDryReason;
  deadlinePressure?: LiveEffectRackDeadlinePressure;
}

export class LiveEffectRackChain extends EventTarget {
  readonly stages: LiveEffectRackChainStage[];
  readonly maxBlockSize: number;
  processBudgetMs: number;
  processTimeoutMs: number;
  readonly maxConsecutiveProcessBudgetMisses: number;
  readonly processBudgetRecoveryBlocks: number;
  readonly processTimeoutRecoveryBlocks: number;
  transitionFadeSamples: number;
  private readonly outputChannels?: number;
  private readonly nowMs: () => number;
  private bypassed: boolean;
  private wetMix: number;
  private sampleRate: number;
  private latencySamples = 0;
  private tailSamples = 0;
  private infiniteTail = false;
  private stageHealthy = true;
  private lastProcessedStages = 0;
  private lastFailedStageIndex?: number;
  private lastStageResults: LiveEffectRackChainStageResult[] = [];
  private lastStageError?: unknown;
  private lastDryReason?: LiveEffectRackChainDryReason;
  private dryOutputBlocks = 0;
  private bypassDryOutputBlocks = 0;
  private processBudgetMisses = 0;
  private recoveryDryBlocks = 0;
  private timeoutRecoveryDryBlocks = 0;
  private lastError?: unknown;
  private unhealthyReason?: LiveEffectRackChainResponse["chainUnhealthyReason"];
  private lastProcessDurationMs?: number;
  private lastProcessBudgetMs?: number;
  private lastProcessBudgetExceeded = false;
  private lastProcessTimedOut = false;
  private lastResponseDeadlineLeadMs?: number;
  private lastResponseDeadlineLeadBlocks?: number;
  private responseDeadlineLeadMinBlocks?: number;
  private responseDeadlineLeadMaxBlocks?: number;
  private responseJitterBlocks = 0;
  private responseDeadlineMisses = 0;
  private lastOutputPath?: "wet" | "dry";
  private lastOutputTail?: number[];

  constructor(options: LiveEffectRackChainOptions) {
    super();
    const maxStages = boundedLiveEffectInteger(options.maxStages, LIVE_EFFECT_CHAIN_MAX_STAGES, 0, LIVE_EFFECT_CHAIN_MAX_STAGES);
    const stages = Array.from({ length: boundedLiveEffectInteger(options.stages?.length, 0, 0, maxStages) }, (_unused, index) => options.stages[index])
      .filter((stage): stage is LiveEffectRackChainStage => typeof stage?.processBlock === "function");
    this.stages = stages.slice(0, maxStages);
    this.maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, 0, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, 0, 0, 60000);
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, 0, 0, 1024);
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.processTimeoutRecoveryBlocks = boundedLiveEffectInteger(options.processTimeoutRecoveryBlocks, 0, 0, 4096);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.outputChannels = options.outputChannels === undefined
      ? undefined
      : boundedLiveEffectInteger(options.outputChannels, 2, 1, 32);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
    this.bypassed = options.bypassed === true;
    this.wetMix = boundedWetMix(options.wetMix, 1);
    this.sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
  }

  get health(): LiveEffectRackChainHealth {
    return {
      bypassed: this.bypassed,
      wetMix: this.wetMix,
      sampleRate: this.sampleRate,
      latencySamples: this.latencySamples,
      latencyMs: liveEffectLatencyMilliseconds(this.latencySamples, this.sampleRate),
      tailSamples: this.tailSamples,
      tailMs: liveEffectLatencyMilliseconds(this.tailSamples, this.sampleRate),
      infiniteTail: this.infiniteTail,
      healthy: this.chainHealthy(),
      stageHealthy: this.stageHealthy,
      stageCount: this.stages.length,
      processedStages: this.lastProcessedStages,
      failedStageIndex: this.lastFailedStageIndex,
      stageResults: this.lastStageResults.slice(),
      lastStageError: this.lastStageError,
      lastDryReason: this.lastDryReason,
      dryOutputBlocks: this.dryOutputBlocks,
      bypassDryOutputBlocks: this.bypassDryOutputBlocks,
      processBudgetMs: this.processBudgetMs,
      processTimeoutMs: this.processTimeoutMs,
      maxConsecutiveProcessBudgetMisses: this.maxConsecutiveProcessBudgetMisses,
      processBudgetRecoveryBlocks: this.processBudgetRecoveryBlocks,
      processTimeoutRecoveryBlocks: this.processTimeoutRecoveryBlocks,
      transitionFadeSamples: this.transitionFadeSamples,
      processBudgetMisses: this.processBudgetMisses,
      lastProcessDurationMs: this.lastProcessDurationMs,
      lastProcessBudgetMs: this.lastProcessBudgetMs,
      processBudgetExceeded: this.lastProcessBudgetExceeded,
      processTimedOut: this.lastProcessTimedOut,
      lastResponseDeadlineLeadMs: this.lastResponseDeadlineLeadMs,
      lastResponseDeadlineLeadBlocks: this.lastResponseDeadlineLeadBlocks,
      responseJitterBlocks: this.responseJitterBlocks,
      responseDeadlineMisses: this.responseDeadlineMisses,
      processBudgetTripped: this.unhealthyReason === "process-budget-exceeded",
      processTimeoutTripped: this.unhealthyReason === "process-timeout",
      recoveryDryBlocks: this.recoveryDryBlocks,
      timeoutRecoveryDryBlocks: this.timeoutRecoveryDryBlocks,
      unhealthyReason: this.unhealthyReason,
      lastError: this.lastError
    };
  }

  get timing(): LiveEffectRackTiming {
    return liveEffectRackTiming(
      this.sampleRate,
      this.maxBlockSize,
      this.latencySamples,
      0,
      this.latencySamples,
      this.processBudgetMs,
      this.processTimeoutMs,
      0,
      this.transitionFadeSamples
    );
  }

  async processBlock(
    request: LiveEffectBlockRequest,
    options: LiveEffectRackChainProcessOptions = {}
  ): Promise<LiveEffectRackChainResponse> {
    const processStartedAt = this.nowMs();
    const outputChannels = this.chainOutputChannels(request.channels);
    if (this.bypassed) {
      const response = this.chainDryResponse(request, "chain-bypass", outputChannels);
      this.maybeRecoverFromProcessBudget();
      this.maybeRecoverFromProcessTimeout();
      return response;
    }
    if (this.unhealthyReason !== undefined) {
      const reason = this.unhealthyReason === "process-timeout" ? "chain-process-timeout" : "chain-process-budget-exceeded";
      const response = this.chainDryResponse(request, reason, outputChannels, this.lastError, false);
      this.maybeRecoverFromProcessBudget();
      this.maybeRecoverFromProcessTimeout();
      return response;
    }
    if (this.stages.length === 0) {
      return this.chainDryResponse(request, "chain-empty", outputChannels);
    }
    const chainWetMix = boundedWetMix(options.wetMix, this.wetMix);
    let channels = boundedLiveEffectChannels(request.channels, outputChannels, this.maxBlockSize);
    let latencySamples = 0;
    let tailSamples = 0;
    let infiniteTail = false;
    const stageResults: LiveEffectRackChainStageResult[] = [];
    for (let index = 0; index < this.stages.length; index += 1) {
      const stage = this.stages[index];
      const stageStartedAt = this.nowMs();
      try {
        const timeoutMs = this.remainingProcessTimeoutMs(processStartedAt);
        if (timeoutMs === 0) return this.chainProcessTimeoutResponse(request, outputChannels, processStartedAt, new Error("chain_process_timeout"));
        const response = await withLiveEffectTimeout(stage.processBlock({
          ...request,
          channels,
          wetMix: stageWetMix(options.stageWetMixes, index, request.wetMix)
        }), timeoutMs ?? 0);
        const stageDurationMs = this.nowMs() - stageStartedAt;
        if (this.processTimedOut(processStartedAt)) return this.chainProcessTimeoutResponse(request, outputChannels, processStartedAt, new Error("chain_process_timeout"));
        channels = boundedLiveEffectChannels(response.channels, outputChannels, this.maxBlockSize);
        latencySamples = boundedLatencySamples(latencySamples + boundedLatencySamples(response.latencySamples, 0), latencySamples);
        tailSamples = boundedLatencySamples(tailSamples + boundedLatencySamples(response.tailSamples, 0), tailSamples);
        infiniteTail = infiniteTail || response.infiniteTail === true;
        stageResults.push(stageResult(index, stage, response, stageDurationMs));
      } catch (error) {
        if (isChainTimeoutError(error)) return this.chainProcessTimeoutResponse(request, outputChannels, processStartedAt, error);
        stageResults.push(stageErrorResult(index, stage, error, this.nowMs() - stageStartedAt));
        return this.finishChainResponse({
          blockId: request.blockId,
          channels,
          latencySamples,
          tailSamples,
          infiniteTail,
          renderEngine: "chain-stage-error",
          bypassed: stageResults.every((stage) => stage.bypassed),
          healthy: false,
          error,
          stageCount: this.stages.length,
          processedStages: stageResults.length,
          failedStageIndex: index,
          stageResults
        }, processStartedAt, request, outputChannels, chainWetMix);
      }
    }
    return this.finishChainResponse({
      blockId: request.blockId,
      channels,
      latencySamples,
      tailSamples,
      infiniteTail,
      renderEngine: "live-effect-rack-chain",
      bypassed: stageResults.length === 0 || stageResults.every((stage) => stage.bypassed),
      healthy: stageResults.every((stage) => stage.healthy),
      stageCount: this.stages.length,
      processedStages: stageResults.length,
      stageResults
    }, processStartedAt, request, outputChannels, chainWetMix);
  }

  processScheduledBlock(
    scheduled: LiveEffectRackScheduledBlock,
    options: LiveEffectRackChainProcessOptions = {}
  ): Promise<LiveEffectRackChainResponse> {
    if (scheduled.stale) {
      return Promise.resolve(this.chainDryResponse(
        scheduled.request,
        "chain-stale-input",
        this.chainOutputChannels(scheduled.request.channels)
      ));
    }
    if (shouldSkipLiveEffectDeadlinePressure(scheduled.deadlinePressure, options)) {
      return Promise.resolve(this.chainDryResponse(
        scheduled.request,
        "chain-deadline-pressure",
        this.chainOutputChannels(scheduled.request.channels),
        undefined,
        true,
        scheduled.deadlinePressure
      ));
    }
    return this.processBlock(scheduled.request, options);
  }

  setBypassed(bypassed: boolean): void {
    if (this.bypassed === bypassed) {
      return;
    }
    this.bypassed = bypassed;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  setWetMix(wetMix: number): void {
    const bounded = boundedWetMix(wetMix, this.wetMix);
    if (bounded === this.wetMix) {
      return;
    }
    this.wetMix = bounded;
    this.dispatchEvent(new CustomEvent("wetmixchange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  setTimingPolicy(options: Partial<LiveEffectRackChainOptions>): LiveEffectRackChainHealth {
    const previous = { processBudgetMs: this.processBudgetMs, processTimeoutMs: this.processTimeoutMs, transitionFadeSamples: this.transitionFadeSamples };
    this.processBudgetMs = boundedLiveEffectNumber(options.processBudgetMs, this.processBudgetMs, 0, 60000);
    this.processTimeoutMs = boundedLiveEffectNumber(options.processTimeoutMs, this.processTimeoutMs, 0, 60000);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, this.transitionFadeSamples, 0, 4096);
    const changed = this.processBudgetMs !== previous.processBudgetMs || this.processTimeoutMs !== previous.processTimeoutMs || this.transitionFadeSamples !== previous.transitionFadeSamples;
    if (changed) {
      const health = this.health;
      this.dispatchEvent(new CustomEvent("timingpolicychange", { detail: { previous, health } }));
      this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
    }
    return this.health;
  }

  retry(): boolean {
    if (this.unhealthyReason === undefined) {
      return false;
    }
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastProcessBudgetExceeded = false;
    this.lastProcessTimedOut = false;
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  private chainDryResponse(
    request: LiveEffectBlockRequest,
    renderEngine: string,
    outputChannels: number,
    error?: unknown,
    healthy = this.chainHealthy(),
    deadlinePressure?: LiveEffectRackDeadlinePressure
  ): LiveEffectRackChainResponse {
    const chainProcessBudgetTripped = this.unhealthyReason === "process-budget-exceeded";
    const response = this.finishOutputResponse({
      blockId: request.blockId,
      channels: dryChannels(request.channels, outputChannels, this.maxBlockSize),
      latencySamples: 0,
      tailSamples: 0,
      infiniteTail: false,
      renderEngine,
      bypassed: true,
      healthy,
      error,
      stageCount: this.stages.length,
      processedStages: 0,
      stageResults: [],
      chainProcessDurationMs: this.unhealthyReason === "process-timeout" ? this.lastProcessDurationMs : 0,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined,
      chainProcessBudgetExceeded: chainProcessBudgetTripped,
      chainProcessTimedOut: this.unhealthyReason === "process-timeout",
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped,
      chainUnhealthyReason: this.unhealthyReason,
      deadlinePressure
    }, outputChannels);
    return this.recordChainLatency(response, request);
  }

  private chainOutputChannels(channels: ArrayLike<number>[]): number {
    return this.outputChannels ?? boundedLiveEffectInteger(channels.length, 2, 1, 32);
  }

  private finishChainResponse(
    response: LiveEffectRackChainResponse,
    processStartedAt: number,
    request: LiveEffectBlockRequest,
    outputChannels: number,
    wetMix: number
  ): LiveEffectRackChainResponse {
    const previousMisses = this.processBudgetMisses;
    const previousUnhealthyReason = this.unhealthyReason;
    const durationMs = boundedOptionalNumber(this.nowMs() - processStartedAt, 0, 60000);
    const chainProcessBudgetExceeded = this.processBudgetMs > 0 && (durationMs ?? 0) > this.processBudgetMs;
    this.lastProcessDurationMs = durationMs;
    this.lastProcessBudgetMs = this.processBudgetMs > 0 ? this.processBudgetMs : undefined;
    this.recordResponseDeadlineLead(request.sampleRate);
    this.lastProcessBudgetExceeded = chainProcessBudgetExceeded;
    this.lastProcessTimedOut = false;
    this.processBudgetMisses = chainProcessBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    const chainProcessBudgetTripped = response.healthy !== false &&
      this.maxConsecutiveProcessBudgetMisses > 0 &&
      this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses;
    const error = chainProcessBudgetTripped ? response.error ?? new Error("chain_process_budget_exceeded") : response.error;
    if (chainProcessBudgetTripped) {
      this.lastError = error;
      this.unhealthyReason = "process-budget-exceeded";
      this.recoveryDryBlocks = 0;
      const finalResponse = this.recordChainLatency(this.finishOutputResponse({
        ...response,
        channels: dryChannels(request.channels, outputChannels, this.maxBlockSize),
        latencySamples: 0,
        tailSamples: 0,
        infiniteTail: false,
        renderEngine: "chain-process-budget-exceeded",
        bypassed: true,
        healthy: false,
        error,
        chainProcessDurationMs: durationMs,
        chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
        chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined,
        chainProcessBudgetExceeded,
        chainProcessTimedOut: false,
        chainProcessBudgetMisses: this.processBudgetMisses,
        chainProcessBudgetTripped,
        chainUnhealthyReason: this.unhealthyReason
      }, outputChannels), request);
      this.recordStageHealth(finalResponse);
      this.dispatchChainPressureEvents(finalResponse, previousMisses, previousUnhealthyReason);
      return finalResponse;
    }
    const finalResponse = this.recordChainLatency(this.finishOutputResponse({
      ...response,
      channels: wetMixedChannels(response.channels, request.channels, outputChannels, wetMix, this.maxBlockSize),
      healthy: response.healthy !== false,
      error,
      chainProcessDurationMs: durationMs,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      chainProcessTimeoutMs: this.processTimeoutMs > 0 ? this.processTimeoutMs : undefined,
      chainProcessBudgetExceeded,
      chainProcessTimedOut: false,
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped,
      chainUnhealthyReason: this.unhealthyReason
    }, outputChannels), request);
    this.recordStageHealth(finalResponse);
    this.dispatchChainPressureEvents(finalResponse, previousMisses, previousUnhealthyReason);
    return finalResponse;
  }

  private chainProcessTimeoutResponse(
    request: LiveEffectBlockRequest,
    outputChannels: number,
    processStartedAt: number,
    error: unknown
  ): LiveEffectRackChainResponse {
    this.lastProcessDurationMs = Math.max(this.processTimeoutMs, boundedOptionalNumber(this.nowMs() - processStartedAt, 0, 60000) ?? 0);
    this.lastProcessBudgetMs = this.processBudgetMs > 0 ? this.processBudgetMs : undefined;
    this.lastProcessBudgetExceeded = false;
    this.lastProcessTimedOut = true;
    this.lastError = error;
    this.unhealthyReason = "process-timeout";
    this.timeoutRecoveryDryBlocks = 0;
    this.recordResponseDeadlineLead(request.sampleRate);
    const response = this.chainDryResponse(request, "chain-process-timeout", outputChannels, error, false);
    this.recordStageHealth(response);
    this.dispatchEvent(new CustomEvent("chain-process-timeout", { detail: { response, health: this.health } }));
    this.dispatchEvent(new CustomEvent("chain-process-timeout-tripped", { detail: { response, health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return response;
  }

  private finishOutputResponse(response: LiveEffectRackChainResponse, outputChannels: number): LiveEffectRackChainResponse {
    const outputPath = response.bypassed ? "dry" : "wet";
    const lastDryReason = chainDryReason(response);
    if (lastDryReason !== undefined) {
      this.dryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.dryOutputBlocks + 1);
      if (isIntentionalChainBypassResponse(response)) this.bypassDryOutputBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.bypassDryOutputBlocks + 1);
    }
    this.recordDryReason(lastDryReason);
    const normalized = boundedLiveEffectChannels(response.channels, outputChannels, this.maxBlockSize);
    const channels = transitionOutputChannels(normalized, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
    this.lastOutputTail = outputTail(channels, outputChannels);
    this.lastOutputPath = outputPath;
    const finalResponse = channels === response.channels ? response : { ...response, channels };
    if (lastDryReason !== undefined) {
      const detail: LiveEffectRackChainDryOutputEventDetail = {
        response: finalResponse,
        health: this.health,
        reason: lastDryReason,
        deadlinePressure: finalResponse.deadlinePressure
      };
      this.dispatchEvent(new CustomEvent("dry-output", { detail }));
    }
    return finalResponse;
  }

  private recordDryReason(lastDryReason: LiveEffectRackChainDryReason | undefined): void {
    if (lastDryReason === this.lastDryReason) {
      return;
    }
    this.lastDryReason = lastDryReason;
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private recordChainLatency(response: LiveEffectRackChainResponse, request: LiveEffectBlockRequest): LiveEffectRackChainResponse {
    const sampleRate = boundedLiveEffectInteger(request.sampleRate, this.sampleRate, 1, 384000);
    const latencySamples = boundedLatencySamples(response.latencySamples, this.latencySamples);
    const tailSamples = boundedLatencySamples(response.tailSamples, this.tailSamples);
    const infiniteTail = response.infiniteTail === true;
    if (
      sampleRate === this.sampleRate &&
      latencySamples === this.latencySamples &&
      tailSamples === this.tailSamples &&
      infiniteTail === this.infiniteTail
    ) {
      return response;
    }
    this.sampleRate = sampleRate;
    this.latencySamples = latencySamples;
    this.tailSamples = tailSamples;
    this.infiniteTail = infiniteTail;
    this.dispatchEvent(new CustomEvent("latencychange", { detail: this.health }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return response;
  }

  private recordStageHealth(response: LiveEffectRackChainResponse): void {
    if (response.stageResults.length === 0 && response.failedStageIndex === undefined && this.stages.length > 0) {
      return;
    }
    const stageHealthy = response.stageResults.every((stage) => stage.healthy !== false);
    const processedStages = boundedLiveEffectInteger(response.processedStages, 0, 0, this.stages.length);
    const failedStageIndex = boundedFailedStageIndex(response.failedStageIndex, this.stages.length);
    const lastStageError = stageHealthy ? undefined : response.error ?? response.stageResults.find((stage) => stage.healthy === false)?.error;
    const changed = stageHealthy !== this.stageHealthy ||
      failedStageIndex !== this.lastFailedStageIndex ||
      lastStageError !== this.lastStageError;
    this.stageHealthy = stageHealthy;
    this.lastProcessedStages = processedStages;
    this.lastFailedStageIndex = failedStageIndex;
    this.lastStageResults = response.stageResults.slice();
    this.lastStageError = lastStageError;
    if (changed) {
      this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    }
  }

  private chainHealthy(): boolean {
    return this.unhealthyReason === undefined && this.stageHealthy;
  }

  private recordResponseDeadlineLead(sampleRate: unknown): void {
    if (!this.lastProcessBudgetMs || this.lastProcessDurationMs === undefined) {
      return;
    }
    const boundedSampleRate = boundedLiveEffectInteger(sampleRate, this.sampleRate, 1, 384000);
    const blockDurationMs = (this.maxBlockSize / boundedSampleRate) * 1000;
    this.lastResponseDeadlineLeadMs = boundedOptionalNumber(
      this.lastProcessBudgetMs - this.lastProcessDurationMs,
      -60000,
      60000
    );
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
    if ((this.lastResponseDeadlineLeadMs ?? 0) < 0) {
      this.responseDeadlineMisses = Math.min(1024, this.responseDeadlineMisses + 1);
      this.dispatchEvent(new CustomEvent("chain-response-deadline-missed", { detail: { durationMs: this.lastProcessDurationMs, budgetMs: this.lastProcessBudgetMs, leadMs: this.lastResponseDeadlineLeadMs, leadBlocks: this.lastResponseDeadlineLeadBlocks, health: this.health } }));
    }
  }

  private remainingProcessTimeoutMs(processStartedAt: number): number | undefined {
    if (this.processTimeoutMs <= 0) return undefined;
    const remaining = this.processTimeoutMs - (this.nowMs() - processStartedAt);
    return remaining <= 0 ? 0 : remaining;
  }

  private processTimedOut(processStartedAt: number): boolean {
    return this.processTimeoutMs > 0 && this.nowMs() - processStartedAt > this.processTimeoutMs;
  }

  private dispatchChainPressureEvents(
    response: LiveEffectRackChainResponse,
    previousMisses: number,
    previousUnhealthyReason: LiveEffectRackChainResponse["chainUnhealthyReason"]
  ): void {
    const health = this.health;
    if (response.chainProcessBudgetExceeded) {
      this.dispatchEvent(new CustomEvent("chain-process-budget-exceeded", { detail: { response, health } }));
    }
    if (response.chainProcessBudgetTripped) {
      this.dispatchEvent(new CustomEvent("chain-process-budget-tripped", { detail: { response, health } }));
    }
    if (
      previousMisses !== this.processBudgetMisses ||
      previousUnhealthyReason !== this.unhealthyReason ||
      response.chainProcessBudgetExceeded
    ) {
      this.dispatchEvent(new CustomEvent("healthchange", { detail: health }));
    }
  }

  private maybeRecoverFromProcessBudget(): void {
    if (this.unhealthyReason !== "process-budget-exceeded" || this.processBudgetRecoveryBlocks <= 0) {
      return;
    }
    this.recoveryDryBlocks = Math.min(4096, this.recoveryDryBlocks + 1);
    if (this.recoveryDryBlocks < this.processBudgetRecoveryBlocks) {
      return;
    }
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.recoveryDryBlocks = 0;
    this.processBudgetMisses = 0;
    this.lastProcessBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("chain-process-budget-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }

  private maybeRecoverFromProcessTimeout(): void {
    if (this.unhealthyReason !== "process-timeout" || this.processTimeoutRecoveryBlocks <= 0) {
      return;
    }
    this.timeoutRecoveryDryBlocks = Math.min(4096, this.timeoutRecoveryDryBlocks + 1);
    if (this.timeoutRecoveryDryBlocks < this.processTimeoutRecoveryBlocks) {
      return;
    }
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.timeoutRecoveryDryBlocks = 0;
    this.lastProcessTimedOut = false;
    this.dispatchEvent(new CustomEvent("chain-process-timeout-recovered", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
  }
}

export function createLiveEffectRackChain(options: LiveEffectRackChainOptions): LiveEffectRackChain {
  return new LiveEffectRackChain(options);
}

export function createLivePerformanceRackChainOptions(
  options: LivePerformanceRackChainOptions
): LiveEffectRackChainOptions {
  const { processBudgetBlocks, processTimeoutBlocks, transitionFadeBlocks, ...chainOptions } = options;
  const sampleRate = boundedLiveEffectInteger(options.sampleRate, 48000, 1, 384000);
  const maxBlockSize = boundedLiveEffectInteger(options.maxBlockSize, 128, 1, 8192);
  const policy = createLiveEffectRackPolicy({
    ...options,
    sampleRate,
    maxBlockSize,
    processBudgetBlocks,
    processTimeoutBlocks,
    transitionFadeBlocks
  });
  return {
    ...chainOptions,
    sampleRate: policy.sampleRate,
    maxBlockSize: policy.maxBlockSize,
    processBudgetMs: policy.processBudgetMs,
    processTimeoutMs: policy.processTimeoutMs,
    maxConsecutiveProcessBudgetMisses: policy.maxConsecutiveProcessBudgetMisses,
    processBudgetRecoveryBlocks: policy.processBudgetRecoveryBlocks,
    processTimeoutRecoveryBlocks: policy.processTimeoutRecoveryBlocks,
    transitionFadeSamples: policy.transitionFadeSamples
  };
}

export function createLivePerformanceRackChain(options: LivePerformanceRackChainOptions): LiveEffectRackChain {
  return createLiveEffectRackChain(createLivePerformanceRackChainOptions(options));
}
