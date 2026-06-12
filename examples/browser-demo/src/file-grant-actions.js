export function createFileGrantActions({ client, ensureInstance, getInstanceId, refreshParameters, log, logError }) {
  async function restoreState() {
    await useOperation({
      access: "read",
      kind: "file",
      operation: "restoreState",
      purpose: "state",
      successPrefix: "State grant restored",
      refresh: true
    });
  }

  async function loadPreset() {
    await useOperation({
      access: "read",
      kind: "file",
      operation: "loadPreset",
      purpose: "preset",
      successPrefix: "Preset grant loaded",
      refresh: true
    });
  }

  async function saveStateDirectory() {
    await useOperation({
      access: "readWrite",
      kind: "directory",
      operation: "saveStateDirectory",
      purpose: "state",
      successPrefix: "State grant saved",
      refresh: false
    });
  }

  async function useOperation({ access, kind, operation, purpose, successPrefix, refresh }) {
    try {
      const result = await useAttachedFileGrant({ access, kind, operation, purpose });
      if (refresh) {
        await refreshParameters();
      }
      log(`${successPrefix}: ${formatFileGrantResult(result)}`);
    } catch (error) {
      logError(error);
    }
  }

  async function useAttachedFileGrant({ access, kind, operation, purpose }) {
    await ensureInstance();
    const instanceId = getInstanceId();
    if (!instanceId) {
      throw new Error("Create a plugin instance before using a file grant.");
    }

    const activeClient = client();
    const grant = await activeClient.createFileGrant({ access, kind, purpose });
    let attached = false;
    try {
      await activeClient.attachFileGrant(instanceId, grant.grantId, { access, kind, purpose });
      attached = true;
      return await activeClient.useFileGrant(instanceId, grant.grantId, { operation });
    } finally {
      if (attached) {
        await activeClient.detachFileGrant(instanceId, grant.grantId).catch(() => undefined);
      }
      await activeClient.revokeFileGrant(grant.grantId).catch(() => undefined);
    }
  }

  return {
    loadPreset,
    restoreState,
    saveStateDirectory
  };
}

function formatFileGrantResult(result) {
  const status = result.workerStatus ? ` (${result.workerStatus})` : "";
  return `${result.grant?.displayName ?? result.operation}${status}`;
}
