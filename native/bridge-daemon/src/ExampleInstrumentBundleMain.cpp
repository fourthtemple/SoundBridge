#include "SoundBridge/ExampleInstrumentRenderer.h"

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

std::string pluginIdForExecutable(const char* argv0) {
  const auto executableName = std::filesystem::path(argv0).filename().string();
  if (executableName.find("tonewheel") != std::string::npos) {
    return "au:soundbridge-example-tonewheel.component";
  }
  if (executableName.find("wavefold") != std::string::npos) {
    return "lv2:soundbridge-example-wavefold.lv2";
  }
  return "vst3:soundbridge-example-polysynth.vst3";
}

void printUsage(const char* argv0) {
  std::cerr << "Usage:\n";
  std::cerr << "  " << argv0 << " --render-example-block <frames> <sample-rate> <gain> <tone> <detune> <note:velocity,...>\n";
  std::cerr << "  " << argv0 << " --worker\n";
}

} // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--worker") {
    const auto pluginId = pluginIdForExecutable(argv[0]);
    soundbridge::ExampleInstrumentState state(pluginId);
    std::string line;
    while (std::getline(std::cin, line)) {
      std::stringstream stream(line);
      std::string command;
      stream >> command;
      if (command == "quit") {
        return 0;
      }

      if (command == "noteOn") {
        int note = 60;
        double velocity = 0.8;
        stream >> note;
        stream >> velocity;
        state.noteOn(static_cast<std::uint8_t>(std::clamp(note, 0, 127)), velocity);
        std::cout << "{\"ok\":true}" << std::endl;
        continue;
      }

      if (command == "noteOff") {
        int note = 60;
        stream >> note;
        state.noteOff(static_cast<std::uint8_t>(std::clamp(note, 0, 127)));
        std::cout << "{\"ok\":true}" << std::endl;
        continue;
      }

      if (command != "render") {
        std::cout << "{\"error\":\"unknown_command\"}" << std::endl;
        continue;
      }

      std::uint32_t frames = 128;
      double sampleRate = 48000.0;
      double gain = 0.5;
      double tone = 0.5;
      double detune = 0.5;
      std::string voices;
      stream >> frames;
      stream >> sampleRate;
      stream >> gain;
      stream >> tone;
      stream >> detune;
      stream >> voices;

      if (!voices.empty()) {
        soundbridge::ExampleRenderConfig config;
        config.pluginId = pluginId;
        config.frames = frames;
        config.sampleRate = sampleRate;
        config.gain = gain;
        config.tone = tone;
        config.detune = detune;
        config.voices = soundbridge::parseExampleVoices(voices);
        std::cout << soundbridge::exampleInstrumentBlockToJson(
            soundbridge::renderExampleInstrumentBlock(config)) << std::endl;
      } else {
        std::cout << soundbridge::exampleInstrumentBlockToJson(
            state.render(frames, sampleRate, gain, tone, detune)) << std::endl;
      }
    }
    return 0;
  }

  if (argc != 8 || std::string(argv[1]) != "--render-example-block") {
    printUsage(argv[0]);
    return 2;
  }

  soundbridge::ExampleRenderConfig config;
  config.pluginId = pluginIdForExecutable(argv[0]);
  try {
    config.frames = static_cast<std::uint32_t>(std::stoul(argv[2]));
    config.sampleRate = std::stod(argv[3]);
    config.gain = std::stod(argv[4]);
    config.tone = std::stod(argv[5]);
    config.detune = std::stod(argv[6]);
  } catch (const std::exception& error) {
    std::cerr << "--render-example-block received invalid numeric arguments: " << error.what() << "\n";
    return 2;
  }
  config.voices = soundbridge::parseExampleVoices(argv[7]);

  std::cout << soundbridge::exampleInstrumentBlockToJson(
      soundbridge::renderExampleInstrumentBlock(config)) << "\n";
  return 0;
}
