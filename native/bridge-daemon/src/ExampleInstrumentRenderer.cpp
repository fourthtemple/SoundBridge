#include "SoundBridge/ExampleInstrumentRenderer.h"

#include <algorithm>
#include <cmath>
#include <sstream>
#include <utility>

namespace soundbridge {

namespace {

constexpr double kPi = 3.14159265358979323846264338327950288;
constexpr std::uint32_t kMaxExampleFrames = 8192;

double clamp01(double value) {
  if (!std::isfinite(value)) {
    return 0.0;
  }
  return std::clamp(value, 0.0, 1.0);
}

double normalizedGainToDb(double normalizedValue) {
  return -24.0 + clamp01(normalizedValue) * 48.0;
}

double normalizedDetuneToCents(double normalizedValue) {
  return -12.0 + clamp01(normalizedValue) * 24.0;
}

double midiNoteToFrequency(std::uint8_t note) {
  return 440.0 * std::pow(2.0, (static_cast<double>(note) - 69.0) / 12.0);
}

float clampAudio(double sample) {
  if (!std::isfinite(sample)) {
    return 0.0F;
  }
  return static_cast<float>(std::clamp(sample, -1.0, 1.0));
}

} // namespace

bool isExampleInstrumentPluginId(const std::string& pluginId) {
  return pluginId == "vst3:soundbridge-example-polysynth.vst3" ||
      pluginId == "au:soundbridge-example-tonewheel.component" ||
      pluginId == "lv2:soundbridge-example-wavefold.lv2";
}

ExampleInstrumentState::ExampleInstrumentState(std::string pluginId)
    : pluginId_(std::move(pluginId)) {}

void ExampleInstrumentState::noteOn(std::uint8_t note, double velocity) {
  const auto existing = std::find_if(voices_.begin(), voices_.end(), [note](const auto& voice) {
    return voice.note == note;
  });
  if (existing != voices_.end()) {
    existing->velocity = clamp01(velocity);
    return;
  }
  voices_.push_back(VoiceState{note, clamp01(velocity), 0.0, 0.0});
}

void ExampleInstrumentState::noteOff(std::uint8_t note) {
  voices_.erase(
      std::remove_if(
          voices_.begin(),
          voices_.end(),
          [note](const auto& voice) {
            return voice.note == note;
          }),
      voices_.end());
}

std::vector<std::vector<float>> ExampleInstrumentState::render(
    std::uint32_t frames,
    double sampleRate,
    double gain,
    double tone,
    double detune) {
  frames = std::clamp<std::uint32_t>(frames, 1, kMaxExampleFrames);
  std::vector<std::vector<float>> channels(2, std::vector<float>(frames, 0.0F));
  if (voices_.empty() || sampleRate <= 0.0) {
    return channels;
  }

  const double gainLinear = std::pow(10.0, normalizedGainToDb(gain) / 20.0);
  const double normalizedTone = clamp01(tone);
  const double detuneRatio = std::pow(2.0, normalizedDetuneToCents(detune) / 1200.0);
  const double voiceScale = std::max(0.16, 1.0 / std::sqrt(static_cast<double>(voices_.size())));
  const bool tonewheel = pluginId_ == "au:soundbridge-example-tonewheel.component";
  const bool wavefold = pluginId_ == "lv2:soundbridge-example-wavefold.lv2";

  for (std::uint32_t frame = 0; frame < frames; ++frame) {
    double mixed = 0.0;
    for (auto& voice : voices_) {
      const double frequency = midiNoteToFrequency(voice.note) * detuneRatio;
      const double phaseIncrement = 2.0 * kPi * frequency / sampleRate;
      voice.phase = std::fmod(voice.phase + phaseIncrement, 2.0 * kPi);
      voice.phase2 = std::fmod(voice.phase2 + phaseIncrement * 2.01, 2.0 * kPi);

      if (tonewheel) {
        const double fundamental = std::sin(voice.phase);
        const double harmonic = std::sin(voice.phase2) * normalizedTone * 0.55;
        mixed += (fundamental + harmonic) * voice.velocity;
      } else if (wavefold) {
        const double carrier = std::sin(voice.phase);
        const double folded = std::sin(carrier * (1.0 + normalizedTone * 7.0));
        const double edge = std::sin(voice.phase2) * normalizedTone * 0.25;
        mixed += (folded * 0.86 + edge) * voice.velocity;
      } else {
        const double sine = std::sin(voice.phase);
        const double shaped = std::tanh(std::sin(voice.phase) * (1.5 + normalizedTone * 5.0));
        mixed += (sine * (1.0 - normalizedTone * 0.45) + shaped * normalizedTone * 0.45) * voice.velocity;
      }
    }

    const float sample = clampAudio(mixed * gainLinear * voiceScale);
    channels[0][frame] = sample;
    channels[1][frame] = sample;
  }

  return channels;
}

std::vector<std::vector<float>> renderExampleInstrumentBlock(const ExampleRenderConfig& config) {
  ExampleInstrumentState state(config.pluginId);
  for (const auto& voice : config.voices) {
    state.noteOn(voice.note, voice.velocity);
  }
  return state.render(config.frames, config.sampleRate, config.gain, config.tone, config.detune);
}

std::string exampleInstrumentBlockToJson(const std::vector<std::vector<float>>& channels) {
  std::ostringstream output;
  output << "{\"channels\":[";
  for (std::size_t channelIndex = 0; channelIndex < channels.size(); ++channelIndex) {
    if (channelIndex > 0) {
      output << ",";
    }
    output << "[";
    for (std::size_t frame = 0; frame < channels[channelIndex].size(); ++frame) {
      if (frame > 0) {
        output << ",";
      }
      output << channels[channelIndex][frame];
    }
    output << "]";
  }
  output << "]}";
  return output.str();
}

std::vector<ExampleVoice> parseExampleVoices(const std::string& voices) {
  std::vector<ExampleVoice> parsed;
  std::stringstream stream(voices);
  std::string token;
  while (std::getline(stream, token, ',')) {
    if (token.empty()) {
      continue;
    }

    const auto separator = token.find(':');
    const auto noteText = token.substr(0, separator);
    const auto velocityText = separator == std::string::npos ? std::string("0.8") : token.substr(separator + 1);
    try {
      const auto note = std::clamp(std::stoi(noteText), 0, 127);
      const auto velocity = clamp01(std::stod(velocityText));
      parsed.push_back(ExampleVoice{static_cast<std::uint8_t>(note), velocity});
    } catch (...) {
    }
  }
  return parsed;
}

} // namespace soundbridge
