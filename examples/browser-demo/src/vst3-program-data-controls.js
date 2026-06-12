export function createVst3ProgramDataControls({
  elements,
  client,
  getInstanceId,
  getPlugin,
  controlsEnabled,
  refreshParameters,
  log,
  logError
}) {
  const { select, exportButton, restoreButton, text } = elements;

  exportButton.addEventListener("click", () => {
    void exportProgramData();
  });

  restoreButton.addEventListener("click", () => {
    void restoreProgramData();
  });

  text.addEventListener("input", () => {
    update();
  });

  function update() {
    const targets = vst3ProgramDataTargets(getPlugin());
    const selectedValue = select.value;
    select.replaceChildren();

    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.value;
      option.dataset.programListId = String(target.programListId);
      option.dataset.programIndex = String(target.programIndex);
      option.textContent = target.label;
      option.selected = target.value === selectedValue;
      select.append(option);
    }

    const instanceReady = Boolean(getInstanceId());
    const enabled = controlsEnabled() && instanceReady && targets.length > 0;
    select.disabled = !enabled;
    exportButton.disabled = !enabled;
    restoreButton.disabled = !(enabled && text.value.trim().length > 0);
    text.disabled = !enabled;
  }

  function clearEnvelope() {
    text.value = "";
    update();
  }

  async function exportProgramData() {
    try {
      const instanceId = requireInstanceId(getInstanceId());
      const target = requireProgramTarget(selectedProgramTarget());
      const response = await client().getVst3ProgramData(instanceId, target.programListId, target.programIndex);
      text.value = response.programData ?? "";
      update();
      log(`VST3 program data exported: ${target.label}`);
    } catch (error) {
      logError(error);
    }
  }

  async function restoreProgramData() {
    try {
      const instanceId = requireInstanceId(getInstanceId());
      const programData = text.value.trim();
      if (!programData) {
        return;
      }

      const response = await client().setVst3ProgramData(instanceId, programData);
      await refreshParameters(response.parameters);
      log("VST3 program data restored.");
    } catch (error) {
      logError(error);
    }
  }

  return {
    clearEnvelope,
    update
  };

  function selectedProgramTarget() {
    const option = select.selectedOptions[0];
    if (!option) {
      return undefined;
    }

    return {
      programListId: Number(option.dataset.programListId),
      programIndex: Number(option.dataset.programIndex),
      label: option.textContent ?? "Program"
    };
  }
}

function requireInstanceId(instanceId) {
  if (!instanceId) {
    throw new Error("Create a VST3 plugin instance first.");
  }
  return instanceId;
}

function requireProgramTarget(target) {
  if (!target) {
    throw new Error("Select a VST3 program-data target first.");
  }
  return target;
}

function vst3ProgramDataTargets(plugin) {
  if (plugin?.format !== "vst3" || !Array.isArray(plugin.vst3ProgramLists)) {
    return [];
  }

  const targets = [];
  for (const programList of plugin.vst3ProgramLists) {
    if (programList?.programDataSupported !== true || !Array.isArray(programList.programs)) {
      continue;
    }
    for (const program of programList.programs) {
      targets.push({
        value: `${programList.id}:${program.index}`,
        programListId: programList.id,
        programIndex: program.index,
        label: `${programList.name ?? "Programs"} · ${program.name ?? `Program ${program.index + 1}`}`
      });
    }
  }
  return targets;
}
