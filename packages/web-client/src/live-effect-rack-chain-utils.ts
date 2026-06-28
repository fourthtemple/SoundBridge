import type { LiveEffectBlockResponse } from "./live-effect-rack-types";
import type {
  LiveEffectRackChainDryReason,
  LiveEffectRackChainResponse,
  LiveEffectRackChainStage,
  LiveEffectRackChainStageResult
} from "./live-effect-rack-chain-types";
import { boundedLiveEffectNumber, boundedOptionalNumber } from "./live-effect-rack-metrics";

export function stageWetMix(
  stageWetMixes: ArrayLike<number> | undefined,
  index: number,
  fallback: number | undefined
): number | undefined {
  return stageWetMixes && index < stageWetMixes.length ? Number(stageWetMixes[index]) : fallback;
}

export function boundedWetMix(value: unknown, fallback: number): number {
  return boundedLiveEffectNumber(value, fallback, 0, 1);
}

export function boundedFailedStageIndex(value: unknown, stageCount: number): number | undefined {
  const bounded = boundedOptionalNumber(value, 0, Math.max(0, stageCount - 1));
  return bounded === undefined ? undefined : Math.floor(bounded);
}

export function chainDryReason(response: LiveEffectRackChainResponse): LiveEffectRackChainDryReason | undefined {
  if (response.renderEngine === "chain-bypass" ||
    response.renderEngine === "chain-deadline-pressure" ||
    response.renderEngine === "chain-empty" ||
    response.renderEngine === "chain-process-budget-exceeded" ||
    response.renderEngine === "chain-process-timeout" ||
    response.renderEngine === "chain-stage-error" ||
    response.renderEngine === "chain-stale-input") {
    return response.renderEngine;
  }
  if (response.stageResults.length > 0 && response.stageResults.every((stage) => stage.bypassed)) {
    return "chain-stage-bypass";
  }
  return response.bypassed ? "chain-bypass" : undefined;
}

export function isIntentionalChainBypassResponse(response: LiveEffectRackChainResponse): boolean {
  return response.renderEngine === "chain-bypass" || (response.stageResults.length > 0 && response.stageResults.every((stage) => stage.bypassed && stage.healthy !== false && stage.error === undefined && (stage.renderEngine === "dry-bypass" || stage.lastDryReason === "bypass")));
}

export function stageResult(
  index: number,
  stage: LiveEffectRackChainStage,
  response: LiveEffectBlockResponse,
  durationMs: number
): LiveEffectRackChainStageResult {
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

export function stageErrorResult(
  index: number,
  stage: LiveEffectRackChainStage,
  error: unknown,
  durationMs: number
): LiveEffectRackChainStageResult {
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

export function isChainTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "SoundBridgeLiveEffectTimeout";
}
