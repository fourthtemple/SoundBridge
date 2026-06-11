#include "SoundBridge/NativePlugin.h"

#include <cstdio>
#include <sstream>

namespace soundbridge {

std::string pluginFormatToString(PluginFormat format) {
  switch (format) {
    case PluginFormat::Vst3:
      return "vst3";
    case PluginFormat::AudioUnit:
      return "au";
    case PluginFormat::Lv2:
      return "lv2";
    case PluginFormat::Mock:
      return "mock";
    case PluginFormat::Unknown:
      return "unknown";
  }
  return "unknown";
}

std::string jsonEscape(const std::string& input) {
  std::ostringstream output;
  for (const char value : input) {
    switch (value) {
      case '\\':
        output << "\\\\";
        break;
      case '"':
        output << "\\\"";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(value) < 0x20) {
          char escaped[7];
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned char>(value));
          output << escaped;
        } else {
          output << value;
        }
        break;
    }
  }
  return output.str();
}

std::string nativePluginInfoToJson(const NativePluginInfo& info) {
  std::ostringstream output;
  output << "{";
  output << "\"pluginId\":\"" << jsonEscape(info.pluginId) << "\",";
  output << "\"format\":\"" << pluginFormatToString(info.format) << "\",";
  output << "\"name\":\"" << jsonEscape(info.name) << "\",";
  output << "\"vendor\":\"" << jsonEscape(info.vendor) << "\",";
  output << "\"category\":\"" << jsonEscape(info.category) << "\",";
  output << "\"kind\":\"" << jsonEscape(info.kind) << "\",";
  output << "\"source\":\"" << jsonEscape(info.source) << "\",";
  output << "\"inputs\":" << info.inputs << ",";
  output << "\"outputs\":" << info.outputs << ",";
  output << "\"diagnostics\":{";
  output << "\"bundlePath\":\"" << jsonEscape(info.bundlePath) << "\",";
  output << "\"executablePath\":\"" << jsonEscape(info.executablePath) << "\",";
  output << "\"isExample\":" << (info.isExample ? "true" : "false") << ",";
  output << "\"isRegistry\":" << (info.isRegistry ? "true" : "false") << ",";
  output << "\"hasContents\":" << (info.hasContents ? "true" : "false") << ",";
  output << "\"hasExecutable\":" << (info.hasExecutable ? "true" : "false") << ",";
  output << "\"hasManifest\":" << (info.hasManifest ? "true" : "false");
  if (!info.componentType.empty()) {
    output << ",\"componentType\":\"" << jsonEscape(info.componentType) << "\"";
  }
  if (!info.componentSubType.empty()) {
    output << ",\"componentSubType\":\"" << jsonEscape(info.componentSubType) << "\"";
  }
  if (!info.componentManufacturer.empty()) {
    output << ",\"componentManufacturer\":\"" << jsonEscape(info.componentManufacturer) << "\"";
  }
  if (!info.bundleIdentifier.empty()) {
    output << ",\"bundleIdentifier\":\"" << jsonEscape(info.bundleIdentifier) << "\"";
  }
  if (!info.version.empty()) {
    output << ",\"version\":\"" << jsonEscape(info.version) << "\"";
  }
  output << "}";
  output << "}";
  return output.str();
}

std::string nativePluginListToJson(const std::vector<NativePluginInfo>& plugins) {
  std::ostringstream output;
  output << "{";
  output << "\"plugins\":[";
  for (std::size_t index = 0; index < plugins.size(); ++index) {
    if (index > 0) {
      output << ",";
    }
    output << nativePluginInfoToJson(plugins[index]);
  }
  output << "],";
  output << "\"count\":" << plugins.size();
  output << "}";
  return output.str();
}

} // namespace soundbridge
