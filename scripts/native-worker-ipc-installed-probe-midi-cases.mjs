import { summarizeProbeMidiControllerEvents } from "./installed-plugin-probe-midi.mjs";
import { summarizeProbeResults } from "./installed-plugin-probe-reporting.mjs";

export function exerciseInstalledProbeMidiSupport({ check }) {
  const controllerProfile = summarizeProbeMidiControllerEvents([
    { type: "controlChange", controller: 74, value: 0.5, channel: 0, busIndex: 0 },
    { type: "channelPressure", pressure: 0.25, channel: 1, busIndex: 1 },
    { type: "pitchBend", value: -0.5, channel: 2, busIndex: 1 }
  ]);
  const controllerMatrix = summarizeProbeResults([{
    ok: true,
    format: "vst3",
    midiControllerEventProfile: controllerProfile
  }]).matrix[0];
  check(
    controllerProfile.controllerFamilyCount === 3 &&
      JSON.stringify(controllerProfile.controllers) === JSON.stringify([74, 128, 129]) &&
      JSON.stringify(controllerMatrix.midiControllerNumbers) === JSON.stringify([74, 128, 129]),
    "installed plugin probe reports VST3 MIDI controller-family ids"
  );
}
