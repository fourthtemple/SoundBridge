export function setCapabilityStatus(element, capabilities) {
  const formats = capabilities?.pluginFormats ?? {};
  const vst3 = formats.vst3 ?? {};
  const au = formats.au ?? {};
  const lv2 = formats.lv2 ?? {};
  const fullNativeHost = vst3.host === true && au.host === true && lv2.host === true;
  const nativeExampleHost = vst3.exampleHost === true && au.exampleHost === true && lv2.exampleHost === true;
  const playableExamples =
    nativeExampleHost ||
    (vst3.mockExamples === true && au.mockExamples === true && lv2.mockExamples === true);
  element.title = [vst3.notes, au.notes, lv2.notes].filter(Boolean).join(" ");

  if (fullNativeHost) {
    applyStatus(element, "AU/VST/LV2 host ready", "ready");
    return;
  }

  if (vst3.host === true && au.host === true && nativeExampleHost) {
    applyStatus(element, "AU/VST3 host + examples", "ready");
    return;
  }

  if (au.host === true && nativeExampleHost) {
    applyStatus(element, "AU host + examples", "ready");
    return;
  }

  if (nativeExampleHost) {
    applyStatus(element, "AU/VST/LV2 bundle examples", "ready");
    return;
  }

  if (playableExamples) {
    applyStatus(element, "AU/VST/LV2 examples ready", "ready");
    return;
  }

  if (vst3.scan === true || au.scan === true || lv2.scan === true) {
    applyStatus(element, "AU/VST/LV2 scan only", "warn");
    return;
  }

  applyStatus(element, "Host unavailable", "");
}

function applyStatus(element, text, mode) {
  element.textContent = text;
  element.classList.toggle("ready", mode === "ready");
  element.classList.toggle("warn", mode === "warn");
}
