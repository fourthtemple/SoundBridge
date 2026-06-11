#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace soundbridge {

struct NativeParameterInfo {
  std::string id;
  std::string name;
  double normalizedValue = 0.0;
  double defaultNormalizedValue = 0.0;
  bool automatable = false;
};

struct NativePluginInstanceConfig {
  std::string pluginId;
  double sampleRate = 48000.0;
  std::uint32_t maxBlockSize = 128;
  std::uint32_t inputChannels = 2;
  std::uint32_t outputChannels = 2;
};

class Vst3Host {
public:
  bool sdkAvailable() const;
  std::string status() const;

  // Real parameter/state/audio work lives in the isolated Vst3HostWorker.
  std::vector<NativeParameterInfo> parametersForInstance(const std::string& instanceId) const;
  std::uint32_t latencySamplesForInstance(const std::string& instanceId) const;
};

} // namespace soundbridge
