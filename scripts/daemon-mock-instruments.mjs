export function createMockInstrumentSupport({ clamp01, finiteNumber }) {
  function makeInstrumentParameters(values) {
    return [
      makeGainParameter(values.gain),
      {
        id: "tone",
        name: "Tone",
        normalizedValue: clamp01(values.tone),
        defaultNormalizedValue: 0.5,
        unit: "%",
        minPlain: 0,
        maxPlain: 100,
        plainValue: clamp01(values.tone) * 100,
        automatable: true
      },
      {
        id: "detune",
        name: "Detune",
        normalizedValue: clamp01(values.detune),
        defaultNormalizedValue: 0.5,
        unit: "ct",
        minPlain: -12,
        maxPlain: 12,
        plainValue: normalizedDetuneToCents(values.detune),
        automatable: true
      }
    ];
  }

  function makeUpdatedParameter(parameter, normalizedValue) {
    if (parameter.id === "gain") {
      return makeGainParameter(normalizedValue);
    }
    if (parameter.id === "tone") {
      const value = clamp01(normalizedValue);
      return {
        ...parameter,
        normalizedValue: value,
        plainValue: value * 100
      };
    }
    if (parameter.id === "detune") {
      const value = clamp01(normalizedValue);
      return {
        ...parameter,
        normalizedValue: value,
        plainValue: normalizedDetuneToCents(value)
      };
    }
    if (parameter.programChange) {
      const value = clamp01(normalizedValue);
      const programs = parameter.programList?.programs ?? [];
      const selected = programs.reduce((closest, program) => {
        if (!closest) {
          return program;
        }
        return Math.abs(program.normalizedValue - value) < Math.abs(closest.normalizedValue - value)
          ? program
          : closest;
      }, undefined);
      return {
        ...parameter,
        normalizedValue: selected?.normalizedValue ?? value,
        plainValue: selected?.index ?? value
      };
    }
    return {
      ...parameter,
      normalizedValue: clamp01(normalizedValue)
    };
  }

  function makeNativeUpdatedParameter(parameter, normalizedValue) {
    const value = clamp01(Number(parameter.normalizedValue ?? normalizedValue));
    const minPlain = finiteNumber(parameter.minPlain, 0);
    const maxPlain = finiteNumber(parameter.maxPlain, 1);
    return {
      ...parameter,
      normalizedValue: value,
      plainValue: finiteNumber(parameter.plainValue, minPlain + (maxPlain - minPlain) * value)
    };
  }

  function makeGainParameter(normalizedValue) {
    const clamped = clamp01(normalizedValue);
    return {
      id: "gain",
      name: "Gain",
      normalizedValue: clamped,
      defaultNormalizedValue: 0.5,
      unit: "dB",
      minPlain: -24,
      maxPlain: 24,
      plainValue: normalizedGainToDb(clamped),
      automatable: true
    };
  }

  function makeProgramParameter(normalizedValue) {
    const programs = [
      { index: 0, name: "Clean", normalizedValue: 0 },
      { index: 1, name: "Warm", normalizedValue: 1 / 3 },
      { index: 2, name: "Bright", normalizedValue: 2 / 3 },
      { index: 3, name: "Wide", normalizedValue: 1 }
    ];
    const value = clamp01(normalizedValue);
    const selected = programs.reduce((closest, program) => {
      if (!closest) {
        return program;
      }
      return Math.abs(program.normalizedValue - value) < Math.abs(closest.normalizedValue - value)
        ? program
        : closest;
    }, undefined);
    return {
      id: "program",
      name: "Program",
      normalizedValue: selected?.normalizedValue ?? 0,
      defaultNormalizedValue: 0,
      minPlain: 0,
      maxPlain: programs.length - 1,
      plainValue: selected?.index ?? 0,
      automatable: true,
      stepCount: programs.length - 1,
      programChange: true,
      programList: {
        id: 0,
        name: "Programs",
        programs
      }
    };
  }

  function makeOutputLevelParameter(normalizedValue) {
    const clamped = clamp01(normalizedValue);
    return {
      id: "output-level",
      name: "Output Level",
      normalizedValue: clamped,
      defaultNormalizedValue: 0,
      unit: "%",
      minPlain: 0,
      maxPlain: 100,
      plainValue: clamped * 100,
      automatable: false,
      readOnly: true
    };
  }

  function normalizedGainToDb(normalizedValue) {
    return -24 + clamp01(normalizedValue) * 48;
  }

  function normalizedDetuneToCents(normalizedValue) {
    return -12 + clamp01(normalizedValue) * 24;
  }

  function parameterValue(instance, parameterId, fallback) {
    return instance.parameters.find((parameter) => parameter.id === parameterId)?.normalizedValue ?? fallback;
  }

  function synthesizeInstrumentBlock(instance, frames, sampleRate) {
    const output = Array.from({ length: instance.outputChannels }, () => new Array(frames).fill(0));
    if (instance.voices.size === 0) {
      return output;
    }

    const gainLinear = Math.pow(10, normalizedGainToDb(parameterValue(instance, "gain", 0.5)) / 20);
    const tone = parameterValue(instance, "tone", 0.5);
    const detuneRatio = 2 ** (normalizedDetuneToCents(parameterValue(instance, "detune", 0.5)) / 1200);
    const voices = Array.from(instance.voices.values());
    const voiceScale = Math.max(0.16, 1 / Math.sqrt(voices.length));

    for (let frame = 0; frame < frames; frame += 1) {
      let sample = 0;
      for (const voice of voices) {
        const frequency = voice.frequency * detuneRatio;
        const phaseIncrement = (2 * Math.PI * frequency) / sampleRate;
        voice.phase = (voice.phase + phaseIncrement) % (2 * Math.PI);
        voice.phase2 = (voice.phase2 + phaseIncrement * 2.01) % (2 * Math.PI);

        if (instance.engine === "tonewheel") {
          const fundamental = Math.sin(voice.phase);
          const harmonic = Math.sin(voice.phase2) * tone * 0.55;
          sample += (fundamental + harmonic) * voice.velocity;
        } else if (instance.engine === "wavefold") {
          const carrier = Math.sin(voice.phase);
          const folded = Math.sin(carrier * (1 + tone * 7));
          const edge = Math.sin(voice.phase2) * tone * 0.25;
          sample += (folded * 0.86 + edge) * voice.velocity;
        } else {
          const sine = Math.sin(voice.phase);
          const shaped = Math.tanh(Math.sin(voice.phase) * (1.5 + tone * 5));
          sample += (sine * (1 - tone * 0.45) + shaped * tone * 0.45) * voice.velocity;
        }
      }

      sample = Math.max(-1, Math.min(1, sample * gainLinear * voiceScale));
      for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
        output[channelIndex][frame] = sample;
      }
    }

    return output;
  }

  return {
    makeGainParameter,
    makeInstrumentParameters,
    makeNativeUpdatedParameter,
    makeOutputLevelParameter,
    makeProgramParameter,
    makeUpdatedParameter,
    midiNoteToFrequency,
    normalizedGainToDb,
    parameterValue,
    synthesizeInstrumentBlock
  };
}

function midiNoteToFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}
