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
  bridge.addEventListener("response-deadline-missed", (event) => {
    realtimeStats.updateTransportPressure({ reasons: ["deadline-miss"] });
    updateHealth(event.detail?.health);
  });
  bridge.addEventListener("process-timeout", (event) => {
    updateHealth(event.detail?.health);
  });
  bridge.addEventListener("process-timeout-tripped", (event) => {
    updateHealth(event.detail?.health);
  });
  bridge.addEventListener("process-timeout-auto-bypassed", (event) => {
    updateHealth(event.detail?.health);
  });
  bridge.addEventListener("audio-error", (event) => {
    logError(event.detail);
  });
  bridge.addEventListener("process-diagnostics", (event) => {
    realtimeStats.updateRenderDiagnostics(event.detail);
    elements.renderEngine.textContent = formatRenderEngine(event.detail?.renderEngine);
  });
}

export function createEngineRetryController({ button, getBridge, controlsEnabled, setEngineStatus, log, recreate }) {
  function update(health = getBridge()?.health) {
    const timeout = health?.unhealthyReason === "process-timeout";
    const recoverable = timeout ? Boolean(recreate) : Boolean(health?.transportPressureAutoBypassed || health?.renderBudgetAutoBypassed || health?.audioErrorAutoBypassed);
    button.textContent = timeout ? "Recreate Engine" : "Retry Engine";
    button.disabled = !controlsEnabled() || !getBridge() || !recoverable;
  }

  function updateHealth(health = getBridge()?.health) {
    update(health);
    if (!getBridge() || !health) return;
    const timeout = health.unhealthyReason === "process-timeout";
    setEngineStatus(timeout ? "Engine needs recreate" : health.unhealthyReason ? "Engine bypassed" : "Engine running", health.unhealthyReason ? "warn" : "ready");
  }

  button.addEventListener("click", () => {
    const bridge = getBridge();
    if (!bridge) return;
    if (bridge.health.unhealthyReason === "process-timeout" && recreate) {
      button.disabled = true;
      setEngineStatus("Recreating", "warn");
      void recreate().then(() => log("Engine recreate requested.")).catch((error) => log(error?.message ?? String(error)));
      return;
    }
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
