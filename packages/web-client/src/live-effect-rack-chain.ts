import type { LiveEffectBlockRequest, LiveEffectBlockResponse, LiveEffectRackHealth } from "./live-effect-rack";
import { boundedLiveEffectChannels, dryChannels, outputTail, transitionOutputChannels, wetMixedChannels } from "./live-effect-rack-audio";
import { boundedLatencySamples, boundedLiveEffectInteger, boundedLiveEffectNumber, boundedOptionalNumber, liveEffectNowMs } from "./live-effect-rack-metrics";
import type { LiveEffectRackScheduledBlock } from "./live-effect-rack-scheduler";

const LIVE_EFFECT_CHAIN_MAX_STAGES = 16;

export interface LiveEffectRackChainStage {
  readonly health?: Partial<LiveEffectRackHealth>;
  processBlock(request: LiveEffectBlockRequest): Promise<LiveEffectBlockResponse>;
}

export interface LiveEffectRackChainOptions {
  stages: ArrayLike<LiveEffectRackChainStage>;
  bypassed?: boolean;
  wetMix?: number;
  maxStages?: number;
  outputChannels?: number;
  maxBlockSize?: number;
  processBudgetMs?: number;
  maxConsecutiveProcessBudgetMisses?: number;
  processBudgetRecoveryBlocks?: number;
  transitionFadeSamples?: number;
  nowMs?: () => number;
}

export interface LiveEffectRackChainProcessOptions {
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
  chainProcessBudgetMisses: number;
  chainProcessBudgetTripped: boolean;
  chainUnhealthyReason?: "process-budget-exceeded";
}

export interface LiveEffectRackChainHealth {
  bypassed: boolean;
  wetMix: number;
  healthy: boolean;
  stageCount: number;
  processBudgetMs: number;
  maxConsecutiveProcessBudgetMisses: number;
  processBudgetRecoveryBlocks: number;
  transitionFadeSamples: number;
  processBudgetMisses: number;
  lastProcessDurationMs?: number;
  processBudgetExceeded: boolean;
  processBudgetTripped: boolean;
  recoveryDryBlocks: number;
  unhealthyReason?: "process-budget-exceeded";
  lastError?: unknown;
}

export class LiveEffectRackChain extends EventTarget {
  readonly stages: LiveEffectRackChainStage[];
  readonly maxBlockSize: number;
  readonly processBudgetMs: number;
  readonly maxConsecutiveProcessBudgetMisses: number;
  readonly processBudgetRecoveryBlocks: number;
  readonly transitionFadeSamples: number;
  private readonly outputChannels?: number;
  private readonly nowMs: () => number;
  private bypassed: boolean;
  private wetMix: number;
  private processBudgetMisses = 0;
  private recoveryDryBlocks = 0;
  private lastError?: unknown;
  private unhealthyReason?: LiveEffectRackChainResponse["chainUnhealthyReason"];
  private lastProcessDurationMs?: number;
  private lastProcessBudgetExceeded = false;
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
    this.maxConsecutiveProcessBudgetMisses = boundedLiveEffectInteger(options.maxConsecutiveProcessBudgetMisses, 0, 0, 1024);
    this.processBudgetRecoveryBlocks = boundedLiveEffectInteger(options.processBudgetRecoveryBlocks, 0, 0, 4096);
    this.transitionFadeSamples = boundedLiveEffectInteger(options.transitionFadeSamples, 0, 0, 4096);
    this.outputChannels = options.outputChannels === undefined
      ? undefined
      : boundedLiveEffectInteger(options.outputChannels, 2, 1, 32);
    this.nowMs = typeof options.nowMs === "function" ? options.nowMs : liveEffectNowMs;
    this.bypassed = options.bypassed === true;
    this.wetMix = boundedWetMix(options.wetMix, 1);
  }

  get health(): LiveEffectRackChainHealth {
    return {
      bypassed: this.bypassed,
      wetMix: this.wetMix,
      healthy: this.unhealthyReason === undefined,
      stageCount: this.stages.length,
      processBudgetMs: this.processBudgetMs,
      maxConsecutiveProcessBudgetMisses: this.maxConsecutiveProcessBudgetMisses,
      processBudgetRecoveryBlocks: this.processBudgetRecoveryBlocks,
      transitionFadeSamples: this.transitionFadeSamples,
      processBudgetMisses: this.processBudgetMisses,
      lastProcessDurationMs: this.lastProcessDurationMs,
      processBudgetExceeded: this.lastProcessBudgetExceeded,
      processBudgetTripped: this.unhealthyReason === "process-budget-exceeded",
      recoveryDryBlocks: this.recoveryDryBlocks,
      unhealthyReason: this.unhealthyReason,
      lastError: this.lastError
    };
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
      return response;
    }
    if (this.unhealthyReason === "process-budget-exceeded") {
      const response = this.chainDryResponse(request, "chain-process-budget-exceeded", outputChannels, this.lastError, false);
      this.maybeRecoverFromProcessBudget();
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
        const response = await stage.processBlock({
          ...request,
          channels,
          wetMix: stageWetMix(options.stageWetMixes, index, request.wetMix)
        });
        const stageDurationMs = this.nowMs() - stageStartedAt;
        channels = boundedLiveEffectChannels(response.channels, outputChannels, this.maxBlockSize);
        latencySamples = boundedLatencySamples(latencySamples + boundedLatencySamples(response.latencySamples, 0), latencySamples);
        tailSamples = boundedLatencySamples(tailSamples + boundedLatencySamples(response.tailSamples, 0), tailSamples);
        infiniteTail = infiniteTail || response.infiniteTail === true;
        stageResults.push(stageResult(index, stage, response, stageDurationMs));
      } catch (error) {
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

  retry(): boolean {
    if (this.unhealthyReason !== "process-budget-exceeded") {
      return false;
    }
    this.lastError = undefined;
    this.unhealthyReason = undefined;
    this.processBudgetMisses = 0;
    this.recoveryDryBlocks = 0;
    this.lastProcessBudgetExceeded = false;
    this.dispatchEvent(new CustomEvent("retry", { detail: { health: this.health } }));
    this.dispatchEvent(new CustomEvent("healthchange", { detail: this.health }));
    return true;
  }

  private chainDryResponse(
    request: LiveEffectBlockRequest,
    renderEngine: string,
    outputChannels: number,
    error?: unknown,
    healthy = this.unhealthyReason === undefined
  ): LiveEffectRackChainResponse {
    const chainProcessBudgetTripped = this.unhealthyReason === "process-budget-exceeded";
    return this.finishOutputResponse({
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
      chainProcessDurationMs: 0,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      chainProcessBudgetExceeded: chainProcessBudgetTripped,
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped,
      chainUnhealthyReason: this.unhealthyReason
    }, outputChannels);
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
    this.lastProcessBudgetExceeded = chainProcessBudgetExceeded;
    this.processBudgetMisses = chainProcessBudgetExceeded ? Math.min(1024, this.processBudgetMisses + 1) : 0;
    const chainProcessBudgetTripped = response.healthy !== false &&
      this.maxConsecutiveProcessBudgetMisses > 0 &&
      this.processBudgetMisses >= this.maxConsecutiveProcessBudgetMisses;
    const error = chainProcessBudgetTripped ? response.error ?? new Error("chain_process_budget_exceeded") : response.error;
    if (chainProcessBudgetTripped) {
      this.lastError = error;
      this.unhealthyReason = "process-budget-exceeded";
      this.recoveryDryBlocks = 0;
      const finalResponse = this.finishOutputResponse({
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
        chainProcessBudgetExceeded,
        chainProcessBudgetMisses: this.processBudgetMisses,
        chainProcessBudgetTripped,
        chainUnhealthyReason: this.unhealthyReason
      }, outputChannels);
      this.dispatchChainPressureEvents(finalResponse, previousMisses, previousUnhealthyReason);
      return finalResponse;
    }
    const finalResponse = this.finishOutputResponse({
      ...response,
      channels: wetMixedChannels(response.channels, request.channels, outputChannels, wetMix, this.maxBlockSize),
      healthy: response.healthy !== false,
      error,
      chainProcessDurationMs: durationMs,
      chainProcessBudgetMs: this.processBudgetMs > 0 ? this.processBudgetMs : undefined,
      chainProcessBudgetExceeded,
      chainProcessBudgetMisses: this.processBudgetMisses,
      chainProcessBudgetTripped,
      chainUnhealthyReason: this.unhealthyReason
    }, outputChannels);
    this.dispatchChainPressureEvents(finalResponse, previousMisses, previousUnhealthyReason);
    return finalResponse;
  }

  private finishOutputResponse(response: LiveEffectRackChainResponse, outputChannels: number): LiveEffectRackChainResponse {
    const outputPath = response.bypassed ? "dry" : "wet";
    const normalized = boundedLiveEffectChannels(response.channels, outputChannels, this.maxBlockSize);
    const channels = transitionOutputChannels(normalized, this.lastOutputTail, this.lastOutputPath, outputPath, this.transitionFadeSamples);
    this.lastOutputTail = outputTail(channels, outputChannels);
    this.lastOutputPath = outputPath;
    return channels === response.channels ? response : { ...response, channels };
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
}

export function createLiveEffectRackChain(options: LiveEffectRackChainOptions): LiveEffectRackChain {
  return new LiveEffectRackChain(options);
}

function stageWetMix(stageWetMixes: ArrayLike<number> | undefined, index: number, fallback: number | undefined): number | undefined {
  return stageWetMixes && index < stageWetMixes.length ? Number(stageWetMixes[index]) : fallback;
}

function boundedWetMix(value: unknown, fallback: number): number {
  return boundedLiveEffectNumber(value, fallback, 0, 1);
}

function stageResult(index: number, stage: LiveEffectRackChainStage, response: LiveEffectBlockResponse, durationMs: number): LiveEffectRackChainStageResult {
  return {
    index,
    bypassed: response.bypassed === true,
    healthy: response.healthy !== false,
    instanceId: stage.health?.instanceId,
    renderEngine: typeof response.renderEngine === "string" ? response.renderEngine : undefined,
    lastDryReason: typeof stage.health?.lastDryReason === "string" ? stage.health.lastDryReason : undefined,
    durationMs: boundedOptionalNumber(durationMs, 0, 60000),
    error: response.error
  };
}

function stageErrorResult(index: number, stage: LiveEffectRackChainStage, error: unknown, durationMs: number): LiveEffectRackChainStageResult {
  return {
    index,
    bypassed: true,
    healthy: false,
    instanceId: stage.health?.instanceId,
    lastDryReason: typeof stage.health?.lastDryReason === "string" ? stage.health.lastDryReason : undefined,
    durationMs: boundedOptionalNumber(durationMs, 0, 60000),
    error
  };
}
