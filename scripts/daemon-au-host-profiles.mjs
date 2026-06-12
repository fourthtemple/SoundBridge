export const AUDIO_UNIT_HOST_PROFILES = Object.freeze({
  REALTIME_MAIN_BUS: "realtime-main-bus",
  REALTIME_FORMAT_CONVERTER: "realtime-format-converter",
  REALTIME_MULTI_SOURCE_MERGER: "realtime-multi-source-merger",
  REALTIME_MULTI_OUTPUT_SPLITTER: "realtime-multi-output-splitter",
  OFFLINE_RENDER: "offline-render",
  MULTI_SOURCE_FORMAT_CONVERTER: "multi-source-format-converter",
  MULTI_OUTPUT_SPLITTER: "multi-output-splitter"
});

export function classifyAudioUnitHostProfile(plugin) {
  if (plugin?.format !== "au") {
    return {};
  }

  const diagnostics = plugin.diagnostics ?? {};
  const componentType = String(diagnostics.componentType ?? plugin.metadata?.componentType ?? "");
  const componentSubType = String(diagnostics.componentSubType ?? plugin.metadata?.componentSubType ?? "");
  const componentManufacturer = String(diagnostics.componentManufacturer ?? plugin.metadata?.componentManufacturer ?? "");

  if (!componentType || !componentSubType || !componentManufacturer) {
    return {};
  }

  if (componentType === "auol") {
    return {
      profile: AUDIO_UNIT_HOST_PROFILES.OFFLINE_RENDER,
      hostUnavailableReason: "This Audio Unit is an offline effect and requires a future offline-render host profile."
    };
  }

  if (componentManufacturer === "appl" && componentType === "aufc" && componentSubType === "amix") {
    return {
      profile: AUDIO_UNIT_HOST_PROFILES.MULTI_SOURCE_FORMAT_CONVERTER,
      hostUnavailableReason:
        "AUAudioMix requires a dedicated multi-source format-converter profile beyond the current bounded realtime Audio Unit worker."
    };
  }

  if (componentManufacturer === "appl" && componentType === "aufc" && componentSubType === "merg") {
    return {
      profile: AUDIO_UNIT_HOST_PROFILES.REALTIME_MULTI_SOURCE_MERGER
    };
  }

  if (componentManufacturer === "appl" && componentType === "aufc" && componentSubType === "splt") {
    return {
      profile: AUDIO_UNIT_HOST_PROFILES.REALTIME_MULTI_OUTPUT_SPLITTER
    };
  }

  if (componentManufacturer === "appl" && componentType === "aufc") {
    return {
      profile: AUDIO_UNIT_HOST_PROFILES.REALTIME_FORMAT_CONVERTER
    };
  }

  if (componentManufacturer === "appl" && componentType === "aumx" && componentSubType === "mspl") {
    return {
      profile: AUDIO_UNIT_HOST_PROFILES.MULTI_OUTPUT_SPLITTER,
      hostUnavailableReason:
        "AUMultiSplitter requires a dedicated multi-output mixer/splitter profile beyond the current bounded realtime Audio Unit worker."
    };
  }

  return {
    profile: AUDIO_UNIT_HOST_PROFILES.REALTIME_MAIN_BUS
  };
}
