export function cloneParameters(parameters = []) {
  return Array.isArray(parameters) ? parameters.map((parameter) => ({ ...parameter })) : [];
}

export function parameterMetadataAtLimit(parameters, maxPluginParameters = 1024) {
  return Array.isArray(parameters) && parameters.length >= maxPluginParameters;
}

export function parameterSnapshotResponse(instance, maxPluginParameters) {
  const parameters = cloneParameters(instance.parameters);
  return {
    parameters,
    ...(instance.parameterMetadataAtLimit === true || parameterMetadataAtLimit(parameters, maxPluginParameters)
      ? { parameterMetadataAtLimit: true }
      : {})
  };
}

export function applyNativeParameterSnapshot(instance, snapshot, maxPluginParameters) {
  const parameters = Array.isArray(snapshot) ? snapshot : snapshot?.parameters;
  if (Array.isArray(parameters) && parameters.length > 0) {
    instance.parameters = parameters;
    instance.nativeParameterIds = new Set(parameters.map((parameter) => parameter.id));
  }
  instance.parameterMetadataAtLimit =
    Boolean(snapshot?.parameterMetadataAtLimit) ||
    parameterMetadataAtLimit(instance.parameters, maxPluginParameters);
}
