#include "SoundBridge/Lv2HostedPlugin.h"

#ifndef _WIN32

#include "SoundBridge/Lv2Abi.h"
#include "SoundBridge/Lv2AtomSupport.h"
#include "SoundBridge/Lv2BusSupport.h"
#include "SoundBridge/Lv2StateSupport.h"
#include "SoundBridge/Lv2HostedPluginStateSupport.h"
#include "SoundBridge/Lv2WorkerSupport.h"

#include <dlfcn.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge::lv2_worker {
namespace {

using namespace lv2_abi;

struct DlCloser {
  void operator()(void* handle) const {
    if (handle != nullptr) {
      dlclose(handle);
    }
  }
};

} // namespace

class HostedLv2Plugin::Impl {
public:
  Impl(
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
    if (metadata_.requiresPowerOf2BlockLength && !isPowerOfTwoLv2BlockSize(maxBlockSize_)) {
      throw std::runtime_error("LV2 plugin requires power-of-two block sizes.");
    }
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
    workerSchedule_ = workerCycle_.scheduleFeature();
    instantiate();
  }

  Impl(const Impl&) = delete;
  Impl& operator=(const Impl&) = delete;

  ~Impl() {
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

    if (!lv2MetadataAcceptsRenderBlockSize(metadata_, maxBlockSize_, frames)) {
      throw std::runtime_error("invalid_lv2_block_size");
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
        if (lv2MetadataHasRestrictedBlockProfile(metadata_)) {
          throw std::runtime_error("lv2_block_profile_requires_block_boundary_parameters");
        }
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

  void writeStateFile(const worker_file_grants::NativeFileGrantCommand& command) {
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
    return lv2LayoutToJson(
        requestedInputChannels_,
        requestedOutputChannels_,
        inputChannels_,
        outputChannels_,
        inputBusGroups_,
        outputBusGroups_,
        sampleRate_,
        maxBlockSize_);
  }

  std::string outputAudioToJson(const std::vector<std::vector<float>>& channels) const {
    return lv2RenderedAudioToJson(channels, outputBusGroups_, outputPortIndexes_);
  }

private:
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
    return lv2HostedPluginStateBase64(ports_, inputControlPortIndexes_, extensionStateProperties());
  }

  void restoreState(const std::string& encodedState) {
    restoreLv2HostedPluginState(
        encodedState,
        ports_,
        inputControlPortIndexes_,
        uridMapper_,
        [this](const std::vector<Lv2RestoredStateProperty>& properties, const std::vector<Lv2StateFile>& files) {
          restoreExtensionState(properties, files);
        });
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
            workerCycle_.setInterface(workerInterface);
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
    if (workerCycle_.available()) {
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
    workerCycle_.setHandle(handle_);
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
    workerCycle_.reset();
    descriptor_->run(handle_, frames);
    workerCycle_.deliverResponses();
  }

  void refreshInstantOutputPorts() {
    if (handle_ == nullptr || descriptor_ == nullptr || descriptor_->run == nullptr) {
      return;
    }
    prepareEmptyMidiBuffers();
    connectPorts(0);
    workerCycle_.reset();
    descriptor_->run(handle_, 0);
    workerCycle_.deliverResponses();
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

  std::string bundlePath_;
  Lv2BundleMetadata metadata_;
  std::unique_ptr<void, DlCloser> module_;
  Lv2DescriptorFunction descriptorFunction_ = nullptr;
  const LV2_Descriptor* descriptor_ = nullptr;
  const LV2_State_Interface* stateInterface_ = nullptr;
  Lv2WorkerCycle workerCycle_;
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
  bool activated_ = false;
};

HostedLv2Plugin::HostedLv2Plugin(
    std::string bundlePath,
    double sampleRate,
    std::uint32_t maxBlockSize,
    std::uint32_t inputChannels,
    std::uint32_t outputChannels)
    : impl_(std::make_unique<Impl>(
          std::move(bundlePath),
          sampleRate,
          maxBlockSize,
          inputChannels,
          outputChannels)) {}

HostedLv2Plugin::~HostedLv2Plugin() = default;

std::vector<std::vector<float>> HostedLv2Plugin::render(
    std::uint32_t frames,
    double sampleRate,
    std::vector<std::vector<float>> inputChannels,
    std::vector<IndexedAudioBus> inputBuses,
    HostTransportContext transport) {
  return impl_->render(frames, sampleRate, std::move(inputChannels), std::move(inputBuses), transport);
}

double HostedLv2Plugin::sampleTime() const {
  return impl_->sampleTime();
}

void HostedLv2Plugin::enqueueMidiEvents(std::vector<PendingMidiMessage> messages) {
  impl_->enqueueMidiEvents(std::move(messages));
}

std::string HostedLv2Plugin::parametersToJson() const {
  return impl_->parametersToJson();
}

std::string HostedLv2Plugin::setParameter(
    const std::string& parameterId,
    double value,
    std::uint32_t sampleOffset) {
  return impl_->setParameter(parameterId, value, sampleOffset);
}

std::string HostedLv2Plugin::latencyToJson() {
  return impl_->latencyToJson();
}

std::string HostedLv2Plugin::tailTimeToJson() const {
  return impl_->tailTimeToJson();
}

std::string HostedLv2Plugin::stateToJson() {
  return impl_->stateToJson();
}

void HostedLv2Plugin::writeStateFile(const worker_file_grants::NativeFileGrantCommand& command) {
  impl_->writeStateFile(command);
}

std::string HostedLv2Plugin::setState(const std::string& stateText) {
  return impl_->setState(stateText);
}

std::string HostedLv2Plugin::layoutToJson() const {
  return impl_->layoutToJson();
}

std::string HostedLv2Plugin::outputAudioToJson(const std::vector<std::vector<float>>& channels) const {
  return impl_->outputAudioToJson(channels);
}

} // namespace soundbridge::lv2_worker

#endif
