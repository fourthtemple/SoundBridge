#include "SoundBridge/AudioUnitScanner.h"

#ifdef SOUNDBRIDGE_MACOS
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>

namespace soundbridge {

namespace {

std::filesystem::path homeLibraryAudioUnitPath() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || std::string(home).empty()) {
    return {};
  }
  return std::filesystem::path(home) / "Library" / "Audio" / "Plug-Ins" / "Components";
}

std::filesystem::path repositoryExampleAudioUnitPath() {
#ifdef SOUNDBRIDGE_SOURCE_DIR
  return std::filesystem::path(SOUNDBRIDGE_SOURCE_DIR) / "native" / "example-plugins" / "Components";
#else
  return {};
#endif
}

std::string componentNameFromPath(const std::filesystem::path& path) {
  auto name = path.stem().string();
  return name.empty() ? path.filename().string() : name;
}

std::string normalizeComparableName(std::string value) {
  value.erase(
      std::remove_if(
          value.begin(),
          value.end(),
          [](unsigned char character) {
            return !std::isalnum(character);
          }),
      value.end());
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) {
    return {};
  }
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

std::optional<std::string> manifestStringValue(const std::string& manifest, const std::string& key) {
  const auto keyPosition = manifest.find("\"" + key + "\"");
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto colonPosition = manifest.find(':', keyPosition);
  if (colonPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto quoteStart = manifest.find('"', colonPosition + 1);
  if (quoteStart == std::string::npos) {
    return std::nullopt;
  }
  const auto quoteEnd = manifest.find('"', quoteStart + 1);
  if (quoteEnd == std::string::npos) {
    return std::nullopt;
  }
  return manifest.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
}

std::optional<std::uint32_t> manifestIntValue(const std::string& manifest, const std::string& key) {
  const auto keyPosition = manifest.find("\"" + key + "\"");
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto colonPosition = manifest.find(':', keyPosition);
  if (colonPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto valueStart = manifest.find_first_of("0123456789", colonPosition + 1);
  if (valueStart == std::string::npos) {
    return std::nullopt;
  }
  const auto valueEnd = manifest.find_first_not_of("0123456789", valueStart);
  const auto text = manifest.substr(valueStart, valueEnd - valueStart);
  char* end = nullptr;
  errno = 0;
  const auto value = std::strtoul(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0' || errno == ERANGE || value > 32) {
    return std::nullopt;
  }
  return static_cast<std::uint32_t>(value);
}

void applySoundBridgeManifest(NativePluginInfo& info, const std::filesystem::path& bundlePath) {
  const auto manifestPath = bundlePath / "Contents" / "Resources" / "SoundBridgePlugin.json";
  const auto manifest = readTextFile(manifestPath);
  if (manifest.empty()) {
    return;
  }

  if (auto value = manifestStringValue(manifest, "pluginId")) {
    info.pluginId = *value;
  }
  if (auto value = manifestStringValue(manifest, "name")) {
    info.name = *value;
  }
  if (auto value = manifestStringValue(manifest, "vendor")) {
    info.vendor = *value;
  }
  if (auto value = manifestStringValue(manifest, "category")) {
    info.category = *value;
  }
  if (auto value = manifestStringValue(manifest, "kind")) {
    info.kind = *value;
  }
  if (auto value = manifestStringValue(manifest, "source")) {
    info.source = *value;
  }
  if (auto value = manifestIntValue(manifest, "inputs")) {
    info.inputs = *value;
  }
  if (auto value = manifestIntValue(manifest, "outputs")) {
    info.outputs = *value;
  }
  info.isExample = info.source == "example-bundle";
  info.hasManifest = true;
}

std::filesystem::path macBinaryPath(const std::filesystem::path& bundlePath) {
  const auto macosPath = bundlePath / "Contents" / "MacOS";
  std::error_code error;
  if (!std::filesystem::is_directory(macosPath, error)) {
    return {};
  }

  for (const auto& entry : std::filesystem::directory_iterator(macosPath, error)) {
    if (error) {
      return {};
    }
    if (entry.is_regular_file(error) && !error) {
      return entry.path();
    }
  }

  return {};
}

#ifdef SOUNDBRIDGE_MACOS
std::string fourCharCodeToString(OSType value) {
  std::string text(4, ' ');
  text[0] = static_cast<char>((value >> 24) & 0xFF);
  text[1] = static_cast<char>((value >> 16) & 0xFF);
  text[2] = static_cast<char>((value >> 8) & 0xFF);
  text[3] = static_cast<char>(value & 0xFF);
  return text;
}

std::string safeFourCharCode(OSType value) {
  auto text = fourCharCodeToString(value);
  for (auto& character : text) {
    if (!std::isalnum(static_cast<unsigned char>(character))) {
      character = '_';
    }
  }
  return text;
}

std::string cfStringToUtf8(CFStringRef value) {
  if (value == nullptr) {
    return {};
  }

  char buffer[1024] = {};
  if (CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
    return buffer;
  }

  const auto length = CFStringGetLength(value);
  const auto maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string output(static_cast<std::size_t>(maxSize), '\0');
  if (!CFStringGetCString(value, output.data(), maxSize, kCFStringEncodingUTF8)) {
    return {};
  }
  output.resize(std::char_traits<char>::length(output.c_str()));
  return output;
}

std::string audioUnitKind(OSType componentType) {
  switch (componentType) {
    case kAudioUnitType_MusicDevice:
    case kAudioUnitType_Generator:
      return "instrument";
    case kAudioUnitType_MusicEffect:
      return "midi-effect";
    case kAudioUnitType_Effect:
    case kAudioUnitType_FormatConverter:
    case kAudioUnitType_Mixer:
    case kAudioUnitType_Panner:
    case kAudioUnitType_OfflineEffect:
      return "effect";
    default:
      return "unknown";
  }
}

std::string audioUnitCategory(OSType componentType) {
  switch (componentType) {
    case kAudioUnitType_Effect:
      return "AudioUnit|Effect";
    case kAudioUnitType_MusicDevice:
      return "AudioUnit|Instrument";
    case kAudioUnitType_MusicEffect:
      return "AudioUnit|MusicEffect";
    case kAudioUnitType_Generator:
      return "AudioUnit|Generator";
    case kAudioUnitType_FormatConverter:
      return "AudioUnit|FormatConverter";
    case kAudioUnitType_Mixer:
      return "AudioUnit|Mixer";
    case kAudioUnitType_Panner:
      return "AudioUnit|Panner";
    case kAudioUnitType_OfflineEffect:
      return "AudioUnit|OfflineEffect";
    default:
      return "AudioUnit";
  }
}

bool isHostRelevantAudioUnitType(OSType componentType) {
  switch (componentType) {
    case kAudioUnitType_Effect:
    case kAudioUnitType_MusicDevice:
    case kAudioUnitType_MusicEffect:
    case kAudioUnitType_Generator:
    case kAudioUnitType_FormatConverter:
    case kAudioUnitType_Mixer:
    case kAudioUnitType_Panner:
    case kAudioUnitType_OfflineEffect:
      return true;
    default:
      return false;
  }
}

NativePluginInfo infoFromAudioComponent(AudioComponent component, const AudioComponentDescription& description) {
  CFStringRef componentName = nullptr;
  AudioComponentCopyName(component, &componentName);
  auto fullName = cfStringToUtf8(componentName);
  if (componentName != nullptr) {
    CFRelease(componentName);
  }

  std::string vendor = fourCharCodeToString(description.componentManufacturer);
  std::string name = fullName.empty() ? "Audio Unit" : fullName;
  const auto separator = fullName.find(':');
  if (separator != std::string::npos) {
    vendor = fullName.substr(0, separator);
    name = fullName.substr(separator + 1);
    while (!name.empty() && std::isspace(static_cast<unsigned char>(name.front()))) {
      name.erase(name.begin());
    }
  }

  NativePluginInfo info;
  info.pluginId = "au-reg:" +
      safeFourCharCode(description.componentManufacturer) + ":" +
      safeFourCharCode(description.componentType) + ":" +
      safeFourCharCode(description.componentSubType);
  info.format = PluginFormat::AudioUnit;
  info.name = name;
  info.vendor = vendor.empty() ? "Unknown" : vendor;
  info.category = audioUnitCategory(description.componentType);
  info.kind = audioUnitKind(description.componentType);
  info.source = "scan";
  info.componentType = fourCharCodeToString(description.componentType);
  info.componentSubType = fourCharCodeToString(description.componentSubType);
  info.componentManufacturer = fourCharCodeToString(description.componentManufacturer);
  info.isRegistry = true;
  return info;
}

void mergeAudioComponentRegistryMetadata(std::vector<NativePluginInfo>& plugins) {
  AudioComponentDescription query {};
  AudioComponent component = nullptr;
  while ((component = AudioComponentFindNext(component, &query)) != nullptr) {
    AudioComponentDescription description {};
    AudioComponentGetDescription(component, &description);
    if (!isHostRelevantAudioUnitType(description.componentType)) {
      continue;
    }

    NativePluginInfo registryInfo = infoFromAudioComponent(component, description);
    const auto registryComparableName = normalizeComparableName(registryInfo.name);
    const auto registryFullComparableName = normalizeComparableName(registryInfo.vendor + registryInfo.name);
    auto existing = std::find_if(plugins.begin(), plugins.end(), [&](const NativePluginInfo& plugin) {
      if (plugin.format != PluginFormat::AudioUnit || plugin.isExample) {
        return false;
      }
      const auto pluginComparableName = normalizeComparableName(plugin.name);
      return pluginComparableName == registryComparableName ||
          pluginComparableName == registryFullComparableName ||
          registryFullComparableName.find(pluginComparableName) != std::string::npos;
    });

    if (existing != plugins.end()) {
      existing->vendor = registryInfo.vendor;
      existing->category = registryInfo.category;
      existing->kind = registryInfo.kind;
      existing->componentType = registryInfo.componentType;
      existing->componentSubType = registryInfo.componentSubType;
      existing->componentManufacturer = registryInfo.componentManufacturer;
      existing->isRegistry = true;
      continue;
    }

    plugins.push_back(std::move(registryInfo));
  }
}
#endif

} // namespace

AudioUnitScanner::AudioUnitScanner()
    : paths_{
          repositoryExampleAudioUnitPath(),
          std::filesystem::path("/Library/Audio/Plug-Ins/Components"),
          homeLibraryAudioUnitPath(),
      } {}

std::vector<std::filesystem::path> AudioUnitScanner::searchPaths() const {
  std::vector<std::filesystem::path> paths;
  for (const auto& path : paths_) {
    if (!path.empty()) {
      paths.push_back(path);
    }
  }
  return paths;
}

std::vector<NativePluginInfo> AudioUnitScanner::scan() const {
  std::vector<NativePluginInfo> plugins;

  for (const auto& root : searchPaths()) {
    std::error_code error;
    if (!std::filesystem::is_directory(root, error)) {
      continue;
    }

    for (const auto& entry : std::filesystem::directory_iterator(root, error)) {
      if (error) {
        break;
      }

      const auto path = entry.path();
      if (path.extension() != ".component") {
        continue;
      }

      const bool isBundle = entry.is_directory(error);
      if (error || !isBundle) {
        continue;
      }

      NativePluginInfo info;
      info.pluginId = "au:" + path.filename().string();
      info.format = PluginFormat::AudioUnit;
      info.name = componentNameFromPath(path);
      info.vendor = "Unknown";
      info.category = "AudioUnit";
      info.kind = "unknown";
      info.bundlePath = std::filesystem::weakly_canonical(path, error).string();
      if (error) {
        info.bundlePath = path.string();
        error.clear();
      }
      info.hasContents = std::filesystem::is_directory(path / "Contents", error) && !error;
      auto executablePath = macBinaryPath(path);
      info.hasExecutable = !executablePath.empty();
      if (info.hasExecutable) {
        info.executablePath = std::filesystem::weakly_canonical(executablePath, error).string();
        if (error) {
          info.executablePath = executablePath.string();
          error.clear();
        }
      }
      applySoundBridgeManifest(info, path);
      plugins.push_back(std::move(info));
    }
  }

#ifdef SOUNDBRIDGE_MACOS
  mergeAudioComponentRegistryMetadata(plugins);
#endif

  return plugins;
}

} // namespace soundbridge
