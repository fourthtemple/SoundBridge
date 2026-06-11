#include "SoundBridge/AudioUnitHostWorker.h"

#include "SoundBridge/ExampleInstrumentRenderer.h"
#include "SoundBridge/NativePlugin.h"

#ifdef SOUNDBRIDGE_MACOS
#include <AudioToolbox/AudioToolbox.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace soundbridge {

namespace {

#ifdef SOUNDBRIDGE_MACOS

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

OSType fourCharCodeFromString(const std::string& value) {
  std::string padded = value;
  std::replace(padded.begin(), padded.end(), '_', ' ');
  while (padded.size() < 4) {
    padded.push_back(' ');
  }
  return (static_cast<OSType>(static_cast<unsigned char>(padded[0])) << 24) |
      (static_cast<OSType>(static_cast<unsigned char>(padded[1])) << 16) |
      (static_cast<OSType>(static_cast<unsigned char>(padded[2])) << 8) |
      static_cast<OSType>(static_cast<unsigned char>(padded[3]));
}

std::string osStatusText(OSStatus status) {
  if (status == noErr) {
    return "noErr";
  }

  std::string code(4, '\0');
  code[0] = static_cast<char>((status >> 24) & 0xFF);
  code[1] = static_cast<char>((status >> 16) & 0xFF);
  code[2] = static_cast<char>((status >> 8) & 0xFF);
  code[3] = static_cast<char>(status & 0xFF);
  const bool printable = std::all_of(code.begin(), code.end(), [](unsigned char character) {
    return character >= 32 && character <= 126;
  });

  std::ostringstream output;
  output << status;
  if (printable) {
    output << " ('" << code << "')";
  }
  return output.str();
}

void checkStatus(OSStatus status, const std::string& operation) {
  if (status != noErr) {
    throw std::runtime_error(operation + " failed with OSStatus " + osStatusText(status));
  }
}

AudioStreamBasicDescription streamDescription(double sampleRate, std::uint32_t channels) {
  AudioStreamBasicDescription description {};
  description.mSampleRate = sampleRate;
  description.mFormatID = kAudioFormatLinearPCM;
  description.mFormatFlags =
      kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
  description.mBytesPerPacket = sizeof(Float32);
  description.mFramesPerPacket = 1;
  description.mBytesPerFrame = sizeof(Float32);
  description.mChannelsPerFrame = channels;
  description.mBitsPerChannel = 8 * sizeof(Float32);
  return description;
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

std::unique_ptr<AudioBufferList, void (*)(AudioBufferList*)> makeAudioBufferList(
    std::vector<std::vector<float>>& channels,
    std::uint32_t channelCount,
    std::uint32_t frames) {
  channels.resize(channelCount);
  for (auto& channel : channels) {
    channel.resize(frames, 0.0F);
  }

  const auto bufferListSize = sizeof(AudioBufferList) + sizeof(AudioBuffer) * (channelCount > 0 ? channelCount - 1 : 0);
  auto* raw = static_cast<AudioBufferList*>(std::calloc(1, bufferListSize));
  if (raw == nullptr) {
    throw std::bad_alloc();
  }

  raw->mNumberBuffers = channelCount;
  for (std::uint32_t channelIndex = 0; channelIndex < channelCount; ++channelIndex) {
    raw->mBuffers[channelIndex].mNumberChannels = 1;
    raw->mBuffers[channelIndex].mDataByteSize = frames * sizeof(Float32);
    raw->mBuffers[channelIndex].mData = channels[channelIndex].data();
  }

  return {raw, [](AudioBufferList* value) {
            std::free(value);
          }};
}

class HostedAudioUnit {
public:
  HostedAudioUnit(
      std::string componentType,
      std::string componentSubType,
      std::string componentManufacturer,
      double sampleRate,
      std::uint32_t maxBlockSize,
      std::uint32_t inputChannels,
      std::uint32_t outputChannels)
      : sampleRate_(sampleRate),
        maxBlockSize_(std::clamp<std::uint32_t>(maxBlockSize, 1, 8192)),
        inputChannels_(std::min<std::uint32_t>(inputChannels, 32)),
        outputChannels_(std::clamp<std::uint32_t>(outputChannels, 1, 32)) {
    AudioComponentDescription description {};
    description.componentType = fourCharCodeFromString(componentType);
    description.componentSubType = fourCharCodeFromString(componentSubType);
    description.componentManufacturer = fourCharCodeFromString(componentManufacturer);
    description.componentFlags = 0;
    description.componentFlagsMask = 0;

    AudioComponent component = AudioComponentFindNext(nullptr, &description);
    if (component == nullptr) {
      throw std::runtime_error("AudioComponentFindNext did not find the requested Audio Unit.");
    }

    checkStatus(AudioComponentInstanceNew(component, &unit_), "AudioComponentInstanceNew");
    configure();
  }

  HostedAudioUnit(const HostedAudioUnit&) = delete;
  HostedAudioUnit& operator=(const HostedAudioUnit&) = delete;

  ~HostedAudioUnit() {
    if (unit_ != nullptr) {
      AudioUnitUninitialize(unit_);
      AudioComponentInstanceDispose(unit_);
    }
  }

  void noteOn(std::uint8_t note, double velocity) {
    const auto scaledVelocity = static_cast<UInt32>(std::clamp(velocity, 0.0, 1.0) * 127.0);
    checkStatus(MusicDeviceMIDIEvent(unit_, 0x90, note, std::max<UInt32>(1, scaledVelocity), 0), "MusicDeviceMIDIEvent noteOn");
  }

  void noteOff(std::uint8_t note) {
    checkStatus(MusicDeviceMIDIEvent(unit_, 0x80, note, 0, 0), "MusicDeviceMIDIEvent noteOff");
  }

  std::vector<std::vector<float>> render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("Audio Unit worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    currentInput_ = std::move(inputChannels);
    currentInputFrames_ = frames;
    for (auto& channel : currentInput_) {
      channel.resize(frames, 0.0F);
    }

    std::vector<std::vector<float>> outputChannels;
    auto outputList = makeAudioBufferList(outputChannels, outputChannels_, frames);

    AudioTimeStamp timeStamp {};
    timeStamp.mFlags = kAudioTimeStampSampleTimeValid;
    timeStamp.mSampleTime = sampleTime_;
    AudioUnitRenderActionFlags flags = 0;
    checkStatus(AudioUnitRender(unit_, &flags, &timeStamp, 0, frames, outputList.get()), "AudioUnitRender");
    sampleTime_ += frames;
    return outputChannels;
  }

private:
  static OSStatus inputCallback(
      void* refCon,
      AudioUnitRenderActionFlags* /* actionFlags */,
      const AudioTimeStamp* /* timeStamp */,
      UInt32 /* busNumber */,
      UInt32 frameCount,
      AudioBufferList* ioData) {
    auto* host = static_cast<HostedAudioUnit*>(refCon);
    for (UInt32 bufferIndex = 0; bufferIndex < ioData->mNumberBuffers; ++bufferIndex) {
      auto* output = static_cast<Float32*>(ioData->mBuffers[bufferIndex].mData);
      const auto bytes = frameCount * sizeof(Float32);
      ioData->mBuffers[bufferIndex].mDataByteSize = bytes;
      if (output == nullptr) {
        continue;
      }

      if (bufferIndex < host->currentInput_.size()) {
        const auto& source = host->currentInput_[bufferIndex];
        for (UInt32 frame = 0; frame < frameCount; ++frame) {
          output[frame] = frame < source.size() ? source[frame] : 0.0F;
        }
      } else {
        std::memset(output, 0, bytes);
      }
    }
    return noErr;
  }

  void configure() {
    UInt32 maxFrames = maxBlockSize_;
    checkStatus(
        AudioUnitSetProperty(
            unit_,
            kAudioUnitProperty_MaximumFramesPerSlice,
            kAudioUnitScope_Global,
            0,
            &maxFrames,
            sizeof(maxFrames)),
        "AudioUnitSetProperty MaximumFramesPerSlice");

    const auto outputFormat = streamDescription(sampleRate_, outputChannels_);
    checkStatus(
        AudioUnitSetProperty(
            unit_,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output,
            0,
            &outputFormat,
            sizeof(outputFormat)),
        "AudioUnitSetProperty output StreamFormat");

    if (inputChannels_ > 0) {
      const auto inputFormat = streamDescription(sampleRate_, inputChannels_);
      checkStatus(
          AudioUnitSetProperty(
              unit_,
              kAudioUnitProperty_StreamFormat,
              kAudioUnitScope_Input,
              0,
              &inputFormat,
              sizeof(inputFormat)),
          "AudioUnitSetProperty input StreamFormat");

      AURenderCallbackStruct callback {};
      callback.inputProc = &HostedAudioUnit::inputCallback;
      callback.inputProcRefCon = this;
      checkStatus(
          AudioUnitSetProperty(
              unit_,
              kAudioUnitProperty_SetRenderCallback,
              kAudioUnitScope_Input,
              0,
              &callback,
              sizeof(callback)),
          "AudioUnitSetProperty input RenderCallback");
    }

    checkStatus(AudioUnitInitialize(unit_), "AudioUnitInitialize");
  }

  AudioUnit unit_ = nullptr;
  double sampleRate_ = 48000.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  std::vector<std::vector<float>> currentInput_;
  std::uint32_t currentInputFrames_ = 0;
  double sampleTime_ = 0.0;
};

int runAudioUnitHostWorkerMac(int argc, char** argv) {
  if (argc < 10) {
    std::cerr << "--host-au-worker requires type, subtype, manufacturer, sample rate, max block size, input channels, output channels, and kind.\n";
    return 2;
  }

  double sampleRate = 48000.0;
  std::uint32_t maxBlockSize = 128;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 2;
  if (!parseSampleRateArg(argv[5], sampleRate) ||
      !parseUint32Arg(argv[6], 1, kMaxWorkerFrames, maxBlockSize) ||
      !parseUint32Arg(argv[7], 0, kMaxWorkerChannels, inputChannels) ||
      !parseUint32Arg(argv[8], 1, kMaxWorkerChannels, outputChannels)) {
    std::cout << "{\"error\":\"invalid_worker_arguments\"}" << std::endl;
    return 2;
  }

  try {
    HostedAudioUnit host(argv[2], argv[3], argv[4], sampleRate, maxBlockSize, inputChannels, outputChannels);

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
        if (command == "noteOn") {
          int note = 60;
          double velocity = 0.8;
          stream >> note;
          stream >> velocity;
          if (!std::isfinite(velocity)) {
            velocity = 0.0;
          }
          host.noteOn(static_cast<std::uint8_t>(std::clamp(note, 0, 127)), std::clamp(velocity, 0.0, 1.0));
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "noteOff") {
          int note = 60;
          stream >> note;
          host.noteOff(static_cast<std::uint8_t>(std::clamp(note, 0, 127)));
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

bool audioUnitHostAvailable() {
#ifdef SOUNDBRIDGE_MACOS
  return true;
#else
  return false;
#endif
}

std::string audioUnitHostStatus() {
#ifdef SOUNDBRIDGE_MACOS
  return "Audio Unit scanner and CoreAudio host worker are available.";
#else
  return "Audio Unit hosting is only available on macOS.";
#endif
}

int runAudioUnitHostWorker(int argc, char** argv) {
#ifdef SOUNDBRIDGE_MACOS
  return runAudioUnitHostWorkerMac(argc, argv);
#else
  (void)argc;
  (void)argv;
  std::cout << "{\"error\":\"Audio Unit hosting is only available on macOS.\"}" << std::endl;
  return 3;
#endif
}

} // namespace soundbridge
