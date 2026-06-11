#include "SoundBridge/Lv2HostWorker.h"

#include "SoundBridge/ExampleInstrumentRenderer.h"
#include "SoundBridge/NativePlugin.h"

#ifndef _WIN32
#include <dlfcn.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace soundbridge {

namespace {

#ifndef _WIN32

// Minimal LV2 core ABI declarations. The full LV2 SDK is intentionally not
// required for this conservative audio/control host path.
using LV2_Handle = void*;

struct LV2_Feature {
  const char* URI;
  void* data;
};

struct LV2_Descriptor {
  const char* URI;
  LV2_Handle (*instantiate)(
      const LV2_Descriptor* descriptor,
      double sampleRate,
      const char* bundlePath,
      const LV2_Feature* const* features);
  void (*connect_port)(LV2_Handle instance, std::uint32_t port, void* dataLocation);
  void (*activate)(LV2_Handle instance);
  void (*run)(LV2_Handle instance, std::uint32_t sampleCount);
  void (*deactivate)(LV2_Handle instance);
  void (*cleanup)(LV2_Handle instance);
  const void* (*extension_data)(const char* uri);
};

using Lv2DescriptorFunction = const LV2_Descriptor* (*)(std::uint32_t index);

constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerAudioPorts = 32;
constexpr std::uint32_t kMaxWorkerPortIndex = 4096;
constexpr std::size_t kMaxWorkerPorts = 1024;
constexpr std::size_t kMaxWorkerParameters = 1024;
constexpr std::size_t kMaxWorkerParameterStringBytes = 160;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;

enum class Lv2PortDirection {
  Input,
  Output,
};

enum class Lv2PortType {
  Audio,
  Control,
};

struct Lv2Port {
  std::uint32_t index = 0;
  Lv2PortDirection direction = Lv2PortDirection::Input;
  Lv2PortType type = Lv2PortType::Control;
  std::string symbol;
  std::string name;
  float defaultValue = 0.0F;
  float minimum = 0.0F;
  float maximum = 1.0F;
  float value = 0.0F;
};

struct Lv2BundleMetadata {
  std::string pluginUri;
  std::filesystem::path binaryPath;
  std::vector<Lv2Port> ports;
};

struct DlCloser {
  void operator()(void* handle) const {
    if (handle != nullptr) {
      dlclose(handle);
    }
  }
};

float sanitizeSample(float value) {
  if (!std::isfinite(value)) {
    return 0.0F;
  }
  return std::clamp(value, -16.0F, 16.0F);
}

float sanitizeSampleText(const std::string& text) {
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

std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes) {
  if (value.size() > maxBytes) {
    value.resize(maxBytes);
  }
  return value;
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
  } else {
    return std::nullopt;
  }

  port.symbol = cappedString(parseStringAfter(block, "lv2:symbol").value_or(std::to_string(port.index)), 64);
  port.name = cappedString(parseStringAfter(block, "lv2:name").value_or(port.symbol));

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
  metadata.ports = parsePorts(ttl);
  if (metadata.ports.empty()) {
    throw std::runtime_error("LV2 plugin metadata did not expose basic audio/control ports.");
  }
  return metadata;
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

class HostedLv2Plugin {
public:
  HostedLv2Plugin(
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
    ports_ = metadata_.ports;
    classifyPorts();
    if (outputPortIndexes_.empty()) {
      throw std::runtime_error("LV2 plugin has no basic audio output ports.");
    }
    if (inputPortIndexes_.size() > kMaxWorkerAudioPorts || outputPortIndexes_.size() > kMaxWorkerAudioPorts) {
      throw std::runtime_error("LV2 plugin exceeds SoundBridge audio port limits.");
    }

    inputChannels_ = static_cast<std::uint32_t>(std::min<std::size_t>(inputPortIndexes_.size(), kMaxWorkerAudioPorts));
    outputChannels_ = static_cast<std::uint32_t>(std::min<std::size_t>(outputPortIndexes_.size(), kMaxWorkerAudioPorts));
    loadDescriptor();
    instantiate();
  }

  HostedLv2Plugin(const HostedLv2Plugin&) = delete;
  HostedLv2Plugin& operator=(const HostedLv2Plugin&) = delete;

  ~HostedLv2Plugin() {
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
      std::vector<std::vector<float>> inputChannels) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("LV2 worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    inputBuffers_.resize(inputPortIndexes_.size());
    outputBuffers_.resize(outputPortIndexes_.size());

    for (std::size_t index = 0; index < inputBuffers_.size(); ++index) {
      inputBuffers_[index].assign(frames, 0.0F);
      if (index < inputChannels.size()) {
        const auto copyFrames = std::min<std::size_t>(frames, inputChannels[index].size());
        for (std::size_t frame = 0; frame < copyFrames; ++frame) {
          inputBuffers_[index][frame] = sanitizeSample(inputChannels[index][frame]);
        }
      }
    }
    for (auto& output : outputBuffers_) {
      output.assign(frames, 0.0F);
    }

    connectPorts();
    descriptor_->run(handle_, frames);
    for (auto& channel : outputBuffers_) {
      for (auto& sample : channel) {
        sample = sanitizeSample(sample);
      }
    }
    return outputBuffers_;
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
      output << parameterInfoToJson(ports_[portIndex]);
      first = false;
      ++emitted;
    }
    output << "]}";
    return output.str();
  }

  std::string setParameter(const std::string& parameterId, double value) {
    for (const auto portIndex : inputControlPortIndexes_) {
      auto& port = ports_[portIndex];
      if (parameterIdForPort(port) != parameterId && std::to_string(port.index) != parameterId) {
        continue;
      }
      const auto normalized = std::clamp(value, 0.0, 1.0);
      const auto range = static_cast<double>(port.maximum) - static_cast<double>(port.minimum);
      port.value = static_cast<float>(std::clamp(
          static_cast<double>(port.minimum) + range * normalized,
          static_cast<double>(port.minimum),
          static_cast<double>(port.maximum)));
      return std::string("{\"parameter\":") + parameterInfoToJson(port) + "}";
    }
    throw std::runtime_error("unknown_parameter");
  }

  std::string latencyToJson() const {
    return "{\"latencySamples\":0}";
  }

  std::string tailTimeToJson() const {
    return "{\"tailSamples\":0,\"infiniteTail\":false}";
  }

  std::string layoutToJson() const {
    std::ostringstream output;
    output << "{\"requestedInputChannels\":" << requestedInputChannels_
           << ",\"requestedOutputChannels\":" << requestedOutputChannels_
           << ",\"inputChannels\":" << inputChannels_
           << ",\"outputChannels\":" << outputChannels_
           << ",\"inputBuses\":" << (inputChannels_ > 0 ? 1 : 0)
           << ",\"outputBuses\":1"
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

private:
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
      }
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
        return;
      }
    }

    throw std::runtime_error("LV2 descriptor did not match the bundle plugin URI.");
  }

  void instantiate() {
    const LV2_Feature* const features[] = {nullptr};
    auto bundlePath = bundlePath_;
    if (!bundlePath.empty() && bundlePath.back() != '/') {
      bundlePath.push_back('/');
    }
    handle_ = descriptor_->instantiate(descriptor_, sampleRate_, bundlePath.c_str(), features);
    if (handle_ == nullptr) {
      throw std::runtime_error("LV2 descriptor refused instantiation.");
    }
    inputBuffers_.assign(inputPortIndexes_.size(), std::vector<float>(1, 0.0F));
    outputBuffers_.assign(outputPortIndexes_.size(), std::vector<float>(1, 0.0F));
    connectPorts();
    if (descriptor_->activate != nullptr) {
      descriptor_->activate(handle_);
      activated_ = true;
    }
  }

  void connectPorts() {
    if (handle_ == nullptr || descriptor_ == nullptr) {
      return;
    }

    for (std::size_t channel = 0; channel < inputPortIndexes_.size(); ++channel) {
      descriptor_->connect_port(
          handle_,
          ports_[inputPortIndexes_[channel]].index,
          inputBuffers_.empty() ? nullptr : inputBuffers_[channel].data());
    }
    for (std::size_t channel = 0; channel < outputPortIndexes_.size(); ++channel) {
      descriptor_->connect_port(
          handle_,
          ports_[outputPortIndexes_[channel]].index,
          outputBuffers_.empty() ? nullptr : outputBuffers_[channel].data());
    }
    for (const auto portIndex : inputControlPortIndexes_) {
      descriptor_->connect_port(handle_, ports_[portIndex].index, &ports_[portIndex].value);
    }
    for (const auto portIndex : outputControlPortIndexes_) {
      descriptor_->connect_port(handle_, ports_[portIndex].index, &ports_[portIndex].value);
    }
  }

  std::string parameterIdForPort(const Lv2Port& port) const {
    return port.symbol.empty() ? std::to_string(port.index) : port.symbol;
  }

  double normalizedValueForPort(const Lv2Port& port) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    if (std::abs(maxValue - minValue) < 0.000001) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(port.value) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  double defaultNormalizedValueForPort(const Lv2Port& port) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    if (std::abs(maxValue - minValue) < 0.000001) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(port.defaultValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  std::string parameterInfoToJson(const Lv2Port& port) const {
    std::ostringstream output;
    output << "{\"id\":\"" << jsonEscape(parameterIdForPort(port)) << "\""
           << ",\"name\":\"" << jsonEscape(port.name.empty() ? parameterIdForPort(port) : port.name) << "\""
           << ",\"normalizedValue\":" << normalizedValueForPort(port)
           << ",\"defaultNormalizedValue\":" << defaultNormalizedValueForPort(port)
           << ",\"plainValue\":" << port.value
           << ",\"minPlain\":" << port.minimum
           << ",\"maxPlain\":" << port.maximum
           << ",\"automatable\":true"
           << ",\"stepCount\":0"
           << ",\"readOnly\":false"
           << "}";
    return output.str();
  }

  std::string bundlePath_;
  Lv2BundleMetadata metadata_;
  std::unique_ptr<void, DlCloser> module_;
  Lv2DescriptorFunction descriptorFunction_ = nullptr;
  const LV2_Descriptor* descriptor_ = nullptr;
  LV2_Handle handle_ = nullptr;
  double sampleRate_ = 48000.0;
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
  std::vector<std::vector<float>> inputBuffers_;
  std::vector<std::vector<float>> outputBuffers_;
  bool activated_ = false;
};

int runLv2HostWorkerNative(int argc, char** argv) {
  if (argc < 8) {
    std::cerr << "--host-lv2-worker requires bundle path, sample rate, max block size, input channels, output channels, and kind.\n";
    return 2;
  }

  double sampleRate = 48000.0;
  std::uint32_t maxBlockSize = 128;
  std::uint32_t inputChannels = 0;
  std::uint32_t outputChannels = 2;
  if (!parseSampleRateArg(argv[3], sampleRate) ||
      !parseUint32Arg(argv[4], 1, kMaxWorkerFrames, maxBlockSize) ||
      !parseUint32Arg(argv[5], 0, kMaxWorkerAudioPorts, inputChannels) ||
      !parseUint32Arg(argv[6], 1, kMaxWorkerAudioPorts, outputChannels)) {
    std::cout << "{\"error\":\"invalid_worker_arguments\"}" << std::endl;
    return 2;
  }

  try {
    HostedLv2Plugin host(argv[2], sampleRate, maxBlockSize, inputChannels, outputChannels);

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

        if (command == "midi") {
          std::string encodedEvents;
          stream >> encodedEvents;
          std::size_t eventCount = 0;
          if (!encodedEvents.empty() && encodedEvents != "-") {
            eventCount = 1;
            for (const auto character : encodedEvents) {
              if (character == ';') {
                ++eventCount;
              }
            }
          }
          std::cout << "{\"ok\":true,\"eventCount\":" << eventCount << "}" << std::endl;
          continue;
        }

        if (command == "parameters") {
          std::cout << host.parametersToJson() << std::endl;
          continue;
        }

        if (command == "getState") {
          std::cout << "{\"state\":\"\"}" << std::endl;
          continue;
        }

        if (command == "setState") {
          std::cout << "{\"ok\":true}" << std::endl;
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
          std::string parameterId;
          std::string valueText;
          std::string sampleOffsetText;
          double value = 0.0;
          stream >> parameterId;
          stream >> valueText;
          stream >> sampleOffsetText;
          if (parameterId.empty() || !parseDoubleArg(valueText.c_str(), 0.0, 1.0, value)) {
            std::cout << "{\"error\":\"invalid_parameter_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setParameter(parameterId, value) << std::endl;
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

bool lv2HostWorkerAvailable() {
#ifndef _WIN32
  return true;
#else
  return false;
#endif
}

std::string lv2HostWorkerStatus() {
#ifndef _WIN32
  return "Basic LV2 audio/control host worker is available; LV2 atom MIDI, state, worker, and UI extensions remain disabled.";
#else
  return "LV2 host worker is not available on this platform build.";
#endif
}

int runLv2HostWorker(int argc, char** argv) {
#ifndef _WIN32
  return runLv2HostWorkerNative(argc, argv);
#else
  (void)argc;
  (void)argv;
  std::cout << "{\"error\":\"LV2 host worker is not available on this platform build.\"}" << std::endl;
  return 3;
#endif
}

} // namespace soundbridge
