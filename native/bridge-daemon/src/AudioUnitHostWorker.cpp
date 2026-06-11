#include "SoundBridge/AudioUnitHostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/ExampleInstrumentRenderer.h"
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

struct PendingMidiMessage {
  UInt32 status = 0x90;
  UInt32 data1 = 60;
  UInt32 data2 = 100;
  std::uint32_t sampleOffset = 0;
};

struct HostTransportContext {
  bool playing = false;
  bool recording = false;
  bool loopActive = false;
  bool hasTempo = false;
  double tempo = 120.0;
  bool hasTimeSignature = false;
  Float32 timeSignatureNumerator = 4.0F;
  UInt32 timeSignatureDenominator = 4;
  bool hasProjectTimeMusic = false;
  Float64 projectTimeMusic = 0.0;
  bool hasBarPositionMusic = false;
  Float64 barPositionMusic = 0.0;
  bool hasCycle = false;
  Float64 cycleStartMusic = 0.0;
  Float64 cycleEndMusic = 0.0;
  Float64 samplePosition = 0.0;
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

bool parseTransportSamplePosition(const std::string& text, Float64& out) {
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
  out = static_cast<Float64>(value);
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
  out.samplePosition = static_cast<Float64>(std::max(0.0, fallbackSampleTime));
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
      out.timeSignatureNumerator = static_cast<Float32>(parsed);
      sawNumerator = true;
    } else if (key == "den") {
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed) || !isPowerOfTwo(parsed)) {
        return false;
      }
      out.timeSignatureDenominator = static_cast<UInt32>(parsed);
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

UInt32 scaled7Bit(double value) {
  return static_cast<UInt32>(std::clamp(std::lround(std::clamp(value, 0.0, 1.0) * 127.0), 0L, 127L));
}

bool parseMidiEventToken(const std::string& token, PendingMidiMessage& message) {
  std::vector<std::string> parts;
  std::stringstream stream(token);
  std::string part;
  while (std::getline(stream, part, ':')) {
    parts.push_back(part);
  }
  if (parts.empty()) {
    return false;
  }

  auto parseChannelAndOffset = [&](std::size_t channelIndex, std::size_t offsetIndex, std::uint32_t& channel, std::uint32_t& offset) -> bool {
    return parseUint32Arg(parts[channelIndex].c_str(), 0, 15, channel) &&
        parseUint32Arg(parts[offsetIndex].c_str(), 0, kMaxWorkerFrames - 1, offset);
  };

  if (parts[0] == "on" || parts[0] == "off" || parts[0] == "poly") {
    if (parts.size() != 5) {
      return false;
    }
    std::uint32_t note = 60;
    std::uint32_t channel = 0;
    std::uint32_t offset = 0;
    double value = parts[0] == "off" ? 0.0 : 0.8;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, note) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4, channel, offset)) {
      return false;
    }
    message.status = (parts[0] == "on" ? 0x90 : parts[0] == "off" ? 0x80 : 0xA0) | channel;
    message.data1 = note;
    message.data2 = scaled7Bit(value);
    message.sampleOffset = offset;
    return true;
  }

  if (parts[0] == "cc") {
    if (parts.size() != 5) {
      return false;
    }
    std::uint32_t controller = 0;
    std::uint32_t channel = 0;
    std::uint32_t offset = 0;
    double value = 0.0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, controller) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4, channel, offset)) {
      return false;
    }
    message.status = 0xB0 | channel;
    message.data1 = controller;
    message.data2 = scaled7Bit(value);
    message.sampleOffset = offset;
    return true;
  }

  if (parts[0] == "bend") {
    if (parts.size() != 4) {
      return false;
    }
    std::uint32_t channel = 0;
    std::uint32_t offset = 0;
    double value = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), -1.0, 1.0, value) ||
        !parseChannelAndOffset(2, 3, channel, offset)) {
      return false;
    }
    const auto bend = static_cast<UInt32>(
        std::clamp(std::lround(((std::clamp(value, -1.0, 1.0) + 1.0) / 2.0) * 16383.0), 0L, 16383L));
    message.status = 0xE0 | channel;
    message.data1 = bend & 0x7F;
    message.data2 = (bend >> 7) & 0x7F;
    message.sampleOffset = offset;
    return true;
  }

  if (parts[0] == "pressure") {
    if (parts.size() != 4) {
      return false;
    }
    std::uint32_t channel = 0;
    std::uint32_t offset = 0;
    double pressure = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), 0.0, 1.0, pressure) ||
        !parseChannelAndOffset(2, 3, channel, offset)) {
      return false;
    }
    message.status = 0xD0 | channel;
    message.data1 = scaled7Bit(pressure);
    message.data2 = 0;
    message.sampleOffset = offset;
    return true;
  }

  if (parts[0] == "program") {
    if (parts.size() != 4) {
      return false;
    }
    std::uint32_t program = 0;
    std::uint32_t channel = 0;
    std::uint32_t offset = 0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, program) ||
        !parseChannelAndOffset(2, 3, channel, offset)) {
      return false;
    }
    message.status = 0xC0 | channel;
    message.data1 = program;
    message.data2 = 0;
    message.sampleOffset = offset;
    return true;
  }

  return false;
}

bool parseMidiEvents(const std::string& encoded, std::vector<PendingMidiMessage>& messages) {
  messages.clear();
  if (encoded.empty() || encoded == "-") {
    return true;
  }

  std::stringstream stream(encoded);
  std::string token;
  while (std::getline(stream, token, ';')) {
    if (token.empty()) {
      continue;
    }
    if (messages.size() >= kMaxWorkerMidiEvents) {
      return false;
    }
    PendingMidiMessage message;
    if (!parseMidiEventToken(token, message)) {
      return false;
    }
    messages.push_back(message);
  }
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
           << ",\"inputBuses\":" << (inputChannels_ > 0 ? 1 : 0)
           << ",\"outputBuses\":1"
           << ",\"inputBusLayouts\":" << mainBusLayoutToJson("input", inputChannels_, inputChannels_ > 0)
           << ",\"outputBusLayouts\":" << mainBusLayoutToJson("output", outputChannels_, true)
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

  std::vector<std::vector<float>> render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels,
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
    currentInput_ = std::move(inputChannels);
    currentInputFrames_ = frames;
    for (auto& channel : currentInput_) {
      channel.resize(frames, 0.0F);
    }

    std::vector<std::vector<float>> outputChannels;
    auto outputList = makeAudioBufferList(outputChannels, outputChannels_, frames);

    AudioTimeStamp timeStamp {};
    timeStamp.mFlags = kAudioTimeStampSampleTimeValid;
    timeStamp.mSampleTime = currentTransport_.samplePosition;
    AudioUnitRenderActionFlags flags = 0;
    checkStatus(AudioUnitRender(unit_, &flags, &timeStamp, 0, frames, outputList.get()), "AudioUnitRender");
    sampleTime_ = currentTransport_.samplePosition + frames;
    return outputChannels;
  }

  double sampleTime() const {
    return sampleTime_;
  }

private:
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
  std::vector<std::vector<float>> currentInput_;
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
          const auto channels = host.render(frames, renderSampleRate, parseChannels(encodedChannels, frames), transport);
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
