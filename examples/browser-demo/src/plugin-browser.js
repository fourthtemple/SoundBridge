export function createPluginBrowser({
  elements,
  client,
  controlsEnabled,
  ensureInstance,
  getInstanceId,
  refreshParameters,
  log,
  logError
}) {
  const pluginMetadataById = new Map();

  function renderOptions(plugins) {
    elements.pluginSelect.replaceChildren();
    pluginMetadataById.clear();
    const summary = {
      total: plugins.length,
      hostable: 0,
      scanOnly: 0
    };

    for (const plugin of plugins) {
      pluginMetadataById.set(plugin.pluginId, plugin);
      const option = document.createElement("option");
      option.value = plugin.pluginId;
      option.dataset.format = plugin.format ?? "unknown";
      option.dataset.kind = plugin.kind ?? "unknown";
      option.dataset.source = plugin.source ?? "unknown";
      option.dataset.hostable = String(plugin.hostable !== false);
      option.dataset.hostUnavailableReason = plugin.hostUnavailableReason ?? "";
      option.dataset.fileGrantOperations = Array.isArray(plugin.fileGrantOperations)
        ? plugin.fileGrantOperations.join(",")
        : "";
      option.disabled = plugin.hostable === false;
      if (plugin.hostUnavailableReason) {
        option.title = plugin.hostUnavailableReason;
      }
      if (plugin.hostable === false) {
        summary.scanOnly += 1;
      } else {
        summary.hostable += 1;
      }
      option.textContent = `[${formatPluginFormat(plugin.format)}] ${plugin.vendor} ${plugin.name}${formatPluginSource(plugin)}`;
      elements.pluginSelect.append(option);
    }

    elements.pluginSelect.dataset.totalCount = String(summary.total);
    elements.pluginSelect.dataset.hostableCount = String(summary.hostable);
    elements.pluginSelect.dataset.scanOnlyCount = String(summary.scanOnly);
    updateStatus();
    updatePresetControls();
    updateFileGrantControls();
  }

  function updateAll() {
    updateStatus();
    updatePresetControls();
    updateFileGrantControls();
  }

  function updatePresetControls() {
    const plugin = selectedPlugin();
    const presets = Array.isArray(plugin?.presets) ? plugin.presets : [];
    elements.presetSelect.replaceChildren();

    for (const preset of presets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.name;
      elements.presetSelect.append(option);
    }

    const enabled = controlsEnabled() && presets.length > 0 && plugin?.hostable !== false;
    elements.presetSelect.disabled = !enabled;
    elements.applyPresetButton.disabled = !enabled;
  }

  function updateFileGrantControls() {
    const plugin = selectedPlugin();
    const enabled = controlsEnabled() && plugin?.hostable !== false;
    elements.grantRestoreStateButton.disabled = !(enabled && hasFileGrantOperation("restoreState"));
    elements.grantLoadPresetButton.disabled = !(enabled && hasFileGrantOperation("loadPreset"));
    elements.grantSaveStateButton.disabled = !(enabled && hasFileGrantOperation("saveStateDirectory"));
  }

  function selectedPlugin() {
    return pluginMetadataById.get(elements.pluginSelect.value);
  }

  function hasFileGrantOperation(operation) {
    const plugin = selectedPlugin();
    return Array.isArray(plugin?.fileGrantOperations) && plugin.fileGrantOperations.includes(operation);
  }

  function updateStatus() {
    const selected = elements.pluginSelect.selectedOptions[0];
    const total = Number(elements.pluginSelect.dataset.totalCount ?? 0);
    const hostable = Number(elements.pluginSelect.dataset.hostableCount ?? 0);
    const scanOnly = Number(elements.pluginSelect.dataset.scanOnlyCount ?? 0);

    if (!selected || total === 0) {
      elements.pluginStatus.textContent = "No plugins scanned";
      return;
    }

    const selectedState =
      selected.dataset.hostable === "false"
        ? "scan only"
        : formatPluginSourceLabel(selected.dataset.source);
    elements.pluginStatus.textContent = `${hostable} playable \u00b7 ${scanOnly} scan only \u00b7 selected ${selectedState}`;
  }

  async function applySelectedPreset() {
    const activeClient = client();
    if (!activeClient) {
      return;
    }

    const plugin = selectedPlugin();
    const preset = plugin?.presets?.find((candidate) => candidate.id === elements.presetSelect.value);
    if (!preset) {
      return;
    }

    try {
      await ensureInstance();
      const instanceId = getInstanceId();
      if (!instanceId) {
        return;
      }
      const applied = await activeClient.setPreset(instanceId, preset.id);
      const { parameters } = await activeClient.getParameters(instanceId);
      await refreshParameters(parameters);
      log(`Preset applied: ${preset.name} (${applied.parameterCount} parameter${applied.parameterCount === 1 ? "" : "s"})`);
    } catch (error) {
      logError(error);
    }
  }

  return {
    applySelectedPreset,
    hasFileGrantOperation,
    renderOptions,
    selectedPlugin,
    updateAll,
    updateFileGrantControls,
    updatePresetControls,
    updateStatus
  };
}

function formatPluginSourceLabel(source) {
  switch (source) {
    case "example-bundle":
      return "example bundle";
    case "builtin-example":
      return "built-in example";
    case "mock":
      return "mock";
    case "scan":
      return "installed";
    default:
      return "plugin";
  }
}

function formatPluginFormat(format) {
  switch (format) {
    case "vst3":
      return "VST3";
    case "au":
      return "AU";
    case "lv2":
      return "LV2";
    case "mock":
      return "Mock";
    default:
      return "Unknown";
  }
}

function formatPluginSource(plugin) {
  if (plugin.hostable === false) {
    return " \u00b7 scan only";
  }

  switch (plugin.source) {
    case "example-bundle":
      return " \u00b7 example bundle";
    case "builtin-example":
      return " \u00b7 built-in example";
    case "scan":
      return " \u00b7 installed";
    default:
      return "";
  }
}
