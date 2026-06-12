#include "SoundBridge/AudioUnitHostWorker.h"

#include "SoundBridge/AudioUnitHostedEffect.h"
#include "SoundBridge/AudioUnitHostWorkerSupport.h"
#include "SoundBridge/Base64.h"
#include "SoundBridge/NativeFileGrantSupport.h"
#include "SoundBridge/NativePlugin.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge {

namespace {

#ifdef SOUNDBRIDGE_MACOS

using namespace audio_unit_worker;
using namespace worker_file_grants;

int runAudioUnitHostWorkerMac(int argc, char** argv) {
  if (argc < 10) {
    std::cerr << "--host-au-worker requires type, subtype, manufacturer, sample rate, max block size, input channels, output channels, and kind.\n";
    return 2;
  }

  double sampleRate = 48000.0;
  std::uint32_t maxBlockSize = 128;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 2;
  if (!parseSampleRateArg(argv[5], sampleRate) ||
      !parseUint32Arg(argv[6], 1, kMaxWorkerFrames, maxBlockSize) ||
      !parseUint32Arg(argv[7], 0, kMaxWorkerChannels, inputChannels) ||
      !parseUint32Arg(argv[8], 1, kMaxWorkerChannels, outputChannels)) {
    std::cout << "{\"error\":\"invalid_worker_arguments\"}" << std::endl;
    return 2;
  }

  try {
    HostedAudioUnit host(argv[2], argv[3], argv[4], sampleRate, maxBlockSize, inputChannels, outputChannels);

    std::cout << "{\"ok\":true,\"ready\":true}" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.size() > kMaxWorkerLineBytes) {
        std::cout << "{\"error\":\"command_too_large\"}" << std::endl;
        continue;
      }

      std::stringstream stream(line);
      std::string command;
      stream >> command;
      if (command == "quit") {
        return 0;
      }

      try {
        if (command == "noteOn") {
          int note = 60;
          double velocity = 0.8;
          int channel = 0;
          int sampleOffset = 0;
          stream >> note >> velocity >> channel >> sampleOffset;
          if (!std::isfinite(velocity)) {
            velocity = 0.0;
          }
          host.noteOn(
              static_cast<std::uint8_t>(std::clamp(note, 0, 127)),
              std::clamp(velocity, 0.0, 1.0),
              static_cast<std::uint8_t>(std::clamp(channel, 0, 15)),
              static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1))));
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "noteOff") {
          int note = 60;
          int velocity = 0;
          int channel = 0;
          int sampleOffset = 0;
          stream >> note >> velocity >> channel >> sampleOffset;
          host.noteOff(
              static_cast<std::uint8_t>(std::clamp(note, 0, 127)),
              static_cast<std::uint8_t>(std::clamp(channel, 0, 15)),
              static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1))));
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "midi") {
          std::string encodedEvents;
          stream >> encodedEvents;
          std::vector<PendingMidiMessage> messages;
          if (!parseMidiEvents(encodedEvents, messages)) {
            std::cout << "{\"error\":\"invalid_midi_events\"}" << std::endl;
            continue;
          }
          host.sendMidiEvents(messages);
          std::cout << "{\"ok\":true,\"eventCount\":" << messages.size() << "}" << std::endl;
          continue;
        }

        if (command == "parameters") {
          std::cout << host.parametersToJson() << std::endl;
          continue;
        }

        if (command == "getState") {
          std::cout << host.stateToJson() << std::endl;
          continue;
        }

        if (command == "setState") {
          std::string stateText;
          stream >> stateText;
          if (stateText.empty()) {
            std::cout << "{\"error\":\"invalid_state_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setState(stateText) << std::endl;
          continue;
        }

        if (command == "fileGrant") {
          const auto fileGrant = parseFileGrantCommand(stream);
          if (fileGrant.operation == "restoreState") {
            host.setState(readSingleStateFile(fileGrant, kMaxWorkerStateBytes));
            std::cout << fileGrantAppliedJson() << std::endl;
            continue;
          }
          if (fileGrant.operation == "loadPreset") {
            host.setState(readSinglePresetFile(fileGrant, kMaxWorkerStateBytes));
            std::cout << fileGrantPresetLoadedJson() << std::endl;
            continue;
          }
          if (fileGrant.operation == "saveStateDirectory") {
            host.writeStateFile(fileGrant);
            std::cout << fileGrantSavedJson() << std::endl;
            continue;
          }
          throw std::runtime_error("unsupported_file_grant_operation");
        }

        if (command == "latency") {
          std::cout << host.latencyToJson() << std::endl;
          continue;
        }

        if (command == "tail") {
          std::cout << host.tailTimeToJson() << std::endl;
          continue;
        }

        if (command == "layout") {
          std::cout << host.layoutToJson() << std::endl;
          continue;
        }

        if (command == "setParameter") {
          std::string parameterIdToken;
          std::string valueText;
          std::string sampleOffsetText;
          std::uint32_t parameterId = 0;
          std::uint32_t sampleOffset = 0;
          double value = 0.0;
          stream >> parameterIdToken;
          stream >> valueText;
          stream >> sampleOffsetText;
          const auto parameterIdText = base64DecodeTextToken(parameterIdToken, kMaxWorkerParameterStringBytes);
          if (!parseUint32Arg(parameterIdText.c_str(), 0, 0xFFFFFFFFU, parameterId) ||
              !parseDoubleArg(valueText.c_str(), 0.0, 1.0, value) ||
              (!sampleOffsetText.empty() && !parseUint32Arg(sampleOffsetText.c_str(), 0, kMaxWorkerFrames - 1, sampleOffset))) {
            std::cout << "{\"error\":\"invalid_parameter_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setParameter(parameterId, value, sampleOffset) << std::endl;
          continue;
        }

        if (command == "setParameterDisplayValue") {
          std::string parameterIdToken;
          std::string displayValueText;
          std::uint32_t parameterId = 0;
          stream >> parameterIdToken;
          stream >> displayValueText;
          const auto parameterIdText = base64DecodeTextToken(parameterIdToken, kMaxWorkerParameterStringBytes);
          if (!parseUint32Arg(parameterIdText.c_str(), 0, std::numeric_limits<std::uint32_t>::max(), parameterId) ||
              displayValueText.empty() || displayValueText == "-") {
            std::cout << "{\"error\":\"invalid_parameter_display_arguments\"}" << std::endl;
            continue;
          }
          const auto displayValue = base64DecodeTextToken(displayValueText, kMaxWorkerParameterStringBytes);
          if (displayValue.empty() || displayValue.find('\0') != std::string::npos) {
            std::cout << "{\"error\":\"invalid_parameter_display_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setParameterDisplayValue(parameterId, displayValue) << std::endl;
          continue;
        }

        if (command == "render") {
          std::uint32_t frames = 128;
          double renderSampleRate = sampleRate;
          std::string encodedChannels;
          std::string encodedInputBuses;
          std::string encodedTransport;
          std::string framesText;
          std::string sampleRateText;
          stream >> framesText;
          stream >> sampleRateText;
          stream >> encodedChannels;
          stream >> encodedInputBuses;
          stream >> encodedTransport;
          HostTransportContext transport;
          if (!parseUint32Arg(framesText.c_str(), 1, kMaxWorkerFrames, frames) ||
              !parseSampleRateArg(sampleRateText.c_str(), renderSampleRate) ||
              !parseTransportContext(encodedTransport, host.sampleTime(), transport)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          auto channels = parseChannels(encodedChannels, frames);
          std::vector<IndexedAudioBus> inputBuses;
          if (!parseAudioBuses(encodedInputBuses, frames, inputBuses)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          const auto rendered = host.render(
              frames,
              renderSampleRate,
              std::move(channels),
              std::move(inputBuses),
              transport);
          std::cout << renderedAudioToJson(rendered) << std::endl;
          continue;
        }

        std::cout << "{\"error\":\"unknown_command\"}" << std::endl;
      } catch (const std::exception& error) {
        std::cout << "{\"error\":\"" << jsonEscape(error.what()) << "\"}" << std::endl;
      }
    }
    return 0;
  } catch (const std::exception& error) {
    std::cout << "{\"error\":\"" << jsonEscape(error.what()) << "\"}" << std::endl;
    return 3;
  }
}

#endif

} // namespace

bool audioUnitHostAvailable() {
#ifdef SOUNDBRIDGE_MACOS
  return true;
#else
  return false;
#endif
}

std::string audioUnitHostStatus() {
#ifdef SOUNDBRIDGE_MACOS
  return "Audio Unit scanner and CoreAudio host worker are available with bounded preset/state file grants.";
#else
  return "Audio Unit hosting is only available on macOS.";
#endif
}

int runAudioUnitHostWorker(int argc, char** argv) {
#ifdef SOUNDBRIDGE_MACOS
  return runAudioUnitHostWorkerMac(argc, argv);
#else
  (void)argc;
  (void)argv;
  std::cout << "{\"error\":\"Audio Unit hosting is only available on macOS.\"}" << std::endl;
  return 3;
#endif
}

} // namespace soundbridge
