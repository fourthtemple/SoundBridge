#include "SoundBridge/Vst3HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/NativeFileGrantSupport.h"
#include "SoundBridge/NativePlugin.h"
#include "SoundBridge/Vst3HostedEffect.h"
#include "SoundBridge/Vst3HostWorkerSupport.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace soundbridge {

namespace {

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

using namespace vst3_worker;
using namespace worker_file_grants;

int runVst3HostWorkerWithSdk(int argc, char** argv) {
  if (argc < 8) {
    std::cerr << "--host-vst3-worker requires bundle path, sample rate, max block size, input channels, output channels, and kind.\n";
    return 2;
  }

  double sampleRate = 48000.0;
  std::uint32_t maxBlockSize = 128;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 2;
  if (!parseSampleRateArg(argv[3], sampleRate) ||
      !parseUint32Arg(argv[4], 1, kMaxWorkerFrames, maxBlockSize) ||
      !parseUint32Arg(argv[5], 0, kMaxWorkerChannels, inputChannels) ||
      !parseUint32Arg(argv[6], 1, kMaxWorkerChannels, outputChannels)) {
    std::cout << "{\"error\":\"invalid_worker_arguments\"}" << std::endl;
    return 2;
  }

  try {
    HostedVst3Effect host(argv[2], sampleRate, maxBlockSize, inputChannels, outputChannels);

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
          if (!std::isfinite(velocity)) {
            velocity = 0.0;
          }
          PendingMidiEvent event;
          event.type = command == "noteOn" && velocity > 0.0
              ? PendingMidiEventType::NoteOn
              : PendingMidiEventType::NoteOff;
          event.note = static_cast<std::uint8_t>(std::clamp(note, 0, 127));
          event.value = static_cast<float>(std::clamp(velocity, 0.0, 1.0));
          event.channel = static_cast<std::uint8_t>(std::clamp(channel, 0, 15));
          event.sampleOffset = static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1)));
          host.enqueueMidiEvents({event});
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "midi") {
          std::string encodedEvents;
          stream >> encodedEvents;
          std::vector<PendingMidiEvent> events;
          if (!parseMidiEvents(encodedEvents, events)) {
            std::cout << "{\"error\":\"invalid_midi_events\"}" << std::endl;
            continue;
          }
          host.enqueueMidiEvents(events);
          std::cout << "{\"ok\":true,\"eventCount\":" << events.size() << "}" << std::endl;
          continue;
        }

        if (command == "parameters") {
          std::cout << host.parametersToJson() << std::endl;
          continue;
        }

        if (command == "noteExpressions") {
          std::cout << host.noteExpressionsToJson() << std::endl;
          continue;
        }

        if (command == "programLists") {
          std::cout << host.programListsToJson() << std::endl;
          continue;
        }

        if (command == "getProgramData") {
          std::string programListIdText;
          std::string programIndexText;
          std::int32_t programListId = 0;
          std::int32_t programIndex = 0;
          stream >> programListIdText;
          stream >> programIndexText;
          if (!parseInt32Arg(
                  programListIdText.c_str(),
                  std::numeric_limits<std::int32_t>::min(),
                  std::numeric_limits<std::int32_t>::max(),
                  programListId) ||
              !parseInt32Arg(
                  programIndexText.c_str(),
                  0,
                  kMaxWorkerProgramsPerParameter - 1,
                  programIndex)) {
            std::cout << "{\"error\":\"invalid_program_data_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.programDataToJson(programListId, programIndex) << std::endl;
          continue;
        }

        if (command == "setProgramData") {
          std::string programListIdText;
          std::string programIndexText;
          std::string dataText;
          std::int32_t programListId = 0;
          std::int32_t programIndex = 0;
          stream >> programListIdText;
          stream >> programIndexText;
          stream >> dataText;
          if (!parseInt32Arg(
                  programListIdText.c_str(),
                  std::numeric_limits<std::int32_t>::min(),
                  std::numeric_limits<std::int32_t>::max(),
                  programListId) ||
              !parseInt32Arg(
                  programIndexText.c_str(),
                  0,
                  kMaxWorkerProgramsPerParameter - 1,
                  programIndex) ||
              dataText.empty()) {
            std::cout << "{\"error\":\"invalid_program_data_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setProgramData(programListId, programIndex, dataText) << std::endl;
          continue;
        }

        if (command == "getState") {
          std::cout << host.stateToJson() << std::endl;
          continue;
        }

        if (command == "setState") {
          std::string componentStateText;
          std::string controllerStateText;
          stream >> componentStateText;
          stream >> controllerStateText;
          if (componentStateText.empty()) {
            std::cout << "{\"error\":\"invalid_state_arguments\"}" << std::endl;
            continue;
          }
          if (controllerStateText.empty()) {
            controllerStateText = "-";
          }
          std::cout << host.setState(componentStateText, controllerStateText) << std::endl;
          continue;
        }

        if (command == "fileGrant") {
          const auto fileGrant = parseFileGrantCommand(stream);
          if (fileGrant.operation == "restoreState") {
            const auto stateFile = readDualStateFile(fileGrant, kMaxWorkerStateBytes);
            host.setState(stateFile.primary, stateFile.secondary);
            std::cout << fileGrantAppliedJson() << std::endl;
            continue;
          }
          if (fileGrant.operation == "loadPreset") {
            const auto presetFile = readDualPresetFile(fileGrant, kMaxWorkerStateBytes);
            host.setState(presetFile.primary, presetFile.secondary);
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
          Steinberg::Vst::ParamID parameterId = 0;
          double value = 0.0;
          std::uint32_t sampleOffset = 0;
          stream >> parameterIdToken;
          stream >> valueText;
          stream >> sampleOffsetText;
          const auto parameterIdText = base64DecodeTextToken(parameterIdToken, kMaxWorkerParameterStringBytes);
          if (!parseParamIdArg(parameterIdText.c_str(), parameterId) ||
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
          Steinberg::Vst::ParamID parameterId = 0;
          stream >> parameterIdToken;
          stream >> displayValueText;
          const auto parameterIdText = base64DecodeTextToken(parameterIdToken, kMaxWorkerParameterStringBytes);
          if (!parseParamIdArg(parameterIdText.c_str(), parameterId) || displayValueText.empty() || displayValueText == "-") {
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
          std::vector<IndexedAudioBus> inputBuses;
          if (!parseAudioBuses(encodedInputBuses, frames, inputBuses)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          const auto rendered = host.render(
              frames,
              renderSampleRate,
              parseChannels(encodedChannels, frames),
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

bool vst3HostWorkerAvailable() {
#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK
  return true;
#else
  return false;
#endif
}

std::string vst3HostWorkerStatus() {
#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK
  return "VST3 SDK host worker is available for installed bundles with bounded preset/state file grants.";
#else
  return "VST3 SDK host worker is not linked; scanner-only VST3 support is active.";
#endif
}

int runVst3HostWorker(int argc, char** argv) {
#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK
  return runVst3HostWorkerWithSdk(argc, argv);
#else
  (void)argc;
  (void)argv;
  std::cout << "{\"error\":\"VST3 SDK host worker is not linked.\"}" << std::endl;
  return 3;
#endif
}

} // namespace soundbridge
