import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAudioUnitHostProfile } from "./daemon-au-host-profiles.mjs";
import { FILE_GRANT_OPERATION_NAMES, isKnownFileGrantOperation } from "./daemon-file-grant-operations.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_FILE_GRANT_OPERATIONS = Object.freeze(["loadPreset", "restoreState", "saveStateDirectory"]);
const PLUGIN_EDITOR_KINDS = Object.freeze(["generic-parameters", "native-window"]);

export function resolveNativeRenderer() {
  const candidates = [
    process.env.SOUNDBRIDGE_NATIVE_RENDERER,
    path.resolve(__dirname, "../native/bridge-daemon/build-current/soundbridge-daemon"),
    path.resolve(__dirname, "../native/bridge-daemon/build/soundbridge-daemon")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  return undefined;
}

export function loadNativeHostStatus(nativeRenderer) {
  if (!nativeRenderer) {
    return new Map();
  }

  try {
    const output = execFileSync(nativeRenderer, ["--host-status"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(output);
    if (!parsed || !Array.isArray(parsed.formats)) {
      return new Map();
    }
    return new Map(
      parsed.formats.map((formatStatus) => [
        String(formatStatus.format),
        {
          scan: Boolean(formatStatus.scanAvailable),
          host: Boolean(formatStatus.hostAvailable),
          exampleHost: Boolean(formatStatus.exampleHostAvailable),
          notes: typeof formatStatus.notes === "string" ? formatStatus.notes : undefined
        }
      ])
    );
  } catch (error) {
    console.warn(`Native host status failed: ${error.message}`);
    return new Map();
  }
}

export function createPluginCatalogSupport({
  nativeRenderer,
  nativeHostStatus,
  normalizers,
  mockInstruments,
  limits
}) {
  const { clamp01, normalizeVst3NoteExpressions, normalizeVst3ProgramLists, truncateText } = normalizers;
  const {
    makeGainParameter,
    makeInstrumentParameters,
    makeOutputLevelParameter,
    makeProgramParameter
  } = mockInstruments;
  const {
    maxPluginMetadataTextBytes,
    maxPluginNoteExpressions = 256,
    maxPluginParameters,
    maxPluginParameterTextBytes,
    maxPluginPresets
  } = limits;

  function createPluginCatalog() {
    return [
      (() => {
        const programParameter = makeProgramParameter(0);
        return {
          pluginId: "mock.gain",
          format: "mock",
          name: "Mock Gain",
          vendor: "SoundBridge",
          category: "Fx|Gain",
          kind: "effect",
          source: "mock",
          hostable: true,
          inputs: 2,
          outputs: 2,
          editorKinds: ["generic-parameters"],
          parameters: [makeGainParameter(0.5), programParameter, makeOutputLevelParameter(0)],
          vst3ProgramLists: [programParameter.programList],
          presets: [
            {
              id: "gain-unity",
              name: "Unity",
              parameters: {
                gain: 0.5,
                program: 0,
                "output-level": 1
              }
            },
            {
              id: "gain-bright",
              name: "Bright Gain",
              parameters: {
                gain: 0.75,
                program: 2 / 3,
                "output-level": 1
              }
            }
          ]
        };
      })(),
      ...loadNativeExamplePlugins(),
      ...loadNativeInstalledPlugins()
    ];
  }

  function loadNativeExamplePlugins() {
    if (!nativeRenderer) {
      return fallbackExamplePlugins();
    }

    try {
      const output = execFileSync(nativeRenderer, ["--scan-examples"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
      const parsed = JSON.parse(output);
      if (!parsed || !Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
        return fallbackExamplePlugins();
      }
      return parsed.plugins.map((plugin) => decorateExamplePlugin(enrichVst3PluginMetadata(plugin)));
    } catch (error) {
      console.warn(`Native example scan failed, using fallback examples: ${error.message}`);
      return fallbackExamplePlugins();
    }
  }

  function loadNativeInstalledPlugins() {
    if (!nativeRenderer) {
      return [];
    }

    try {
      const output = execFileSync(nativeRenderer, ["--scan-installed"], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      });
      const parsed = JSON.parse(output);
      if (!parsed || !Array.isArray(parsed.plugins)) {
        return [];
      }
      return parsed.plugins.map((plugin) => decorateInstalledPlugin(enrichVst3PluginMetadata(plugin)));
    } catch (error) {
      console.warn(`Native installed plugin scan failed: ${error.message}`);
      return [];
    }
  }

  function enrichVst3PluginMetadata(plugin) {
    if (plugin?.format !== "vst3") {
      return plugin;
    }
    const bundlePath = plugin.diagnostics?.bundlePath;
    if (typeof bundlePath !== "string" || bundlePath.length === 0 || plugin.diagnostics?.hasExecutable !== true) {
      return plugin;
    }

    try {
      const output = execFileSync(nativeRenderer, ["--inspect-vst3-factory", bundlePath], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5000
      });
      const parsed = JSON.parse(output);
      if (parsed?.ok !== true || !parsed.plugin || typeof parsed.plugin !== "object") {
        return plugin;
      }
      const metadata = parsed.plugin.metadata && typeof parsed.plugin.metadata === "object"
        ? { ...(plugin.metadata ?? {}), ...parsed.plugin.metadata }
        : plugin.metadata;
      return {
        ...plugin,
        name: typeof parsed.plugin.name === "string" && parsed.plugin.name ? parsed.plugin.name : plugin.name,
        vendor: typeof parsed.plugin.vendor === "string" && parsed.plugin.vendor ? parsed.plugin.vendor : plugin.vendor,
        category: typeof parsed.plugin.category === "string" && parsed.plugin.category ? parsed.plugin.category : plugin.category,
        kind: typeof parsed.plugin.kind === "string" && parsed.plugin.kind ? parsed.plugin.kind : plugin.kind,
        metadata
      };
    } catch {
      return plugin;
    }
  }

  function createPluginFormatCapabilities() {
    return {
      vst3: formatCapability("vst3", {
        scan: true,
        host: false,
        exampleHost: Boolean(nativeRenderer),
        mockExamples: true
      }),
      au: formatCapability("au", {
        scan: true,
        host: false,
        exampleHost: Boolean(nativeRenderer),
        mockExamples: true
      }),
      lv2: formatCapability("lv2", {
        scan: Boolean(nativeRenderer),
        host: false,
        exampleHost: Boolean(nativeRenderer),
        mockExamples: true
      }),
      mock: {
        scan: true,
        host: true
      }
    };
  }

  function formatCapability(format, fallback) {
    const nativeStatus = nativeHostStatus.get(format);
    return {
      scan: nativeStatus?.scan ?? fallback.scan,
      host: nativeStatus?.host ?? fallback.host,
      ...(nativeStatus?.exampleHost ?? fallback.exampleHost
        ? { exampleHost: nativeStatus?.exampleHost ?? fallback.exampleHost }
        : {}),
      ...(fallback.mockExamples ? { mockExamples: fallback.mockExamples } : {}),
      ...(nativeStatus?.notes ? { notes: nativeStatus.notes } : {})
    };
  }

  function decorateExamplePlugin(plugin) {
    const manifest = readExampleManifest(plugin);
    const defaults = normalizeExampleDefaults(plugin.pluginId, manifest);
    const presets = normalizeExamplePresets(plugin.pluginId, manifest, defaults);
    const diagnostics = plugin.diagnostics ?? {};
    const nativeHost =
      plugin.format === "lv2" &&
      plugin.kind !== "instrument" &&
      nativeHostStatus.get("lv2")?.host === true &&
      typeof diagnostics.bundlePath === "string" &&
      diagnostics.bundlePath.length > 0 &&
      diagnostics.hasExecutable === true &&
      diagnostics.hasUnsupportedRequiredFeatures !== true &&
      diagnostics.hasUnsupportedRequiredOptions !== true
        ? {
            format: "lv2",
            renderEngine: "native-lv2",
            bundlePath: diagnostics.bundlePath,
            blockSizeProfile: lv2BlockSizeProfile(diagnostics)
          }
        : undefined;
    return {
      pluginId: plugin.pluginId,
      format: plugin.format,
      name: plugin.name,
      vendor: plugin.vendor,
      category: plugin.category,
      kind: plugin.kind,
      source: plugin.source ?? "example-bundle",
      hostable: true,
      inputs: plugin.inputs ?? 0,
      outputs: plugin.outputs ?? 2,
      metadata: normalizePluginClassMetadata(plugin.metadata, plugin.format),
      executablePath: nativeHost ? undefined : diagnostics.executablePath,
      engine: defaults.engine,
      parameters: makeInstrumentParameters(defaults),
      presets,
      editorKinds: editorKindsForHostableNativeHost(true, nativeHost),
      fileGrantOperations: fileGrantOperationsForNativeHost(nativeHost),
      nativeHost
    };
  }

  function decorateInstalledPlugin(plugin) {
    const auHostProfile = audioUnitHostProfileFor(plugin);
    const auProfileReason = auHostProfile.hostUnavailableReason;
    const nativeHost = auProfileReason ? undefined : nativeHostForInstalledPlugin(plugin);
    const hostable = Boolean(nativeHost);
    return {
      pluginId: plugin.pluginId,
      format: plugin.format,
      name: plugin.name,
      vendor: plugin.vendor ?? "Unknown",
      category: plugin.category ?? formatCategory(plugin.format),
      kind: plugin.kind ?? "unknown",
      source: "scan",
      hostable,
      hostUnavailableReason: hostable
        ? undefined
        : auProfileReason ?? hostUnavailableReasonForInstalledPlugin(plugin),
      inputs: defaultInputChannels(plugin),
      outputs: defaultOutputChannels(plugin),
      metadata: normalizePluginClassMetadata(publicPluginMetadata(plugin, auHostProfile), plugin.format),
      parameters: [],
      presets: [],
      editorKinds: editorKindsForHostableNativeHost(hostable, nativeHost),
      fileGrantOperations: fileGrantOperationsForNativeHost(nativeHost),
      nativeHost
    };
  }

  function hostUnavailableReasonForInstalledPlugin(plugin) {
    const auProfileReason = unsupportedAudioUnitHostProfileReason(plugin);
    if (auProfileReason) {
      return auProfileReason;
    }
    if (plugin.format === "lv2" && nativeHostStatus.get("lv2")?.host === true) {
      if (
        plugin.diagnostics?.hasUnsupportedRequiredFeatures === true ||
        plugin.diagnostics?.hasUnsupportedRequiredOptions === true
      ) {
        return "Installed LV2 scanning is available, but this plugin requires unsupported LV2 host features or options.";
      }
      return "Installed LV2 scanning is available; this plugin does not match the basic audio/control LV2 host profile yet.";
    }
    return "Installed plugin scanning is available; binary hosting adapter is not linked yet.";
  }

  function nativeHostForInstalledPlugin(plugin) {
    const diagnostics = plugin.diagnostics ?? {};

    if (plugin.format === "au" && nativeHostStatus.get("au")?.host === true) {
      const auHostProfile = audioUnitHostProfileFor(plugin);
      if (auHostProfile.hostUnavailableReason) {
        return undefined;
      }
      if (
        typeof diagnostics.componentType !== "string" ||
        typeof diagnostics.componentSubType !== "string" ||
        typeof diagnostics.componentManufacturer !== "string"
      ) {
        return undefined;
      }

      return {
        format: "au",
        renderEngine: "native-au",
        componentType: diagnostics.componentType,
        componentSubType: diagnostics.componentSubType,
        componentManufacturer: diagnostics.componentManufacturer,
        hostProfile: auHostProfile.profile
      };
    }

    if (plugin.format === "vst3" && nativeHostStatus.get("vst3")?.host === true) {
      if (typeof diagnostics.bundlePath !== "string" || diagnostics.bundlePath.length === 0) {
        return undefined;
      }

      return {
        format: "vst3",
        renderEngine: "native-vst3",
        bundlePath: diagnostics.bundlePath
      };
    }

    if (plugin.format === "lv2" && nativeHostStatus.get("lv2")?.host === true) {
      if (
        typeof diagnostics.bundlePath !== "string" ||
        diagnostics.bundlePath.length === 0 ||
        diagnostics.hasExecutable !== true ||
        diagnostics.hasUnsupportedRequiredFeatures === true ||
        diagnostics.hasUnsupportedRequiredOptions === true ||
        Number(plugin.outputs) <= 0 ||
        plugin.kind === "instrument"
      ) {
        return undefined;
      }

      return {
        format: "lv2",
        renderEngine: "native-lv2",
        bundlePath: diagnostics.bundlePath,
        blockSizeProfile: lv2BlockSizeProfile(diagnostics)
      };
    }

    return undefined;
  }

  function unsupportedAudioUnitHostProfileReason(plugin) {
    if (plugin?.format !== "au" || nativeHostStatus.get("au")?.host !== true) {
      return undefined;
    }
    return audioUnitHostProfileFor(plugin).hostUnavailableReason;
  }

  function audioUnitHostProfileFor(plugin) {
    return plugin?.format === "au" && nativeHostStatus.get("au")?.host === true
      ? classifyAudioUnitHostProfile(plugin)
      : {};
  }

  function publicPluginMetadata(plugin, auHostProfile) {
    if (!auHostProfile.profile) {
      return plugin.metadata;
    }
    return {
      ...(plugin.metadata ?? {}),
      audioUnitHostProfile: auHostProfile.profile
    };
  }

  function lv2BlockSizeProfile(diagnostics) {
    const fixed = diagnostics?.lv2RequiresFixedBlockLength === true;
    const powerOfTwo = diagnostics?.lv2RequiresPowerOf2BlockLength === true;
    if (fixed && powerOfTwo) {
      return "fixed-power-of-two";
    }
    if (fixed) {
      return "fixed";
    }
    if (powerOfTwo) {
      return "power-of-two";
    }
    return undefined;
  }

  function fileGrantOperationsForNativeHost(nativeHost) {
    return nativeHost && ["au", "vst3", "lv2"].includes(nativeHost.format)
      ? [...NATIVE_FILE_GRANT_OPERATIONS]
      : undefined;
  }

  function editorKindsForHostableNativeHost(hostable, nativeHost) {
    if (!hostable) {
      return undefined;
    }
    return nativeHost && ["au", "vst3", "lv2"].includes(nativeHost.format)
      ? ["generic-parameters", "native-window"]
      : ["generic-parameters"];
  }

  function defaultInputChannels(plugin) {
    if (Number(plugin.inputs) > 0) {
      return Number(plugin.inputs);
    }
    return plugin.kind === "instrument" ? 0 : 2;
  }

  function defaultOutputChannels(plugin) {
    if (Number(plugin.outputs) > 0) {
      return Number(plugin.outputs);
    }
    return 2;
  }

  function readExampleManifest(plugin) {
    const bundlePath = plugin.diagnostics?.bundlePath;
    if (!bundlePath) {
      return undefined;
    }

    const manifestCandidates = [
      path.join(bundlePath, "Contents", "Resources", "SoundBridgePlugin.json"),
      path.join(bundlePath, "SoundBridgePlugin.json")
    ];

    for (const manifestPath of manifestCandidates) {
      try {
        return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
      }
    }

    return undefined;
  }

  function normalizeExampleDefaults(pluginId, manifest) {
    const fallback = exampleDefaultsFor(pluginId);
    const defaults = manifest?.defaults && typeof manifest.defaults === "object" ? manifest.defaults : {};
    return {
      engine: typeof manifest?.engine === "string" ? manifest.engine : fallback.engine,
      gain: clamp01(Number(defaults.gain ?? fallback.gain)),
      tone: clamp01(Number(defaults.tone ?? fallback.tone)),
      detune: clamp01(Number(defaults.detune ?? fallback.detune))
    };
  }

  function normalizeExamplePresets(pluginId, manifest, defaults) {
    const rawPresets = Array.isArray(manifest?.presets) ? manifest.presets : examplePresetsFor(pluginId, defaults);
    const presets = rawPresets
      .slice(0, maxPluginPresets)
      .map((preset, index) => {
        if (!preset || typeof preset !== "object") {
          return undefined;
        }
        const parameters = preset.parameters && typeof preset.parameters === "object" ? preset.parameters : {};
        const id = truncateText(preset.id ?? `preset-${index + 1}`, 64) || `preset-${index + 1}`;
        const name = truncateText(preset.name ?? `Preset ${index + 1}`, maxPluginParameterTextBytes) || id;
        return {
          id,
          name,
          parameters: {
            gain: clamp01(Number(parameters.gain ?? defaults.gain)),
            tone: clamp01(Number(parameters.tone ?? defaults.tone)),
            detune: clamp01(Number(parameters.detune ?? defaults.detune))
          }
        };
      })
      .filter(Boolean);

    return presets.length > 0 ? presets : examplePresetsFor(pluginId, defaults);
  }

  function fallbackExamplePlugins() {
    return [
      decorateExamplePlugin({
        pluginId: "vst3:soundbridge-example-polysynth.vst3",
        format: "vst3",
        name: "Example PolySynth",
        vendor: "SoundBridge",
        category: "Instrument|Synth",
        kind: "instrument",
        source: "builtin-example",
        inputs: 0,
        outputs: 2
      }),
      decorateExamplePlugin({
        pluginId: "au:soundbridge-example-tonewheel.component",
        format: "au",
        name: "Example Tonewheel",
        vendor: "SoundBridge",
        category: "Instrument|Keys",
        kind: "instrument",
        source: "builtin-example",
        inputs: 0,
        outputs: 2
      }),
      decorateExamplePlugin({
        pluginId: "lv2:soundbridge-example-wavefold.lv2",
        format: "lv2",
        name: "Example Wavefold",
        vendor: "SoundBridge",
        category: "Instrument|Synth",
        kind: "instrument",
        source: "builtin-example",
        inputs: 0,
        outputs: 2
      })
    ];
  }

  function exampleDefaultsFor(pluginId) {
    if (pluginId === "au:soundbridge-example-tonewheel.component") {
      return {
        engine: "tonewheel",
        gain: 0.48,
        tone: 0.36,
        detune: 0.5
      };
    }
    if (pluginId === "lv2:soundbridge-example-wavefold.lv2") {
      return {
        engine: "wavefold",
        gain: 0.4,
        tone: 0.58,
        detune: 0.5
      };
    }
    return {
      engine: "poly-sine",
      gain: 0.42,
      tone: 0.68,
      detune: 0.5
    };
  }

  function examplePresetsFor(pluginId, defaults) {
    if (pluginId === "au:soundbridge-example-tonewheel.component") {
      return [
        {
          id: "tonewheel-default",
          name: "Clean Drawbars",
          parameters: {
            gain: defaults.gain,
            tone: defaults.tone,
            detune: defaults.detune
          }
        },
        {
          id: "tonewheel-bright",
          name: "Bright Percussive",
          parameters: {
            gain: 0.58,
            tone: 0.74,
            detune: 0.5
          }
        }
      ];
    }

    if (pluginId === "lv2:soundbridge-example-wavefold.lv2") {
      return [
        {
          id: "wavefold-default",
          name: "Glass Fold",
          parameters: {
            gain: defaults.gain,
            tone: defaults.tone,
            detune: defaults.detune
          }
        },
        {
          id: "wavefold-edge",
          name: "Edge Stack",
          parameters: {
            gain: 0.52,
            tone: 0.82,
            detune: 0.61
          }
        }
      ];
    }

    return [
      {
        id: "poly-default",
        name: "Open Poly",
        parameters: {
          gain: defaults.gain,
          tone: defaults.tone,
          detune: defaults.detune
        }
      },
      {
        id: "poly-bright-stack",
        name: "Bright Stack",
        parameters: {
          gain: 0.56,
          tone: 0.86,
          detune: 0.62
        }
      }
    ];
  }

  function clonePluginMetadata(plugin) {
    const cloned = {
      pluginId: plugin.pluginId,
      format: plugin.format,
      name: plugin.name,
      vendor: plugin.vendor,
      category: plugin.category,
      kind: plugin.kind,
      source: plugin.source,
      hostable: plugin.hostable !== false,
      hostUnavailableReason: plugin.hostUnavailableReason,
      inputs: plugin.inputs,
      outputs: plugin.outputs,
      metadata: clonePluginClassMetadata(plugin.metadata),
      parameters: plugin.parameters.map((parameter) => ({ ...parameter })),
      parameterMetadataAtLimit: plugin.parameterMetadataAtLimit === true || plugin.parameters.length >= maxPluginParameters || undefined,
      presets: (plugin.presets ?? [])
        .slice(0, maxPluginPresets)
        .map((preset, index) => normalizePresetSnapshot(preset, index))
        .filter(Boolean)
    };
    const noteExpressions = normalizeVst3NoteExpressions(plugin.vst3NoteExpressions)
      .slice(0, maxPluginNoteExpressions);
    if (noteExpressions.length > 0) {
      cloned.vst3NoteExpressions = noteExpressions;
    }
    const fileGrantOperations = normalizeFileGrantOperations(plugin.fileGrantOperations);
    if (fileGrantOperations.length > 0) {
      cloned.fileGrantOperations = fileGrantOperations;
    }
    const editorKinds = normalizeEditorKinds(plugin.editorKinds);
    if (editorKinds.length > 0) {
      cloned.editorKinds = editorKinds;
    }
    const programLists = normalizeVst3ProgramLists(plugin.vst3ProgramLists);
    if (programLists.length > 0) {
      cloned.vst3ProgramLists = programLists;
    }
    return cloned;
  }

  function normalizeFileGrantOperations(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const operations = [];
    for (const rawOperation of value) {
      const operation = String(rawOperation ?? "");
      if (isKnownFileGrantOperation(operation) && !operations.includes(operation)) {
        operations.push(operation);
      }
      if (operations.length >= FILE_GRANT_OPERATION_NAMES.length) {
        break;
      }
    }
    return operations;
  }

  function normalizeEditorKinds(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const kinds = [];
    for (const rawKind of value) {
      const kind = String(rawKind ?? "");
      if (PLUGIN_EDITOR_KINDS.includes(kind) && !kinds.includes(kind)) {
        kinds.push(kind);
      }
      if (kinds.length >= PLUGIN_EDITOR_KINDS.length) {
        break;
      }
    }
    return kinds;
  }

  function normalizePresetSnapshot(preset, index) {
    if (!preset || typeof preset !== "object") {
      return undefined;
    }
    const fallbackId = `preset-${index + 1}`;
    const id = truncateText(preset.id ?? fallbackId, 64) || fallbackId;
    const name = truncateText(preset.name ?? `Preset ${index + 1}`, maxPluginParameterTextBytes) || id;
    const rawParameters = preset.parameters && typeof preset.parameters === "object" ? preset.parameters : {};
    const parameters = Object.create(null);
    for (const [rawParameterId, rawValue] of Object.entries(rawParameters).slice(0, maxPluginParameters)) {
      const parameterId = String(rawParameterId ?? "");
      const value = Number(rawValue);
      if (!parameterId || Buffer.byteLength(parameterId, "utf8") > 64 || !Number.isFinite(value)) {
        continue;
      }
      parameters[parameterId] = clamp01(value);
    }
    return { id, name, parameters };
  }

  function clonePluginClassMetadata(metadata) {
    const normalized = normalizePluginClassMetadata(metadata);
    return normalized ? { ...normalized } : undefined;
  }

  function normalizePluginClassMetadata(value) {
    const source = value && typeof value === "object" ? value : {};
    const metadata = {};
    const add = (key, maxBytes = maxPluginMetadataTextBytes) => {
      const text = truncateText(source[key], maxBytes);
      if (text) {
        metadata[key] = text;
      }
    };

    add("stableId");
    add("bundleIdentifier");
    add("version", 80);
    add("vst3ClassId", 64);
    add("vst3SdkVersion", 80);
    add("componentType", 16);
    add("componentSubType", 16);
    add("componentManufacturer", 16);
    add("audioUnitHostProfile", 64);
    add("lv2Uri");
    add("lv2BlockSizeProfile", 32);
    add("lv2UiTypes");
    add("lv2UiCount", 16);
    add("lv2UiBinaryCount", 16);

    if (!metadata.stableId) {
      if (metadata.vst3ClassId) {
        metadata.stableId = `vst3:${metadata.vst3ClassId}`;
      } else if (metadata.componentManufacturer && metadata.componentType && metadata.componentSubType) {
        metadata.stableId = `${metadata.componentManufacturer}:${metadata.componentType}:${metadata.componentSubType}`;
      } else if (metadata.lv2Uri) {
        metadata.stableId = metadata.lv2Uri;
      } else if (metadata.bundleIdentifier) {
        metadata.stableId = metadata.bundleIdentifier;
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  return {
    clonePluginMetadata,
    createPluginFormatCapabilities,
    formatCategory,
    normalizePresetSnapshot,
    plugins: createPluginCatalog()
  };
}

function formatCategory(format) {
  switch (format) {
    case "vst3":
      return "VST3";
    case "au":
      return "AudioUnit";
    case "lv2":
      return "LV2";
    default:
      return "Unknown";
  }
}
