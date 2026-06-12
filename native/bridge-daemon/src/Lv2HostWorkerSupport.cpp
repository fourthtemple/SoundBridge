#include "SoundBridge/Lv2HostWorkerSupport.h"

#include "SoundBridge/Base64.h"
#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <set>
#include <sstream>

namespace soundbridge::lv2_worker {
namespace {

float sanitizeSampleText(const std::string& text) {
  char* end = nullptr;
  const double value = std::strtod(text.c_str(), &end);
  if (end == text.c_str() || !std::isfinite(value)) {
    return 0.0F;
  }
  return static_cast<float>(std::clamp(value, -16.0, 16.0));
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

bool parseTransportSamplePosition(const std::string& text, std::int64_t& out) {
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
  out = static_cast<std::int64_t>(value);
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

  auto parseChannelAndOffset = [&](std::size_t channelIndex, std::size_t offsetIndex, std::uint32_t& channel, std::uint32_t& sampleOffset) -> bool {
    return parseUint32Arg(parts[channelIndex].c_str(), 0, 15, channel) &&
        parseUint32Arg(parts[offsetIndex].c_str(), 0, kMaxWorkerFrames - 1, sampleOffset);
  };

  if (parts[0] == "on" || parts[0] == "off" || parts[0] == "poly") {
    std::uint32_t note = 0;
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    double value = 0.0;
    if (parts.size() != 5 ||
        !parseUint32Arg(parts[1].c_str(), 0, 127, note) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4, channel, sampleOffset)) {
      return false;
    }
    message.status = static_cast<std::uint8_t>((parts[0] == "on" ? 0x90 : parts[0] == "off" ? 0x80 : 0xA0) | channel);
    message.data1 = static_cast<std::uint8_t>(note);
    message.data2 = scaled7Bit(value);
    message.sampleOffset = sampleOffset;
    return true;
  }
  if (parts[0] == "cc") {
    std::uint32_t controller = 0;
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    double value = 0.0;
    if (parts.size() != 5 ||
        !parseUint32Arg(parts[1].c_str(), 0, 127, controller) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4, channel, sampleOffset)) {
      return false;
    }
    message.status = static_cast<std::uint8_t>(0xB0 | channel);
    message.data1 = static_cast<std::uint8_t>(controller);
    message.data2 = scaled7Bit(value);
    message.sampleOffset = sampleOffset;
    return true;
  }
  if (parts[0] == "bend") {
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    double value = 0.0;
    if (parts.size() != 4 ||
        !parseDoubleArg(parts[1].c_str(), -1.0, 1.0, value) ||
        !parseChannelAndOffset(2, 3, channel, sampleOffset)) {
      return false;
    }
    const auto bend = static_cast<std::uint32_t>(
        std::clamp(std::lround(((std::clamp(value, -1.0, 1.0) + 1.0) / 2.0) * 16383.0), 0L, 16383L));
    message.status = static_cast<std::uint8_t>(0xE0 | channel);
    message.data1 = static_cast<std::uint8_t>(bend & 0x7F);
    message.data2 = static_cast<std::uint8_t>((bend >> 7) & 0x7F);
    message.sampleOffset = sampleOffset;
    return true;
  }
  if (parts[0] == "pressure") {
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    double pressure = 0.0;
    if (parts.size() != 4 ||
        !parseDoubleArg(parts[1].c_str(), 0.0, 1.0, pressure) ||
        !parseChannelAndOffset(2, 3, channel, sampleOffset)) {
      return false;
    }
    message.status = static_cast<std::uint8_t>(0xD0 | channel);
    message.data1 = scaled7Bit(pressure);
    message.data2 = 0;
    message.sampleOffset = sampleOffset;
    return true;
  }
  if (parts[0] == "program") {
    std::uint32_t program = 0;
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    if (parts.size() != 4 ||
        !parseUint32Arg(parts[1].c_str(), 0, 127, program) ||
        !parseChannelAndOffset(2, 3, channel, sampleOffset)) {
      return false;
    }
    message.status = static_cast<std::uint8_t>(0xC0 | channel);
    message.data1 = static_cast<std::uint8_t>(program);
    message.data2 = 0;
    message.sampleOffset = sampleOffset;
    return true;
  }
  return false;
}

} // namespace

float sanitizeSample(float value) {
  if (!std::isfinite(value)) {
    return 0.0F;
  }
  return std::clamp(value, -16.0F, 16.0F);
}

float sanitizeStateValue(float value) {
  if (!std::isfinite(value)) {
    return 0.0F;
  }
  return std::clamp(value, -1.0e9F, 1.0e9F);
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

bool parseStateValue(const std::string& text, double& out) {
  return parseDoubleArg(text.c_str(), -1.0e9, 1.0e9, out);
}

bool parseSampleRateArg(const char* text, double& out) {
  return parseDoubleArg(text, kMinWorkerSampleRate, kMaxWorkerSampleRate, out);
}

bool parseTransportContext(
    const std::string& encoded,
    double fallbackSampleTime,
    HostTransportContext& out) {
  out = HostTransportContext {};
  out.samplePosition = static_cast<std::int64_t>(std::clamp(
      fallbackSampleTime,
      0.0,
      static_cast<double>(kMaxWorkerTransportSamplePosition)));
  if (encoded.empty() || encoded == "-") {
    return true;
  }
  out.explicitTransport = true;

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
      if (!parseUint32Arg(value.c_str(), 1, 64, out.timeSignatureNumerator)) {
        return false;
      }
      sawNumerator = true;
    } else if (key == "den") {
      if (!parseUint32Arg(value.c_str(), 1, 64, out.timeSignatureDenominator) ||
          !isPowerOfTwo(out.timeSignatureDenominator)) {
        return false;
      }
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

std::uint8_t scaled7Bit(double value) {
  return static_cast<std::uint8_t>(std::clamp(std::lround(std::clamp(value, 0.0, 1.0) * 127.0), 0L, 127L));
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

std::size_t alignAtomSize(std::size_t size) {
  return (size + 7U) & ~std::size_t(7U);
}

std::string stateStringToBase64(const std::string& value) {
  return base64Encode(reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
}

bool isPortablePodState(std::uint32_t flags) {
  return (flags & kLv2StateIsPod) != 0 &&
      (flags & kLv2StateIsPortable) != 0 &&
      (flags & kLv2StateIsNative) == 0;
}

bool isValidStateUri(const std::string& value) {
  if (value.empty() || value.size() > kMaxWorkerUriBytes) {
    return false;
  }
  return std::none_of(value.begin(), value.end(), [](unsigned char character) {
    return character == '\0' || character <= 0x20 || character == 0x7F;
  });
}

std::string base64ToStateString(const std::string& encoded, std::size_t maxBytes) {
  const auto decoded = base64Decode(encoded, maxBytes);
  return std::string(decoded.begin(), decoded.end());
}

std::string cappedString(std::string value, std::size_t maxBytes) {
  if (value.size() > maxBytes) {
    value.resize(maxBytes);
  }
  return value;
}

std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames) {
  frames = std::clamp<std::uint32_t>(frames, 1, kMaxWorkerFrames);
  if (encoded.empty() || encoded == "-") {
    return {};
  }

  std::vector<std::vector<float>> channels;
  std::stringstream channelStream(encoded);
  std::string channelText;
  while (channels.size() < kMaxWorkerAudioPorts && std::getline(channelStream, channelText, '|')) {
    std::vector<float> channel;
    channel.reserve(frames);
    std::stringstream sampleStream(channelText);
    std::string sampleText;
    while (channel.size() < frames && std::getline(sampleStream, sampleText, ',')) {
      if (sampleText.empty()) {
        channel.push_back(0.0F);
        continue;
      }
      channel.push_back(sanitizeSampleText(sampleText));
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
    if (seenIndexes.size() >= kMaxWorkerAudioPorts) {
      return false;
    }
    const auto separator = token.find('=');
    if (separator == std::string::npos) {
      return false;
    }
    std::uint32_t index = 0;
    if (!parseUint32Arg(token.substr(0, separator).c_str(), 0, kMaxWorkerAudioPorts - 1, index)) {
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

std::string lv2OutputBusBlockToJson(const std::vector<std::vector<float>>& channels) {
  const auto channelsJson = audioChannelsToJson(channels);
  std::ostringstream output;
  output << "{\"channels\":" << channelsJson
         << ",\"outputBuses\":[{\"index\":0,\"channels\":" << channelsJson << "}";
  const auto outputBusCount = std::min<std::size_t>(channels.size() + 1, kMaxWorkerAudioPorts);
  for (std::size_t busIndex = 1; busIndex < outputBusCount; ++busIndex) {
    output << ",{\"index\":" << busIndex
           << ",\"channels\":" << audioChannelsToJson({channels[busIndex - 1]}) << "}";
  }
  output << "]}";
  return output.str();
}

} // namespace soundbridge::lv2_worker
