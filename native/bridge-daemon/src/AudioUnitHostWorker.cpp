#include "SoundBridge/AudioUnitHostWorker.h"

#include "SoundBridge/AudioUnitHostWorkerSupport.h"
#include "SoundBridge/Base64.h"
#include "SoundBridge/NativePlugin.h"

#ifdef SOUNDBRIDGE_MACOS
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace soundbridge {

namespace {

#ifdef SOUNDBRIDGE_MACOS

using namespace audio_unit_worker;

// Hard limits applied to every value crossing the worker's stdin/argv boundary.
// The parent daemon enforces its own caps, but the worker must not trust it.
constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerChannels = 32;
constexpr std::size_t kMaxWorkerMidiEvents = 4096;
constexpr std::size_t kMaxWorkerParameters = 1024;
constexpr std::size_t kMaxWorkerParameterStringBytes = 160;
constexpr std::size_t kMaxWorkerStateBytes = 384 * 1024;
constexpr std::uint32_t kMaxWorkerLatencySamples = 1'048'576;
constexpr std::uint32_t kMaxWorkerTailSamples = 1'048'576;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;
constexpr double kMaxWorkerTransportTempoBpm = 960.0;
constexpr double kMaxWorkerTransportPositionMusic = 1'000'000'000.0;
constexpr long long kMaxWorkerTransportSamplePosition = 9'007'199'254'740'991LL;
// Some AU effects return this for MusicDeviceMIDIEvent instead of a named AudioUnit error.
constexpr OSStatus kAudioUnitUnimplementedStatus = -4;

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

std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes) {
  if (value.size() > maxBytes) {
    value.resize(maxBytes);
  }
  return value;
}

std::string cfStringToUtf8(CFStringRef value) {
  if (value == nullptr) {
    return "";
  }
  char buffer[512] {};
  if (CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
    return cappedString(buffer);
  }
  const auto length = CFStringGetLength(value);
  const auto maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string output(static_cast<std::size_t>(std::max<CFIndex>(0, maxSize)), '\0');
  if (CFStringGetCString(value, output.data(), maxSize, kCFStringEncodingUTF8)) {
    output.resize(std::strlen(output.c_str()));
    return cappedString(output);
  }
  return "";
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

bool isUnsupportedMidiStatus(OSStatus status) {
  return status == kAudioUnitErr_InvalidProperty ||
      status == kAudioUnitErr_InvalidParameter ||
      status == kAudioUnitErr_InvalidElement ||
      status == kAudioUnitErr_InvalidPropertyValue ||
      status == kAudioUnitErr_InvalidParameterValue ||
      status == kAudioUnitUnimplementedStatus;
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
        requestedInputChannels_(std::min<std::uint32_t>(inputChannels, 32)),
        requestedOutputChannels_(std::clamp<std::uint32_t>(outputChannels, 1, 32)),
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

  bool sendMidi(UInt32 status, UInt32 data1, UInt32 data2, std::uint32_t sampleOffset) {
    const auto result = MusicDeviceMIDIEvent(
        unit_,
        status & 0xFF,
        data1 & 0x7F,
        data2 & 0x7F,
        std::min<std::uint32_t>(sampleOffset, maxBlockSize_ - 1));
    if (result == noErr) {
      return true;
    }
    if (isUnsupportedMidiStatus(result)) {
      return false;
    }
    checkStatus(result, "MusicDeviceMIDIEvent");
    return false;
  }

  void sendMidiEvents(const std::vector<PendingMidiMessage>& messages) {
    for (const auto& message : messages) {
      sendMidi(message.status, message.data1, message.data2, message.sampleOffset);
    }
  }

  void noteOn(std::uint8_t note, double velocity, std::uint8_t channel = 0, std::uint32_t sampleOffset = 0) {
    const auto scaledVelocity = std::max<UInt32>(1, scaled7Bit(velocity));
    sendMidi(0x90 | std::min<UInt32>(channel, 15), note, scaledVelocity, sampleOffset);
  }

  void noteOff(std::uint8_t note, std::uint8_t channel = 0, std::uint32_t sampleOffset = 0) {
    sendMidi(0x80 | std::min<UInt32>(channel, 15), note, 0, sampleOffset);
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

  std::string setParameter(AudioUnitParameterID parameterId, double normalizedValue, std::uint32_t sampleOffset) {
    AudioUnitParameterInfo info {};
    UInt32 infoSize = sizeof(info);
    checkStatus(
        AudioUnitGetProperty(
            unit_,
            kAudioUnitProperty_ParameterInfo,
            kAudioUnitScope_Global,
            parameterId,
            &info,
            &infoSize),
        "AudioUnitGetProperty ParameterInfo");

    const auto value = plainValueForNormalized(info, normalizedValue);
    checkStatus(
        AudioUnitSetParameter(
            unit_,
            parameterId,
            kAudioUnitScope_Global,
            0,
            value,
            std::min<std::uint32_t>(sampleOffset, maxBlockSize_ - 1)),
        "AudioUnitSetParameter");
    return std::string("{\"parameter\":") + parameterInfoToJson(parameterId, info) + "}";
  }

  std::string stateToJson() const {
    return std::string("{\"state\":\"") + stateBase64() + "\"}";
  }

  std::string setState(const std::string& stateText) {
    if (stateText == "-") {
      return "{\"ok\":true}";
    }

    const auto decoded = base64Decode(stateText, kMaxWorkerStateBytes);
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, decoded.data(), static_cast<CFIndex>(decoded.size()));
    if (data == nullptr) {
      throw std::runtime_error("Audio Unit state data allocation failed.");
    }

    CFErrorRef error = nullptr;
    CFPropertyListRef classInfo = CFPropertyListCreateWithData(
        kCFAllocatorDefault,
        data,
        kCFPropertyListImmutable,
        nullptr,
        &error);
    CFRelease(data);
    if (error != nullptr) {
      CFRelease(error);
    }
    if (classInfo == nullptr) {
      throw std::runtime_error("Audio Unit state was not a valid property list.");
    }

    const auto status = AudioUnitSetProperty(
        unit_,
        kAudioUnitProperty_ClassInfo,
        kAudioUnitScope_Global,
        0,
        &classInfo,
        sizeof(classInfo));
    CFRelease(classInfo);
    checkStatus(status, "AudioUnitSetProperty ClassInfo");
    return "{\"ok\":true}";
  }

  std::string latencyToJson() const {
    Float64 latencySeconds = 0.0;
    UInt32 propertySize = sizeof(latencySeconds);
    if (AudioUnitGetProperty(
            unit_,
            kAudioUnitProperty_Latency,
            kAudioUnitScope_Global,
            0,
            &latencySeconds,
            &propertySize) != noErr ||
        !std::isfinite(latencySeconds) ||
        latencySeconds < 0.0) {
      latencySeconds = 0.0;
    }

    const auto latencySamples = static_cast<std::uint32_t>(std::clamp<double>(
        std::round(latencySeconds * sampleRate_),
        0.0,
        static_cast<double>(kMaxWorkerLatencySamples)));
    std::ostringstream output;
    output << "{\"latencySamples\":" << latencySamples << "}";
    return output.str();
  }

  std::string tailTimeToJson() const {
    Float64 tailSeconds = 0.0;
    UInt32 propertySize = sizeof(tailSeconds);
    if (AudioUnitGetProperty(
            unit_,
            kAudioUnitProperty_TailTime,
            kAudioUnitScope_Global,
            0,
            &tailSeconds,
            &propertySize) != noErr ||
        !std::isfinite(tailSeconds) ||
        tailSeconds < 0.0) {
      tailSeconds = 0.0;
    }

    const auto tailSamples = static_cast<std::uint32_t>(std::clamp<double>(
        std::round(tailSeconds * sampleRate_),
        0.0,
        static_cast<double>(kMaxWorkerTailSamples)));
    std::ostringstream output;
    output << "{\"tailSamples\":" << tailSamples << ",\"infiniteTail\":false}";
    return output.str();
  }

  std::string layoutToJson() const {
    std::ostringstream output;
    output << "{\"requestedInputChannels\":" << requestedInputChannels_
           << ",\"requestedOutputChannels\":" << requestedOutputChannels_
           << ",\"inputChannels\":" << inputChannels_
           << ",\"outputChannels\":" << outputChannels_
           << ",\"inputBuses\":" << activeInputBusCount()
           << ",\"outputBuses\":" << activeOutputBusCount()
           << ",\"inputBusLayouts\":" << inputBusLayoutsToJson()
           << ",\"outputBusLayouts\":" << outputBusLayoutsToJson()
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

  RenderedAudio render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels,
      std::vector<IndexedAudioBus> inputBuses,
      HostTransportContext transport) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("Audio Unit worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    transportStateChanged_ = currentTransportInitialized_ &&
        (transport.playing != currentTransport_.playing ||
         transport.recording != currentTransport_.recording ||
         transport.loopActive != currentTransport_.loopActive ||
         std::abs(transport.samplePosition - sampleTime_) > 0.5);
    currentTransport_ = transport;
    currentTransportInitialized_ = true;
    if (inputBuses.empty() && !inputChannels.empty()) {
      inputBuses.push_back(IndexedAudioBus{0, std::move(inputChannels)});
    }
    currentInputBuses_ = std::move(inputBuses);
    currentInputFrames_ = frames;
    for (auto& bus : currentInputBuses_) {
      for (auto& channel : bus.channels) {
        channel.resize(frames, 0.0F);
      }
    }

    RenderedAudio rendered;
    auto outputList = makeAudioBufferList(rendered.channels, outputChannels_, frames);

    AudioTimeStamp timeStamp {};
    timeStamp.mFlags = kAudioTimeStampSampleTimeValid;
    timeStamp.mSampleTime = currentTransport_.samplePosition;
    AudioUnitRenderActionFlags flags = 0;
    checkStatus(AudioUnitRender(unit_, &flags, &timeStamp, 0, frames, outputList.get()), "AudioUnitRender");
    rendered.outputBuses.push_back(IndexedAudioBus{0, rendered.channels});

    for (std::uint32_t busIndex = 1; busIndex < outputBusActive_.size(); ++busIndex) {
      if (!outputBusActive_[busIndex]) {
        continue;
      }
      std::vector<std::vector<float>> busChannels;
      auto busOutputList = makeAudioBufferList(busChannels, outputChannels_, frames);
      AudioUnitRenderActionFlags busFlags = 0;
      checkStatus(
          AudioUnitRender(unit_, &busFlags, &timeStamp, busIndex, frames, busOutputList.get()),
          "AudioUnitRender auxiliary output");
      rendered.outputBuses.push_back(IndexedAudioBus{busIndex, std::move(busChannels)});
    }

    sampleTime_ = currentTransport_.samplePosition + frames;
    return rendered;
  }

  double sampleTime() const {
    return sampleTime_;
  }

private:
  std::uint32_t activeInputBusCount() const {
    return static_cast<std::uint32_t>(std::count(inputBusActive_.begin(), inputBusActive_.end(), true));
  }

  std::uint32_t activeOutputBusCount() const {
    return static_cast<std::uint32_t>(std::count(outputBusActive_.begin(), outputBusActive_.end(), true));
  }

  std::string inputBusLayoutsToJson() const {
    std::ostringstream output;
    output << "[";
    bool wrote = false;
    for (std::uint32_t index = 0; index < inputBusActive_.size(); ++index) {
      if (!inputBusActive_[index]) {
        continue;
      }
      if (wrote) {
        output << ",";
      }
      output << "{\"index\":" << index
             << ",\"direction\":\"input\""
             << ",\"mediaType\":\"audio\""
             << ",\"name\":\"" << (index == 0 ? "Main Input" : "Aux Input " + std::to_string(index)) << "\""
             << ",\"type\":\"" << (index == 0 ? "main" : "aux") << "\""
             << ",\"channels\":" << std::min<std::uint32_t>(inputChannels_, kMaxWorkerChannels)
             << ",\"active\":true}";
      wrote = true;
    }
    output << "]";
    return output.str();
  }

  std::string outputBusLayoutsToJson() const {
    std::ostringstream output;
    output << "[";
    bool wrote = false;
    for (std::uint32_t index = 0; index < outputBusActive_.size(); ++index) {
      if (!outputBusActive_[index]) {
        continue;
      }
      if (wrote) {
        output << ",";
      }
      output << "{\"index\":" << index
             << ",\"direction\":\"output\""
             << ",\"mediaType\":\"audio\""
             << ",\"name\":\"" << (index == 0 ? "Main Output" : "Aux Output " + std::to_string(index)) << "\""
             << ",\"type\":\"" << (index == 0 ? "main" : "aux") << "\""
             << ",\"channels\":" << std::min<std::uint32_t>(outputChannels_, kMaxWorkerChannels)
             << ",\"active\":true}";
      wrote = true;
    }
    output << "]";
    return output.str();
  }

  static std::string mainBusLayoutToJson(const char* direction, std::uint32_t channels, bool active) {
    const std::string directionText(direction);
    if (!active && directionText == "input") {
      return "[]";
    }
    std::ostringstream output;
    output << "[{\"index\":0"
           << ",\"direction\":\"" << directionText << "\""
           << ",\"mediaType\":\"audio\""
           << ",\"name\":\"" << (directionText == "input" ? "Main Input" : "Main Output") << "\""
           << ",\"type\":\"main\""
           << ",\"channels\":" << std::min<std::uint32_t>(channels, kMaxWorkerChannels)
           << ",\"active\":" << (active ? "true" : "false")
           << "}]";
    return output.str();
  }

  std::string stateBase64() const {
    CFPropertyListRef classInfo = nullptr;
    UInt32 classInfoSize = sizeof(classInfo);
    const auto status = AudioUnitGetProperty(
        unit_,
        kAudioUnitProperty_ClassInfo,
        kAudioUnitScope_Global,
        0,
        &classInfo,
        &classInfoSize);
    if (status != noErr || classInfo == nullptr) {
      return "";
    }

    CFErrorRef error = nullptr;
    CFDataRef data = CFPropertyListCreateData(
        kCFAllocatorDefault,
        classInfo,
        kCFPropertyListBinaryFormat_v1_0,
        0,
        &error);
    CFRelease(classInfo);
    if (error != nullptr) {
      CFRelease(error);
    }
    if (data == nullptr) {
      return "";
    }

    const auto size = static_cast<std::size_t>(CFDataGetLength(data));
    if (size > kMaxWorkerStateBytes) {
      CFRelease(data);
      throw std::runtime_error("state_too_large");
    }
    const auto encoded = base64Encode(CFDataGetBytePtr(data), size);
    CFRelease(data);
    return encoded;
  }

  std::vector<std::string> parameterJsonList() const {
    UInt32 propertySize = 0;
    Boolean writable = false;
    const auto status = AudioUnitGetPropertyInfo(
        unit_,
        kAudioUnitProperty_ParameterList,
        kAudioUnitScope_Global,
        0,
        &propertySize,
        &writable);
    if (status != noErr || propertySize == 0) {
      return {};
    }

    std::vector<AudioUnitParameterID> parameterIds(propertySize / sizeof(AudioUnitParameterID));
    if (parameterIds.empty()) {
      return {};
    }
    parameterIds.resize(std::min<std::size_t>(parameterIds.size(), kMaxWorkerParameters));
    propertySize = static_cast<UInt32>(parameterIds.size() * sizeof(AudioUnitParameterID));
    checkStatus(
        AudioUnitGetProperty(
            unit_,
            kAudioUnitProperty_ParameterList,
            kAudioUnitScope_Global,
            0,
            parameterIds.data(),
            &propertySize),
        "AudioUnitGetProperty ParameterList");

    std::vector<std::string> parameters;
    parameters.reserve(parameterIds.size());
    for (const auto parameterId : parameterIds) {
      AudioUnitParameterInfo info {};
      UInt32 infoSize = sizeof(info);
      if (AudioUnitGetProperty(
              unit_,
              kAudioUnitProperty_ParameterInfo,
              kAudioUnitScope_Global,
              parameterId,
              &info,
              &infoSize) != noErr) {
        continue;
      }
      parameters.push_back(parameterInfoToJson(parameterId, info));
    }
    return parameters;
  }

  AudioUnitParameterValue plainValueForNormalized(const AudioUnitParameterInfo& info, double normalizedValue) const {
    const auto clamped = std::clamp(normalizedValue, 0.0, 1.0);
    const auto minValue = std::isfinite(info.minValue) ? info.minValue : 0.0F;
    const auto maxValue = std::isfinite(info.maxValue) ? info.maxValue : 1.0F;
    return static_cast<AudioUnitParameterValue>(minValue + (maxValue - minValue) * clamped);
  }

  double normalizedValueForPlain(const AudioUnitParameterInfo& info, AudioUnitParameterValue value) const {
    const auto minValue = std::isfinite(info.minValue) ? info.minValue : 0.0F;
    const auto maxValue = std::isfinite(info.maxValue) ? info.maxValue : 1.0F;
    if (std::abs(maxValue - minValue) < 0.000001F) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(value) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  std::string parameterInfoToJson(AudioUnitParameterID parameterId, const AudioUnitParameterInfo& info) const {
    AudioUnitParameterValue plainValue = info.defaultValue;
    if (AudioUnitGetParameter(unit_, parameterId, kAudioUnitScope_Global, 0, &plainValue) != noErr) {
      plainValue = info.defaultValue;
    }

    auto name = info.cfNameString != nullptr ? cfStringToUtf8(info.cfNameString) : cappedString(info.name);
    if ((info.flags & kAudioUnitParameterFlag_CFNameRelease) != 0 && info.cfNameString != nullptr) {
      CFRelease(info.cfNameString);
    }
    if (name.empty()) {
      name = std::to_string(parameterId);
    }
    const auto unit = cfStringToUtf8(info.unitName);
    const auto readOnly = (info.flags & kAudioUnitParameterFlag_MeterReadOnly) != 0 ||
        ((info.flags & kAudioUnitParameterFlag_IsWritable) == 0 && (info.flags & kAudioUnitParameterFlag_IsReadable) != 0);

    std::ostringstream output;
    output << "{\"id\":\"" << parameterId << "\""
           << ",\"name\":\"" << jsonEscape(name) << "\""
           << ",\"normalizedValue\":" << normalizedValueForPlain(info, plainValue)
           << ",\"defaultNormalizedValue\":" << normalizedValueForPlain(info, info.defaultValue)
           << ",\"plainValue\":" << (std::isfinite(plainValue) ? plainValue : info.defaultValue)
           << ",\"minPlain\":" << (std::isfinite(info.minValue) ? info.minValue : 0.0F)
           << ",\"maxPlain\":" << (std::isfinite(info.maxValue) ? info.maxValue : 1.0F)
           << ",\"automatable\":" << (readOnly ? "false" : "true");
    if (!unit.empty()) {
      output << ",\"unit\":\"" << jsonEscape(cappedString(unit, 64)) << "\"";
    }
    output << ",\"stepCount\":0"
           << ",\"readOnly\":" << (readOnly ? "true" : "false")
           << "}";
    return output.str();
  }

  static OSStatus inputCallback(
      void* refCon,
      AudioUnitRenderActionFlags* /* actionFlags */,
      const AudioTimeStamp* /* timeStamp */,
      UInt32 busNumber,
      UInt32 frameCount,
      AudioBufferList* ioData) {
    auto* host = static_cast<HostedAudioUnit*>(refCon);
    const auto* sourceBus = findBusChannels(host->currentInputBuses_, busNumber);
    for (UInt32 bufferIndex = 0; bufferIndex < ioData->mNumberBuffers; ++bufferIndex) {
      auto* output = static_cast<Float32*>(ioData->mBuffers[bufferIndex].mData);
      const auto bytes = frameCount * sizeof(Float32);
      ioData->mBuffers[bufferIndex].mDataByteSize = bytes;
      if (output == nullptr) {
        continue;
      }

      if (sourceBus != nullptr && bufferIndex < sourceBus->size()) {
        const auto& source = (*sourceBus)[bufferIndex];
        for (UInt32 frame = 0; frame < frameCount; ++frame) {
          output[frame] = frame < source.size() ? source[frame] : 0.0F;
        }
      } else {
        std::memset(output, 0, bytes);
      }
    }
    return noErr;
  }

  static OSStatus beatAndTempoCallback(
      void* userData,
      Float64* currentBeat,
      Float64* currentTempo) {
    auto* host = static_cast<HostedAudioUnit*>(userData);
    if (host == nullptr) {
      return kAudioUnitErr_CannotDoInCurrentContext;
    }
    const auto& transport = host->currentTransport_;
    if ((currentBeat != nullptr && !transport.hasProjectTimeMusic) ||
        (currentTempo != nullptr && !transport.hasTempo)) {
      return kAudioUnitErr_CannotDoInCurrentContext;
    }
    if (currentBeat != nullptr) {
      *currentBeat = transport.projectTimeMusic;
    }
    if (currentTempo != nullptr) {
      *currentTempo = transport.tempo;
    }
    return noErr;
  }

  static OSStatus musicalTimeLocationCallback(
      void* userData,
      UInt32* deltaSampleOffsetToNextBeat,
      Float32* timeSigNumerator,
      UInt32* timeSigDenominator,
      Float64* currentMeasureDownBeat) {
    auto* host = static_cast<HostedAudioUnit*>(userData);
    if (host == nullptr) {
      return kAudioUnitErr_CannotDoInCurrentContext;
    }
    const auto& transport = host->currentTransport_;
    if ((deltaSampleOffsetToNextBeat != nullptr && (!transport.hasProjectTimeMusic || !transport.hasTempo)) ||
        ((timeSigNumerator != nullptr || timeSigDenominator != nullptr) && !transport.hasTimeSignature) ||
        (currentMeasureDownBeat != nullptr && !transport.hasBarPositionMusic)) {
      return kAudioUnitErr_CannotDoInCurrentContext;
    }
    if (deltaSampleOffsetToNextBeat != nullptr) {
      *deltaSampleOffsetToNextBeat = host->samplesUntilNextBeat(transport);
    }
    if (timeSigNumerator != nullptr) {
      *timeSigNumerator = transport.timeSignatureNumerator;
    }
    if (timeSigDenominator != nullptr) {
      *timeSigDenominator = transport.timeSignatureDenominator;
    }
    if (currentMeasureDownBeat != nullptr) {
      *currentMeasureDownBeat = transport.barPositionMusic;
    }
    return noErr;
  }

  static OSStatus transportStateCallback(
      void* userData,
      Boolean* isPlaying,
      Boolean* transportStateChanged,
      Float64* currentSampleInTimeLine,
      Boolean* isCycling,
      Float64* cycleStartBeat,
      Float64* cycleEndBeat) {
    return fillTransportState(userData, isPlaying, nullptr, transportStateChanged, currentSampleInTimeLine, isCycling, cycleStartBeat, cycleEndBeat);
  }

  static OSStatus transportState2Callback(
      void* userData,
      Boolean* isPlaying,
      Boolean* isRecording,
      Boolean* transportStateChanged,
      Float64* currentSampleInTimeLine,
      Boolean* isCycling,
      Float64* cycleStartBeat,
      Float64* cycleEndBeat) {
    return fillTransportState(userData, isPlaying, isRecording, transportStateChanged, currentSampleInTimeLine, isCycling, cycleStartBeat, cycleEndBeat);
  }

  static OSStatus fillTransportState(
      void* userData,
      Boolean* isPlaying,
      Boolean* isRecording,
      Boolean* transportStateChanged,
      Float64* currentSampleInTimeLine,
      Boolean* isCycling,
      Float64* cycleStartBeat,
      Float64* cycleEndBeat) {
    auto* host = static_cast<HostedAudioUnit*>(userData);
    if (host == nullptr) {
      return kAudioUnitErr_CannotDoInCurrentContext;
    }
    const auto& transport = host->currentTransport_;
    if ((cycleStartBeat != nullptr || cycleEndBeat != nullptr) && !transport.hasCycle) {
      return kAudioUnitErr_CannotDoInCurrentContext;
    }
    if (isPlaying != nullptr) {
      *isPlaying = transport.playing ? 1 : 0;
    }
    if (isRecording != nullptr) {
      *isRecording = transport.recording ? 1 : 0;
    }
    if (transportStateChanged != nullptr) {
      *transportStateChanged = host->transportStateChanged_ ? 1 : 0;
    }
    if (currentSampleInTimeLine != nullptr) {
      *currentSampleInTimeLine = transport.samplePosition;
    }
    if (isCycling != nullptr) {
      *isCycling = (transport.loopActive && transport.hasCycle) ? 1 : 0;
    }
    if (cycleStartBeat != nullptr) {
      *cycleStartBeat = transport.cycleStartMusic;
    }
    if (cycleEndBeat != nullptr) {
      *cycleEndBeat = transport.cycleEndMusic;
    }
    return noErr;
  }

  UInt32 samplesUntilNextBeat(const HostTransportContext& transport) const {
    const auto beatFraction = transport.projectTimeMusic - std::floor(transport.projectTimeMusic);
    if (beatFraction <= 0.000000001 || !transport.hasTempo || transport.tempo <= 0.0) {
      return 0;
    }
    const auto samplesPerBeat = (60.0 / transport.tempo) * sampleRate_;
    const auto samples = std::round((1.0 - beatFraction) * samplesPerBeat);
    return static_cast<UInt32>(std::clamp<double>(
        samples,
        0.0,
        static_cast<double>(std::numeric_limits<UInt32>::max())));
  }

  void installHostCallbacks() {
    HostCallbackInfo callbacks {};
    callbacks.hostUserData = this;
    callbacks.beatAndTempoProc = &HostedAudioUnit::beatAndTempoCallback;
    callbacks.musicalTimeLocationProc = &HostedAudioUnit::musicalTimeLocationCallback;
    callbacks.transportStateProc = &HostedAudioUnit::transportStateCallback;
    callbacks.transportStateProc2 = &HostedAudioUnit::transportState2Callback;
    AudioUnitSetProperty(
        unit_,
        kAudioUnitProperty_HostCallbacks,
        kAudioUnitScope_Global,
        0,
        &callbacks,
        sizeof(callbacks));
  }

  std::uint32_t audioUnitElementCount(AudioUnitScope scope, std::uint32_t fallback) const {
    UInt32 count = 0;
    UInt32 countSize = sizeof(count);
    const auto status = AudioUnitGetProperty(
        unit_,
        kAudioUnitProperty_ElementCount,
        scope,
        0,
        &count,
        &countSize);
    if (status != noErr || count == 0) {
      return fallback;
    }
    return std::clamp<std::uint32_t>(count, 0, kMaxWorkerChannels);
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

    outputBusCount_ = audioUnitElementCount(kAudioUnitScope_Output, 1);
    outputBusActive_.assign(outputBusCount_, false);
    const auto outputFormat = streamDescription(sampleRate_, outputChannels_);
    for (std::uint32_t busIndex = 0; busIndex < outputBusCount_; ++busIndex) {
      const auto formatStatus = AudioUnitSetProperty(
          unit_,
          kAudioUnitProperty_StreamFormat,
          kAudioUnitScope_Output,
          busIndex,
          &outputFormat,
          sizeof(outputFormat));
      if (busIndex == 0) {
        checkStatus(formatStatus, "AudioUnitSetProperty output StreamFormat");
      }
      outputBusActive_[busIndex] = formatStatus == noErr;
    }

    if (inputChannels_ > 0) {
      inputBusCount_ = audioUnitElementCount(kAudioUnitScope_Input, 1);
      inputBusActive_.assign(inputBusCount_, false);
      const auto inputFormat = streamDescription(sampleRate_, inputChannels_);
      for (std::uint32_t busIndex = 0; busIndex < inputBusCount_; ++busIndex) {
        const auto formatStatus = AudioUnitSetProperty(
            unit_,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input,
            busIndex,
            &inputFormat,
            sizeof(inputFormat));

        AURenderCallbackStruct callback {};
        callback.inputProc = &HostedAudioUnit::inputCallback;
        callback.inputProcRefCon = this;
        const auto callbackStatus = AudioUnitSetProperty(
            unit_,
            kAudioUnitProperty_SetRenderCallback,
            kAudioUnitScope_Input,
            busIndex,
            &callback,
            sizeof(callback));

        if (busIndex == 0) {
          checkStatus(formatStatus, "AudioUnitSetProperty input StreamFormat");
          checkStatus(callbackStatus, "AudioUnitSetProperty input RenderCallback");
        }
        inputBusActive_[busIndex] = formatStatus == noErr && callbackStatus == noErr;
      }
    } else {
      inputBusCount_ = 0;
      inputBusActive_.clear();
    }

    installHostCallbacks();
    checkStatus(AudioUnitInitialize(unit_), "AudioUnitInitialize");
  }

  AudioUnit unit_ = nullptr;
  double sampleRate_ = 48000.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t requestedInputChannels_ = 2;
  std::uint32_t requestedOutputChannels_ = 2;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  std::uint32_t inputBusCount_ = 0;
  std::uint32_t outputBusCount_ = 0;
  std::vector<bool> inputBusActive_;
  std::vector<bool> outputBusActive_;
  std::vector<IndexedAudioBus> currentInputBuses_;
  std::uint32_t currentInputFrames_ = 0;
  HostTransportContext currentTransport_;
  double sampleTime_ = 0.0;
  bool currentTransportInitialized_ = false;
  bool transportStateChanged_ = false;
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
          int channel = 0;
          int sampleOffset = 0;
          stream >> note >> velocity >> channel >> sampleOffset;
          if (!std::isfinite(velocity)) {
            velocity = 0.0;
          }
          host.noteOn(
              static_cast<std::uint8_t>(std::clamp(note, 0, 127)),
              std::clamp(velocity, 0.0, 1.0),
              static_cast<std::uint8_t>(std::clamp(channel, 0, 15)),
              static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1))));
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "noteOff") {
          int note = 60;
          int velocity = 0;
          int channel = 0;
          int sampleOffset = 0;
          stream >> note >> velocity >> channel >> sampleOffset;
          host.noteOff(
              static_cast<std::uint8_t>(std::clamp(note, 0, 127)),
              static_cast<std::uint8_t>(std::clamp(channel, 0, 15)),
              static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1))));
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
          host.sendMidiEvents(messages);
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
          std::uint32_t parameterId = 0;
          std::uint32_t sampleOffset = 0;
          double value = 0.0;
          stream >> parameterIdText;
          stream >> valueText;
          stream >> sampleOffsetText;
          if (!parseUint32Arg(parameterIdText.c_str(), 0, 0xFFFFFFFFU, parameterId) ||
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
          const auto rendered = host.render(
              frames,
              renderSampleRate,
              std::move(channels),
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
