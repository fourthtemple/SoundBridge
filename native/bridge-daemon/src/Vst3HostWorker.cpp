#include "SoundBridge/Vst3HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/ExampleInstrumentRenderer.h"
#include "SoundBridge/NativePlugin.h"
#include "SoundBridge/Vst3HostWorkerSupport.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK
#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstnoteexpression.h"
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
#include <limits>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge {

namespace {

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

using namespace vst3_worker;

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
    programListData_ = Steinberg::FUnknownPtr<Steinberg::Vst::IProgramListData>(component_);
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
      parameters.push_back(vst3_worker::parameterInfoToJson(info, controller_, unitInfo_));
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

  std::string noteExpressionsToJson() const {
    return vst3_worker::noteExpressionsToJson(noteExpressionController_);
  }

  std::string programListsToJson() const {
    return vst3_worker::programListsToJson(unitInfo_, programListData_);
  }

  std::string programDataToJson(Steinberg::Vst::ProgramListID programListId, Steinberg::int32 programIndex) const {
    return vst3_worker::programDataToJson(unitInfo_, programListData_, programListId, programIndex);
  }

  std::string setProgramData(
      Steinberg::Vst::ProgramListID programListId,
      Steinberg::int32 programIndex,
      const std::string& dataText) {
    return vst3_worker::setProgramData(unitInfo_, programListData_, programListId, programIndex, dataText);
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
        return std::string("{\"parameter\":") + vst3_worker::parameterInfoToJson(info, controller_, unitInfo_) + "}";
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
      noteExpressionController_ = Steinberg::FUnknownPtr<Steinberg::Vst::INoteExpressionController>(controller_);
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
      noteExpressionController_ = Steinberg::FUnknownPtr<Steinberg::Vst::INoteExpressionController>(controller_);
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
    return streamToBase64(stream, kMaxWorkerStateBytes, "component_state_too_large");
  }

  std::string controllerStateBase64() const {
    if (!controller_) {
      return "";
    }

    Steinberg::MemoryStream stream;
    if (controller_->getState(&stream) != Steinberg::kResultOk) {
      return "";
    }
    return streamToBase64(stream, kMaxWorkerStateBytes, "controller_state_too_large");
  }

  std::string streamToBase64(
      Steinberg::MemoryStream& stream,
      std::size_t maxBytes,
      const std::string& sizeError) const {
    const auto size = stream.getSize();
    if (size <= 0) {
      return "";
    }
    if (static_cast<std::size_t>(size) > maxBytes) {
      throw std::runtime_error(sizeError);
    }
    const auto* data = reinterpret_cast<const std::uint8_t*>(stream.getData());
    return base64Encode(data, static_cast<std::size_t>(size));
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

  std::vector<Steinberg::Vst::SpeakerArrangement> desiredBusArrangements(
      Steinberg::Vst::BusDirection direction,
      Steinberg::int32 busCount,
      std::uint32_t mainChannels) const {
    const auto count = std::clamp<Steinberg::int32>(busCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels));
    std::vector<Steinberg::Vst::SpeakerArrangement> arrangements;
    arrangements.reserve(static_cast<std::size_t>(count));
    for (Steinberg::int32 index = 0; index < count; ++index) {
      const auto channels = index == 0
          ? mainChannels
          : defaultBusChannels(direction, index, 0);
      arrangements.push_back(arrangementForChannels(channels));
    }
    return arrangements;
  }

  std::uint32_t negotiatedBusChannels(
      Steinberg::Vst::BusDirection direction,
      Steinberg::int32 index,
      Steinberg::Vst::SpeakerArrangement fallbackArrangement,
      std::uint32_t fallbackChannels,
      bool requireOutput) const {
    Steinberg::Vst::SpeakerArrangement currentArrangement {};
    const auto arrangement = processor_->getBusArrangement(direction, index, currentArrangement) == Steinberg::kResultOk
        ? currentArrangement
        : fallbackArrangement;
    auto channels = std::min<std::uint32_t>(
        channelsForArrangement(arrangement, fallbackChannels),
        kMaxWorkerChannels);
    if (requireOutput && channels == 0) {
      channels = std::clamp<std::uint32_t>(fallbackChannels, 1, kMaxWorkerChannels);
    }
    return channels;
  }

  std::vector<std::uint32_t> negotiatedBusChannelList(
      Steinberg::Vst::BusDirection direction,
      Steinberg::int32 busCount,
      const std::vector<Steinberg::Vst::SpeakerArrangement>& arrangements,
      bool requireMainOutput) const {
    const auto count = std::clamp<Steinberg::int32>(busCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels));
    std::vector<std::uint32_t> channels;
    channels.reserve(static_cast<std::size_t>(count));
    for (Steinberg::int32 index = 0; index < count; ++index) {
      const auto fallbackArrangement = static_cast<std::size_t>(index) < arrangements.size()
          ? arrangements[static_cast<std::size_t>(index)]
          : Steinberg::Vst::SpeakerArr::kEmpty;
      const auto fallbackChannels = channelsForArrangement(
          fallbackArrangement,
          defaultBusChannels(direction, index, index == 0 && requireMainOutput ? requestedOutputChannels_ : 0));
      channels.push_back(negotiatedBusChannels(
          direction,
          index,
          fallbackArrangement,
          fallbackChannels,
          requireMainOutput && index == 0));
    }
    return channels;
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
    auto inputArrangements = desiredBusArrangements(Steinberg::Vst::kInput, inputBusCount_, inputChannels_);
    auto outputArrangements = desiredBusArrangements(Steinberg::Vst::kOutput, outputBusCount_, outputChannels_);

    const auto fullArrangementResult = processor_->setBusArrangements(
        inputArrangements.empty() ? nullptr : inputArrangements.data(),
        static_cast<Steinberg::int32>(inputArrangements.size()),
        outputArrangements.empty() ? nullptr : outputArrangements.data(),
        static_cast<Steinberg::int32>(outputArrangements.size()));
    if (fullArrangementResult == Steinberg::kResultOk) {
      inputBusChannels_ = negotiatedBusChannelList(
          Steinberg::Vst::kInput,
          inputBusCount_,
          inputArrangements,
          false);
      outputBusChannels_ = negotiatedBusChannelList(
          Steinberg::Vst::kOutput,
          outputBusCount_,
          outputArrangements,
          true);
      inputChannels_ = inputBusChannels_.empty() ? 0 : inputBusChannels_[0];
      outputChannels_ = outputBusChannels_.empty() ? requestedOutputChannels_ : outputBusChannels_[0];
    } else {
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
    }

    if (outputBusChannels_.empty() || outputBusChannels_[0] == 0) {
      if (outputBusChannels_.empty()) {
        outputBusChannels_.assign(static_cast<std::size_t>(outputBusCount_), 0);
      }
      outputChannels_ = std::clamp<std::uint32_t>(
          outputChannels_ == 0 ? requestedOutputChannels_ : outputChannels_,
          1,
          kMaxWorkerChannels);
      outputBusChannels_[0] = outputChannels_;
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
  Steinberg::IPtr<Steinberg::Vst::INoteExpressionController> noteExpressionController_;
  Steinberg::IPtr<Steinberg::Vst::IUnitInfo> unitInfo_;
  Steinberg::IPtr<Steinberg::Vst::IProgramListData> programListData_;
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
