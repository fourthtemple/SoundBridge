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
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/stringconvert.h"
#include "public.sdk/source/vst/hosting/uid.h"
#endif

#include <algorithm>
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
constexpr std::size_t kMaxWorkerStateBytes = 384 * 1024;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;

struct PendingMidiEvent {
  bool noteOn = true;
  std::uint8_t note = 60;
  float velocity = 0.8F;
  std::uint8_t channel = 0;
  std::uint32_t sampleOffset = 0;
};

struct PendingParameterChange {
  Steinberg::Vst::ParamID id = 0;
  Steinberg::Vst::ParamValue value = 0.0;
  std::uint32_t sampleOffset = 0;
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

bool parseMidiEventToken(const std::string& token, PendingMidiEvent& event) {
  std::vector<std::string> parts;
  std::stringstream stream(token);
  std::string part;
  while (std::getline(stream, part, ':')) {
    parts.push_back(part);
  }
  if (parts.size() != 5) {
    return false;
  }

  if (parts[0] == "on") {
    event.noteOn = true;
  } else if (parts[0] == "off") {
    event.noteOn = false;
  } else {
    return false;
  }

  std::uint32_t note = 60;
  std::uint32_t channel = 0;
  std::uint32_t sampleOffset = 0;
  double velocity = event.noteOn ? 0.8 : 0.0;
  if (!parseUint32Arg(parts[1].c_str(), 0, 127, note) ||
      !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, velocity) ||
      !parseUint32Arg(parts[3].c_str(), 0, 15, channel) ||
      !parseUint32Arg(parts[4].c_str(), 0, kMaxWorkerFrames - 1, sampleOffset)) {
    return false;
  }

  event.note = static_cast<std::uint8_t>(note);
  event.velocity = static_cast<float>(velocity);
  event.channel = static_cast<std::uint8_t>(channel);
  event.sampleOffset = sampleOffset;
  return true;
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

Steinberg::Vst::Event makeVst3Event(const PendingMidiEvent& pending, std::uint32_t frames) {
  Steinberg::Vst::Event event {};
  event.busIndex = 0;
  event.sampleOffset = static_cast<Steinberg::int32>(
      std::clamp<std::uint32_t>(pending.sampleOffset, 0, frames > 0 ? frames - 1 : 0));
  event.ppqPosition = 0.0;
  event.flags = Steinberg::Vst::Event::kIsLive;
  if (pending.noteOn && pending.velocity > 0.0F) {
    event.type = Steinberg::Vst::Event::kNoteOnEvent;
    event.noteOn.channel = static_cast<Steinberg::int16>(pending.channel);
    event.noteOn.pitch = static_cast<Steinberg::int16>(pending.note);
    event.noteOn.tuning = 0.0F;
    event.noteOn.velocity = std::clamp(pending.velocity, 0.0F, 1.0F);
    event.noteOn.length = 0;
    event.noteOn.noteId = -1;
  } else {
    event.type = Steinberg::Vst::Event::kNoteOffEvent;
    event.noteOff.channel = static_cast<Steinberg::int16>(pending.channel);
    event.noteOff.pitch = static_cast<Steinberg::int16>(pending.note);
    event.noteOff.velocity = std::clamp(pending.velocity, 0.0F, 1.0F);
    event.noteOff.noteId = -1;
    event.noteOff.tuning = 0.0F;
  }
  return event;
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

  std::vector<std::vector<float>> render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("VST3 worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    inputChannels.resize(inputChannels_);
    for (auto& channel : inputChannels) {
      channel.resize(frames, 0.0F);
    }

    std::vector<std::vector<float>> outputChannels(outputChannels_);
    for (auto& channel : outputChannels) {
      channel.resize(frames, 0.0F);
    }

    std::vector<Steinberg::Vst::Sample32*> inputPointers(inputChannels_);
    std::vector<Steinberg::Vst::Sample32*> outputPointers(outputChannels_);
    for (std::uint32_t index = 0; index < inputChannels_; ++index) {
      inputPointers[index] = inputChannels[index].data();
    }
    for (std::uint32_t index = 0; index < outputChannels_; ++index) {
      outputPointers[index] = outputChannels[index].data();
    }

    Steinberg::Vst::AudioBusBuffers inputBus;
    inputBus.numChannels = static_cast<Steinberg::int32>(inputChannels_);
    inputBus.silenceFlags = 0;
    inputBus.channelBuffers32 = inputPointers.empty() ? nullptr : inputPointers.data();

    Steinberg::Vst::AudioBusBuffers outputBus;
    outputBus.numChannels = static_cast<Steinberg::int32>(outputChannels_);
    outputBus.silenceFlags = 0;
    outputBus.channelBuffers32 = outputPointers.empty() ? nullptr : outputPointers.data();

    Steinberg::Vst::ProcessData processData {};
    processData.processMode = Steinberg::Vst::kRealtime;
    processData.symbolicSampleSize = Steinberg::Vst::kSample32;
    processData.numSamples = static_cast<Steinberg::int32>(frames);
    processData.numInputs = inputChannels_ > 0 ? 1 : 0;
    processData.numOutputs = outputChannels_ > 0 ? 1 : 0;
    processData.inputs = inputChannels_ > 0 ? &inputBus : nullptr;
    processData.outputs = outputChannels_ > 0 ? &outputBus : nullptr;

    auto parameterEvents = std::move(pendingParameterChanges_);
    pendingParameterChanges_.clear();
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

    auto midiEvents = std::move(pendingMidiEvents_);
    pendingMidiEvents_.clear();
    std::stable_sort(midiEvents.begin(), midiEvents.end(), [](const auto& left, const auto& right) {
      return left.sampleOffset < right.sampleOffset;
    });
    Steinberg::Vst::EventList inputEvents(static_cast<Steinberg::int32>(midiEvents.size()));
    for (const auto& midiEvent : midiEvents) {
      auto vstEvent = makeVst3Event(midiEvent, frames);
      inputEvents.addEvent(vstEvent);
    }
    processData.inputEvents = inputEvents.getEventCount() > 0 ? &inputEvents : nullptr;
    processData.outputEvents = nullptr;

    checkResult(processor_->process(processData), "IAudioProcessor::process");
    sampleTime_ += frames;
    return outputChannels;
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

private:
  void initializeController() {
    controller_ = Steinberg::FUnknownPtr<Steinberg::Vst::IEditController>(component_);
    if (controller_) {
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
           << ",\"readOnly\":" << ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) ? "true" : "false")
           << "}";
    return output.str();
  }

  void configure() {
    inputBusCount_ = std::max<Steinberg::int32>(0, component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kInput));
    outputBusCount_ = std::max<Steinberg::int32>(0, component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput));
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
        outputChannels_ = std::max<std::uint32_t>(1, channelsForArrangement(currentOutput, requestedOutputChannels_));
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
    }

    if (inputBusCount_ > 0) {
      checkResult(component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, true), "IComponent::activateBus input");
    }
    checkResult(component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, true), "IComponent::activateBus output");

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
  double sampleRate_ = 48000.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t requestedInputChannels_ = 2;
  std::uint32_t requestedOutputChannels_ = 2;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  Steinberg::int32 inputBusCount_ = 0;
  Steinberg::int32 outputBusCount_ = 0;
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
          event.noteOn = command == "noteOn" && velocity > 0.0;
          event.note = static_cast<std::uint8_t>(std::clamp(note, 0, 127));
          event.velocity = static_cast<float>(std::clamp(velocity, 0.0, 1.0));
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
          std::string framesText;
          std::string sampleRateText;
          stream >> framesText;
          stream >> sampleRateText;
          stream >> encodedChannels;
          if (!parseUint32Arg(framesText.c_str(), 1, kMaxWorkerFrames, frames) ||
              !parseSampleRateArg(sampleRateText.c_str(), renderSampleRate)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          const auto channels = host.render(frames, renderSampleRate, parseChannels(encodedChannels, frames));
          std::cout << exampleInstrumentBlockToJson(channels) << std::endl;
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
