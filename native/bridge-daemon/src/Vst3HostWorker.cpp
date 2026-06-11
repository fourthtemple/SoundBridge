#include "SoundBridge/Vst3HostWorker.h"

#include "SoundBridge/ExampleInstrumentRenderer.h"
#include "SoundBridge/NativePlugin.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK
#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
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
#include <vector>

namespace soundbridge {

namespace {

std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames) {
  if (encoded.empty() || encoded == "-") {
    return {};
  }

  std::vector<std::vector<float>> channels;
  std::stringstream channelStream(encoded);
  std::string channelText;
  while (std::getline(channelStream, channelText, '|')) {
    std::vector<float> channel;
    std::stringstream sampleStream(channelText);
    std::string sampleText;
    while (std::getline(sampleStream, sampleText, ',')) {
      if (sampleText.empty()) {
        channel.push_back(0.0F);
        continue;
      }
      channel.push_back(static_cast<float>(std::strtod(sampleText.c_str(), nullptr)));
    }
    channel.resize(frames, 0.0F);
    channels.push_back(std::move(channel));
  }
  return channels;
}

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

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
    configure();
  }

  HostedVst3Effect(const HostedVst3Effect&) = delete;
  HostedVst3Effect& operator=(const HostedVst3Effect&) = delete;

  ~HostedVst3Effect() {
    if (processor_) {
      processor_->setProcessing(false);
    }
    if (component_) {
      if (active_) {
        component_->setActive(false);
      }
      if (initialized_) {
        component_->terminate();
      }
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

    Steinberg::Vst::ProcessData processData;
    processData.processMode = Steinberg::Vst::kRealtime;
    processData.symbolicSampleSize = Steinberg::Vst::kSample32;
    processData.numSamples = static_cast<Steinberg::int32>(frames);
    processData.numInputs = inputChannels_ > 0 ? 1 : 0;
    processData.numOutputs = outputChannels_ > 0 ? 1 : 0;
    processData.inputs = inputChannels_ > 0 ? &inputBus : nullptr;
    processData.outputs = outputChannels_ > 0 ? &outputBus : nullptr;

    checkResult(processor_->process(processData), "IAudioProcessor::process");
    sampleTime_ += frames;
    return outputChannels;
  }

private:
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
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
  double sampleRate_ = 48000.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t requestedInputChannels_ = 2;
  std::uint32_t requestedOutputChannels_ = 2;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  Steinberg::int32 inputBusCount_ = 0;
  Steinberg::int32 outputBusCount_ = 0;
  double sampleTime_ = 0.0;
  bool initialized_ = false;
  bool active_ = false;
};

int runVst3HostWorkerWithSdk(int argc, char** argv) {
  if (argc < 8) {
    std::cerr << "--host-vst3-worker requires bundle path, sample rate, max block size, input channels, output channels, and kind.\n";
    return 2;
  }

  try {
    HostedVst3Effect host(
        argv[2],
        std::strtod(argv[3], nullptr),
        static_cast<std::uint32_t>(std::strtoul(argv[4], nullptr, 10)),
        static_cast<std::uint32_t>(std::strtoul(argv[5], nullptr, 10)),
        static_cast<std::uint32_t>(std::strtoul(argv[6], nullptr, 10)));

    std::cout << "{\"ok\":true,\"ready\":true}" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
      std::stringstream stream(line);
      std::string command;
      stream >> command;
      if (command == "quit") {
        return 0;
      }

      try {
        if (command == "noteOn" || command == "noteOff") {
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "render") {
          std::uint32_t frames = 128;
          double sampleRate = 48000.0;
          std::string encodedChannels;
          stream >> frames;
          stream >> sampleRate;
          stream >> encodedChannels;
          const auto channels = host.render(frames, sampleRate, parseChannels(encodedChannels, frames));
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
