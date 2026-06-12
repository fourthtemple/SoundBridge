#include "SoundBridge/Lv2HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/Lv2Abi.h"
#include "SoundBridge/Lv2AtomSupport.h"
#include "SoundBridge/Lv2BusSupport.h"
#include "SoundBridge/Lv2HostWorkerSupport.h"
#include "SoundBridge/Lv2StateSupport.h"
#include "SoundBridge/NativePlugin.h"
#include "SoundBridge/NativeFileGrantSupport.h"

#ifndef _WIN32
#include <dlfcn.h>
#endif

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge {

namespace {

#ifndef _WIN32

using namespace lv2_abi;
using namespace lv2_worker;
using namespace worker_file_grants;

struct DlCloser {
  void operator()(void* handle) const {
    if (handle != nullptr) {
      dlclose(handle);
    }
  }
};

class HostedLv2Plugin {
public:
  HostedLv2Plugin(
      std::string bundlePath,
      double sampleRate,
      std::uint32_t maxBlockSize,
      std::uint32_t inputChannels,
      std::uint32_t outputChannels)
      : bundlePath_(std::move(bundlePath)),
        sampleRate_(sampleRate),
        maxBlockSize_(std::clamp<std::uint32_t>(maxBlockSize, 1, kMaxWorkerFrames)),
        requestedInputChannels_(std::min<std::uint32_t>(inputChannels, kMaxWorkerAudioPorts)),
        requestedOutputChannels_(std::clamp<std::uint32_t>(outputChannels, 1, kMaxWorkerAudioPorts)) {
    metadata_ = loadBundleMetadata(bundlePath_);
    ports_ = metadata_.ports;
    classifyPorts();
    if (outputPortIndexes_.empty()) {
      throw std::runtime_error("LV2 plugin has no basic audio output ports.");
    }
    if (inputPortIndexes_.size() > kMaxWorkerAudioPorts || outputPortIndexes_.size() > kMaxWorkerAudioPorts) {
      throw std::runtime_error("LV2 plugin exceeds SoundBridge audio port limits.");
    }

    buildAudioBusGroups();
    inputChannels_ = static_cast<std::uint32_t>(std::min<std::size_t>(inputPortIndexes_.size(), kMaxWorkerAudioPorts));
    outputChannels_ = static_cast<std::uint32_t>(std::min<std::size_t>(outputPortIndexes_.size(), kMaxWorkerAudioPorts));
    loadDescriptor();
    workerSchedule_ = LV2_Worker_Schedule{this, &HostedLv2Plugin::scheduleLv2Work};
    instantiate();
  }

  HostedLv2Plugin(const HostedLv2Plugin&) = delete;
  HostedLv2Plugin& operator=(const HostedLv2Plugin&) = delete;

  ~HostedLv2Plugin() {
    if (handle_ != nullptr && descriptor_ != nullptr) {
      if (activated_ && descriptor_->deactivate != nullptr) {
        descriptor_->deactivate(handle_);
      }
      if (descriptor_->cleanup != nullptr) {
        descriptor_->cleanup(handle_);
      }
    }
  }

  std::vector<std::vector<float>> render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels,
      std::vector<IndexedAudioBus> inputBuses,
      HostTransportContext transport) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("LV2 worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    if (inputBuses.empty() && !inputChannels.empty()) {
      inputBuses.push_back(IndexedAudioBus{0, std::move(inputChannels)});
    }
    inputBuffers_.resize(inputPortIndexes_.size());
    outputBuffers_.resize(outputPortIndexes_.size());

    for (std::size_t index = 0; index < inputBuffers_.size(); ++index) {
      inputBuffers_[index].assign(frames, 0.0F);
      copyInputBusChannels(index, inputBuses, frames);
    }
    for (auto& output : outputBuffers_) {
      output.assign(frames, 0.0F);
    }
    renderSegments(frames, transport);
    pendingMidiMessages_.clear();
    for (auto& channel : outputBuffers_) {
      for (auto& sample : channel) {
        sample = sanitizeSample(sample);
      }
    }
    sampleTime_ = std::min(
        static_cast<double>(kMaxWorkerTransportSamplePosition),
        static_cast<double>(transport.samplePosition) + frames);
    return outputBuffers_;
  }

  double sampleTime() const {
    return sampleTime_;
  }

  void enqueueMidiEvents(std::vector<PendingMidiMessage> messages) {
    if (messages.empty()) {
      return;
    }
    const auto capacity = kMaxWorkerMidiEvents - std::min<std::size_t>(pendingMidiMessages_.size(), kMaxWorkerMidiEvents);
    if (messages.size() > capacity) {
      throw std::runtime_error("too_many_queued_midi_events");
    }
    pendingMidiMessages_.insert(pendingMidiMessages_.end(), messages.begin(), messages.end());
  }

  std::string parametersToJson() const {
    std::ostringstream output;
    output << "{\"parameters\":[";
    bool first = true;
    std::size_t emitted = 0;
    for (const auto portIndex : inputControlPortIndexes_) {
      if (emitted >= kMaxWorkerParameters) {
        break;
      }
      if (!first) {
        output << ",";
      }
      output << parameterInfoToJson(ports_[portIndex], ports_[portIndex].value);
      first = false;
      ++emitted;
    }
    output << "]}";
    return output.str();
  }

  std::string setParameter(const std::string& parameterId, double value, std::uint32_t sampleOffset) {
    for (const auto portIndex : inputControlPortIndexes_) {
      auto& port = ports_[portIndex];
      if (parameterIdForPort(port) != parameterId && std::to_string(port.index) != parameterId) {
        continue;
      }
      const auto normalized = std::clamp(value, 0.0, 1.0);
      const auto plainValue = plainValueForPort(port, normalized);
      if (sampleOffset == 0) {
        port.value = plainValue;
      } else {
        if (pendingParameterChanges_.size() >= kMaxWorkerParameterChanges) {
          throw std::runtime_error("too_many_queued_parameter_changes");
        }
        pendingParameterChanges_.push_back(PendingParameterChange{
            parameterIdForPort(port),
            normalized,
            std::clamp<std::uint32_t>(sampleOffset, 0, maxBlockSize_ - 1)});
      }
      return std::string("{\"parameter\":") + parameterInfoToJson(port, plainValue) + "}";
    }
    throw std::runtime_error("unknown_parameter");
  }

  std::string latencyToJson() {
    if (latencyPortIndex_) {
      refreshInstantOutputPorts();
    }
    const auto latencySamples = latencyPortIndex_
        ? boundedLatencySamples(ports_[*latencyPortIndex_].value)
        : 0U;
    return std::string("{\"latencySamples\":") + std::to_string(latencySamples) + "}";
  }

  std::string tailTimeToJson() const {
    return "{\"tailSamples\":0,\"infiniteTail\":false}";
  }

  std::string stateToJson() {
    const auto state = stateBase64();
    return std::string("{\"state\":\"") + state + "\"}";
  }

  void writeStateFile(const NativeFileGrantCommand& command) {
    writeSingleStateFile(command, stateBase64(), kMaxWorkerStateBytes);
  }

  std::string setState(const std::string& stateText) {
    if (stateText == "-") {
      return "{\"ok\":true}";
    }
    restoreState(stateText);
    return "{\"ok\":true}";
  }

  std::string layoutToJson() const {
    std::ostringstream output;
    output << "{\"requestedInputChannels\":" << requestedInputChannels_
           << ",\"requestedOutputChannels\":" << requestedOutputChannels_
           << ",\"inputChannels\":" << inputChannels_
           << ",\"outputChannels\":" << outputChannels_
           << ",\"inputBuses\":" << inputBusCount()
           << ",\"outputBuses\":" << outputBusCount()
           << ",\"inputBusLayouts\":" << inputBusLayoutsToJson()
           << ",\"outputBusLayouts\":" << outputBusLayoutsToJson()
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

  std::string outputAudioToJson(const std::vector<std::vector<float>>& channels) const {
    return lv2RenderedAudioToJson(channels, outputBusGroups_, outputPortIndexes_);
  }

private:
  std::uint32_t inputBusCount() const {
    return static_cast<std::uint32_t>(std::min<std::size_t>(inputBusGroups_.size(), kMaxWorkerAudioPorts));
  }

  std::uint32_t outputBusCount() const {
    return static_cast<std::uint32_t>(std::min<std::size_t>(outputBusGroups_.size(), kMaxWorkerAudioPorts));
  }

  std::string inputBusLayoutsToJson() const {
    return lv2BusLayoutsToJson(inputBusGroups_, "input");
  }

  std::string outputBusLayoutsToJson() const {
    return lv2BusLayoutsToJson(outputBusGroups_, "output");
  }

  void copyInputBusChannels(
      std::size_t inputBufferIndex,
      const std::vector<IndexedAudioBus>& inputBuses,
      std::uint32_t frames) {
    if (inputBufferIndex >= inputPortIndexes_.size()) {
      return;
    }
    const auto portIndex = inputPortIndexes_[inputBufferIndex];
    for (const auto& busGroup : inputBusGroups_) {
      const auto* busChannels = findBusChannels(inputBuses, busGroup.index);
      if (busChannels == nullptr) {
        continue;
      }
      const auto position = std::find(busGroup.portIndexes.begin(), busGroup.portIndexes.end(), portIndex);
      if (position == busGroup.portIndexes.end()) {
        continue;
      }
      std::fill(inputBuffers_[inputBufferIndex].begin(), inputBuffers_[inputBufferIndex].end(), 0.0F);
      const auto channelIndex = static_cast<std::size_t>(std::distance(busGroup.portIndexes.begin(), position));
      if (channelIndex >= busChannels->size()) {
        continue;
      }
      const auto copyFrames = std::min<std::size_t>(frames, (*busChannels)[channelIndex].size());
      for (std::size_t frame = 0; frame < copyFrames; ++frame) {
        inputBuffers_[inputBufferIndex][frame] = sanitizeSample((*busChannels)[channelIndex][frame]);
      }
    }
  }

  std::string stateBase64() {
    std::ostringstream state;
    state << kLv2StateMagic << "\n";
    state << std::setprecision(9);
    for (const auto portIndex : inputControlPortIndexes_) {
      const auto& port = ports_[portIndex];
      state << "p " << port.index << " " << sanitizeStateValue(port.value) << "\n";
    }
    const auto extensionState = extensionStateProperties();
    for (const auto& property : extensionState.properties) {
      state << "s "
            << stateStringToBase64(property.keyUri) << " "
            << stateStringToBase64(property.typeUri) << " "
            << property.flags << " "
            << base64Encode(property.value.data(), property.value.size()) << "\n";
    }
    for (const auto& file : extensionState.files) {
      state << "f "
            << stateStringToBase64(file.abstractPath) << " "
            << base64Encode(file.value.data(), file.value.size()) << "\n";
    }
    const auto text = state.str();
    if (text.size() > kMaxWorkerStateBytes) {
      throw std::runtime_error("state_too_large");
    }
    return base64Encode(reinterpret_cast<const std::uint8_t*>(text.data()), text.size());
  }

  void restoreState(const std::string& encodedState) {
    const auto decoded = base64Decode(encodedState, kMaxWorkerStateBytes);
    const std::string text(decoded.begin(), decoded.end());
    std::stringstream lines(text);
    std::string line;
    if (!std::getline(lines, line)) {
      throw std::runtime_error("invalid_lv2_state");
    }
    if (line == kLv2ControlStateMagic) {
      restoreControlStateLines(lines);
      return;
    }
    if (line != kLv2StateMagic) {
      throw std::runtime_error("invalid_lv2_state");
    }

    std::size_t restored = 0;
    std::size_t totalExtensionBytes = 0;
    std::size_t totalFileBytes = 0;
    std::vector<Lv2RestoredStateProperty> extensionProperties;
    std::vector<Lv2StateFile> extensionFiles;
    while (std::getline(lines, line)) {
      if (line.empty()) {
        continue;
      }
      if (++restored > kMaxWorkerParameters + kMaxWorkerStateProperties) {
        throw std::runtime_error("state_too_large");
      }

      std::stringstream entry(line);
      std::string prefix;
      entry >> prefix;
      if (prefix == "p") {
        restoreControlStateEntry(entry);
        continue;
      }
      if (prefix == "s") {
        std::string keyText;
        std::string typeText;
        std::string flagsText;
        std::string valueText;
        entry >> keyText;
        entry >> typeText;
        entry >> flagsText;
        entry >> valueText;
        std::string extra;
        entry >> extra;
        std::uint32_t flags = 0;
        if (!extra.empty() || !parseUint32Arg(flagsText.c_str(), 0, 0xFFFFFFFFU, flags)) {
          throw std::runtime_error("invalid_lv2_state");
        }

        const auto keyUri = base64ToStateString(keyText, kMaxWorkerUriBytes);
        const auto typeUri = base64ToStateString(typeText, kMaxWorkerUriBytes);
        auto value = base64Decode(valueText, kMaxWorkerStatePropertyBytes);
        if (!isValidStateUri(keyUri) || !isValidStateUri(typeUri) || value.empty() || !isPortablePodState(flags)) {
          throw std::runtime_error("invalid_lv2_state");
        }
        totalExtensionBytes += value.size();
        if (totalExtensionBytes > kMaxWorkerStateBytes / 2) {
          throw std::runtime_error("state_too_large");
        }
        const auto key = uridMapper_.map(keyUri.c_str());
        const auto type = uridMapper_.map(typeUri.c_str());
        if (key == 0 || type == 0) {
          throw std::runtime_error("invalid_lv2_state");
        }
        if (extensionProperties.size() >= kMaxWorkerStateProperties) {
          throw std::runtime_error("state_too_large");
        }
        extensionProperties.push_back(Lv2RestoredStateProperty{key, type, flags, std::move(value)});
        continue;
      }
      if (prefix == "f") {
        std::string pathText;
        std::string valueText;
        entry >> pathText;
        entry >> valueText;
        std::string extra;
        entry >> extra;
        if (!extra.empty() || extensionFiles.size() >= kMaxWorkerStateFiles) {
          throw std::runtime_error("invalid_lv2_state");
        }
        auto abstractPath = base64ToStateString(pathText, kMaxWorkerStatePathBytes);
        auto value = base64Decode(valueText, kMaxWorkerStateFileBytes);
        if (abstractPath.empty() || value.empty()) {
          throw std::runtime_error("invalid_lv2_state");
        }
        totalFileBytes += value.size();
        if (totalFileBytes > kMaxWorkerStateFileTotalBytes) {
          throw std::runtime_error("state_too_large");
        }
        extensionFiles.push_back(Lv2StateFile{std::move(abstractPath), std::move(value)});
        continue;
      }
      throw std::runtime_error("invalid_lv2_state");
    }
    restoreExtensionState(extensionProperties, extensionFiles);
  }

  void restoreControlStateLines(std::stringstream& lines) {
    std::size_t restored = 0;
    std::string line;
    while (std::getline(lines, line)) {
      if (line.empty()) {
        continue;
      }
      if (++restored > kMaxWorkerParameters) {
        throw std::runtime_error("state_too_large");
      }
      std::stringstream entry(line);
      std::string prefix;
      entry >> prefix;
      if (prefix != "p") {
        throw std::runtime_error("invalid_lv2_state");
      }
      restoreControlStateEntry(entry);
    }
  }

  void restoreControlStateEntry(std::stringstream& entry) {
    std::string portIndexText;
    std::string valueText;
    entry >> portIndexText;
    entry >> valueText;
    std::string extra;
    entry >> extra;
    std::uint32_t portIndex = 0;
    double value = 0.0;
    if (!extra.empty() ||
        !parseUint32Arg(portIndexText.c_str(), 0, kMaxWorkerPortIndex, portIndex) ||
        !parseStateValue(valueText, value)) {
      throw std::runtime_error("invalid_lv2_state");
    }

    for (const auto controlPortIndex : inputControlPortIndexes_) {
      auto& port = ports_[controlPortIndex];
      if (port.index == portIndex) {
        port.value = static_cast<float>(std::clamp(
            value,
            static_cast<double>(port.minimum),
            static_cast<double>(port.maximum)));
        break;
      }
    }
  }

  Lv2SavedExtensionState extensionStateProperties() {
    return saveLv2ExtensionState(handle_, stateInterface_, uridMapper_);
  }

  void restoreExtensionState(
      const std::vector<Lv2RestoredStateProperty>& properties,
      const std::vector<Lv2StateFile>& files) {
    if (properties.empty() && files.empty()) {
      return;
    }
    if (stateInterface_ == nullptr || stateInterface_->restore == nullptr || handle_ == nullptr) {
      throw std::runtime_error("lv2_state_extension_unavailable");
    }

    const bool reactivate = activated_ && descriptor_->deactivate != nullptr && descriptor_->activate != nullptr;
    if (reactivate) {
      descriptor_->deactivate(handle_);
      activated_ = false;
    }
    try {
      restoreLv2ExtensionState(handle_, stateInterface_, uridMapper_, properties, files);
    } catch (...) {
      if (reactivate) {
        descriptor_->activate(handle_);
        activated_ = true;
      }
      throw;
    }
    if (reactivate) {
      descriptor_->activate(handle_);
      activated_ = true;
    }
  }

  void classifyPorts() {
    for (std::size_t index = 0; index < ports_.size(); ++index) {
      auto& port = ports_[index];
      if (port.type == Lv2PortType::Audio && port.direction == Lv2PortDirection::Input) {
        inputPortIndexes_.push_back(index);
      } else if (port.type == Lv2PortType::Audio && port.direction == Lv2PortDirection::Output) {
        outputPortIndexes_.push_back(index);
      } else if (port.type == Lv2PortType::Control && port.direction == Lv2PortDirection::Input) {
        inputControlPortIndexes_.push_back(index);
      } else if (port.type == Lv2PortType::Control && port.direction == Lv2PortDirection::Output) {
        outputControlPortIndexes_.push_back(index);
        if (port.reportsLatency && !latencyPortIndex_) {
          latencyPortIndex_ = index;
        }
      } else if (port.type == Lv2PortType::Midi && port.direction == Lv2PortDirection::Input) {
        inputMidiPortIndexes_.push_back(index);
      }
    }
  }

  void buildAudioBusGroups() {
    inputBusGroups_ = groupedLv2AudioBuses(
        ports_,
        inputPortIndexes_,
        metadata_.mainInputGroupUri,
        "Main Input",
        "Input Port");
    outputBusGroups_ = groupedLv2AudioBuses(
        ports_,
        outputPortIndexes_,
        metadata_.mainOutputGroupUri,
        "Main Output",
        "Output Port");
    if (!outputPortIndexes_.empty() && outputBusGroups_.empty()) {
      outputBusGroups_.push_back(Lv2AudioBusGroup{0, "Main Output", outputPortIndexes_});
    }
  }

  void loadDescriptor() {
    module_.reset(dlopen(metadata_.binaryPath.string().c_str(), RTLD_NOW | RTLD_LOCAL));
    if (!module_) {
      const char* error = dlerror();
      throw std::runtime_error(error == nullptr ? "LV2 binary could not be loaded." : error);
    }

    auto* symbol = dlsym(module_.get(), "lv2_descriptor");
    if (symbol == nullptr) {
      throw std::runtime_error("LV2 binary did not export lv2_descriptor.");
    }
    descriptorFunction_ = reinterpret_cast<Lv2DescriptorFunction>(symbol);

    for (std::uint32_t index = 0; index < 4096; ++index) {
      const auto* descriptor = descriptorFunction_(index);
      if (descriptor == nullptr) {
        break;
      }
      if (descriptor->URI == nullptr || descriptor->instantiate == nullptr ||
          descriptor->connect_port == nullptr || descriptor->run == nullptr ||
          descriptor->cleanup == nullptr) {
        continue;
      }
      if (metadata_.pluginUri.empty() || metadata_.pluginUri == descriptor->URI) {
        descriptor_ = descriptor;
        if (descriptor_->extension_data != nullptr) {
          auto* stateInterface = static_cast<const LV2_State_Interface*>(descriptor_->extension_data(kLv2StateInterfaceUri));
          if (stateInterface != nullptr && (stateInterface->save != nullptr || stateInterface->restore != nullptr)) {
            stateInterface_ = stateInterface;
          }
          auto* workerInterface = static_cast<const LV2_Worker_Interface*>(descriptor_->extension_data(kLv2WorkerInterfaceUri));
          if (workerInterface != nullptr && workerInterface->work != nullptr) {
            workerInterface_ = workerInterface;
          }
        }
        return;
      }
    }

    throw std::runtime_error("LV2 descriptor did not match the bundle plugin URI.");
  }

  void instantiate() {
    LV2_URID_Map uridMap {&uridMapper_, &mapLv2Urid};
    LV2_URID_Unmap uridUnmap {&uridMapper_, &unmapLv2Urid};
    LV2_Feature uridMapFeature {kLv2UridMapUri, &uridMap};
    LV2_Feature uridUnmapFeature {kLv2UridUnmapUri, &uridUnmap};
    maxBlockLengthOption_ = static_cast<std::int32_t>(maxBlockSize_);
    nominalBlockLengthOption_ = static_cast<std::int32_t>(maxBlockSize_);
    options_ = {
        LV2_Options_Option{LV2_OPTIONS_INSTANCE, 0, kUridBufSizeMinBlockLength, sizeof(minBlockLengthOption_), kUridAtomInt, &minBlockLengthOption_},
        LV2_Options_Option{LV2_OPTIONS_INSTANCE, 0, kUridBufSizeMaxBlockLength, sizeof(maxBlockLengthOption_), kUridAtomInt, &maxBlockLengthOption_},
        LV2_Options_Option{LV2_OPTIONS_INSTANCE, 0, kUridBufSizeNominalBlockLength, sizeof(nominalBlockLengthOption_), kUridAtomInt, &nominalBlockLengthOption_},
        LV2_Options_Option{LV2_OPTIONS_INSTANCE, 0, kUridBufSizeSequenceSize, sizeof(sequenceSizeOption_), kUridAtomInt, &sequenceSizeOption_},
        LV2_Options_Option{}};
    LV2_Feature optionsFeature {kLv2OptionsOptionsUri, options_.data()};
    LV2_Feature workerScheduleFeature {kLv2WorkerScheduleUri, &workerSchedule_};
    std::vector<const LV2_Feature*> features {&uridMapFeature, &uridUnmapFeature, &optionsFeature};
    if (workerInterface_ != nullptr) {
      features.push_back(&workerScheduleFeature);
    }
    features.push_back(nullptr);
    auto bundlePath = bundlePath_;
    if (!bundlePath.empty() && bundlePath.back() != '/') {
      bundlePath.push_back('/');
    }
    handle_ = descriptor_->instantiate(descriptor_, sampleRate_, bundlePath.c_str(), features.data());
    if (handle_ == nullptr) {
      throw std::runtime_error("LV2 descriptor refused instantiation.");
    }
    inputBuffers_.assign(inputPortIndexes_.size(), std::vector<float>(1, 0.0F));
    outputBuffers_.assign(outputPortIndexes_.size(), std::vector<float>(1, 0.0F));
    midiBuffers_.assign(inputMidiPortIndexes_.size(), emptyLv2MidiSequenceBuffer(maxBlockSize_));
    connectPorts(0);
    if (descriptor_->activate != nullptr) {
      descriptor_->activate(handle_);
      activated_ = true;
    }
  }

  void renderSegments(std::uint32_t frames, const HostTransportContext& transport) {
    if (pendingParameterChanges_.empty()) {
      runSegment(0, frames, frames, transport);
      return;
    }

    auto parameterEvents = std::move(pendingParameterChanges_);
    pendingParameterChanges_.clear();
    std::stable_sort(parameterEvents.begin(), parameterEvents.end(), [](const auto& left, const auto& right) {
      return left.sampleOffset < right.sampleOffset;
    });

    std::size_t eventIndex = 0;
    std::uint32_t frameOffset = 0;
    while (frameOffset < frames) {
      while (eventIndex < parameterEvents.size() &&
          std::clamp<std::uint32_t>(parameterEvents[eventIndex].sampleOffset, 0, frames - 1) <= frameOffset) {
        applyParameterChange(parameterEvents[eventIndex]);
        ++eventIndex;
      }

      std::uint32_t nextOffset = frames;
      if (eventIndex < parameterEvents.size()) {
        nextOffset = std::clamp<std::uint32_t>(parameterEvents[eventIndex].sampleOffset, 0, frames - 1);
      }
      runSegment(frameOffset, nextOffset - frameOffset, frames, transport);
      frameOffset = nextOffset;
    }
  }

  void runSegment(
      std::uint32_t frameOffset,
      std::uint32_t frames,
      std::uint32_t totalFrames,
      const HostTransportContext& transport) {
    if (frames == 0) {
      return;
    }
    prepareMidiBuffers(frameOffset, frames, totalFrames, transport);
    connectPorts(frameOffset);
    resetWorkerCycle();
    descriptor_->run(handle_, frames);
    deliverWorkerResponses();
  }

  void refreshInstantOutputPorts() {
    if (handle_ == nullptr || descriptor_ == nullptr || descriptor_->run == nullptr) {
      return;
    }
    prepareEmptyMidiBuffers();
    connectPorts(0);
    resetWorkerCycle();
    descriptor_->run(handle_, 0);
    deliverWorkerResponses();
  }

  static LV2_Worker_Status scheduleLv2Work(
      LV2_Worker_Schedule_Handle handle,
      std::uint32_t size,
      const void* data) {
    if (handle == nullptr) {
      return kLv2WorkerErrUnknown;
    }
    return static_cast<HostedLv2Plugin*>(handle)->scheduleWorkerWork(size, data);
  }

  static LV2_Worker_Status respondLv2Work(
      LV2_Worker_Respond_Handle handle,
      std::uint32_t size,
      const void* data) {
    if (handle == nullptr) {
      return kLv2WorkerErrUnknown;
    }
    return static_cast<HostedLv2Plugin*>(handle)->queueWorkerResponse(size, data);
  }

  LV2_Worker_Status scheduleWorkerWork(std::uint32_t size, const void* data) noexcept {
    try {
      if (workerInterface_ == nullptr || workerInterface_->work == nullptr || handle_ == nullptr) {
        return kLv2WorkerErrUnknown;
      }
      if ((size > 0 && data == nullptr) ||
          size > kMaxWorkerWorkMessageBytes ||
          scheduledWorkerMessages_ >= kMaxWorkerWorkMessages ||
          workerWorkBytes_ + size > kMaxWorkerWorkTotalBytes) {
        return kLv2WorkerErrNoSpace;
      }
      ++scheduledWorkerMessages_;
      workerWorkBytes_ += size;
      return workerInterface_->work(handle_, &HostedLv2Plugin::respondLv2Work, this, size, data);
    } catch (...) {
      return kLv2WorkerErrUnknown;
    }
  }

  LV2_Worker_Status queueWorkerResponse(std::uint32_t size, const void* data) noexcept {
    try {
      if ((size > 0 && data == nullptr) ||
          size > kMaxWorkerWorkMessageBytes ||
          pendingWorkerResponses_.size() >= kMaxWorkerWorkMessages ||
          workerResponseBytes_ + size > kMaxWorkerWorkTotalBytes) {
        return kLv2WorkerErrNoSpace;
      }
      std::vector<std::uint8_t> response;
      if (size > 0) {
        const auto* bytes = static_cast<const std::uint8_t*>(data);
        response.assign(bytes, bytes + size);
      }
      workerResponseBytes_ += response.size();
      pendingWorkerResponses_.push_back(std::move(response));
      return kLv2WorkerSuccess;
    } catch (...) {
      return kLv2WorkerErrUnknown;
    }
  }

  void resetWorkerCycle() {
    pendingWorkerResponses_.clear();
    scheduledWorkerMessages_ = 0;
    workerWorkBytes_ = 0;
    workerResponseBytes_ = 0;
  }

  void deliverWorkerResponses() {
    if (workerInterface_ == nullptr) {
      return;
    }
    if (!pendingWorkerResponses_.empty() && workerInterface_->work_response == nullptr) {
      throw std::runtime_error("lv2_worker_response_unavailable");
    }
    for (const auto& response : pendingWorkerResponses_) {
      const auto status = workerInterface_->work_response(
          handle_,
          static_cast<std::uint32_t>(response.size()),
          response.empty() ? nullptr : response.data());
      if (status != kLv2WorkerSuccess) {
        throw std::runtime_error("lv2_worker_response_failed");
      }
    }
    pendingWorkerResponses_.clear();
    if (workerInterface_->end_run != nullptr) {
      const auto status = workerInterface_->end_run(handle_);
      if (status != kLv2WorkerSuccess) {
        throw std::runtime_error("lv2_worker_end_run_failed");
      }
    }
  }

  void applyParameterChange(const PendingParameterChange& change) {
    for (const auto portIndex : inputControlPortIndexes_) {
      auto& port = ports_[portIndex];
      if (parameterIdForPort(port) == change.parameterId || std::to_string(port.index) == change.parameterId) {
        port.value = plainValueForPort(port, change.normalizedValue);
        return;
      }
    }
  }

  void connectPorts(std::uint32_t frameOffset) {
    if (handle_ == nullptr || descriptor_ == nullptr) {
      return;
    }

    for (std::size_t channel = 0; channel < inputPortIndexes_.size(); ++channel) {
      descriptor_->connect_port(
          handle_,
          ports_[inputPortIndexes_[channel]].index,
          inputBuffers_.empty() ? nullptr : inputBuffers_[channel].data() + frameOffset);
    }
    for (std::size_t channel = 0; channel < outputPortIndexes_.size(); ++channel) {
      descriptor_->connect_port(
          handle_,
          ports_[outputPortIndexes_[channel]].index,
          outputBuffers_.empty() ? nullptr : outputBuffers_[channel].data() + frameOffset);
    }
    for (const auto portIndex : inputControlPortIndexes_) {
      descriptor_->connect_port(handle_, ports_[portIndex].index, &ports_[portIndex].value);
    }
    for (const auto portIndex : outputControlPortIndexes_) {
      descriptor_->connect_port(handle_, ports_[portIndex].index, &ports_[portIndex].value);
    }
    for (std::size_t index = 0; index < inputMidiPortIndexes_.size(); ++index) {
      descriptor_->connect_port(
          handle_,
          ports_[inputMidiPortIndexes_[index]].index,
          index < midiBuffers_.size() ? midiBuffers_[index].data() : nullptr);
    }
  }

  void prepareMidiBuffers(
      std::uint32_t frameOffset,
      std::uint32_t frames,
      std::uint32_t totalFrames,
      const HostTransportContext& transport) {
    midiBuffers_.resize(inputMidiPortIndexes_.size());
    for (std::size_t index = 0; index < inputMidiPortIndexes_.size(); ++index) {
      const auto& port = ports_[inputMidiPortIndexes_[index]];
      midiBuffers_[index] = lv2MidiSequenceBuffer(port, pendingMidiMessages_, frameOffset, frames, totalFrames, transport);
    }
  }

  void prepareEmptyMidiBuffers() {
    midiBuffers_.resize(inputMidiPortIndexes_.size());
    for (std::size_t index = 0; index < inputMidiPortIndexes_.size(); ++index) {
      const auto& port = ports_[inputMidiPortIndexes_[index]];
      midiBuffers_[index] = lv2MidiSequenceBuffer(port, {}, 0, maxBlockSize_, maxBlockSize_, HostTransportContext {});
    }
  }

  std::string parameterIdForPort(const Lv2Port& port) const {
    return port.symbol.empty() ? std::to_string(port.index) : port.symbol;
  }

  float plainValueForPort(const Lv2Port& port, double normalizedValue) const {
    const auto range = static_cast<double>(port.maximum) - static_cast<double>(port.minimum);
    return quantizedPlainValueForPort(
        port,
        static_cast<double>(port.minimum) + range * std::clamp(normalizedValue, 0.0, 1.0),
        normalizedValue);
  }

  double normalizedValueForPort(const Lv2Port& port, float plainValue) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    if (std::abs(maxValue - minValue) < 0.000001) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(plainValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  double defaultNormalizedValueForPort(const Lv2Port& port) const {
    return normalizedValueForPort(port, quantizedPlainValueForPort(port, port.defaultValue, defaultNormalizedHint(port)));
  }

  float quantizedPlainValueForPort(const Lv2Port& port, double plainValue, double normalizedHint) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    double value = std::clamp(plainValue, minValue, maxValue);
    if (port.isToggled) {
      value = std::clamp(normalizedHint, 0.0, 1.0) >= 0.5 ? maxValue : minValue;
    } else if (port.isInteger || port.isEnumeration) {
      value = std::round(value);
    }
    return static_cast<float>(std::clamp(value, minValue, maxValue));
  }

  double defaultNormalizedHint(const Lv2Port& port) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    if (std::abs(maxValue - minValue) < 0.000001) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(port.defaultValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  std::uint32_t stepCountForPort(const Lv2Port& port) const {
    if (port.isToggled) {
      return 1;
    }
    if (!port.isInteger && !port.isEnumeration) {
      return 0;
    }
    const auto minStep = static_cast<long long>(std::ceil(static_cast<double>(port.minimum)));
    const auto maxStep = static_cast<long long>(std::floor(static_cast<double>(port.maximum)));
    if (maxStep <= minStep) {
      return 0;
    }
    return static_cast<std::uint32_t>(
        std::min<long long>(maxStep - minStep, static_cast<long long>(kMaxWorkerParameterStepCount)));
  }

  std::string parameterInfoToJson(const Lv2Port& port, float plainValue) const {
    std::ostringstream output;
    output << "{\"id\":\"" << jsonEscape(parameterIdForPort(port)) << "\""
           << ",\"name\":\"" << jsonEscape(port.name.empty() ? parameterIdForPort(port) : port.name) << "\""
           << ",\"normalizedValue\":" << normalizedValueForPort(port, plainValue)
           << ",\"defaultNormalizedValue\":" << defaultNormalizedValueForPort(port)
           << ",\"plainValue\":" << plainValue
           << ",\"minPlain\":" << port.minimum
           << ",\"maxPlain\":" << port.maximum
           << ",\"automatable\":true"
           << ",\"stepCount\":" << stepCountForPort(port)
           << ",\"readOnly\":false"
           << "}";
    return output.str();
  }

  std::string bundlePath_;
  Lv2BundleMetadata metadata_;
  std::unique_ptr<void, DlCloser> module_;
  Lv2DescriptorFunction descriptorFunction_ = nullptr;
  const LV2_Descriptor* descriptor_ = nullptr;
  const LV2_State_Interface* stateInterface_ = nullptr;
  const LV2_Worker_Interface* workerInterface_ = nullptr;
  LV2_Worker_Schedule workerSchedule_ {};
  LV2_Handle handle_ = nullptr;
  Lv2UridMapper uridMapper_;
  std::int32_t minBlockLengthOption_ = 1;
  std::int32_t maxBlockLengthOption_ = 128;
  std::int32_t nominalBlockLengthOption_ = 128;
  std::int32_t sequenceSizeOption_ = kMaxWorkerAtomSequenceBytes;
  std::vector<LV2_Options_Option> options_;
  double sampleRate_ = 48000.0;
  double sampleTime_ = 0.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t requestedInputChannels_ = 2;
  std::uint32_t requestedOutputChannels_ = 2;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  std::vector<Lv2Port> ports_;
  std::vector<std::size_t> inputPortIndexes_;
  std::vector<std::size_t> outputPortIndexes_;
  std::vector<std::size_t> inputControlPortIndexes_;
  std::vector<std::size_t> outputControlPortIndexes_;
  std::vector<std::size_t> inputMidiPortIndexes_;
  std::vector<Lv2AudioBusGroup> inputBusGroups_;
  std::vector<Lv2AudioBusGroup> outputBusGroups_;
  std::optional<std::size_t> latencyPortIndex_;
  std::vector<std::vector<float>> inputBuffers_;
  std::vector<std::vector<float>> outputBuffers_;
  std::vector<std::vector<std::uint64_t>> midiBuffers_;
  std::vector<PendingParameterChange> pendingParameterChanges_;
  std::vector<PendingMidiMessage> pendingMidiMessages_;
  std::vector<std::vector<std::uint8_t>> pendingWorkerResponses_;
  std::size_t scheduledWorkerMessages_ = 0;
  std::size_t workerWorkBytes_ = 0;
  std::size_t workerResponseBytes_ = 0;
  bool activated_ = false;
};

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
          std::string parameterId;
          std::string valueText;
          std::string sampleOffsetText;
          std::uint32_t sampleOffset = 0;
          double value = 0.0;
          stream >> parameterId;
          stream >> valueText;
          stream >> sampleOffsetText;
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
  return "Basic LV2 audio/control host worker is available with bounded atom MIDI, atom time-position transport, bounded buf-size/options host data, synchronous LV2 worker scheduling, LV2 port-group bus routing with per-port fallback, standard latency output-port reporting, and brokered portable/file-backed state delivery; LV2 UI hosting remains disabled.";
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
