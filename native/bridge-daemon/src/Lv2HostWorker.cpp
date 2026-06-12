#include "SoundBridge/Lv2HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/Lv2HostedPlugin.h"
#include "SoundBridge/Lv2HostWorkerSupport.h"
#include "SoundBridge/NativeFileGrantSupport.h"
#include "SoundBridge/NativePlugin.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge {

namespace {

#ifndef _WIN32

using namespace lv2_worker;
using namespace worker_file_grants;

int runLv2HostWorkerNative(int argc, char** argv) {
  if (argc < 8) {
    std::cerr << "--host-lv2-worker requires bundle path, sample rate, max block size, input channels, output channels, and kind.\n";
    return 2;
  }

  double sampleRate = 48000.0;
  std::uint32_t maxBlockSize = 128;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 2;
  if (!parseSampleRateArg(argv[3], sampleRate) ||
      !parseUint32Arg(argv[4], 1, kMaxWorkerFrames, maxBlockSize) ||
      !parseUint32Arg(argv[5], 0, kMaxWorkerAudioPorts, inputChannels) ||
      !parseUint32Arg(argv[6], 1, kMaxWorkerAudioPorts, outputChannels)) {
    std::cout << "{\"error\":\"invalid_worker_arguments\"}" << std::endl;
    return 2;
  }

  try {
    HostedLv2Plugin host(argv[2], sampleRate, maxBlockSize, inputChannels, outputChannels);

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
        if (command == "noteOn" || command == "noteOff") {
          int note = 60;
          double velocity = command == "noteOn" ? 0.8 : 0.0;
          int channel = 0;
          int sampleOffset = 0;
          stream >> note >> velocity >> channel >> sampleOffset;
          PendingMidiMessage message;
          message.status = static_cast<std::uint8_t>((command == "noteOn" ? 0x90 : 0x80) | std::clamp(channel, 0, 15));
          message.data1 = static_cast<std::uint8_t>(std::clamp(note, 0, 127));
          message.data2 = command == "noteOn" ? scaled7Bit(std::clamp(velocity, 0.0, 1.0)) : 0;
          message.sampleOffset = static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1)));
          host.enqueueMidiEvents({message});
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
          host.enqueueMidiEvents(messages);
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
          std::uint32_t sampleOffset = 0;
          double value = 0.0;
          stream >> parameterIdToken;
          stream >> valueText;
          stream >> sampleOffsetText;
          const auto parameterId = base64DecodeTextToken(parameterIdToken, kMaxWorkerParameterStringBytes);
          if (parameterId.empty() ||
              !parseDoubleArg(valueText.c_str(), 0.0, 1.0, value) ||
              (!sampleOffsetText.empty() && !parseUint32Arg(sampleOffsetText.c_str(), 0, kMaxWorkerFrames - 1, sampleOffset))) {
            std::cout << "{\"error\":\"invalid_parameter_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setParameter(parameterId, value, sampleOffset) << std::endl;
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
          const auto renderedChannels = host.render(
              frames,
              renderSampleRate,
              std::move(channels),
              std::move(inputBuses),
              transport);
          std::cout << host.outputAudioToJson(renderedChannels) << std::endl;
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

bool lv2HostWorkerAvailable() {
#ifndef _WIN32
  return true;
#else
  return false;
#endif
}

std::string lv2HostWorkerStatus() {
#ifndef _WIN32
  return "Basic LV2 audio/control host worker is available with bounded atom MIDI, atom time-position transport, bounded buf-size/options host data including fixed/power-of-two block profiles, synchronous LV2 worker scheduling, LV2 port-group bus routing with per-port fallback, standard latency output-port reporting, worker-native preset loading, and brokered portable/file-backed state delivery; LV2 UI hosting remains disabled.";
#else
  return "LV2 host worker is not available on this platform build.";
#endif
}

int runLv2HostWorker(int argc, char** argv) {
#ifndef _WIN32
  return runLv2HostWorkerNative(argc, argv);
#else
  (void)argc;
  (void)argv;
  std::cout << "{\"error\":\"LV2 host worker is not available on this platform build.\"}" << std::endl;
  return 3;
#endif
}

} // namespace soundbridge
