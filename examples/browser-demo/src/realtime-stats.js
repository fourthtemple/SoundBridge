export function createRealtimeStats({ onTransportLatencySamples } = {}) {
  const elements = {
    processedBlocks: document.querySelector("#processedBlocks"),
    underruns: document.querySelector("#underruns"),
    queuedBlocks: document.querySelector("#queuedBlocks"),
    staleOutputBlocks: document.querySelector("#staleOutputBlocks"),
    droppedInputBlocks: document.querySelector("#droppedInputBlocks"),
    inFlightBlocks: document.querySelector("#inFlightBlocks"),
    outputLatencyBlocks: document.querySelector("#outputLatencyBlocks"),
    transportLatencySamples: document.querySelector("#transportLatencySamples"),
    latencyIncreases: document.querySelector("#latencyIncreases"),
    latencyDecreases: document.querySelector("#latencyDecreases"),
    responseDeadlineLeadSamples: document.querySelector("#responseDeadlineLeadSamples"),
    responseJitterSamples: document.querySelector("#responseJitterSamples"),
    sharedAudioEnabled: document.querySelector("#sharedAudioEnabled"),
    sharedQueuedBlocks: document.querySelector("#sharedQueuedBlocks"),
    sharedDroppedBlocks: document.querySelector("#sharedDroppedBlocks"),
    inputBufferAllocations: document.querySelector("#inputBufferAllocations"),
    inputBufferReuses: document.querySelector("#inputBufferReuses"),
    latencyRecoveryBlocks: document.querySelector("#latencyRecoveryBlocks"),
    renderDurationMs: document.querySelector("#renderDurationMs"),
    renderBudgetMs: document.querySelector("#renderBudgetMs"),
    renderBudgetStatus: document.querySelector("#renderBudgetStatus")
  };

  return {
    update(stats = {}) {
      setText(elements.processedBlocks, stats.processedBlocks);
      setText(elements.underruns, stats.underruns);
      setText(elements.queuedBlocks, stats.queuedOutputBlocks);
      setText(elements.staleOutputBlocks, stats.staleOutputBlocks);
      setText(elements.droppedInputBlocks, stats.droppedInputBlocks);
      setText(elements.inFlightBlocks, stats.inFlightBlocks);
      setText(elements.outputLatencyBlocks, stats.outputLatencyBlocks);
      setText(elements.transportLatencySamples, stats.transportLatencySamples);
      setText(elements.latencyIncreases, stats.latencyIncreases);
      setText(elements.latencyDecreases, stats.latencyDecreases);
      setText(elements.responseDeadlineLeadSamples, stats.responseDeadlineLeadSamples);
      setText(elements.responseJitterSamples, stats.responseJitterSamples);
      setText(elements.inputBufferAllocations, stats.inputBufferAllocations);
      setText(elements.inputBufferReuses, stats.inputBufferReuses);
      setText(elements.latencyRecoveryBlocks, stats.latencyRecoveryBlocks);
      setSharedAudio(elements, stats);
      onTransportLatencySamples?.(Number(stats.transportLatencySamples ?? 0) || 0);
    },
    updateRenderDiagnostics(diagnostics = {}) {
      setText(elements.renderDurationMs, formatMilliseconds(diagnostics.renderDurationMs));
      setText(elements.renderBudgetMs, formatMilliseconds(diagnostics.renderBudgetMs));
      if (elements.renderBudgetStatus) {
        elements.renderBudgetStatus.textContent = diagnostics.renderBudgetExceeded === true ? "Over" : "OK";
      }
    }
  };
}

function setText(element, value) {
  if (element) {
    element.textContent = String(value ?? 0);
  }
}

function setSharedAudio(elements, stats) {
  const wakeMode = typeof stats.sharedAudioWakeMode === "string" ? stats.sharedAudioWakeMode : "";
  if (elements.sharedAudioEnabled) {
    elements.sharedAudioEnabled.textContent = stats.sharedAudioEnabled
      ? wakeMode && wakeMode !== "none"
        ? `On (${wakeMode})`
        : "On"
      : "Off";
  }
  if (elements.sharedQueuedBlocks) {
    elements.sharedQueuedBlocks.textContent = `${stats.sharedInputQueuedBlocks ?? 0}/${stats.sharedOutputQueuedBlocks ?? 0}`;
  }
  if (elements.sharedDroppedBlocks) {
    elements.sharedDroppedBlocks.textContent = `${stats.sharedInputDroppedBlocks ?? 0}/${stats.sharedOutputDroppedBlocks ?? 0}`;
  }
}

function formatMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(60000, number)).toFixed(3) : "0";
}
