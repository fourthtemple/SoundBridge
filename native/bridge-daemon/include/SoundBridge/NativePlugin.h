#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace soundbridge {

enum class PluginFormat {
  Vst3,
  AudioUnit,
  Lv2,
  Mock,
  Unknown,
};

struct NativePluginInfo {
  std::string pluginId;
  PluginFormat format = PluginFormat::Unknown;
  std::string name;
  std::string vendor = "Unknown";
  std::string category = "Unknown";
  std::string kind = "unknown";
  std::string source = "scan";
  std::string bundlePath;
  std::string executablePath;
  std::string bundleIdentifier;
  std::string version;
  std::string componentType;
  std::string componentSubType;
  std::string componentManufacturer;
  std::string lv2Uri;
  std::vector<std::string> lv2UiTypes;
  std::uint32_t inputs = 0;
  std::uint32_t outputs = 0;
  std::uint32_t lv2UiCount = 0;
  std::uint32_t lv2UiBinaryCount = 0;
  bool isExample = false;
  bool isRegistry = false;
  bool hasContents = false;
  bool hasExecutable = false;
  bool hasManifest = false;
  bool hasUnsupportedRequiredFeatures = false;
  std::uint32_t unsupportedRequiredFeatureCount = 0;
  bool hasUnsupportedRequiredOptions = false;
  std::uint32_t unsupportedRequiredOptionCount = 0;
};

std::string pluginFormatToString(PluginFormat format);
std::string jsonEscape(const std::string& input);
std::string nativePluginInfoToJson(const NativePluginInfo& info);
std::string nativePluginListToJson(const std::vector<NativePluginInfo>& plugins);

} // namespace soundbridge
