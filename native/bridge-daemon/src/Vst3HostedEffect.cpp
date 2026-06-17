#include "SoundBridge/Vst3HostedEffect.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/Vst3HostInfoSupport.h"
#include "SoundBridge/Vst3HostWorkerProcessSupport.h"
#include "SoundBridge/Vst3StateSupport.h"

#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/stringconvert.h"
#include "public.sdk/source/vst/hosting/uid.h"

#include <algorithm>
#include <cmath>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace soundbridge::vst3_worker {

HostedVst3Effect::HostedVst3Effect(
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

HostedVst3Effect::~HostedVst3Effect() {
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

double HostedVst3Effect::sampleTime() const {
  return sampleTime_;
}

RenderedAudio HostedVst3Effect::render(
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

  auto processContext = processContextForTransport(transport, sampleRate_);
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

void HostedVst3Effect::enqueueMidiEvents(std::vector<PendingMidiEvent> events) {
  if (events.empty()) {
    return;
  }
  if (pendingMidiEvents_.size() + events.size() > kMaxWorkerMidiEvents) {
    throw std::runtime_error("too_many_queued_midi_events");
  }
  pendingMidiEvents_.insert(pendingMidiEvents_.end(), events.begin(), events.end());
}

std::vector<std::string> HostedVst3Effect::parameterJsonList() const {
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
    parameters.push_back(
        vst3_worker::parameterInfoToJson(info, controller_, unitInfo_, programListData_));
  }
  return parameters;
}

std::string HostedVst3Effect::parametersToJson() const {
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

std::string HostedVst3Effect::noteExpressionsToJson() const {
  return vst3_worker::noteExpressionsToJson(component_, noteExpressionController_);
}

std::string HostedVst3Effect::programListsToJson() const {
  return vst3_worker::programListsToJson(unitInfo_, programListData_);
}

std::string HostedVst3Effect::programDataToJson(
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::int32 programIndex) const {
  return vst3_worker::programDataToJson(unitInfo_, programListData_, programListId, programIndex);
}

std::string HostedVst3Effect::setProgramData(
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::int32 programIndex,
    const std::string& dataText) {
  return vst3_worker::setProgramData(unitInfo_, programListData_, programListId, programIndex, dataText);
}

std::string HostedVst3Effect::setParameter(Steinberg::Vst::ParamID id, double value, std::uint32_t sampleOffset) {
  if (!controller_) {
    throw std::runtime_error("VST3 plugin does not expose an edit controller.");
  }
  Steinberg::Vst::ParameterInfo info {};
  if (!parameterInfoForId(id, info)) {
    throw std::runtime_error("unknown_parameter");
  }
  if ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) != 0) {
    throw std::runtime_error("parameter_read_only");
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

  return std::string("{\"parameter\":") +
      vst3_worker::parameterInfoToJson(info, controller_, unitInfo_, programListData_) +
      "}";
}

std::string HostedVst3Effect::setParameterDisplayValue(Steinberg::Vst::ParamID id, const std::string& displayValue) {
  if (!controller_) {
    throw std::runtime_error("VST3 plugin does not expose an edit controller.");
  }
  Steinberg::Vst::ParameterInfo info {};
  if (!parameterInfoForId(id, info)) {
    throw std::runtime_error("unknown_parameter");
  }
  if ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) != 0) {
    throw std::runtime_error("parameter_read_only");
  }
  Steinberg::Vst::String128 text {};
  if (!VST3::StringConvert::convert(displayValue, text)) {
    throw std::runtime_error("invalid_parameter_display_value");
  }
  Steinberg::Vst::ParamValue normalizedValue = 0.0;
  if (controller_->getParamValueByString(id, text, normalizedValue) != Steinberg::kResultOk) {
    throw std::runtime_error("parameter_display_value_not_supported");
  }
  return setParameter(id, std::clamp(normalizedValue, 0.0, 1.0), 0);
}

std::string HostedVst3Effect::stateToJson() const {
  return vst3StateToJson(component_, controller_);
}

void HostedVst3Effect::writeStateFile(const worker_file_grants::NativeFileGrantCommand& command) const {
  writeVst3StateFile(command, component_, controller_);
}

std::string HostedVst3Effect::setState(const std::string& componentStateText, const std::string& controllerStateText) {
  return restoreVst3State(component_, controller_, componentStateText, controllerStateText);
}

std::string HostedVst3Effect::latencyToJson() const {
  return vst3LatencyToJson(processor_);
}

std::string HostedVst3Effect::tailTimeToJson() const {
  return vst3TailTimeToJson(processor_);
}

std::string HostedVst3Effect::layoutToJson() const {
  std::ostringstream output;
  output << "{\"requestedInputChannels\":" << requestedInputChannels_
         << ",\"requestedOutputChannels\":" << requestedOutputChannels_
         << ",\"inputChannels\":" << inputChannels_
         << ",\"outputChannels\":" << outputChannels_
         << ",\"inputBuses\":" << std::clamp<Steinberg::int32>(inputBusCount_, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels))
         << ",\"outputBuses\":" << std::clamp<Steinberg::int32>(outputBusCount_, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels))
         << ",\"inputBusLayouts\":" << busLayoutsToJson(component_, Steinberg::Vst::kInput, inputBusCount_, inputBusChannels_)
         << ",\"outputBusLayouts\":" << busLayoutsToJson(component_, Steinberg::Vst::kOutput, outputBusCount_, outputBusChannels_)
         << ",\"sampleRate\":" << sampleRate_
         << ",\"maxBlockSize\":" << maxBlockSize_
         << "}";
  return output.str();
}

bool HostedVst3Effect::parameterInfoForId(Steinberg::Vst::ParamID id, Steinberg::Vst::ParameterInfo& info) const {
  if (!controller_) {
    return false;
  }
  const auto count = std::clamp<Steinberg::int32>(
      controller_->getParameterCount(),
      0,
      static_cast<Steinberg::int32>(kMaxWorkerParameters));
  for (Steinberg::int32 index = 0; index < count; ++index) {
    Steinberg::Vst::ParameterInfo candidate {};
    if (controller_->getParameterInfo(index, candidate) == Steinberg::kResultOk && candidate.id == id) {
      info = candidate;
      return true;
    }
  }
  return false;
}

bool HostedVst3Effect::midiEventToParameterChange(
    const PendingMidiEvent& event,
    PendingParameterChange& parameterChange) {
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
          static_cast<Steinberg::int32>(std::clamp<std::uint32_t>(event.busIndex, 0, kMaxWorkerChannels - 1)),
          static_cast<Steinberg::int16>(event.channel),
          controllerNumber,
          id) != Steinberg::kResultOk) {
    return false;
  }
  if (id == Steinberg::Vst::kNoParamId) {
    return false;
  }
  Steinberg::Vst::ParameterInfo info {};
  if (!parameterInfoForId(id, info) ||
      (info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) != 0) {
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

void HostedVst3Effect::initializeController() {
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

void HostedVst3Effect::connectController() {
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

void HostedVst3Effect::disconnectController() {
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

void HostedVst3Effect::configure() {
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
  auto inputArrangements = desiredBusArrangements(component_, Steinberg::Vst::kInput, inputBusCount_, inputChannels_);
  auto outputArrangements = desiredBusArrangements(component_, Steinberg::Vst::kOutput, outputBusCount_, outputChannels_);

  const auto fullArrangementResult = processor_->setBusArrangements(
      inputArrangements.empty() ? nullptr : inputArrangements.data(),
      static_cast<Steinberg::int32>(inputArrangements.size()),
      outputArrangements.empty() ? nullptr : outputArrangements.data(),
      static_cast<Steinberg::int32>(outputArrangements.size()));
  if (fullArrangementResult == Steinberg::kResultOk) {
    inputBusChannels_ = negotiatedBusChannelList(
        component_,
        processor_,
        Steinberg::Vst::kInput,
        inputBusCount_,
        inputArrangements,
        requestedOutputChannels_,
        false);
    outputBusChannels_ = negotiatedBusChannelList(
        component_,
        processor_,
        Steinberg::Vst::kOutput,
        outputBusCount_,
        outputArrangements,
        requestedOutputChannels_,
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
        inputBusChannels_[index] = defaultBusChannels(component_, Steinberg::Vst::kInput, static_cast<Steinberg::int32>(index), 0);
      }
    }
    if (!outputBusChannels_.empty()) {
      outputBusChannels_[0] = outputChannels_;
      for (std::size_t index = 1; index < outputBusChannels_.size(); ++index) {
        outputBusChannels_[index] = defaultBusChannels(component_, Steinberg::Vst::kOutput, static_cast<Steinberg::int32>(index), 0);
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

} // namespace soundbridge::vst3_worker

#endif
