export const INSTALLED_PLUGIN_PROBE_FORMATS = Object.freeze(["vst3", "au", "lv2"]);

const KNOWN_INSTALLED_PLUGIN_PROBE_FORMATS = new Set(INSTALLED_PLUGIN_PROBE_FORMATS);

export function installedProbeFormats(env = process.env) {
  const raw = env.SOUNDBRIDGE_PROBE_FORMATS;
  const requested = raw == null ? INSTALLED_PLUGIN_PROBE_FORMATS : String(raw).split(",");
  const formats = [];
  for (const value of requested) {
    const format = String(value).trim().toLowerCase();
    if (!format) {
      continue;
    }
    if (!KNOWN_INSTALLED_PLUGIN_PROBE_FORMATS.has(format)) {
      throw new Error(
        `SOUNDBRIDGE_PROBE_FORMATS contains unsupported format "${format}". ` +
          `Use one or more of: ${INSTALLED_PLUGIN_PROBE_FORMATS.join(",")}`
      );
    }
    if (!formats.includes(format)) {
      formats.push(format);
    }
  }
  return new Set(formats);
}
