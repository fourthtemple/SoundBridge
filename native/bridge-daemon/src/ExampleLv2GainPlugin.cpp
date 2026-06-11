#include <algorithm>
#include <cstdint>
#include <cstdlib>

namespace {

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

enum PortIndex : std::uint32_t {
  kGain = 0,
  kInputLeft = 1,
  kInputRight = 2,
  kOutputLeft = 3,
  kOutputRight = 4,
};

struct GainPlugin {
  const float* gain = nullptr;
  const float* inputLeft = nullptr;
  const float* inputRight = nullptr;
  float* outputLeft = nullptr;
  float* outputRight = nullptr;
};

LV2_Handle instantiate(
    const LV2_Descriptor* /* descriptor */,
    double /* sampleRate */,
    const char* /* bundlePath */,
    const LV2_Feature* const* /* features */) {
  return new GainPlugin();
}

void connectPort(LV2_Handle instance, std::uint32_t port, void* dataLocation) {
  auto* plugin = static_cast<GainPlugin*>(instance);
  switch (port) {
    case kGain:
      plugin->gain = static_cast<const float*>(dataLocation);
      break;
    case kInputLeft:
      plugin->inputLeft = static_cast<const float*>(dataLocation);
      break;
    case kInputRight:
      plugin->inputRight = static_cast<const float*>(dataLocation);
      break;
    case kOutputLeft:
      plugin->outputLeft = static_cast<float*>(dataLocation);
      break;
    case kOutputRight:
      plugin->outputRight = static_cast<float*>(dataLocation);
      break;
    default:
      break;
  }
}

void run(LV2_Handle instance, std::uint32_t sampleCount) {
  auto* plugin = static_cast<GainPlugin*>(instance);
  const float gain = std::clamp(plugin->gain == nullptr ? 1.0F : *plugin->gain, 0.0F, 2.0F);
  for (std::uint32_t frame = 0; frame < sampleCount; ++frame) {
    if (plugin->outputLeft != nullptr) {
      plugin->outputLeft[frame] = (plugin->inputLeft == nullptr ? 0.0F : plugin->inputLeft[frame]) * gain;
    }
    if (plugin->outputRight != nullptr) {
      plugin->outputRight[frame] = (plugin->inputRight == nullptr ? 0.0F : plugin->inputRight[frame]) * gain;
    }
  }
}

void cleanup(LV2_Handle instance) {
  delete static_cast<GainPlugin*>(instance);
}

const LV2_Descriptor kDescriptor {
    "urn:soundbridge:example:lv2-gain",
    instantiate,
    connectPort,
    nullptr,
    run,
    nullptr,
    cleanup,
    nullptr};

} // namespace

extern "C" const LV2_Descriptor* lv2_descriptor(std::uint32_t index) {
  return index == 0 ? &kDescriptor : nullptr;
}
