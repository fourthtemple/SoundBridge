#include "SoundBridge/Lv2HostWorkerSupport.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <set>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <utility>

namespace soundbridge::lv2_worker {
namespace {

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

} // namespace soundbridge::lv2_worker
