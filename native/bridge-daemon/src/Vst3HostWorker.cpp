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

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

// Hard limits applied to every value crossing the worker's stdin/argv boundary.
// The parent daemon enforces its own caps, but the worker must not trust it.
constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerChannels = 32;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;

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
          std::cout << "{\"ok\":true}" << std::endl;
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
