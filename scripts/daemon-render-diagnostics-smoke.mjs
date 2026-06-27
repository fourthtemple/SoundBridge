import {
  boundedRenderTimeoutMs,
  recordRenderSuccess,
  renderBudgetDiagnostics,
  renderTimeoutProtocolError
} from "./daemon-render-diagnostics.mjs";

let passed = 0;
const failures = [];

const instance = {
  instanceId: "inst-live",
  pluginId: "vst3:test-plugin",
  format: "vst3",
  renderEngine: "native-vst3"
};
const timeoutError = new Error("worker_command_timeout: worker command timed out after 3ms");
const firstTimeout = renderTimeoutProtocolError(
  instance,
  timeoutError,
  { blockId: 12, frames: 128, renderTimeoutMs: 3.7, sampleRate: 48000 },
  protocolError
);
check(firstTimeout?.code === "render_timeout", "worker command timeout maps to render_timeout");
check(firstTimeout.details.renderTimeoutMs === 3, "render timeout details clamp timeout milliseconds");
check(firstTimeout.details.renderTimeouts === 1, "render timeout details count total misses");
check(firstTimeout.details.consecutiveRenderTimeouts === 1, "render timeout details count consecutive misses");
check(firstTimeout.details.workerTerminated === true, "render timeout details report worker termination");

const secondTimeout = renderTimeoutProtocolError(
  instance,
  timeoutError,
  { blockId: 13, frames: 512, renderTimeoutMs: 5, sampleRate: 96000 },
  protocolError
);
check(secondTimeout.details.renderTimeouts === 2, "render timeout counter increments");
check(secondTimeout.details.consecutiveRenderTimeouts === 2, "consecutive render timeout counter increments");
recordRenderSuccess(instance);
check(instance.consecutiveRenderTimeouts === 0, "successful render clears consecutive timeout counter");
check(
  renderTimeoutProtocolError(instance, new Error("worker_stdout_malformed"), {}, protocolError) === undefined,
  "non-timeout worker errors stay on the generic error path"
);
check(
  renderTimeoutProtocolError(instance, timeoutError, {}, protocolError) === undefined,
  "worker command timeouts without a live render deadline stay generic"
);
check(boundedRenderTimeoutMs(0) === undefined, "zero render timeout disables the deadline");
check(boundedRenderTimeoutMs(60001) === 60000, "render timeout milliseconds stay bounded");
const budget = renderBudgetDiagnostics(3, 128, 48000);
check(budget.renderBudgetMs === 2.667 && budget.renderBudgetExceeded === true, "render budget diagnostics are bounded");

console.log(`Daemon render diagnostics smoke checks passed (${passed} checks).`);
if (failures.length > 0) {
  process.exit(1);
}

function protocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function check(condition, message) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(message);
  console.log(`FAIL - ${message}`);
}
