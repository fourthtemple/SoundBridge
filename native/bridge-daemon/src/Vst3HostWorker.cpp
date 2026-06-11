#include "SoundBridge/Vst3HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/ExampleInstrumentRenderer.h"
#include "SoundBridge/NativePlugin.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK
#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/stringconvert.h"
#include "public.sdk/source/vst/hosting/uid.h"
#endif

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge {

namespace {

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

// Hard limits applied to every value crossing the worker's stdin/argv boundary.
// The parent daemon enforces its own caps, but the worker must not trust it.
constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerChannels = 32;
constexpr std::size_t kMaxWorkerMidiEvents = 4096;
constexpr std::size_t kMaxWorkerParameters = 1024;
constexpr std::size_t kMaxWorkerParameterChanges = 4096;
constexpr std::size_t kMaxWorkerParameterStringBytes = 160;
constexpr Steinberg::int32 kMaxWorkerProgramLists = 256;
constexpr Steinberg::int32 kMaxWorkerProgramsPerParameter = 256;
constexpr Steinberg::int32 kMaxWorkerUnits = 1024;
constexpr std::size_t kMaxWorkerStateBytes = 384 * 1024;
constexpr std::uint32_t kMaxWorkerLatencySamples = 1'048'576;
constexpr std::uint32_t kMaxWorkerTailSamples = 1'048'576;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;
constexpr double kMaxWorkerTransportTempoBpm = 960.0;
constexpr double kMaxWorkerTransportPositionMusic = 1'000'000'000.0;
constexpr long long kMaxWorkerTransportSamplePosition = 9'007'199'254'740'991LL;

enum class PendingMidiEventType {
  NoteOn,
  NoteOff,
  ControlChange,
  PitchBend,
  ChannelPressure,
  PolyPressure,
  ProgramChange
};

struct PendingMidiEvent {
  PendingMidiEventType type = PendingMidiEventType::NoteOn;
  std::uint8_t note = 60;
  std::uint8_t controller = 0;
  std::uint8_t program = 0;
  float value = 0.8F;
  std::uint8_t channel = 0;
  std::uint32_t sampleOffset = 0;
};

struct PendingParameterChange {
  Steinberg::Vst::ParamID id = 0;
  Steinberg::Vst::ParamValue value = 0.0;
  std::uint32_t sampleOffset = 0;
};

struct IndexedAudioBus {
  std::uint32_t index = 0;
  std::vector<std::vector<float>> channels;
};

struct HostTransportContext {
  bool playing = false;
  bool recording = false;
  bool loopActive = false;
  bool hasTempo = false;
  double tempo = 120.0;
  bool hasTimeSignature = false;
  Steinberg::int32 timeSignatureNumerator = 4;
  Steinberg::int32 timeSignatureDenominator = 4;
  bool hasProjectTimeMusic = false;
  double projectTimeMusic = 0.0;
  bool hasBarPositionMusic = false;
  double barPositionMusic = 0.0;
  bool hasCycle = false;
  double cycleStartMusic = 0.0;
  double cycleEndMusic = 0.0;
  Steinberg::Vst::TSamples samplePosition = 0;
};

struct RenderedAudio {
  std::vector<std::vector<float>> channels;
  std::vector<IndexedAudioBus> outputBuses;
};

float sanitizeSample(const std::string& text) {
  char* end = nullptr;
  const double value = std::strtod(text.c_str(), &end);
  if (end == text.c_str() || !std::isfinite(value)) {
    return 0.0F;
  }
  return static_cast<float>(std::clamp(value, -16.0, 16.0));
}

bool parseUint32Arg(const char* text, std::uint32_t minValue, std::uint32_t maxValue, std::uint32_t& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char* end = nullptr;
  const unsigned long value = std::strtoul(text, &end, 10);
  if (end == text || *end != '\0' || value < minValue || value > maxValue) {
    return false;
  }
  out = static_cast<std::uint32_t>(value);
  return true;
}

bool parseParamIdArg(const char* text, Steinberg::Vst::ParamID& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char* end = nullptr;
  const unsigned long value = std::strtoul(text, &end, 10);
  if (end == text || *end != '\0' || value > 0xFFFFFFFFUL) {
    return false;
  }
  out = static_cast<Steinberg::Vst::ParamID>(value);
  return true;
}

bool parseSampleRateArg(const char* text, double& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char* end = nullptr;
  const double value = std::strtod(text, &end);
  if (end == text || *end != '\0' || !std::isfinite(value) ||
      value < kMinWorkerSampleRate || value > kMaxWorkerSampleRate) {
    return false;
  }
  out = value;
  return true;
}

bool parseDoubleArg(const char* text, double minValue, double maxValue, double& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char* end = nullptr;
  const double value = std::strtod(text, &end);
  if (end == text || *end != '\0' || !std::isfinite(value) ||
      value < minValue || value > maxValue) {
    return false;
  }
  out = value;
  return true;
}

bool parseTransportBool(const std::string& text, bool& out) {
  if (text == "1") {
    out = true;
    return true;
  }
  if (text == "0") {
    out = false;
    return true;
  }
  return false;
}

bool parseTransportSamplePosition(const std::string& text, Steinberg::Vst::TSamples& out) {
  if (text.empty()) {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const long long value = std::strtoll(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0' || errno == ERANGE ||
      value < 0 || value > kMaxWorkerTransportSamplePosition) {
    return false;
  }
  out = static_cast<Steinberg::Vst::TSamples>(value);
  return true;
}

bool isPowerOfTwo(std::uint32_t value) {
  return value > 0 && (value & (value - 1U)) == 0;
}

bool parseTransportContext(
    const std::string& encoded,
    double fallbackSampleTime,
    HostTransportContext& out) {
  out = HostTransportContext {};
  out.samplePosition = static_cast<Steinberg::Vst::TSamples>(std::max(0.0, fallbackSampleTime));
  if (encoded.empty() || encoded == "-") {
    return true;
  }

  bool sawNumerator = false;
  bool sawDenominator = false;
  bool sawCycleStart = false;
  bool sawCycleEnd = false;

  std::stringstream stream(encoded);
  std::string token;
  while (std::getline(stream, token, ',')) {
    if (token.empty()) {
      continue;
    }
    const auto separator = token.find('=');
    if (separator == std::string::npos) {
      return false;
    }
    const auto key = token.substr(0, separator);
    const auto value = token.substr(separator + 1);

    if (key == "playing") {
      if (!parseTransportBool(value, out.playing)) {
        return false;
      }
    } else if (key == "recording") {
      if (!parseTransportBool(value, out.recording)) {
        return false;
      }
    } else if (key == "loop") {
      if (!parseTransportBool(value, out.loopActive)) {
        return false;
      }
    } else if (key == "tempo") {
      if (!parseDoubleArg(value.c_str(), 1.0, kMaxWorkerTransportTempoBpm, out.tempo)) {
        return false;
      }
      out.hasTempo = true;
    } else if (key == "num") {
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed)) {
        return false;
      }
      out.timeSignatureNumerator = static_cast<Steinberg::int32>(parsed);
      sawNumerator = true;
    } else if (key == "den") {
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed) || !isPowerOfTwo(parsed)) {
        return false;
      }
      out.timeSignatureDenominator = static_cast<Steinberg::int32>(parsed);
      sawDenominator = true;
    } else if (key == "ppq") {
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.projectTimeMusic)) {
        return false;
      }
      out.hasProjectTimeMusic = true;
    } else if (key == "bar") {
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.barPositionMusic)) {
        return false;
      }
      out.hasBarPositionMusic = true;
    } else if (key == "cycleStart") {
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.cycleStartMusic)) {
        return false;
      }
      sawCycleStart = true;
    } else if (key == "cycleEnd") {
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.cycleEndMusic)) {
        return false;
      }
      sawCycleEnd = true;
    } else if (key == "sample") {
      if (!parseTransportSamplePosition(value, out.samplePosition)) {
        return false;
      }
    } else {
      return false;
    }
  }

  if (sawNumerator != sawDenominator) {
    return false;
  }
  out.hasTimeSignature = sawNumerator && sawDenominator;
  if (sawCycleStart != sawCycleEnd || (sawCycleStart && out.cycleEndMusic < out.cycleStartMusic)) {
    return false;
  }
  out.hasCycle = sawCycleStart && sawCycleEnd;
  return true;
}

std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes) {
  if (value.size() > maxBytes) {
    value.resize(maxBytes);
  }
  return value;
}

std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames) {
  frames = std::clamp<std::uint32_t>(frames, 1, kMaxWorkerFrames);
  if (encoded.empty() || encoded == "-") {
    return {};
  }

  std::vector<std::vector<float>> channels;
  std::stringstream channelStream(encoded);
  std::string channelText;
  while (channels.size() < kMaxWorkerChannels && std::getline(channelStream, channelText, '|')) {
    std::vector<float> channel;
    channel.reserve(frames);
    std::stringstream sampleStream(channelText);
    std::string sampleText;
    while (channel.size() < frames && std::getline(sampleStream, sampleText, ',')) {
      if (sampleText.empty()) {
        channel.push_back(0.0F);
        continue;
      }
      channel.push_back(sanitizeSample(sampleText));
    }
    channel.resize(frames, 0.0F);
    channels.push_back(std::move(channel));
  }
  return channels;
}

std::vector<IndexedAudioBus> parseAudioBuses(const std::string& encoded, std::uint32_t frames) {
  std::vector<IndexedAudioBus> buses;
  if (encoded.empty() || encoded == "-") {
    return buses;
  }

  std::stringstream stream(encoded);
  std::string token;
  while (buses.size() < kMaxWorkerChannels && std::getline(stream, token, ';')) {
    if (token.empty()) {
      continue;
    }
    const auto separator = token.find('=');
    if (separator == std::string::npos) {
      continue;
    }
    std::uint32_t index = 0;
    if (!parseUint32Arg(token.substr(0, separator).c_str(), 0, kMaxWorkerChannels - 1, index)) {
      continue;
    }
    buses.push_back(IndexedAudioBus{
        index,
        parseChannels(token.substr(separator + 1), frames)});
  }
  return buses;
}

const std::vector<std::vector<float>>* findBusChannels(const std::vector<IndexedAudioBus>& buses, std::uint32_t index) {
  for (const auto& bus : buses) {
    if (bus.index == index) {
      return &bus.channels;
    }
  }
  return nullptr;
}

bool parseMidiEventToken(const std::string& token, PendingMidiEvent& event) {
  std::vector<std::string> parts;
  std::stringstream stream(token);
  std::string part;
  while (std::getline(stream, part, ':')) {
    parts.push_back(part);
  }
  if (parts.empty()) {
    return false;
  }

  auto parseChannelAndOffset = [&](std::size_t channelIndex, std::size_t offsetIndex) -> bool {
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    if (!parseUint32Arg(parts[channelIndex].c_str(), 0, 15, channel) ||
        !parseUint32Arg(parts[offsetIndex].c_str(), 0, kMaxWorkerFrames - 1, sampleOffset)) {
      return false;
    }
    event.channel = static_cast<std::uint8_t>(channel);
    event.sampleOffset = sampleOffset;
    return true;
  };

  if (parts[0] == "on" || parts[0] == "off" || parts[0] == "poly") {
    if (parts.size() != 5) {
      return false;
    }
    std::uint32_t note = 60;
    double value = parts[0] == "off" ? 0.0 : 0.8;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, note) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4)) {
      return false;
    }
    event.type = parts[0] == "on"
        ? PendingMidiEventType::NoteOn
        : parts[0] == "off" ? PendingMidiEventType::NoteOff : PendingMidiEventType::PolyPressure;
    event.note = static_cast<std::uint8_t>(note);
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "cc") {
    if (parts.size() != 5) {
      return false;
    }
    std::uint32_t controller = 0;
    double value = 0.0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, controller) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4)) {
      return false;
    }
    event.type = PendingMidiEventType::ControlChange;
    event.controller = static_cast<std::uint8_t>(controller);
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "bend") {
    if (parts.size() != 4) {
      return false;
    }
    double value = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), -1.0, 1.0, value) ||
        !parseChannelAndOffset(2, 3)) {
      return false;
    }
    event.type = PendingMidiEventType::PitchBend;
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "pressure") {
    if (parts.size() != 4) {
      return false;
    }
    double pressure = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), 0.0, 1.0, pressure) ||
        !parseChannelAndOffset(2, 3)) {
      return false;
    }
    event.type = PendingMidiEventType::ChannelPressure;
    event.value = static_cast<float>(pressure);
    return true;
  }

  if (parts[0] == "program") {
    if (parts.size() != 4) {
      return false;
    }
    std::uint32_t program = 0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, program) ||
        !parseChannelAndOffset(2, 3)) {
      return false;
    }
    event.type = PendingMidiEventType::ProgramChange;
    event.program = static_cast<std::uint8_t>(program);
    return true;
  }

  return false;
}

bool parseMidiEvents(const std::string& encoded, std::vector<PendingMidiEvent>& events) {
  events.clear();
  if (encoded.empty() || encoded == "-") {
    return true;
  }

  std::stringstream stream(encoded);
  std::string token;
  while (std::getline(stream, token, ';')) {
    if (token.empty()) {
      continue;
    }
    if (events.size() >= kMaxWorkerMidiEvents) {
      return false;
    }
    PendingMidiEvent event;
    if (!parseMidiEventToken(token, event)) {
      return false;
    }
    events.push_back(event);
  }
  return true;
}

bool makeVst3Event(const PendingMidiEvent& pending, std::uint32_t frames, Steinberg::Vst::Event& event) {
  event = {};
  event.busIndex = 0;
  event.sampleOffset = static_cast<Steinberg::int32>(
      std::clamp<std::uint32_t>(pending.sampleOffset, 0, frames > 0 ? frames - 1 : 0));
  event.ppqPosition = 0.0;
  event.flags = Steinberg::Vst::Event::kIsLive;
  if (pending.type == PendingMidiEventType::NoteOn && pending.value > 0.0F) {
    event.type = Steinberg::Vst::Event::kNoteOnEvent;
    event.noteOn.channel = static_cast<Steinberg::int16>(pending.channel);
    event.noteOn.pitch = static_cast<Steinberg::int16>(pending.note);
    event.noteOn.tuning = 0.0F;
    event.noteOn.velocity = std::clamp(pending.value, 0.0F, 1.0F);
    event.noteOn.length = 0;
    event.noteOn.noteId = -1;
    return true;
  }
  if (pending.type == PendingMidiEventType::NoteOff ||
      pending.type == PendingMidiEventType::NoteOn) {
    event.type = Steinberg::Vst::Event::kNoteOffEvent;
    event.noteOff.channel = static_cast<Steinberg::int16>(pending.channel);
    event.noteOff.pitch = static_cast<Steinberg::int16>(pending.note);
    event.noteOff.velocity = std::clamp(pending.value, 0.0F, 1.0F);
    event.noteOff.noteId = -1;
    event.noteOff.tuning = 0.0F;
    return true;
  }
  if (pending.type == PendingMidiEventType::PolyPressure) {
    event.type = Steinberg::Vst::Event::kPolyPressureEvent;
    event.polyPressure.channel = static_cast<Steinberg::int16>(pending.channel);
    event.polyPressure.pitch = static_cast<Steinberg::int16>(pending.note);
    event.polyPressure.pressure = std::clamp(pending.value, 0.0F, 1.0F);
    event.polyPressure.noteId = -1;
    return true;
  }
  return false;
}

std::string audioChannelsToJson(const std::vector<std::vector<float>>& channels) {
  std::ostringstream output;
  output << "[";
  for (std::size_t channelIndex = 0; channelIndex < channels.size(); ++channelIndex) {
    if (channelIndex > 0) {
      output << ",";
    }
    output << "[";
    for (std::size_t frame = 0; frame < channels[channelIndex].size(); ++frame) {
      if (frame > 0) {
        output << ",";
      }
      const auto sample = channels[channelIndex][frame];
      output << (std::isfinite(sample) ? sample : 0.0F);
    }
    output << "]";
  }
  output << "]";
  return output.str();
}

std::string renderedAudioToJson(const RenderedAudio& rendered) {
  std::ostringstream output;
  output << "{\"channels\":" << audioChannelsToJson(rendered.channels)
         << ",\"outputBuses\":[";
  for (std::size_t index = 0; index < rendered.outputBuses.size(); ++index) {
    if (index > 0) {
      output << ",";
    }
    output << "{\"index\":" << rendered.outputBuses[index].index
           << ",\"channels\":" << audioChannelsToJson(rendered.outputBuses[index].channels)
           << "}";
  }
  output << "]}";
  return output.str();
}

bool parameterIsAutomatable(const Steinberg::Vst::ParameterInfo& info) {
  return (info.flags & Steinberg::Vst::ParameterInfo::kCanAutomate) != 0 &&
      (info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) == 0;
}

void checkResult(Steinberg::tresult result, const std::string& operation) {
  if (result != Steinberg::kResultOk) {
    std::ostringstream message;
    message << operation << " failed with VST3 result " << result;
    throw std::runtime_error(message.str());
  }
}

Steinberg::Vst::SpeakerArrangement arrangementForChannels(std::uint32_t channels) {
  if (channels == 0) {
    return Steinberg::Vst::SpeakerArr::kEmpty;
  }
  if (channels == 1) {
    return Steinberg::Vst::SpeakerArr::kMono;
  }
  return Steinberg::Vst::SpeakerArr::kStereo;
}

std::uint32_t channelsForArrangement(
    Steinberg::Vst::SpeakerArrangement arrangement,
    std::uint32_t fallbackChannels) {
  if (arrangement == Steinberg::Vst::SpeakerArr::kEmpty) {
    return 0;
  }

  std::uint32_t channels = 0;
  while (arrangement != 0) {
    channels += static_cast<std::uint32_t>(arrangement & 1U);
    arrangement >>= 1U;
  }
  return channels == 0 ? fallbackChannels : channels;
}

const VST3::Hosting::ClassInfo* findAudioClass(const VST3::Hosting::PluginFactory::ClassInfos& classes) {
  for (const auto& classInfo : classes) {
    if (classInfo.category() == kVstAudioEffectClass) {
      return &classInfo;
    }
  }
  return nullptr;
}

class HostedVst3Effect {
public:
  HostedVst3Effect(
      std::string bundlePath,
      double sampleRate,
      std::uint32_t maxBlockSize,
      std::uint32_t inputChannels,
      std::uint32_t outputChannels)
      : sampleRate_(sampleRate),
        maxBlockSize_(std::clamp<std::uint32_t>(maxBlockSize, 1, 8192)),
        requestedInputChannels_(std::min<std::uint32_t>(inputChannels, 32)),
        requestedOutputChannels_(std::clamp<std::uint32_t>(outputChannels, 1, 32)) {
    std::string loadError;
    module_ = VST3::Hosting::Module::create(bundlePath, loadError);
    if (!module_) {
      throw std::runtime_error(loadError.empty() ? "VST3 module could not be loaded." : loadError);
    }

    module_->getFactory().setHostContext(&hostApplication_);
    const auto classes = module_->getFactory().classInfos();
    const auto* audioClass = findAudioClass(classes);
    if (audioClass == nullptr) {
      throw std::runtime_error("VST3 bundle does not expose an audio component class.");
    }

    component_ = module_->getFactory().createInstance<Steinberg::Vst::IComponent>(audioClass->ID());
    if (!component_) {
      throw std::runtime_error("VST3 factory could not create an IComponent instance.");
    }

    processor_ = Steinberg::FUnknownPtr<Steinberg::Vst::IAudioProcessor>(component_);
    if (!processor_) {
      throw std::runtime_error("VST3 component does not implement IAudioProcessor.");
    }

    checkResult(component_->initialize(&hostApplication_), "IComponent::initialize");
    initialized_ = true;
    initializeController();
    connectController();
    configure();
  }

  HostedVst3Effect(const HostedVst3Effect&) = delete;
  HostedVst3Effect& operator=(const HostedVst3Effect&) = delete;

  ~HostedVst3Effect() {
    if (processor_) {
      processor_->setProcessing(false);
    }
    disconnectController();
    if (component_) {
      if (active_) {
        component_->setActive(false);
      }
      if (initialized_) {
        component_->terminate();
      }
    }
    if (controller_ && controllerInitialized_) {
      controller_->terminate();
    }
  }

  double sampleTime() const {
    return sampleTime_;
  }

  RenderedAudio render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels,
      std::vector<IndexedAudioBus> inputBuses,
      HostTransportContext transport) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("VST3 worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    if (inputBuses.empty() && !inputChannels.empty()) {
      inputBuses.push_back(IndexedAudioBus{0, std::move(inputChannels)});
    }

    std::vector<std::vector<std::vector<float>>> inputStorage(inputBusChannels_.size());
    std::vector<std::vector<Steinberg::Vst::Sample32*>> inputPointers(inputBusChannels_.size());
    std::vector<Steinberg::Vst::AudioBusBuffers> inputBusBuffers(inputBusChannels_.size());
    for (std::size_t busIndex = 0; busIndex < inputBusChannels_.size(); ++busIndex) {
      const auto channelCount = inputBusChannels_[busIndex];
      inputStorage[busIndex].resize(channelCount);
      const auto* requestedBus = findBusChannels(inputBuses, static_cast<std::uint32_t>(busIndex));
      for (std::uint32_t channelIndex = 0; channelIndex < channelCount; ++channelIndex) {
        inputStorage[busIndex][channelIndex].assign(frames, 0.0F);
        if (requestedBus != nullptr && channelIndex < requestedBus->size()) {
          const auto copyFrames = std::min<std::size_t>(frames, (*requestedBus)[channelIndex].size());
          for (std::size_t frame = 0; frame < copyFrames; ++frame) {
            inputStorage[busIndex][channelIndex][frame] = std::clamp((*requestedBus)[channelIndex][frame], -1.0F, 1.0F);
          }
        }
      }
      inputPointers[busIndex].resize(channelCount);
      for (std::uint32_t channelIndex = 0; channelIndex < channelCount; ++channelIndex) {
        inputPointers[busIndex][channelIndex] = inputStorage[busIndex][channelIndex].data();
      }
      inputBusBuffers[busIndex].numChannels = static_cast<Steinberg::int32>(channelCount);
      inputBusBuffers[busIndex].silenceFlags = 0;
      inputBusBuffers[busIndex].channelBuffers32 = inputPointers[busIndex].empty() ? nullptr : inputPointers[busIndex].data();
    }

    std::vector<std::vector<std::vector<float>>> outputStorage(outputBusChannels_.size());
    std::vector<std::vector<Steinberg::Vst::Sample32*>> outputPointers(outputBusChannels_.size());
    std::vector<Steinberg::Vst::AudioBusBuffers> outputBusBuffers(outputBusChannels_.size());
    for (std::size_t busIndex = 0; busIndex < outputBusChannels_.size(); ++busIndex) {
      const auto channelCount = outputBusChannels_[busIndex];
      outputStorage[busIndex].resize(channelCount);
      outputPointers[busIndex].resize(channelCount);
      for (std::uint32_t channelIndex = 0; channelIndex < channelCount; ++channelIndex) {
        outputStorage[busIndex][channelIndex].assign(frames, 0.0F);
        outputPointers[busIndex][channelIndex] = outputStorage[busIndex][channelIndex].data();
      }
      outputBusBuffers[busIndex].numChannels = static_cast<Steinberg::int32>(channelCount);
      outputBusBuffers[busIndex].silenceFlags = 0;
      outputBusBuffers[busIndex].channelBuffers32 = outputPointers[busIndex].empty() ? nullptr : outputPointers[busIndex].data();
    }

    Steinberg::Vst::ProcessData processData {};
    processData.processMode = Steinberg::Vst::kRealtime;
    processData.symbolicSampleSize = Steinberg::Vst::kSample32;
    processData.numSamples = static_cast<Steinberg::int32>(frames);
    processData.numInputs = static_cast<Steinberg::int32>(inputBusBuffers.size());
    processData.numOutputs = static_cast<Steinberg::int32>(outputBusBuffers.size());
    processData.inputs = inputBusBuffers.empty() ? nullptr : inputBusBuffers.data();
    processData.outputs = outputBusBuffers.empty() ? nullptr : outputBusBuffers.data();

    Steinberg::Vst::ProcessContext processContext {};
    processContext.sampleRate = sampleRate_;
    processContext.projectTimeSamples = transport.samplePosition;
    processContext.continousTimeSamples = transport.samplePosition;
    processContext.state = Steinberg::Vst::ProcessContext::kContTimeValid;
    if (transport.playing) {
      processContext.state |= Steinberg::Vst::ProcessContext::kPlaying;
    }
    if (transport.recording) {
      processContext.state |= Steinberg::Vst::ProcessContext::kRecording;
    }
    if (transport.loopActive) {
      processContext.state |= Steinberg::Vst::ProcessContext::kCycleActive;
    }
    if (transport.hasTempo) {
      processContext.tempo = transport.tempo;
      processContext.state |= Steinberg::Vst::ProcessContext::kTempoValid;
    }
    if (transport.hasTimeSignature) {
      processContext.timeSigNumerator = transport.timeSignatureNumerator;
      processContext.timeSigDenominator = transport.timeSignatureDenominator;
      processContext.state |= Steinberg::Vst::ProcessContext::kTimeSigValid;
    }
    if (transport.hasProjectTimeMusic) {
      processContext.projectTimeMusic = transport.projectTimeMusic;
      processContext.state |= Steinberg::Vst::ProcessContext::kProjectTimeMusicValid;
    }
    if (transport.hasBarPositionMusic) {
      processContext.barPositionMusic = transport.barPositionMusic;
      processContext.state |= Steinberg::Vst::ProcessContext::kBarPositionValid;
    }
    if (transport.hasCycle) {
      processContext.cycleStartMusic = transport.cycleStartMusic;
      processContext.cycleEndMusic = transport.cycleEndMusic;
      processContext.state |= Steinberg::Vst::ProcessContext::kCycleValid;
    }
    processData.processContext = &processContext;

    auto midiEvents = std::move(pendingMidiEvents_);
    pendingMidiEvents_.clear();
    std::stable_sort(midiEvents.begin(), midiEvents.end(), [](const auto& left, const auto& right) {
      return left.sampleOffset < right.sampleOffset;
    });

    auto parameterEvents = std::move(pendingParameterChanges_);
    pendingParameterChanges_.clear();
    for (const auto& midiEvent : midiEvents) {
      PendingParameterChange mappedChange {};
      if (midiEventToParameterChange(midiEvent, mappedChange) &&
          parameterEvents.size() < kMaxWorkerParameterChanges) {
        parameterEvents.push_back(mappedChange);
      }
    }
    std::stable_sort(parameterEvents.begin(), parameterEvents.end(), [](const auto& left, const auto& right) {
      return left.sampleOffset < right.sampleOffset;
    });
    Steinberg::Vst::ParameterChanges inputParameterChanges(static_cast<Steinberg::int32>(parameterEvents.size()));
    for (const auto& parameterEvent : parameterEvents) {
      Steinberg::int32 queueIndex = 0;
      auto* queue = inputParameterChanges.addParameterData(parameterEvent.id, queueIndex);
      if (queue == nullptr) {
        continue;
      }
      Steinberg::int32 pointIndex = 0;
      queue->addPoint(
          static_cast<Steinberg::int32>(
              std::clamp<std::uint32_t>(parameterEvent.sampleOffset, 0, frames > 0 ? frames - 1 : 0)),
          parameterEvent.value,
          pointIndex);
    }
    processData.inputParameterChanges = inputParameterChanges.getParameterCount() > 0 ? &inputParameterChanges : nullptr;
    processData.outputParameterChanges = nullptr;

    Steinberg::Vst::EventList inputEvents(static_cast<Steinberg::int32>(midiEvents.size()));
    for (const auto& midiEvent : midiEvents) {
      Steinberg::Vst::Event vstEvent {};
      if (makeVst3Event(midiEvent, frames, vstEvent)) {
        inputEvents.addEvent(vstEvent);
      }
    }
    processData.inputEvents = inputEvents.getEventCount() > 0 ? &inputEvents : nullptr;
    processData.outputEvents = nullptr;

    checkResult(processor_->process(processData), "IAudioProcessor::process");
    sampleTime_ = static_cast<double>(transport.samplePosition) + frames;
    RenderedAudio rendered;
    rendered.channels = outputStorage.empty() ? std::vector<std::vector<float>>{} : outputStorage[0];
    for (std::size_t busIndex = 0; busIndex < outputStorage.size(); ++busIndex) {
      rendered.outputBuses.push_back(IndexedAudioBus{
          static_cast<std::uint32_t>(busIndex),
          outputStorage[busIndex]});
    }
    return rendered;
  }

  void enqueueMidiEvents(std::vector<PendingMidiEvent> events) {
    if (events.empty()) {
      return;
    }
    if (pendingMidiEvents_.size() + events.size() > kMaxWorkerMidiEvents) {
      throw std::runtime_error("too_many_queued_midi_events");
    }
    pendingMidiEvents_.insert(pendingMidiEvents_.end(), events.begin(), events.end());
  }

  std::vector<std::string> parameterJsonList() const {
    std::vector<std::string> parameters;
    if (!controller_) {
      return parameters;
    }

    const auto count = std::clamp<Steinberg::int32>(
        controller_->getParameterCount(),
        0,
        static_cast<Steinberg::int32>(kMaxWorkerParameters));
    parameters.reserve(static_cast<std::size_t>(count));
    for (Steinberg::int32 index = 0; index < count; ++index) {
      Steinberg::Vst::ParameterInfo info {};
      if (controller_->getParameterInfo(index, info) != Steinberg::kResultOk) {
        continue;
      }
      parameters.push_back(parameterInfoToJson(info));
    }
    return parameters;
  }

  std::string parametersToJson() const {
    const auto parameters = parameterJsonList();
    std::ostringstream output;
    output << "{\"parameters\":[";
    for (std::size_t index = 0; index < parameters.size(); ++index) {
      if (index > 0) {
        output << ",";
      }
      output << parameters[index];
    }
    output << "]}";
    return output.str();
  }

  std::string setParameter(Steinberg::Vst::ParamID id, double value, std::uint32_t sampleOffset) {
    if (!controller_) {
      throw std::runtime_error("VST3 plugin does not expose an edit controller.");
    }
    const auto normalizedValue = std::clamp(value, 0.0, 1.0);
    if (controller_->setParamNormalized(id, normalizedValue) != Steinberg::kResultOk) {
      throw std::runtime_error("VST3 controller rejected parameter value.");
    }
    if (pendingParameterChanges_.size() >= kMaxWorkerParameterChanges) {
      throw std::runtime_error("too_many_queued_parameter_changes");
    }
    pendingParameterChanges_.push_back(PendingParameterChange{
        id,
        normalizedValue,
        std::clamp<std::uint32_t>(sampleOffset, 0, kMaxWorkerFrames - 1)});

    Steinberg::Vst::ParameterInfo info {};
    const auto count = std::clamp<Steinberg::int32>(
        controller_->getParameterCount(),
        0,
        static_cast<Steinberg::int32>(kMaxWorkerParameters));
    for (Steinberg::int32 index = 0; index < count; ++index) {
      if (controller_->getParameterInfo(index, info) == Steinberg::kResultOk && info.id == id) {
        return std::string("{\"parameter\":") + parameterInfoToJson(info) + "}";
      }
    }
    throw std::runtime_error("unknown_parameter");
  }

  std::string stateToJson() const {
    std::ostringstream output;
    output << "{\"state\":{"
           << "\"component\":\"" << componentStateBase64() << "\""
           << ",\"controller\":\"" << controllerStateBase64() << "\""
           << "}}";
    return output.str();
  }

  std::string setState(const std::string& componentStateText, const std::string& controllerStateText) {
    if (componentStateText != "-") {
      auto componentState = base64Decode(componentStateText, kMaxWorkerStateBytes);
      Steinberg::MemoryStream componentStream(componentState.data(), static_cast<Steinberg::TSize>(componentState.size()));
      checkResult(component_->setState(&componentStream), "IComponent::setState");

      if (controller_) {
        componentStream.seek(0, Steinberg::IBStream::kIBSeekSet, nullptr);
        controller_->setComponentState(&componentStream);
      }
    }

    if (controller_ && controllerStateText != "-") {
      auto controllerState = base64Decode(controllerStateText, kMaxWorkerStateBytes);
      Steinberg::MemoryStream controllerStream(controllerState.data(), static_cast<Steinberg::TSize>(controllerState.size()));
      checkResult(controller_->setState(&controllerStream), "IEditController::setState");
    }

    return "{\"ok\":true}";
  }

  std::string latencyToJson() const {
    const auto samples = std::min<std::uint32_t>(processor_->getLatencySamples(), kMaxWorkerLatencySamples);
    std::ostringstream output;
    output << "{\"latencySamples\":" << samples << "}";
    return output.str();
  }

  std::string tailTimeToJson() const {
    const auto rawSamples = processor_->getTailSamples();
    const auto infiniteTail = rawSamples == Steinberg::Vst::kInfiniteTail;
    const auto samples = infiniteTail
        ? kMaxWorkerTailSamples
        : std::min<std::uint32_t>(rawSamples, kMaxWorkerTailSamples);
    std::ostringstream output;
    output << "{\"tailSamples\":" << samples
           << ",\"infiniteTail\":" << (infiniteTail ? "true" : "false")
           << "}";
    return output.str();
  }

  std::string layoutToJson() const {
    std::ostringstream output;
    output << "{\"requestedInputChannels\":" << requestedInputChannels_
           << ",\"requestedOutputChannels\":" << requestedOutputChannels_
           << ",\"inputChannels\":" << inputChannels_
           << ",\"outputChannels\":" << outputChannels_
           << ",\"inputBuses\":" << std::clamp<Steinberg::int32>(inputBusCount_, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels))
           << ",\"outputBuses\":" << std::clamp<Steinberg::int32>(outputBusCount_, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels))
           << ",\"inputBusLayouts\":" << busLayoutsToJson(Steinberg::Vst::kInput, inputBusCount_)
           << ",\"outputBusLayouts\":" << busLayoutsToJson(Steinberg::Vst::kOutput, outputBusCount_)
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

private:
  std::string busLayoutsToJson(Steinberg::Vst::BusDirection direction, Steinberg::int32 busCount) const {
    std::ostringstream output;
    output << "[";
    const auto count = std::clamp<Steinberg::int32>(busCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels));
    for (Steinberg::int32 index = 0; index < count; ++index) {
      if (index > 0) {
        output << ",";
      }
      Steinberg::Vst::BusInfo info {};
      if (component_->getBusInfo(Steinberg::Vst::kAudio, direction, index, info) != Steinberg::kResultOk) {
        info.mediaType = Steinberg::Vst::kAudio;
        info.direction = direction;
        info.channelCount = 0;
        info.busType = index == 0 ? Steinberg::Vst::kMain : Steinberg::Vst::kAux;
      }

      const auto& activeChannels = direction == Steinberg::Vst::kInput ? inputBusChannels_ : outputBusChannels_;
      const auto active = static_cast<std::size_t>(index) < activeChannels.size() && activeChannels[static_cast<std::size_t>(index)] > 0;
      const auto channels = active
          ? activeChannels[static_cast<std::size_t>(index)]
          : static_cast<std::uint32_t>(std::clamp<Steinberg::int32>(info.channelCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels)));
      const auto name = cappedString(VST3::StringConvert::convert(info.name));
      output << "{\"index\":" << index
             << ",\"direction\":\"" << (direction == Steinberg::Vst::kInput ? "input" : "output") << "\""
             << ",\"mediaType\":\"audio\""
             << ",\"name\":\"" << jsonEscape(name.empty() ? (direction == Steinberg::Vst::kInput ? "Input" : "Output") : name) << "\""
             << ",\"type\":\"" << (info.busType == Steinberg::Vst::kMain ? "main" : info.busType == Steinberg::Vst::kAux ? "aux" : "unknown") << "\""
             << ",\"channels\":" << std::min<std::uint32_t>(channels, kMaxWorkerChannels)
             << ",\"active\":" << (active ? "true" : "false")
             << "}";
    }
    output << "]";
    return output.str();
  }

  bool midiEventToParameterChange(const PendingMidiEvent& event, PendingParameterChange& parameterChange) {
    if (!midiMapping_ || !controller_) {
      return false;
    }

    Steinberg::Vst::CtrlNumber controllerNumber = 0;
    double normalizedValue = 0.0;
    switch (event.type) {
      case PendingMidiEventType::ControlChange:
        controllerNumber = static_cast<Steinberg::Vst::CtrlNumber>(event.controller);
        normalizedValue = event.value;
        break;
      case PendingMidiEventType::PitchBend:
        controllerNumber = Steinberg::Vst::kPitchBend;
        normalizedValue = (static_cast<double>(event.value) + 1.0) / 2.0;
        break;
      case PendingMidiEventType::ChannelPressure:
        controllerNumber = Steinberg::Vst::kAfterTouch;
        normalizedValue = event.value;
        break;
      default:
        return false;
    }

    Steinberg::Vst::ParamID id = 0;
    if (midiMapping_->getMidiControllerAssignment(
            0,
            static_cast<Steinberg::int16>(event.channel),
            controllerNumber,
            id) != Steinberg::kResultOk) {
      return false;
    }

    normalizedValue = std::clamp(normalizedValue, 0.0, 1.0);
    if (controller_->setParamNormalized(id, normalizedValue) != Steinberg::kResultOk) {
      return false;
    }

    parameterChange.id = id;
    parameterChange.value = normalizedValue;
    parameterChange.sampleOffset = std::clamp<std::uint32_t>(event.sampleOffset, 0, kMaxWorkerFrames - 1);
    return true;
  }

  void initializeController() {
    controller_ = Steinberg::FUnknownPtr<Steinberg::Vst::IEditController>(component_);
    if (controller_) {
      midiMapping_ = Steinberg::FUnknownPtr<Steinberg::Vst::IMidiMapping>(controller_);
      unitInfo_ = Steinberg::FUnknownPtr<Steinberg::Vst::IUnitInfo>(controller_);
      return;
    }

    Steinberg::TUID controllerClassId {};
    if (component_->getControllerClassId(controllerClassId) != Steinberg::kResultOk) {
      return;
    }

    controller_ = module_->getFactory().createInstance<Steinberg::Vst::IEditController>(VST3::UID(controllerClassId));
    if (controller_) {
      checkResult(controller_->initialize(&hostApplication_), "IEditController::initialize");
      controllerInitialized_ = true;
      midiMapping_ = Steinberg::FUnknownPtr<Steinberg::Vst::IMidiMapping>(controller_);
      unitInfo_ = Steinberg::FUnknownPtr<Steinberg::Vst::IUnitInfo>(controller_);
    }
  }

  void connectController() {
    if (!component_ || !controller_) {
      return;
    }

    componentConnection_ = Steinberg::FUnknownPtr<Steinberg::Vst::IConnectionPoint>(component_);
    controllerConnection_ = Steinberg::FUnknownPtr<Steinberg::Vst::IConnectionPoint>(controller_);
    if (!componentConnection_ || !controllerConnection_) {
      componentConnection_ = nullptr;
      controllerConnection_ = nullptr;
      return;
    }

    componentConnected_ = componentConnection_->connect(controllerConnection_) == Steinberg::kResultTrue;
    controllerConnected_ = controllerConnection_->connect(componentConnection_) == Steinberg::kResultTrue;
  }

  void disconnectController() {
    if (componentConnection_ && controllerConnection_) {
      if (controllerConnected_) {
        controllerConnection_->disconnect(componentConnection_);
      }
      if (componentConnected_) {
        componentConnection_->disconnect(controllerConnection_);
      }
    }
    componentConnection_ = nullptr;
    controllerConnection_ = nullptr;
    componentConnected_ = false;
    controllerConnected_ = false;
  }

  std::string componentStateBase64() const {
    Steinberg::MemoryStream stream;
    if (component_->getState(&stream) != Steinberg::kResultOk) {
      return "";
    }
    return streamToBase64(stream, "component_state_too_large");
  }

  std::string controllerStateBase64() const {
    if (!controller_) {
      return "";
    }

    Steinberg::MemoryStream stream;
    if (controller_->getState(&stream) != Steinberg::kResultOk) {
      return "";
    }
    return streamToBase64(stream, "controller_state_too_large");
  }

  std::string streamToBase64(Steinberg::MemoryStream& stream, const std::string& sizeError) const {
    const auto size = stream.getSize();
    if (size <= 0) {
      return "";
    }
    if (static_cast<std::size_t>(size) > kMaxWorkerStateBytes) {
      throw std::runtime_error(sizeError);
    }
    const auto* data = reinterpret_cast<const std::uint8_t*>(stream.getData());
    return base64Encode(data, static_cast<std::size_t>(size));
  }

  std::string parameterInfoToJson(const Steinberg::Vst::ParameterInfo& info) const {
    const auto normalizedValue = std::clamp(controller_->getParamNormalized(info.id), 0.0, 1.0);
    const auto defaultValue = std::clamp(info.defaultNormalizedValue, 0.0, 1.0);
    const auto name = cappedString(VST3::StringConvert::convert(info.title));
    const auto shortName = cappedString(VST3::StringConvert::convert(info.shortTitle));
    const auto unit = cappedString(VST3::StringConvert::convert(info.units), 64);
    const auto plainValue = controller_->normalizedParamToPlain(info.id, normalizedValue);
    const auto minPlain = controller_->normalizedParamToPlain(info.id, 0.0);
    const auto maxPlain = controller_->normalizedParamToPlain(info.id, 1.0);
    const bool programChange = (info.flags & Steinberg::Vst::ParameterInfo::kIsProgramChange) != 0;

    std::ostringstream output;
    output << "{\"id\":\"" << info.id << "\""
           << ",\"name\":\"" << jsonEscape(name.empty() ? shortName : name) << "\""
           << ",\"normalizedValue\":" << normalizedValue
           << ",\"defaultNormalizedValue\":" << defaultValue
           << ",\"plainValue\":" << (std::isfinite(plainValue) ? plainValue : normalizedValue)
           << ",\"minPlain\":" << (std::isfinite(minPlain) ? minPlain : 0.0)
           << ",\"maxPlain\":" << (std::isfinite(maxPlain) ? maxPlain : 1.0)
           << ",\"automatable\":" << (parameterIsAutomatable(info) ? "true" : "false");
    if (!unit.empty()) {
      output << ",\"unit\":\"" << jsonEscape(unit) << "\"";
    }
    output << ",\"stepCount\":" << std::max<Steinberg::int32>(0, info.stepCount)
           << ",\"readOnly\":" << ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) ? "true" : "false");
    if (programChange) {
      output << ",\"programChange\":true";
      const auto programList = programListToJson(info);
      if (!programList.empty()) {
        output << ",\"programList\":" << programList;
      }
    }
    output << "}";
    return output.str();
  }

  bool programListForParameter(
      const Steinberg::Vst::ParameterInfo& parameter,
      Steinberg::Vst::ProgramListInfo& programList) const {
    if (!unitInfo_) {
      return false;
    }
    const auto unitCount = std::clamp<Steinberg::int32>(
        unitInfo_->getUnitCount(),
        0,
        kMaxWorkerUnits);
    Steinberg::Vst::ProgramListID programListId = Steinberg::Vst::kNoProgramListId;
    for (Steinberg::int32 unitIndex = 0; unitIndex < unitCount; ++unitIndex) {
      Steinberg::Vst::UnitInfo unit {};
      if (unitInfo_->getUnitInfo(unitIndex, unit) == Steinberg::kResultOk && unit.id == parameter.unitId) {
        programListId = unit.programListId;
        break;
      }
    }
    if (programListId == Steinberg::Vst::kNoProgramListId) {
      return false;
    }

    const auto listCount = std::clamp<Steinberg::int32>(
        unitInfo_->getProgramListCount(),
        0,
        kMaxWorkerProgramLists);
    for (Steinberg::int32 listIndex = 0; listIndex < listCount; ++listIndex) {
      Steinberg::Vst::ProgramListInfo info {};
      if (unitInfo_->getProgramListInfo(listIndex, info) == Steinberg::kResultOk && info.id == programListId) {
        programList = info;
        return true;
      }
    }
    return false;
  }

  std::string programListToJson(const Steinberg::Vst::ParameterInfo& parameter) const {
    Steinberg::Vst::ProgramListInfo programList {};
    if (!programListForParameter(parameter, programList)) {
      return "";
    }
    const auto programCount = std::clamp<Steinberg::int32>(
        programList.programCount,
        0,
        kMaxWorkerProgramsPerParameter);
    if (programCount <= 0) {
      return "";
    }

    const auto listName = cappedString(VST3::StringConvert::convert(programList.name));
    std::ostringstream output;
    output << "{\"id\":" << programList.id
           << ",\"name\":\"" << jsonEscape(listName.empty() ? "Programs" : listName) << "\""
           << ",\"programs\":[";
    for (Steinberg::int32 programIndex = 0; programIndex < programCount; ++programIndex) {
      if (programIndex > 0) {
        output << ",";
      }
      Steinberg::Vst::String128 programName {};
      std::string name;
      if (unitInfo_->getProgramName(programList.id, programIndex, programName) == Steinberg::kResultOk) {
        name = cappedString(VST3::StringConvert::convert(programName));
      }
      if (name.empty()) {
        name = "Program " + std::to_string(programIndex + 1);
      }
      const double normalizedValue = programCount <= 1
          ? 0.0
          : static_cast<double>(programIndex) / static_cast<double>(programCount - 1);
      output << "{\"index\":" << programIndex
             << ",\"name\":\"" << jsonEscape(name) << "\""
             << ",\"normalizedValue\":" << std::clamp(normalizedValue, 0.0, 1.0)
             << "}";
    }
    output << "]}";
    return output.str();
  }

  std::uint32_t defaultBusChannels(Steinberg::Vst::BusDirection direction, Steinberg::int32 index, std::uint32_t fallback) const {
    Steinberg::Vst::BusInfo info {};
    if (component_->getBusInfo(Steinberg::Vst::kAudio, direction, index, info) == Steinberg::kResultOk) {
      return static_cast<std::uint32_t>(std::clamp<Steinberg::int32>(
          info.channelCount,
          0,
          static_cast<Steinberg::int32>(kMaxWorkerChannels)));
    }
    return std::min<std::uint32_t>(fallback, kMaxWorkerChannels);
  }

  void configure() {
    inputBusCount_ = std::clamp<Steinberg::int32>(
        component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kInput),
        0,
        static_cast<Steinberg::int32>(kMaxWorkerChannels));
    outputBusCount_ = std::clamp<Steinberg::int32>(
        component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput),
        0,
        static_cast<Steinberg::int32>(kMaxWorkerChannels));
    if (outputBusCount_ <= 0) {
      throw std::runtime_error("VST3 component has no audio output bus.");
    }

    inputChannels_ = inputBusCount_ > 0 ? requestedInputChannels_ : 0;
    outputChannels_ = requestedOutputChannels_;
    auto inputArrangement = arrangementForChannels(inputChannels_);
    auto outputArrangement = arrangementForChannels(outputChannels_);

    const auto arrangementResult = processor_->setBusArrangements(
        inputBusCount_ > 0 ? &inputArrangement : nullptr,
        inputBusCount_ > 0 ? 1 : 0,
        &outputArrangement,
        1);
    if (arrangementResult != Steinberg::kResultOk) {
      Steinberg::Vst::SpeakerArrangement currentOutput {};
      if (processor_->getBusArrangement(Steinberg::Vst::kOutput, 0, currentOutput) == Steinberg::kResultOk) {
        outputChannels_ = std::clamp<std::uint32_t>(
            channelsForArrangement(currentOutput, requestedOutputChannels_),
            1,
            kMaxWorkerChannels);
        outputArrangement = currentOutput;
      } else if (outputChannels_ != 2) {
        outputChannels_ = 2;
        outputArrangement = Steinberg::Vst::SpeakerArr::kStereo;
        checkResult(
            processor_->setBusArrangements(
                inputBusCount_ > 0 ? &inputArrangement : nullptr,
                inputBusCount_ > 0 ? 1 : 0,
                &outputArrangement,
                1),
            "IAudioProcessor::setBusArrangements");
      } else {
        checkResult(arrangementResult, "IAudioProcessor::setBusArrangements");
      }

      if (inputBusCount_ > 0) {
        Steinberg::Vst::SpeakerArrangement currentInput {};
        if (processor_->getBusArrangement(Steinberg::Vst::kInput, 0, currentInput) == Steinberg::kResultOk) {
          inputChannels_ = std::min<std::uint32_t>(
              channelsForArrangement(currentInput, requestedInputChannels_),
              kMaxWorkerChannels);
        }
      } else {
        inputChannels_ = 0;
      }
    }

    inputBusChannels_.assign(static_cast<std::size_t>(inputBusCount_), 0);
    outputBusChannels_.assign(static_cast<std::size_t>(outputBusCount_), 0);
    if (!inputBusChannels_.empty()) {
      inputBusChannels_[0] = inputChannels_;
      for (std::size_t index = 1; index < inputBusChannels_.size(); ++index) {
        inputBusChannels_[index] = defaultBusChannels(Steinberg::Vst::kInput, static_cast<Steinberg::int32>(index), 0);
      }
    }
    if (!outputBusChannels_.empty()) {
      outputBusChannels_[0] = outputChannels_;
      for (std::size_t index = 1; index < outputBusChannels_.size(); ++index) {
        outputBusChannels_[index] = defaultBusChannels(Steinberg::Vst::kOutput, static_cast<Steinberg::int32>(index), 0);
      }
    }

    for (std::size_t index = 0; index < inputBusChannels_.size(); ++index) {
      if (inputBusChannels_[index] == 0) {
        continue;
      }
      const auto result = component_->activateBus(
          Steinberg::Vst::kAudio,
          Steinberg::Vst::kInput,
          static_cast<Steinberg::int32>(index),
          true);
      if (index == 0) {
        checkResult(result, "IComponent::activateBus input");
      } else if (result != Steinberg::kResultOk) {
        inputBusChannels_[index] = 0;
      }
    }
    for (std::size_t index = 0; index < outputBusChannels_.size(); ++index) {
      if (outputBusChannels_[index] == 0) {
        continue;
      }
      const auto result = component_->activateBus(
          Steinberg::Vst::kAudio,
          Steinberg::Vst::kOutput,
          static_cast<Steinberg::int32>(index),
          true);
      if (index == 0) {
        checkResult(result, "IComponent::activateBus output");
      } else if (result != Steinberg::kResultOk) {
        outputBusChannels_[index] = 0;
      }
    }

    Steinberg::Vst::ProcessSetup setup {};
    setup.processMode = Steinberg::Vst::kRealtime;
    setup.symbolicSampleSize = Steinberg::Vst::kSample32;
    setup.maxSamplesPerBlock = static_cast<Steinberg::int32>(maxBlockSize_);
    setup.sampleRate = sampleRate_;
    checkResult(processor_->setupProcessing(setup), "IAudioProcessor::setupProcessing");
    checkResult(component_->setActive(true), "IComponent::setActive");
    active_ = true;
    checkResult(processor_->setProcessing(true), "IAudioProcessor::setProcessing");
  }

  std::shared_ptr<VST3::Hosting::Module> module_;
  Steinberg::Vst::HostApplication hostApplication_;
  Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
  Steinberg::IPtr<Steinberg::Vst::IEditController> controller_;
  Steinberg::IPtr<Steinberg::Vst::IConnectionPoint> componentConnection_;
  Steinberg::IPtr<Steinberg::Vst::IConnectionPoint> controllerConnection_;
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
  Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping_;
  Steinberg::IPtr<Steinberg::Vst::IUnitInfo> unitInfo_;
  double sampleRate_ = 48000.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t requestedInputChannels_ = 2;
  std::uint32_t requestedOutputChannels_ = 2;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  Steinberg::int32 inputBusCount_ = 0;
  Steinberg::int32 outputBusCount_ = 0;
  std::vector<std::uint32_t> inputBusChannels_;
  std::vector<std::uint32_t> outputBusChannels_;
  std::vector<PendingMidiEvent> pendingMidiEvents_;
  std::vector<PendingParameterChange> pendingParameterChanges_;
  double sampleTime_ = 0.0;
  bool initialized_ = false;
  bool controllerInitialized_ = false;
  bool componentConnected_ = false;
  bool controllerConnected_ = false;
  bool active_ = false;
};

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
          std::string parameterIdText;
          std::string valueText;
          std::string sampleOffsetText;
          Steinberg::Vst::ParamID parameterId = 0;
          double value = 0.0;
          std::uint32_t sampleOffset = 0;
          stream >> parameterIdText;
          stream >> valueText;
          stream >> sampleOffsetText;
          if (!parseParamIdArg(parameterIdText.c_str(), parameterId) ||
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
          const auto rendered = host.render(
              frames,
              renderSampleRate,
              parseChannels(encodedChannels, frames),
              parseAudioBuses(encodedInputBuses, frames),
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
  return "VST3 SDK host worker is available for installed audio-effect bundles.";
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
