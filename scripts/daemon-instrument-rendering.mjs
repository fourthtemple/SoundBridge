import { execFileSync } from "node:child_process";

export function createDaemonInstrumentRendering({
  nativeRenderer,
  parameterValue,
  synthesizeInstrumentBlock
}) {
  async function processInstrumentBlock(instance, frames, sampleRate, options = {}) {
    if (instance.worker) {
      try {
        const rendered = await instance.worker.render({
          frames,
          sampleRate,
          channels: [],
          inputBuses: options.inputBuses,
          transport: options.transport,
          gain: parameterValue(instance, "gain", 0.5),
          tone: parameterValue(instance, "tone", 0.5),
          detune: parameterValue(instance, "detune", 0.5)
        });
        return {
          channels: Array.isArray(rendered) ? rendered : rendered.channels,
          outputBuses: Array.isArray(rendered?.outputBuses) ? rendered.outputBuses : undefined,
          renderEngine: instance.renderEngine ?? instance.worker.renderEngine ?? "bundle-worker"
        };
      } catch (error) {
        if (typeof instance.renderEngine === "string" && instance.renderEngine.startsWith("native-")) {
          throw error;
        }
        console.warn(`Bundle worker failed, falling back to executable launch: ${error.message}`);
        instance.worker?.destroy();
        instance.worker = undefined;
      }
    }

    const rendererExecutable = instance.executablePath ?? nativeRenderer;
    if (
      rendererExecutable &&
      ["builtin-example", "example-bundle"].includes(instance.source) &&
      ["vst3", "au", "lv2"].includes(instance.format)
    ) {
      try {
        return {
          channels: renderNativeExampleBlock({
            rendererExecutable,
            instance,
            frames,
            sampleRate,
            parameterValue
          }),
          renderEngine: instance.executablePath ? "bundle-executable" : "native-example"
        };
      } catch (error) {
        console.warn(`Native example renderer failed, falling back to JS: ${error.message}`);
      }
    }

    return {
      channels: synthesizeInstrumentBlock(instance, frames, sampleRate),
      renderEngine: "js-fallback"
    };
  }

  return {
    processInstrumentBlock
  };
}

function renderNativeExampleBlock({ rendererExecutable, instance, frames, sampleRate, parameterValue }) {
  const args = instance.executablePath
    ? [
        "--render-example-block",
        String(frames),
        String(sampleRate),
        String(parameterValue(instance, "gain", 0.5)),
        String(parameterValue(instance, "tone", 0.5)),
        String(parameterValue(instance, "detune", 0.5)),
        voicesToNativeArgument(instance.voices)
      ]
    : [
        "--render-example-block",
        instance.pluginId,
        String(frames),
        String(sampleRate),
        String(parameterValue(instance, "gain", 0.5)),
        String(parameterValue(instance, "tone", 0.5)),
        String(parameterValue(instance, "detune", 0.5)),
        voicesToNativeArgument(instance.voices)
      ];
  const output = execFileSync(
    rendererExecutable,
    args,
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }
  );
  const parsed = JSON.parse(output);
  if (!parsed || !Array.isArray(parsed.channels)) {
    throw new Error("native renderer returned invalid channels");
  }
  return parsed.channels;
}

function voicesToNativeArgument(voices) {
  return Array.from(voices.values(), (voice) => `${voice.note}:${voice.velocity}`).join(",");
}
