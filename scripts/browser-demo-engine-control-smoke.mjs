import { bindBridgeMonitorEvents, createEngineRetryController } from "../examples/browser-demo/src/bridge-monitor-events.js";

class FakeButton extends EventTarget {
  disabled = false;
  textContent = "";

  click() {
    this.dispatchEvent(new Event("click"));
  }
}

let health = {
  bypassed: true,
  renderBudgetAutoBypassed: true,
  unhealthyReason: "render-budget-exceeded"
};
const bridge = {
  get health() {
    return health;
  },
  retryCalls: 0,
  retry() {
    this.retryCalls += 1;
    health = { bypassed: false };
    return true;
  }
};
const button = new FakeButton();
let status = "";
let logMessage = "";
let recreateCalls = 0;
const controller = createEngineRetryController({
  button,
  getBridge: () => bridge,
  controlsEnabled: () => true,
  setEngineStatus(text) {
    status = text;
  },
  log(message) {
    logMessage = message;
  },
  async recreate() {
    recreateCalls += 1;
    health = { bypassed: false };
  }
});

controller.update();
assert(button.textContent === "Retry Engine" && button.disabled === false, "recoverable pressure enables retry");
button.click();
assert(bridge.retryCalls === 1 && logMessage === "Engine retry requested.", "retry control calls AudioNode retry");

health = { bypassed: true, audioErrorAutoBypassed: true, unhealthyReason: "process-timeout" };
controller.updateHealth(health);
assert(button.textContent === "Recreate Engine" && button.disabled === false && status === "Engine needs recreate", "process-timeout enables recreate mode");
button.click();
await Promise.resolve();
assert(recreateCalls === 1 && status === "Recreating" && logMessage === "Engine recreate requested.", "recreate control calls host recreate callback");

health = { bypassed: true, audioErrorAutoBypassed: true, unhealthyReason: "process-timeout" };
const disabledButton = new FakeButton();
const disabledController = createEngineRetryController({
  button: disabledButton,
  getBridge: () => bridge,
  controlsEnabled: () => true,
  setEngineStatus() {},
  log() {}
});
disabledController.update(health);
assert(disabledButton.textContent === "Recreate Engine" && disabledButton.disabled === true, "process-timeout stays disabled without recreate callback");

const monitorBridge = new EventTarget();
let monitorHealth;
let latencyHealth;
let pressureReasons;
bindBridgeMonitorEvents({
  bridge: monitorBridge,
  realtimeStats: {
    update() {},
    updateLatencyHealth(health) {
      latencyHealth = health;
    },
    updateTransportPressure(detail) {
      pressureReasons = detail?.reasons;
    },
    updateRenderDiagnostics() {}
  },
  elements: { renderEngine: { textContent: "" } },
  logError() {},
  formatRenderEngine: (engine) => engine ?? "",
  onHealth(health) {
    monitorHealth = health;
  }
});
const deadlineHealth = { responseDeadlineMisses: 2, lastTransportPressureReasons: ["deadline-miss"] };
monitorBridge.dispatchEvent(new CustomEvent("response-deadline-missed", { detail: { health: deadlineHealth } }));
assert(monitorHealth === deadlineHealth && latencyHealth === deadlineHealth, "browser demo monitor updates health from response deadline events");
assert(pressureReasons?.join(",") === "deadline-miss", "browser demo monitor surfaces deadline-miss pressure");
const timeoutTripHealth = { unhealthyReason: "process-timeout", bypassed: true };
monitorBridge.dispatchEvent(new CustomEvent("process-timeout-tripped", { detail: { health: timeoutTripHealth } }));
assert(monitorHealth === timeoutTripHealth && latencyHealth === timeoutTripHealth, "browser demo monitor updates from process-timeout trip events");

console.log("Browser demo engine control smoke checks passed.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
