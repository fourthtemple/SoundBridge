import fs from "node:fs";
import path from "node:path";

const MAX_NATIVE_STATE_FILE_BYTES = 2 * Math.ceil((384 * 1024) / 3) * 4 + 32;

export async function probeFileGrantPresetLoad({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket,
  state
}) {
  const presetText = nativeStateFileText(plugin.format, state.state);
  if (!presetText) {
    result.fileGrantPresetLoad = "skipped";
    return;
  }
  const presetPath = path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}.preset`);
  fs.writeFileSync(presetPath, presetText, "utf8");
  let grantId = "";
  try {
    const grant = await phase(result, "createPresetFileGrant", () =>
      request(socket, "createFileGrant", { path: presetPath, purpose: "preset", access: "read", kind: "file" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachPresetFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "preset", access: "read", kind: "file" }, true, session)
    );
    const loaded = await phase(result, "useFileGrantLoadPreset", () =>
      request(socket, "useFileGrant", { instanceId, grantId, operation: "loadPreset" }, true, session)
    );
    assertProbe(loaded.applied === true, "bad_file_grant_preset_load", "file grant preset load was not applied");
    assertNoNativeLaunchData(loaded, "file grant preset response", assertProbe);
    result.fileGrantPresetLoad = "applied";
  } finally {
    if (grantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId }, true, session).catch(() => undefined);
    }
    fs.rmSync(presetPath, { force: true });
  }
}

export async function probeFileGrantStateRestore({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket,
  state
}) {
  const stateText = nativeStateFileText(plugin.format, state.state);
  if (!stateText) {
    result.fileGrantStateRestore = "skipped";
    return;
  }
  const statePath = path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}.state`);
  fs.writeFileSync(statePath, stateText, "utf8");
  let grantId = "";
  try {
    const grant = await phase(result, "createStateFileGrant", () =>
      request(socket, "createFileGrant", { path: statePath, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachStateFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    const restored = await phase(result, "useFileGrantRestoreState", () =>
      request(socket, "useFileGrant", { instanceId, grantId, operation: "restoreState" }, true, session)
    );
    assertProbe(restored.applied === true, "bad_file_grant_restore", "file grant state restore was not applied");
    assertNoNativeLaunchData(restored, "file grant restore response", assertProbe);
    result.fileGrantStateRestore = "applied";
  } finally {
    if (grantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId }, true, session).catch(() => undefined);
    }
    fs.rmSync(statePath, { force: true });
  }
}

export async function probeFileGrantStateSave({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  const stateDir = fs.mkdtempSync(path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}-save-`));
  let directoryGrantId = "";
  let fileGrantId = "";
  try {
    const directoryGrant = await phase(result, "createStateDirectoryGrant", () =>
      request(socket, "createFileGrant", { path: stateDir, purpose: "state", access: "readWrite", kind: "directory" }, true, session)
    );
    directoryGrantId = directoryGrant.grantId;
    await phase(result, "attachStateDirectoryGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId: directoryGrantId, purpose: "state", access: "readWrite", kind: "directory" }, true, session)
    );
    const saved = await phase(result, "useFileGrantSaveStateDirectory", () =>
      request(socket, "useFileGrant", { instanceId, grantId: directoryGrantId, operation: "saveStateDirectory" }, true, session)
    );
    assertProbe(saved.applied === true, "bad_file_grant_save", "file grant state save was not applied");
    assertNoNativeLaunchData(saved, "file grant save response", assertProbe);
    result.fileGrantStateSave = "applied";

    const savedFiles = fs.readdirSync(stateDir, { withFileTypes: true }).filter((entry) => entry.isFile());
    assertProbe(savedFiles.length === 1, "bad_file_grant_save_file", "file grant state save did not create exactly one state file");
    const savedPath = path.join(stateDir, savedFiles[0].name);
    const savedStats = fs.lstatSync(savedPath);
    assertProbe(savedStats.isFile(), "bad_file_grant_save_file", "saved state path is not a regular file");
    assertProbe(
      savedStats.size > 0 && savedStats.size <= MAX_NATIVE_STATE_FILE_BYTES,
      "bad_file_grant_save_file",
      "saved state file size is invalid"
    );

    const fileGrant = await phase(result, "createSavedStateFileGrant", () =>
      request(socket, "createFileGrant", { path: savedPath, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    fileGrantId = fileGrant.grantId;
    await phase(result, "attachSavedStateFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId: fileGrantId, purpose: "state", access: "read", kind: "file" }, true, session)
    );
    const restored = await phase(result, "useFileGrantRestoreSavedState", () =>
      request(socket, "useFileGrant", { instanceId, grantId: fileGrantId, operation: "restoreState" }, true, session)
    );
    assertProbe(restored.applied === true, "bad_file_grant_saved_restore", "saved file grant state restore was not applied");
    assertNoNativeLaunchData(restored, "saved file grant restore response", assertProbe);
    result.fileGrantSavedStateRestore = "applied";
  } finally {
    if (fileGrantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId: fileGrantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId: fileGrantId }, true, session).catch(() => undefined);
    }
    if (directoryGrantId) {
      await request(socket, "detachFileGrant", { instanceId, grantId: directoryGrantId }, true, session).catch(() => undefined);
      await request(socket, "revokeFileGrant", { grantId: directoryGrantId }, true, session).catch(() => undefined);
    }
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
}

export async function probeFileGrantSampleLoad({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  if (!pluginAdvertisesFileGrantOperation(plugin, "loadSample")) {
    result.fileGrantSampleLoad = "skipped-unadvertised";
    return;
  }
  const samplePath = path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}.wav`);
  fs.writeFileSync(samplePath, "SoundBridge sample fixture\n", "utf8");
  let grantId = "";
  try {
    const grant = await phase(result, "createSampleFileGrant", () =>
      request(socket, "createFileGrant", { path: samplePath, purpose: "sample", access: "read", kind: "file" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachSampleFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "sample", access: "read", kind: "file" }, true, session)
    );
    const loaded = await phase(result, "useFileGrantLoadSample", () =>
      request(socket, "useFileGrant", { instanceId, grantId, operation: "loadSample" }, true, session)
    );
    assertProbe(loaded.applied === true, "bad_file_grant_sample_load", "file grant sample load was not applied");
    assertNoNativeLaunchData(loaded, "file grant sample response", assertProbe);
    result.fileGrantSampleLoad = "applied";
  } finally {
    await detachAndRevokeGrant({ grantId, instanceId, request, session, socket });
    fs.rmSync(samplePath, { force: true });
  }
}

export async function probeFileGrantCacheDirectoryOpen({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  if (!pluginAdvertisesFileGrantOperation(plugin, "openCacheDirectory")) {
    result.fileGrantCacheDirectoryOpen = "skipped-unadvertised";
    return;
  }
  const cacheDir = fs.mkdtempSync(path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}-cache-`));
  let grantId = "";
  try {
    const grant = await phase(result, "createCacheDirectoryGrant", () =>
      request(socket, "createFileGrant", { path: cacheDir, purpose: "cache", access: "readWrite", kind: "directory" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachCacheDirectoryGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "cache", access: "readWrite", kind: "directory" }, true, session)
    );
    const opened = await phase(result, "useFileGrantOpenCacheDirectory", () =>
      request(socket, "useFileGrant", { instanceId, grantId, operation: "openCacheDirectory" }, true, session)
    );
    assertProbe(opened.applied === true, "bad_file_grant_cache_open", "file grant cache directory open was not applied");
    assertNoNativeLaunchData(opened, "file grant cache response", assertProbe);
    result.fileGrantCacheDirectoryOpen = "applied";
  } finally {
    await detachAndRevokeGrant({ grantId, instanceId, request, session, socket });
    fs.rmSync(cacheDir, { force: true, recursive: true });
  }
}

export async function probeFileGrantLicenseLoad({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  if (!pluginAdvertisesFileGrantOperation(plugin, "loadLicense")) {
    result.fileGrantLicenseLoad = "skipped-unadvertised";
    return;
  }
  const licensePath = path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}.license`);
  fs.writeFileSync(licensePath, "SoundBridge license fixture\n", "utf8");
  let grantId = "";
  try {
    const grant = await phase(result, "createLicenseFileGrant", () =>
      request(socket, "createFileGrant", { path: licensePath, purpose: "license", access: "read", kind: "file" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachLicenseFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "license", access: "read", kind: "file" }, true, session)
    );
    const loaded = await phase(result, "useFileGrantLoadLicense", () =>
      request(socket, "useFileGrant", { instanceId, grantId, operation: "loadLicense" }, true, session)
    );
    assertProbe(loaded.applied === true, "bad_file_grant_license_load", "file grant license load was not applied");
    assertNoNativeLaunchData(loaded, "file grant license response", assertProbe);
    result.fileGrantLicenseLoad = "applied";
  } finally {
    await detachAndRevokeGrant({ grantId, instanceId, request, session, socket });
    fs.rmSync(licensePath, { force: true });
  }
}

export async function probeFileGrantOtherPresetLoad({
  assertProbe,
  fileGrantRoot,
  instanceId,
  phase,
  plugin,
  request,
  result,
  session,
  socket
}) {
  if (!pluginAdvertisesFileGrantOperation(plugin, "other")) {
    result.fileGrantOtherPresetLoad = "skipped-unadvertised";
    return;
  }
  const presetPath = path.join(fileGrantRoot, `${safeFilename(plugin.pluginId)}.vendor-preset`);
  fs.writeFileSync(presetPath, "SoundBridge vendor preset fixture\n", "utf8");
  let grantId = "";
  try {
    const grant = await phase(result, "createOtherPresetFileGrant", () =>
      request(socket, "createFileGrant", { path: presetPath, purpose: "preset", access: "read", kind: "file" }, true, session)
    );
    grantId = grant.grantId;
    await phase(result, "attachOtherPresetFileGrant", () =>
      request(socket, "attachFileGrant", { instanceId, grantId, purpose: "preset", access: "read", kind: "file" }, true, session)
    );
    const loaded = await phase(result, "useFileGrantOtherPreset", () =>
      request(
        socket,
        "useFileGrant",
        { instanceId, grantId, operation: "other", purpose: "preset", access: "read", kind: "file" },
        true,
        session
      )
    );
    assertProbe(loaded.applied === true, "bad_file_grant_other_preset", "explicit other preset file grant was not applied");
    assertNoNativeLaunchData(loaded, "file grant other preset response", assertProbe);
    result.fileGrantOtherPresetLoad = "applied";
  } finally {
    await detachAndRevokeGrant({ grantId, instanceId, request, session, socket });
    fs.rmSync(presetPath, { force: true });
  }
}

export function nativeStateFileText(format, stateEnvelope) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(stateEnvelope), "base64").toString("utf8"));
  } catch {
    return "";
  }
  const nativeState = parsed?.nativeState;
  if (!nativeState || nativeState.format !== format) {
    return "";
  }
  if (format === "vst3") {
    const component = String(nativeState.component ?? "");
    const controller = String(nativeState.controller ?? "");
    if (!component && !controller) {
      return "";
    }
    return `${component || "-"} ${controller || "-"}\n`;
  }
  if (format === "au" || format === "lv2") {
    const state = String(nativeState.state ?? "");
    return state ? `${state}\n` : "";
  }
  return "";
}

export function assertNoNativeLaunchData(value, context, assertProbe) {
  const forbiddenKeys = new Set([
    "absolutePath",
    "brokerSessionId",
    "bundlePath",
    "componentPath",
    "diagnostics",
    "executablePath",
    "nativeHost",
    "path",
    "rootId"
  ]);
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      assertProbe(!forbiddenKeys.has(key), "native_editor_launch_data_leak", `${context} exposed ${key}`);
      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
}

async function detachAndRevokeGrant({ grantId, instanceId, request, session, socket }) {
  if (!grantId) {
    return;
  }
  await request(socket, "detachFileGrant", { instanceId, grantId }, true, session).catch(() => undefined);
  await request(socket, "revokeFileGrant", { grantId }, true, session).catch(() => undefined);
}

function pluginAdvertisesFileGrantOperation(plugin, operation) {
  return Array.isArray(plugin?.fileGrantOperations) && plugin.fileGrantOperations.includes(operation);
}

function safeFilename(value) {
  return String(value ?? "plugin")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 120) || "plugin";
}
