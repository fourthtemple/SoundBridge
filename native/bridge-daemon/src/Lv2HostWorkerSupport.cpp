#include "SoundBridge/Lv2HostWorkerSupport.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/NativePlugin.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <set>
#include <sstream>
#include <stdexcept>

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

bool blockContainsUri(const std::string& block, const char* prefixedName, const char* uri) {
  return block.find(prefixedName) != std::string::npos || block.find(uri) != std::string::npos;
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) {
    return {};
  }
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

std::string stripTurtleComments(const std::string& input) {
  std::string output;
  output.reserve(input.size());
  bool inString = false;
  bool inAngle = false;
  bool escaped = false;
  bool inComment = false;
  for (const char character : input) {
    if (inComment) {
      if (character == '\n' || character == '\r') {
        inComment = false;
        output.push_back(character);
      }
      continue;
    }

    if (inString) {
      output.push_back(character);
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        inString = false;
      }
      continue;
    }

    if (inAngle) {
      output.push_back(character);
      if (character == '>') {
        inAngle = false;
      }
      continue;
    }

    if (character == '<') {
      inAngle = true;
      output.push_back(character);
      continue;
    }

    if (character == '#') {
      inComment = true;
      continue;
    }
    if (character == '"') {
      inString = true;
    }
    output.push_back(character);
  }
  return output;
}

std::optional<std::string> angleValueAfter(const std::string& text, const std::string& key) {
  const auto keyPosition = text.find(key);
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto start = text.find('<', keyPosition + key.size());
  if (start == std::string::npos) {
    return std::nullopt;
  }
  const auto end = text.find('>', start + 1);
  if (end == std::string::npos || end <= start + 1) {
    return std::nullopt;
  }
  return text.substr(start + 1, end - start - 1);
}

std::optional<std::string> prefixedOrUriAngleValueAfter(
    const std::string& text,
    const std::string& prefixedKey,
    const std::string& uriKey) {
  if (auto value = angleValueAfter(text, prefixedKey)) {
    return value;
  }
  return angleValueAfter(text, uriKey);
}

std::vector<std::string> angleValuesAfter(const std::string& text, const std::string& key) {
  std::vector<std::string> values;
  std::size_t position = 0;
  while ((position = text.find(key, position)) != std::string::npos && values.size() < 64) {
    auto restPosition = position + key.size();
    while (true) {
      const auto start = text.find('<', restPosition);
      if (start == std::string::npos) {
        position = restPosition;
        break;
      }
      const auto separator = text.find_first_of(".;", restPosition);
      if (separator != std::string::npos && separator < start) {
        position = separator + 1;
        break;
      }
      const auto end = text.find('>', start + 1);
      if (end == std::string::npos) {
        position = restPosition;
        break;
      }
      values.push_back(text.substr(start + 1, end - start - 1));
      restPosition = end + 1;
      if (values.size() >= 64) {
        break;
      }
    }
  }
  return values;
}

bool predicateRequiresUri(const std::string& text, const char* predicate, const char* prefixedName, const char* uri) {
  std::size_t position = 0;
  while ((position = text.find(predicate, position)) != std::string::npos) {
    const auto end = text.find_first_of(".;", position + std::strlen(predicate));
    const auto block = text.substr(position, end == std::string::npos ? std::string::npos : end - position);
    if (blockContainsUri(block, prefixedName, uri)) {
      return true;
    }
    position = end == std::string::npos ? text.size() : end + 1;
  }
  return false;
}

bool turtleRequiresUri(const std::string& text, const char* prefixedName, const char* uri) {
  return predicateRequiresUri(text, "lv2:requiredFeature", prefixedName, uri) ||
      predicateRequiresUri(text, "opts:requiredOption", prefixedName, uri);
}

std::optional<std::string> firstPluginUri(const std::string& text) {
  const auto pluginPosition = text.find("lv2:Plugin");
  if (pluginPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto start = text.rfind('<', pluginPosition);
  if (start == std::string::npos) {
    return std::nullopt;
  }
  const auto end = text.find('>', start + 1);
  if (end == std::string::npos || end > pluginPosition) {
    return std::nullopt;
  }
  return text.substr(start + 1, end - start - 1);
}

bool pathIsWithin(const std::filesystem::path& child, const std::filesystem::path& parent) {
  auto childIt = child.begin();
  for (auto parentIt = parent.begin(); parentIt != parent.end(); ++parentIt, ++childIt) {
    if (childIt == child.end() || *childIt != *parentIt) {
      return false;
    }
  }
  return true;
}

std::filesystem::path canonicalPathOrThrow(const std::filesystem::path& path, const std::string& label) {
  std::error_code error;
  const auto canonical = std::filesystem::canonical(path, error);
  if (error) {
    throw std::runtime_error(label + " could not be resolved.");
  }
  return canonical;
}

std::filesystem::path resolveBundleLocalPath(
    const std::filesystem::path& bundlePath,
    const std::string& relativeText,
    const std::string& label) {
  const std::filesystem::path relativePath(relativeText);
  if (relativePath.empty() || relativePath.is_absolute() || relativePath.filename() != relativePath) {
    throw std::runtime_error(label + " must be a plain bundle-local file name.");
  }

  const auto canonicalBundle = canonicalPathOrThrow(bundlePath, "LV2 bundle");
  const auto candidate = bundlePath / relativePath;
  std::error_code error;
  if (!std::filesystem::is_regular_file(candidate, error) || error) {
    throw std::runtime_error(label + " was not a regular file.");
  }
  if (std::filesystem::is_symlink(std::filesystem::symlink_status(candidate, error)) || error) {
    throw std::runtime_error(label + " must not be a symlink.");
  }

  const auto canonicalCandidate = canonicalPathOrThrow(candidate, label);
  if (!pathIsWithin(canonicalCandidate, canonicalBundle)) {
    throw std::runtime_error(label + " resolved outside the LV2 bundle.");
  }
  return canonicalCandidate;
}

bool parseNumberAfter(const std::string& text, const std::string& key, double& out) {
  const auto keyPosition = text.find(key);
  if (keyPosition == std::string::npos) {
    return false;
  }
  const auto valueStart = text.find_first_of("-+0123456789.", keyPosition + key.size());
  if (valueStart == std::string::npos) {
    return false;
  }
  char* end = nullptr;
  const double value = std::strtod(text.c_str() + valueStart, &end);
  if (end == text.c_str() + valueStart || !std::isfinite(value)) {
    return false;
  }
  out = value;
  return true;
}

std::optional<std::uint32_t> parseIndexAfter(const std::string& text, const std::string& key) {
  double value = 0.0;
  if (!parseNumberAfter(text, key, value) || value < 0.0 || value > kMaxWorkerPortIndex) {
    return std::nullopt;
  }
  return static_cast<std::uint32_t>(std::floor(value));
}

std::optional<std::string> parseStringAfter(const std::string& text, const std::string& key) {
  const auto keyPosition = text.find(key);
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto start = text.find('"', keyPosition + key.size());
  if (start == std::string::npos) {
    return std::nullopt;
  }
  std::string output;
  bool escaped = false;
  for (auto index = start + 1; index < text.size(); ++index) {
    const char character = text[index];
    if (escaped) {
      output.push_back(character);
      escaped = false;
      continue;
    }
    if (character == '\\') {
      escaped = true;
      continue;
    }
    if (character == '"') {
      return output;
    }
    output.push_back(character);
  }
  return std::nullopt;
}

std::vector<std::string> extractPortBlocks(const std::string& text) {
  std::vector<std::string> blocks;
  std::size_t position = 0;
  while ((position = text.find("lv2:port", position)) != std::string::npos && blocks.size() < kMaxWorkerPorts) {
    auto scan = position + 8;
    std::size_t depth = 0;
    bool inString = false;
    bool escaped = false;
    bool capturedAny = false;
    std::string current;

    for (; scan < text.size(); ++scan) {
      const char character = text[scan];
      if (inString) {
        if (depth > 0) {
          current.push_back(character);
        }
        if (escaped) {
          escaped = false;
        } else if (character == '\\') {
          escaped = true;
        } else if (character == '"') {
          inString = false;
        }
        continue;
      }

      if (character == '"') {
        inString = true;
        if (depth > 0) {
          current.push_back(character);
        }
        continue;
      }

      if (character == '[') {
        if (depth == 0) {
          current.clear();
          capturedAny = true;
        } else {
          current.push_back(character);
        }
        ++depth;
        continue;
      }

      if (character == ']' && depth > 0) {
        --depth;
        if (depth == 0) {
          blocks.push_back(current);
          current.clear();
          if (blocks.size() >= kMaxWorkerPorts) {
            return blocks;
          }
        } else {
          current.push_back(character);
        }
        continue;
      }

      if (character == '.' && depth == 0) {
        ++scan;
        break;
      }

      if (depth > 0) {
        current.push_back(character);
      }
    }

    position = std::max(scan, position + 1);
    if (!capturedAny) {
      continue;
    }
  }
  return blocks;
}

std::optional<Lv2Port> parsePortBlock(const std::string& block) {
  const auto index = parseIndexAfter(block, "lv2:index");
  if (!index) {
    return std::nullopt;
  }

  Lv2Port port;
  port.index = *index;
  if (block.find("lv2:OutputPort") != std::string::npos) {
    port.direction = Lv2PortDirection::Output;
  } else if (block.find("lv2:InputPort") != std::string::npos) {
    port.direction = Lv2PortDirection::Input;
  } else {
    return std::nullopt;
  }

  if (block.find("lv2:AudioPort") != std::string::npos) {
    port.type = Lv2PortType::Audio;
  } else if (block.find("lv2:ControlPort") != std::string::npos) {
    port.type = Lv2PortType::Control;
    port.reportsLatency =
        blockContainsUri(block, "lv2:reportsLatency", kLv2ReportsLatencyUri) ||
        blockContainsUri(block, "lv2:latency", kLv2LatencyUri);
    port.isToggled = blockContainsUri(block, "lv2:toggled", kLv2ToggledUri);
    port.isInteger = blockContainsUri(block, "lv2:integer", kLv2IntegerUri);
    port.isEnumeration = blockContainsUri(block, "lv2:enumeration", kLv2EnumerationUri);
  } else if (block.find("atom:AtomPort") != std::string::npos || block.find("ev:EventPort") != std::string::npos) {
    port.acceptsMidi = blockContainsUri(block, "midi:MidiEvent", kLv2MidiEventUri);
    port.acceptsTimePosition = blockContainsUri(block, "time:Position", kLv2TimePositionUri);
    if (!port.acceptsMidi && !port.acceptsTimePosition) {
      return std::nullopt;
    }
    port.type = Lv2PortType::Midi;
  } else {
    return std::nullopt;
  }

  port.symbol = cappedString(parseStringAfter(block, "lv2:symbol").value_or(std::to_string(port.index)), 64);
  port.name = cappedString(parseStringAfter(block, "lv2:name").value_or(port.symbol));
  port.groupUri = cappedString(
      prefixedOrUriAngleValueAfter(block, "pg:group", kLv2PortGroupsGroupUri).value_or(""),
      kMaxWorkerUriBytes);

  double minimum = 0.0;
  double maximum = 1.0;
  double defaultValue = 0.0;
  parseNumberAfter(block, "lv2:minimum", minimum);
  parseNumberAfter(block, "lv2:maximum", maximum);
  if (maximum < minimum) {
    std::swap(maximum, minimum);
  }
  if (!parseNumberAfter(block, "lv2:default", defaultValue)) {
    defaultValue = minimum;
  }
  port.minimum = static_cast<float>(std::clamp(minimum, -1.0e9, 1.0e9));
  port.maximum = static_cast<float>(std::clamp(maximum, -1.0e9, 1.0e9));
  port.defaultValue = static_cast<float>(std::clamp(defaultValue, minimum, maximum));
  port.value = port.defaultValue;
  return port;
}

std::vector<Lv2Port> parsePorts(const std::string& text) {
  std::vector<Lv2Port> ports;
  std::set<std::uint32_t> seenIndexes;
  for (const auto& block : extractPortBlocks(text)) {
    auto port = parsePortBlock(block);
    if (!port || seenIndexes.count(port->index) > 0) {
      continue;
    }
    ports.push_back(*port);
    seenIndexes.insert(port->index);
    if (ports.size() >= kMaxWorkerPorts) {
      break;
    }
  }
  std::sort(ports.begin(), ports.end(), [](const auto& left, const auto& right) {
    return left.index < right.index;
  });
  return ports;
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

std::uint32_t boundedLatencySamples(double value) {
  if (!std::isfinite(value) || value <= 0.0) {
    return 0;
  }
  return static_cast<std::uint32_t>(
      std::clamp(std::llround(value), 0LL, static_cast<long long>(kMaxWorkerLatencySamples)));
}

std::string parameterIdForPort(const Lv2Port& port) {
  return port.symbol.empty() ? std::to_string(port.index) : port.symbol;
}

float plainValueForPort(const Lv2Port& port, double normalizedValue) {
  const auto range = static_cast<double>(port.maximum) - static_cast<double>(port.minimum);
  return quantizedPlainValueForPort(
      port,
      static_cast<double>(port.minimum) + range * std::clamp(normalizedValue, 0.0, 1.0),
      normalizedValue);
}

double normalizedValueForPort(const Lv2Port& port, float plainValue) {
  const auto minValue = static_cast<double>(port.minimum);
  const auto maxValue = static_cast<double>(port.maximum);
  if (std::abs(maxValue - minValue) < 0.000001) {
    return 0.0;
  }
  return std::clamp((static_cast<double>(plainValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
}

double defaultNormalizedValueForPort(const Lv2Port& port) {
  return normalizedValueForPort(port, quantizedPlainValueForPort(port, port.defaultValue, defaultNormalizedHint(port)));
}

float quantizedPlainValueForPort(const Lv2Port& port, double plainValue, double normalizedHint) {
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

double defaultNormalizedHint(const Lv2Port& port) {
  const auto minValue = static_cast<double>(port.minimum);
  const auto maxValue = static_cast<double>(port.maximum);
  if (std::abs(maxValue - minValue) < 0.000001) {
    return 0.0;
  }
  return std::clamp((static_cast<double>(port.defaultValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
}

std::uint32_t stepCountForPort(const Lv2Port& port) {
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

std::string parameterInfoToJson(const Lv2Port& port, float plainValue) {
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

Lv2BundleMetadata loadBundleMetadata(const std::filesystem::path& bundlePath) {
  std::error_code error;
  if (!std::filesystem::is_directory(bundlePath, error) || error) {
    throw std::runtime_error("LV2 bundle path is not a directory.");
  }

  const auto manifest = stripTurtleComments(readTextFile(bundlePath / "manifest.ttl"));
  if (manifest.empty() || manifest.find("lv2:Plugin") == std::string::npos) {
    throw std::runtime_error("LV2 manifest did not declare a plugin.");
  }

  Lv2BundleMetadata metadata;
  metadata.pluginUri = firstPluginUri(manifest).value_or("");
  const auto binary = angleValueAfter(manifest, "lv2:binary");
  if (!binary) {
    throw std::runtime_error("LV2 manifest did not declare lv2:binary.");
  }
  metadata.binaryPath = resolveBundleLocalPath(bundlePath, *binary, "LV2 binary");

  std::string ttl = manifest;
  for (const auto& seeAlso : angleValuesAfter(manifest, "rdfs:seeAlso")) {
    try {
      ttl += "\n";
      ttl += stripTurtleComments(readTextFile(resolveBundleLocalPath(bundlePath, seeAlso, "LV2 metadata file")));
    } catch (const std::exception&) {
      // Broken optional metadata should not redirect the loader outside the
      // bundle, but the manifest itself may still contain enough port data.
    }
  }
  if (metadata.pluginUri.empty()) {
    metadata.pluginUri = firstPluginUri(ttl).value_or("");
  }
  metadata.mainInputGroupUri = cappedString(
      prefixedOrUriAngleValueAfter(ttl, "pg:mainInput", kLv2PortGroupsMainInputUri).value_or(""),
      kMaxWorkerUriBytes);
  metadata.mainOutputGroupUri = cappedString(
      prefixedOrUriAngleValueAfter(ttl, "pg:mainOutput", kLv2PortGroupsMainOutputUri).value_or(""),
      kMaxWorkerUriBytes);
  metadata.requiresFixedBlockLength = turtleRequiresUri(ttl, "buf-size:fixedBlockLength", kLv2BufSizeFixedBlockLengthUri);
  metadata.requiresPowerOf2BlockLength = turtleRequiresUri(ttl, "buf-size:powerOf2BlockLength", kLv2BufSizePowerOf2BlockLengthUri);
  metadata.ports = parsePorts(ttl);
  if (metadata.ports.empty()) {
    throw std::runtime_error("LV2 plugin metadata did not expose basic audio/control ports.");
  }
  return metadata;
}

bool isPowerOfTwoLv2BlockSize(std::uint32_t value) {
  return value > 0 && (value & (value - 1U)) == 0;
}

bool lv2MetadataHasRestrictedBlockProfile(const Lv2BundleMetadata& metadata) {
  return metadata.requiresFixedBlockLength || metadata.requiresPowerOf2BlockLength;
}

bool lv2MetadataAcceptsRenderBlockSize(
    const Lv2BundleMetadata& metadata,
    std::uint32_t maxBlockSize,
    std::uint32_t frames) {
  if (frames == 0 || frames > maxBlockSize) {
    return false;
  }
  if (metadata.requiresFixedBlockLength && frames != maxBlockSize) {
    return false;
  }
  if (metadata.requiresPowerOf2BlockLength && !isPowerOfTwoLv2BlockSize(frames)) {
    return false;
  }
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
