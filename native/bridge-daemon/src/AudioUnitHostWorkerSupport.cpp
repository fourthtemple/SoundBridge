#include "SoundBridge/AudioUnitHostWorkerSupport.h"

#ifdef SOUNDBRIDGE_MACOS

#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <set>
#include <sstream>
#include <stdexcept>

namespace soundbridge::audio_unit_worker {
namespace {

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

} // namespace

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
  return parseDoubleArg(text, kMinWorkerSampleRate, kMaxWorkerSampleRate, out);
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

std::string cappedString(std::string value, std::size_t maxBytes) {
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

bool parseAudioBuses(
    const std::string& encoded,
    std::uint32_t frames,
    std::vector<IndexedAudioBus>& buses) {
  buses.clear();
  if (encoded.empty() || encoded == "-") {
    return true;
  }

  std::stringstream stream(encoded);
  std::string token;
  std::set<std::uint32_t> seenIndexes;
  while (std::getline(stream, token, ';')) {
    if (token.empty()) {
      return false;
    }
    if (seenIndexes.size() >= kMaxWorkerChannels) {
      return false;
    }
    const auto separator = token.find('=');
    if (separator == std::string::npos) {
      return false;
    }
    std::uint32_t index = 0;
    if (!parseUint32Arg(token.substr(0, separator).c_str(), 0, kMaxWorkerChannels - 1, index)) {
      return false;
    }
    if (!seenIndexes.insert(index).second) {
      return false;
    }
    buses.push_back(IndexedAudioBus{
        index,
        parseChannels(token.substr(separator + 1), frames)});
  }
  return true;
}

const std::vector<std::vector<float>>* findBusChannels(const std::vector<IndexedAudioBus>& buses, std::uint32_t index) {
  for (const auto& bus : buses) {
    if (bus.index == index) {
      return &bus.channels;
    }
  }
  return nullptr;
}

std::string audioChannelsToJson(const std::vector<std::vector<float>>& channels) {
  std::ostringstream output;
  output << "[";
  for (std::size_t channelIndex = 0; channelIndex < channels.size(); ++channelIndex) {
    if (channelIndex > 0) {
      output << ",";
    }
    output << "[";
    for (std::size_t frame = 0; frame < channels[channelIndex].size(); ++frame) {
      if (frame > 0) {
        output << ",";
      }
      const float sample = channels[channelIndex][frame];
      output << (std::isfinite(sample) ? sample : 0.0F);
    }
    output << "]";
  }
  output << "]";
  return output.str();
}

std::string renderedAudioToJson(const RenderedAudio& rendered) {
  const auto channelsJson = audioChannelsToJson(rendered.channels);
  std::ostringstream output;
  output << "{\"channels\":" << channelsJson << ",\"outputBuses\":[";
  if (rendered.outputBuses.empty()) {
    output << "{\"index\":0,\"channels\":" << channelsJson << "}";
  } else {
    for (std::size_t busIndex = 0; busIndex < rendered.outputBuses.size(); ++busIndex) {
      if (busIndex > 0) {
        output << ",";
      }
      output << "{\"index\":" << rendered.outputBuses[busIndex].index
             << ",\"channels\":" << audioChannelsToJson(rendered.outputBuses[busIndex].channels)
             << "}";
    }
  }
  output << "]}";
  return output.str();
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

} // namespace soundbridge::audio_unit_worker

#endif
