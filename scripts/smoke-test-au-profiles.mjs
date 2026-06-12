export function assertAudioUnitHostProfiles({ assert, plugins }) {
  const nativeAuEffect = plugins.find((plugin) => plugin.pluginId === "au-reg:appl:aufx:lpas");
  assert(nativeAuEffect?.hostable === true, "listPlugins exposes an installed Apple AU effect as hostable");
  assert(!("diagnostics" in nativeAuEffect), "hostable AU metadata does not expose scanner diagnostics");
  assert(
    nativeAuEffect.metadata?.componentManufacturer === "appl" &&
      nativeAuEffect.metadata?.componentType === "aufx" &&
      nativeAuEffect.metadata?.componentSubType === "lpas" &&
      nativeAuEffect.metadata?.audioUnitHostProfile === "realtime-main-bus" &&
      nativeAuEffect.metadata?.stableId === "appl:aufx:lpas",
    "hostable AU metadata exposes bounded AudioComponent class identifiers"
  );

  assertRealtimeAudioUnitProfile(
    assert,
    plugins,
    "au-reg:appl:aufc:conv",
    "realtime-format-converter",
    "AUConverter"
  );
  assertRealtimeAudioUnitProfile(
    assert,
    plugins,
    "au-reg:appl:aufc:merg",
    "realtime-multi-source-merger",
    "AUMerger"
  );
  assertRealtimeAudioUnitProfile(
    assert,
    plugins,
    "au-reg:appl:aufc:splt",
    "realtime-multi-output-splitter",
    "AUSplitter"
  );

  return nativeAuEffect;
}

function assertRealtimeAudioUnitProfile(assert, plugins, pluginId, profile, displayName) {
  const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
  assert(
    plugin?.hostable === true &&
      plugin.metadata?.audioUnitHostProfile === profile,
    `listPlugins exposes ${displayName} with a bounded ${profile} profile`
  );
}
