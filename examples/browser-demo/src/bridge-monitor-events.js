export function bindBridgeMonitorEvents({ bridge, realtimeStats, elements, logError, formatRenderEngine, onHealth }) {
  const updateHealth = (health) => {
    realtimeStats.updateLatencyHealth(health);
    onHealth?.(health);
  };

  bridge.addEventListener("stats", (event) => {
    realtimeStats.update(event.detail);
  });
  bridge.addEventListener("latencychange", (event) => {
    updateHealth(event.detail?.health ?? event.detail);
  });
  bridge.addEventListener("healthchange", (event) => {
    updateHealth(event.detail);
  });
  bridge.addEventListener("transport-pressure", (event) => {
    realtimeStats.updateTransportPressure(event.detail);
  });
  bridge.addEventListener("audio-error", (event) => {
    logError(event.detail);
  });
  bridge.addEventListener("process-diagnostics", (event) => {
    realtimeStats.updateRenderDiagnostics(event.detail);
    elements.renderEngine.textContent = formatRenderEngine(event.detail?.renderEngine);
  });
}

export function createEngineRetryController({ button, getBridge, controlsEnabled, setEngineStatus, log }) {
  function update(health = getBridge()?.health) {
    const recoverable = Boolean(health?.transportPressureAutoBypassed || health?.renderBudgetAutoBypassed || health?.audioErrorAutoBypassed);
    button.disabled = !controlsEnabled() || !getBridge() || !recoverable;
  }

  function updateHealth(health = getBridge()?.health) {
    update(health);
    if (!getBridge() || !health) return;
    setEngineStatus(health.unhealthyReason ? "Engine bypassed" : "Engine running", health.unhealthyReason ? "warn" : "ready");
  }

  button.addEventListener("click", () => {
    const bridge = getBridge();
    if (!bridge) return;
    if (bridge.retry()) {
      log("Engine retry requested.");
      updateHealth(bridge.health);
      return;
    }
    log("No recoverable engine state.");
    update(bridge.health);
  });

  return { update, updateHealth };
}
