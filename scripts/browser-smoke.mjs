import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = loadPlaywright();
const PAIRING_TOKEN = process.env.SOUNDBRIDGE_PAIRING_TOKEN ?? "dev-token";

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

  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.locator("#pairingToken").fill(PAIRING_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(() => document.querySelector("#connectionStatus")?.textContent === "Paired");
  await page.waitForFunction(() => /AU(\/VST3)? host \+ examples|AU\/VST\/LV2 host ready|AU\/VST\/LV2 (bundle )?examples/.test(document.querySelector("#capabilityStatus")?.textContent ?? ""));
  const capabilityTitle = await page.locator("#capabilityStatus").getAttribute("title");
  assert(/VST3 SDK host worker is available/.test(capabilityTitle ?? ""), "Browser demo exposes native VST3 host-status notes.");
  assert(/Audio Unit scanner/.test(capabilityTitle ?? ""), "Browser demo exposes native AU host-status notes.");
  assert(/LV2 (scanner|audio\/control host|host worker)|Basic LV2/.test(capabilityTitle ?? ""), "Browser demo exposes native LV2 host-status notes.");

  const options = await page.locator("#pluginSelect option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.value,
      text: node.textContent ?? "",
      kind: node.dataset.kind,
      format: node.dataset.format,
      hostable: node.dataset.hostable,
      disabled: node.disabled
    }))
  );

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

  for (const format of ["vst3", "au", "lv2"]) {
    const option = options.find((candidate) => candidate.format === format && candidate.kind === "instrument" && candidate.hostable !== "false");
    assert(option, `${format} example instrument option exists.`);

    await page.locator("#pluginSelect").selectOption(option.value);
    await page.getByRole("button", { name: "Create Instance" }).click();
    await page.waitForFunction(() => document.querySelector("#engineStatus")?.textContent === "Engine running");
    await assertPresetApply(page, format);
    await assertParameterStateRoundTrip(page, format);

    const before = await processedBlocks(page);
    const key = page.locator('.piano-key[data-note="60"]');
    const box = await key.boundingBox();
    assert(box, "Keyboard key is visible.");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.up();

    await page.waitForFunction(
      (previous) => Number(document.querySelector("#processedBlocks")?.textContent ?? 0) > previous,
      before,
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => document.querySelector("#renderEngine")?.textContent === "Bundle worker",
      undefined,
      { timeout: 5000 }
    );
  }

  console.log("SoundBridge browser smoke test passed.");
} finally {
  await browser.close();
}

async function processedBlocks(page) {
  return Number(await page.locator("#processedBlocks").textContent());
}

async function assertParameterStateRoundTrip(page, format) {
  const gainSlider = page.locator('.parameter-row[data-parameter-id="gain"] input[type="range"]');
  await gainSlider.waitFor({ state: "visible", timeout: 3000 });

  await setSliderValue(page, "gain", "0.25");
  await page.locator("#stateText").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => (document.querySelector("#stateText")?.value ?? "").length > 0);
  const savedState = await page.locator("#stateText").inputValue();

  await setSliderValue(page, "gain", "0.9");
  await page.getByRole("button", { name: "Restore" }).click();
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
  const preset = await page.locator("#presetSelect option").nth(1).evaluate((option) => ({
    name: option.textContent ?? "",
    parameters: JSON.parse(option.dataset.parameters ?? "{}")
  }));
  await page.getByRole("button", { name: "Apply Preset" }).click();
  await page.waitForFunction(
    ({ expected }) => document.querySelector('.parameter-row[data-parameter-id="gain"] input[type="range"]')?.value === expected,
    { expected: String(preset.parameters.gain) },
    { timeout: 3000 }
  );
  const logText = await page.locator("#log").evaluate((element) => element.value || element.textContent || "");
  assert(logText === `Preset applied: ${preset.name}`, `${format} preset applied through browser UI.`);
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
