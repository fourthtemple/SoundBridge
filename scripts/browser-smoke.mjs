import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = loadPlaywright();
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? "dev-token";
const DEMO_URL = `http://${process.env.SOUNDBRIDGE_DEMO_HOST ?? "127.0.0.1"}:${process.env.SOUNDBRIDGE_DEMO_PORT ?? "5173"}`;

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"]
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });

  await page.goto(DEMO_URL, { waitUntil: "networkidle" });
  await page.locator("#pairingToken").fill(PAIRING_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(() => document.querySelector("#connectionStatus")?.textContent === "Paired");
  await page.waitForFunction(() => /AU(\/VST3)? host \+ examples|AU\/VST\/LV2 host ready|AU\/VST\/LV2 (bundle )?examples/.test(document.querySelector("#capabilityStatus")?.textContent ?? ""));
  const capabilityTitle = await page.locator("#capabilityStatus").getAttribute("title");
  assert(/VST3 SDK host worker is available/.test(capabilityTitle ?? ""), "Browser demo exposes native VST3 host-status notes.");
  assert(/Audio Unit scanner/.test(capabilityTitle ?? ""), "Browser demo exposes native AU host-status notes.");
  assert(/LV2 (scanner|audio\/control host|host worker)|Basic LV2/.test(capabilityTitle ?? ""), "Browser demo exposes native LV2 host-status notes.");

  const options = await readPluginOptions(page);

  assert(
    options.some((option) => option.format === "vst3" && option.kind === "instrument" && /example (bundle|built-in example)/.test(option.text)),
    "Browser demo listed a VST3 example instrument."
  );
  assert(
    options.some((option) => option.format === "au" && option.kind === "instrument" && /example (bundle|built-in example)/.test(option.text)),
    "Browser demo listed an AU example instrument."
  );
  assert(
    options.some((option) => option.format === "lv2" && option.kind === "instrument" && /example (bundle|built-in example)/.test(option.text)),
    "Browser demo listed an LV2 example instrument."
  );
  for (const option of options.filter((candidate) => /scan only/.test(candidate.text))) {
    assert(option.hostable === "false", "Browser demo marks scan-only plugins as non-hostable.");
    assert(option.disabled === true, "Browser demo disables scan-only plugin options.");
  }
  const pluginStatus = await page.locator("#pluginStatus").textContent();
  assert(/playable/.test(pluginStatus ?? ""), "Browser demo reports playable plugin count.");
  assert(/scan only/.test(pluginStatus ?? ""), "Browser demo reports scan-only plugin count.");

  const grantAwareOption = options.find((option) => option.hostable !== "false" && option.fileGrantOperations.includes("restoreState"));
  if (grantAwareOption) {
    await page.locator("#pluginSelect").selectOption(grantAwareOption.value);
    await assertFileGrantControls(page, grantAwareOption, "grant-aware plugin");
  }

  for (const format of ["vst3", "au", "lv2"]) {
    const formatOptions = format === "vst3" ? options : await reconnectDemo(page);
    const option = formatOptions.find((candidate) => candidate.format === format && candidate.kind === "instrument" && candidate.hostable !== "false");
    assert(option, `${format} example instrument option exists.`);

    await page.locator("#pluginSelect").selectOption(option.value);
    await assertFileGrantControls(page, option, `${format} example instrument`);
    await assertProgramDataControls(page, { expectInstanceTargets: false, label: `${format} before instance` });
    await page.getByRole("button", { name: "Create Instance" }).click();
    await page.waitForFunction(() => document.querySelector("#engineStatus")?.textContent === "Engine running");
    await playKeyUntilProcessed(page, format);
    await page.waitForFunction(
      () => document.querySelector("#renderEngine")?.textContent === "Bundle worker",
      undefined,
      { timeout: 5000 }
    );
    await assertRealtimeStats(page);
    await assertRetryControl(page);
    const hasProgramDataTargets = await assertProgramDataControls(page, {
      expectInstanceTargets: format === "vst3",
      label: `${format} instance`
    });
    if (hasProgramDataTargets) {
      await assertVst3ProgramDataRoundTrip(page);
    }
    await assertPresetApply(page, format);
    await assertParameterStateRoundTrip(page, format);
  }

  console.log("SoundBridge browser smoke test passed.");
} finally {
  await browser.close();
}

async function processedBlocks(page) {
  return Number(await page.locator("#processedBlocks").textContent());
}

async function renderedBlocks(page) {
  return Number(await page.locator("#renderedBlocks").textContent());
}

async function reconnectDemo(page) {
  await page.goto(DEMO_URL, { waitUntil: "networkidle" });
  await page.locator("#pairingToken").fill(PAIRING_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(() => document.querySelector("#connectionStatus")?.textContent === "Paired");
  await page.waitForFunction(() => /AU(\/VST3)? host \+ examples|AU\/VST\/LV2 host ready|AU\/VST\/LV2 (bundle )?examples/.test(document.querySelector("#capabilityStatus")?.textContent ?? ""));
  return readPluginOptions(page);
}

async function readPluginOptions(page) {
  return page.locator("#pluginSelect option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.value,
      text: node.textContent ?? "",
      kind: node.dataset.kind,
      format: node.dataset.format,
      hostable: node.dataset.hostable,
      fileGrantOperations: node.dataset.fileGrantOperations ?? "",
      disabled: node.disabled
    }))
  );
}

async function playKeyUntilProcessed(page, label) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.waitForTimeout(100);
    const beforeProcessed = await processedBlocks(page);
    const beforeRendered = await renderedBlocks(page);
    const key = page.locator('.piano-key[data-note="60"]');
    if (attempt === 0) {
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.down((await key.getAttribute("data-key")) ?? "a");
      await page.waitForTimeout(500);
      await page.keyboard.up((await key.getAttribute("data-key")) ?? "a");
    } else {
      const box = await key.boundingBox();
      assert(box, "Keyboard key is visible.");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(500);
      await page.mouse.up();
    }
    try {
      await page.waitForFunction(
        ({ previousProcessed, previousRendered }) => {
          const currentProcessed = Number(document.querySelector("#processedBlocks")?.textContent ?? 0);
          const currentRendered = Number(document.querySelector("#renderedBlocks")?.textContent ?? 0);
          return (currentProcessed > 0 && currentProcessed !== previousProcessed) || currentRendered > previousRendered || currentRendered > 0;
        },
        { previousProcessed: beforeProcessed, previousRendered: beforeRendered },
        { timeout: 5000 }
      );
      return;
    } catch (error) {
      if (attempt === 1) {
        const detail = await page.evaluate(() => ({
          processedBlocks: document.querySelector("#processedBlocks")?.textContent ?? "",
          renderedBlocks: document.querySelector("#renderedBlocks")?.textContent ?? "",
          engineStatus: document.querySelector("#engineStatus")?.textContent ?? "",
          renderEngine: document.querySelector("#renderEngine")?.textContent ?? "",
          renderDurationMs: document.querySelector("#renderDurationMs")?.textContent ?? "",
          renderBudgetMs: document.querySelector("#renderBudgetMs")?.textContent ?? "",
          log: document.querySelector("#log")?.value ?? "",
          selectedPlugin: document.querySelector("#pluginSelect")?.selectedOptions[0]?.textContent ?? ""
        }));
        throw new Error(`${label} key path did not process audio: ${JSON.stringify(detail)}`, { cause: error });
      }
    }
  }
}

async function assertRealtimeStats(page) {
  for (const selector of [
    "#latencyDecreases",
    "#fallbackOutputBlocks",
    "#reportedLatencyMs",
    "#responseDeadlineLeadSamples",
    "#responseJitterSamples",
    "#sharedDroppedBlocks",
    "#latencyRecoveryBlocks",
    "#renderedBlocks",
    "#renderDurationMs",
    "#renderBudgetMs"
  ]) {
    const text = await page.locator(selector).textContent();
    assert(/^-?\d+(\.\d+)?(\/-?\d+(\.\d+)?)?$/.test((text ?? "").trim()), `${selector} reports realtime stats.`);
  }
  const renderBudgetStatus = await page.locator("#renderBudgetStatus").textContent();
  assert(/^(OK|Over)$/.test((renderBudgetStatus ?? "").trim()), "Render budget status reports live render pressure.");
  const latencyDirection = await page.locator("#latencyDirection").textContent();
  assert(/^(None|Changed|Increased|Decreased)$/.test((latencyDirection ?? "").trim()), "Latency direction reports live latency health.");
  const fallbackReason = await page.locator("#lastFallbackReason").textContent();
  assert(/^(None|bypass|latency-safety|underrun)$/.test((fallbackReason ?? "").trim()), "Fallback reason reports live worklet fallback output.");
  const pressureReasons = await page.locator("#transportPressureReasons").textContent();
  assert(/^(None|[a-z-]+(, [a-z-]+)*)$/.test((pressureReasons ?? "").trim()), "Pressure reason reports latest live transport pressure.");
  const sharedQueued = await page.locator("#sharedQueuedBlocks").textContent();
  assert(/^-?\d+\/-?\d+( peak -?\d+\/-?\d+)?$/.test((sharedQueued ?? "").trim()), "Shared queue reports current and peak live pressure.");
}

async function assertRetryControl(page) {
  const disabled = await page.locator("#retryEngineButton").evaluate((button) => button.disabled);
  if (disabled) return;
  await page.getByRole("button", { name: "Retry Engine" }).click();
  await page.waitForFunction(() => (document.querySelector("#log")?.value ?? "") === "Engine retry requested.");
}

async function assertFileGrantControls(page, option, label) {
  const operations = new Set(String(option.fileGrantOperations ?? "").split(",").filter(Boolean));
  const controls = [
    ["#grantRestoreStateButton", "restoreState"],
    ["#grantLoadPresetButton", "loadPreset"],
    ["#grantSaveStateButton", "saveStateDirectory"]
  ];
  for (const [selector, operation] of controls) {
    const disabled = await page.locator(selector).evaluate((button) => button.disabled);
    assert(disabled === !operations.has(operation), `${label} ${operation} grant action is gated by plugin metadata.`);
  }
}

async function assertProgramDataControls(page, { expectInstanceTargets, label }) {
  const optionCount = await page.locator("#programDataSelect option").count();
  const selectDisabled = await page.locator("#programDataSelect").evaluate((select) => select.disabled);
  const exportDisabled = await page.locator("#exportProgramDataButton").evaluate((button) => button.disabled);
  const restoreDisabled = await page.locator("#restoreProgramDataButton").evaluate((button) => button.disabled);
  const textDisabled = await page.locator("#programDataText").evaluate((textarea) => textarea.disabled);

  if (expectInstanceTargets && optionCount > 0) {
    assert(selectDisabled === false, `${label} exposes selectable VST3 program-data targets.`);
    assert(exportDisabled === false, `${label} can export daemon-listed VST3 program data.`);
    assert(restoreDisabled === true, `${label} keeps VST3 program restore disabled until an envelope exists.`);
    assert(textDisabled === false, `${label} keeps the VST3 program envelope field available.`);
    return true;
  }

  assert(selectDisabled === true, `${label} keeps VST3 program target selection disabled.`);
  assert(exportDisabled === true, `${label} keeps VST3 program export disabled.`);
  assert(restoreDisabled === true, `${label} keeps VST3 program restore disabled.`);
  assert(textDisabled === true, `${label} keeps the VST3 program envelope field disabled.`);
  return false;
}

async function assertVst3ProgramDataRoundTrip(page) {
  const label = await page.locator("#programDataSelect option").first().textContent();
  await page.locator("#programDataText").fill("");
  await page.getByRole("button", { name: "Export Program" }).click();
  await page.waitForFunction(() => /^[A-Za-z0-9+/]+={0,2}$/.test(document.querySelector("#programDataText")?.value ?? ""));
  const exported = await page.locator("#programDataText").inputValue();
  assert(exported.length > 0 && exported.length < 512 * 1024, "VST3 program-data export returns a bounded opaque envelope.");

  const restoreDisabled = await page.locator("#restoreProgramDataButton").evaluate((button) => button.disabled);
  assert(restoreDisabled === false, "VST3 program-data restore is enabled after an envelope export.");
  await page.getByRole("button", { name: "Restore Program" }).click();
  await page.waitForFunction(
    () => (document.querySelector("#log")?.value ?? "").startsWith("VST3 program data restored."),
    undefined,
    { timeout: 3000 }
  );
  assert(Boolean(label), "VST3 program-data smoke used a daemon-listed program target.");
}

async function assertParameterStateRoundTrip(page, format) {
  const gainSlider = page.locator('.parameter-row[data-parameter-id="gain"] input[type="range"]');
  await gainSlider.waitFor({ state: "visible", timeout: 3000 });

  await setSliderValue(page, "gain", "0.25");
  await page.locator("#stateText").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector("#stateText")?.value ?? "").length > 0);
  const savedState = await page.locator("#stateText").inputValue();

  await setSliderValue(page, "gain", "0.9");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.parameter-row[data-parameter-id="gain"] input[type="range"]')?.value === "0.25",
    undefined,
    { timeout: 3000 }
  );
  assert((await page.locator("#stateText").inputValue()) === savedState, `${format} state text survived restore.`);
}

async function assertPresetApply(page, format) {
  await page.waitForFunction(() => document.querySelectorAll("#presetSelect option").length >= 2);
  await page.locator("#presetSelect").selectOption({ index: 1 });
  const presetName = await page.locator("#presetSelect option").nth(1).textContent();
  const presetParameterDataset = await page.locator("#presetSelect option").nth(1).getAttribute("data-parameters");
  assert(presetParameterDataset === null, `${format} preset option does not expose a browser-side parameter map.`);
  await setSliderValue(page, "gain", "0.1");
  await page.getByRole("button", { name: "Apply Preset" }).click();
  await page.waitForFunction(
    () => {
      const value = document.querySelector('.parameter-row[data-parameter-id="gain"] input[type="range"]')?.value;
      return value !== undefined && value !== "0.1";
    },
    undefined,
    { timeout: 3000 }
  );
  const logText = await page.locator("#log").evaluate((element) => element.value || element.textContent || "");
  assert(
    logText.startsWith(`Preset applied: ${presetName}`) && /\(\d+ parameters?\)$/.test(logText),
    `${format} preset applied through browser UI by daemon preset id.`
  );
}

async function setSliderValue(page, parameterId, value) {
  await page
    .locator(`.parameter-row[data-parameter-id="${parameterId}"] input[type="range"]`)
    .evaluate(
      (slider, nextValue) => {
        slider.value = nextValue;
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      },
      value
    );
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    {
      selector: `.parameter-row[data-parameter-id="${parameterId}"] input[type="range"]`,
      expected: value
    },
    { timeout: 3000 }
  );
  await page.waitForTimeout(100);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {}

  return require("/opt/homebrew/lib/node_modules/playwright");
}
