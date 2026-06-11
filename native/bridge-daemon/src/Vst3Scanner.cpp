#include "SoundBridge/Vst3Scanner.h"

#ifdef SOUNDBRIDGE_MACOS
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <optional>

namespace soundbridge {

namespace {

std::filesystem::path homeLibraryVst3Path() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || std::string(home).empty()) {
    return {};
  }
  return std::filesystem::path(home) / "Library" / "Audio" / "Plug-Ins" / "VST3";
}

std::filesystem::path repositoryExampleVst3Path() {
#ifdef SOUNDBRIDGE_SOURCE_DIR
  return std::filesystem::path(SOUNDBRIDGE_SOURCE_DIR) / "native" / "example-plugins" / "VST3";
#else
  return {};
#endif
}

std::string bundleNameFromPath(const std::filesystem::path& path) {
  auto name = path.stem().string();
  return name.empty() ? path.filename().string() : name;
}

std::string trim(std::string value) {
  value.erase(
      value.begin(),
      std::find_if(value.begin(), value.end(), [](unsigned char character) {
        return !std::isspace(character);
      }));
  value.erase(
      std::find_if(value.rbegin(), value.rend(), [](unsigned char character) {
        return !std::isspace(character);
      }).base(),
      value.end());
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

std::string dictionaryStringValue(CFDictionaryRef dictionary, CFStringRef key) {
  const auto value = CFDictionaryGetValue(dictionary, key);
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) {
    return {};
  }
  return cfStringToUtf8(static_cast<CFStringRef>(value));
}

std::string vendorFromCopyright(std::string copyright) {
  copyright = trim(std::move(copyright));
  if (copyright.empty()) {
    return {};
  }

  const auto copyrightPosition = copyright.find("Copyright");
  if (copyrightPosition != std::string::npos) {
    copyright.erase(copyrightPosition, std::string("Copyright").size());
  }
  copyright.erase(
      std::remove_if(
          copyright.begin(),
          copyright.end(),
          [](unsigned char character) {
            return character == 0xC2 || character == 0xA9;
          }),
      copyright.end());
  return trim(copyright);
}

std::string capitalizeVendorToken(std::string value) {
  value = trim(std::move(value));
  if (value.empty()) {
    return {};
  }
  value[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(value[0])));
  return value;
}

std::string vendorFromBundleIdentifier(const std::string& identifier) {
  const std::string prefix = "com.";
  if (identifier.rfind(prefix, 0) != 0) {
    return {};
  }

  const auto vendorStart = prefix.size();
  const auto vendorEnd = identifier.find('.', vendorStart);
  if (vendorEnd == std::string::npos || vendorEnd <= vendorStart) {
    return {};
  }

  return capitalizeVendorToken(identifier.substr(vendorStart, vendorEnd - vendorStart));
}

void applyInfoPlistMetadata(NativePluginInfo& info, const std::filesystem::path& bundlePath) {
  const auto plistPath = bundlePath / "Contents" / "Info.plist";
  const auto plistPathText = plistPath.string();
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(plistPathText.c_str()),
      plistPathText.size(),
      false);
  if (url == nullptr) {
    return;
  }

  CFReadStreamRef stream = CFReadStreamCreateWithFile(kCFAllocatorDefault, url);
  CFRelease(url);
  if (stream == nullptr) {
    return;
  }

  if (!CFReadStreamOpen(stream)) {
    CFRelease(stream);
    return;
  }

  CFPropertyListRef propertyList = CFPropertyListCreateWithStream(
      kCFAllocatorDefault,
      stream,
      0,
      kCFPropertyListImmutable,
      nullptr,
      nullptr);
  CFReadStreamClose(stream);
  CFRelease(stream);
  if (propertyList == nullptr) {
    return;
  }

  if (CFGetTypeID(propertyList) != CFDictionaryGetTypeID()) {
    CFRelease(propertyList);
    return;
  }

  const auto dictionary = static_cast<CFDictionaryRef>(propertyList);
  if (const auto displayName = dictionaryStringValue(dictionary, CFSTR("CFBundleDisplayName")); !displayName.empty()) {
    info.name = displayName;
  } else if (const auto bundleName = dictionaryStringValue(dictionary, CFSTR("CFBundleName")); !bundleName.empty()) {
    info.name = bundleName;
  }

  if (const auto identifier = dictionaryStringValue(dictionary, CFSTR("CFBundleIdentifier")); !identifier.empty()) {
    info.bundleIdentifier = identifier;
  }
  if (const auto version = dictionaryStringValue(dictionary, CFSTR("CFBundleShortVersionString")); !version.empty()) {
    info.version = version;
  } else if (const auto bundleVersion = dictionaryStringValue(dictionary, CFSTR("CFBundleVersion")); !bundleVersion.empty()) {
    info.version = bundleVersion;
  }
  if (const auto vendor = vendorFromCopyright(dictionaryStringValue(dictionary, CFSTR("NSHumanReadableCopyright"))); !vendor.empty()) {
    info.vendor = vendor;
  } else if (info.vendor == "Unknown") {
    if (const auto vendorFromIdentifier = vendorFromBundleIdentifier(info.bundleIdentifier); !vendorFromIdentifier.empty()) {
      info.vendor = vendorFromIdentifier;
    }
  }

  CFRelease(propertyList);
}
#endif

} // namespace

Vst3Scanner::Vst3Scanner()
    : paths_{
          repositoryExampleVst3Path(),
          std::filesystem::path("/Library/Audio/Plug-Ins/VST3"),
          homeLibraryVst3Path(),
      } {}

std::vector<std::filesystem::path> Vst3Scanner::searchPaths() const {
  std::vector<std::filesystem::path> paths;
  for (const auto& path : paths_) {
    if (!path.empty()) {
      paths.push_back(path);
    }
  }
  return paths;
}

std::vector<NativePluginInfo> Vst3Scanner::scan() const {
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
      if (path.extension() != ".vst3") {
        continue;
      }

      const bool isBundle = entry.is_directory(error);
      if (error || !isBundle) {
        continue;
      }

      NativePluginInfo info;
      info.pluginId = "vst3:" + path.filename().string();
      info.format = PluginFormat::Vst3;
      info.name = bundleNameFromPath(path);
      info.vendor = "Unknown";
      info.category = "VST3";
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
#ifdef SOUNDBRIDGE_MACOS
      applyInfoPlistMetadata(info, path);
#endif
      applySoundBridgeManifest(info, path);
      plugins.push_back(std::move(info));
    }
  }

  return plugins;
}

std::string vst3BundleListToJson(const std::vector<NativePluginInfo>& plugins) {
  return nativePluginListToJson(plugins);
}

} // namespace soundbridge
