#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

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

using LV2_URID = std::uint32_t;
using LV2_URID_Map_Handle = void*;

struct LV2_URID_Map {
  LV2_URID_Map_Handle handle;
  LV2_URID (*map)(LV2_URID_Map_Handle handle, const char* uri);
};

using LV2_State_Handle = void*;
using LV2_State_Status = std::uint32_t;
using LV2_State_Store_Function = LV2_State_Status (*)(
    LV2_State_Handle handle,
    std::uint32_t key,
    const void* value,
    std::size_t size,
    std::uint32_t type,
    std::uint32_t flags);
using LV2_State_Retrieve_Function = const void* (*)(
    LV2_State_Handle handle,
    std::uint32_t key,
    std::size_t* size,
    std::uint32_t* type,
    std::uint32_t* flags);

struct LV2_State_Interface {
  LV2_State_Status (*save)(
      LV2_Handle instance,
      LV2_State_Store_Function store,
      LV2_State_Handle handle,
      std::uint32_t flags,
      const LV2_Feature* const* features);
  LV2_State_Status (*restore)(
      LV2_Handle instance,
      LV2_State_Retrieve_Function retrieve,
      LV2_State_Handle handle,
      std::uint32_t flags,
      const LV2_Feature* const* features);
};

struct LV2_Atom {
  std::uint32_t size;
  LV2_URID type;
};

struct LV2_Atom_Sequence_Body {
  LV2_URID unit;
  std::uint32_t pad;
};

struct LV2_Atom_Sequence {
  LV2_Atom atom;
  LV2_Atom_Sequence_Body body;
};

union LV2_Atom_Event_Time {
  std::int64_t frames;
  double beats;
};

struct LV2_Atom_Event {
  LV2_Atom_Event_Time time;
  LV2_Atom body;
};

constexpr const char* kLv2UridMapUri = "http://lv2plug.in/ns/ext/urid#map";
constexpr const char* kLv2AtomFloatUri = "http://lv2plug.in/ns/ext/atom#Float";
constexpr const char* kLv2MidiEventUri = "http://lv2plug.in/ns/ext/midi#MidiEvent";
constexpr const char* kLv2StateInterfaceUri = "http://lv2plug.in/ns/ext/state#interface";
constexpr const char* kMidiGainStateUri = "urn:soundbridge:example:lv2-gain#midiGain";
constexpr std::uint32_t kLv2StateSuccess = 0;
constexpr std::uint32_t kLv2StateErrBadType = 2;
constexpr std::uint32_t kLv2StateErrNoFeature = 4;
constexpr std::uint32_t kLv2StateIsPod = 1U << 0U;
constexpr std::uint32_t kLv2StateIsPortable = 1U << 1U;

enum PortIndex : std::uint32_t {
  kGain = 0,
  kInputLeft = 1,
  kInputRight = 2,
  kOutputLeft = 3,
  kOutputRight = 4,
  kMidiIn = 5,
};

struct GainPlugin {
  const float* gain = nullptr;
  const float* inputLeft = nullptr;
  const float* inputRight = nullptr;
  float* outputLeft = nullptr;
  float* outputRight = nullptr;
  const LV2_Atom_Sequence* midiIn = nullptr;
  LV2_URID midiEventUrid = 0;
  LV2_URID midiGainKeyUrid = 0;
  LV2_URID atomFloatUrid = 0;
  float midiGain = 1.0F;
};

std::size_t alignAtomSize(std::size_t size) {
  return (size + 7U) & ~std::size_t(7U);
}

LV2_Handle instantiate(
    const LV2_Descriptor* /* descriptor */,
    double /* sampleRate */,
    const char* /* bundlePath */,
    const LV2_Feature* const* features) {
  auto* plugin = new GainPlugin();
  if (features != nullptr) {
    for (const LV2_Feature* const* feature = features; *feature != nullptr; ++feature) {
      if ((*feature)->URI == nullptr || (*feature)->data == nullptr ||
          std::strcmp((*feature)->URI, kLv2UridMapUri) != 0) {
        continue;
      }
      auto* uridMap = static_cast<const LV2_URID_Map*>((*feature)->data);
      if (uridMap->map != nullptr) {
        plugin->midiEventUrid = uridMap->map(uridMap->handle, kLv2MidiEventUri);
        plugin->midiGainKeyUrid = uridMap->map(uridMap->handle, kMidiGainStateUri);
        plugin->atomFloatUrid = uridMap->map(uridMap->handle, kLv2AtomFloatUri);
      }
    }
  }
  return plugin;
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
    case kMidiIn:
      plugin->midiIn = static_cast<const LV2_Atom_Sequence*>(dataLocation);
      break;
    default:
      break;
  }
}

void applyMidi(GainPlugin& plugin) {
  if (plugin.midiIn == nullptr || plugin.midiEventUrid == 0 ||
      plugin.midiIn->atom.size < sizeof(LV2_Atom_Sequence_Body)) {
    return;
  }

  const auto sequenceBytes = static_cast<std::size_t>(plugin.midiIn->atom.size) + sizeof(LV2_Atom);
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(plugin.midiIn);
  std::size_t offset = sizeof(LV2_Atom_Sequence);
  while (offset + sizeof(LV2_Atom_Event) <= sequenceBytes) {
    const auto* event = reinterpret_cast<const LV2_Atom_Event*>(bytes + offset);
    const auto bodyOffset = offset + sizeof(LV2_Atom_Event);
    const auto nextOffset = bodyOffset + alignAtomSize(event->body.size);
    if (bodyOffset + event->body.size > sequenceBytes || nextOffset <= offset) {
      break;
    }

    if (event->body.type == plugin.midiEventUrid && event->body.size >= 3) {
      const auto* midi = bytes + bodyOffset;
      if ((midi[0] & 0xF0U) == 0xB0U && midi[1] == 7U) {
        plugin.midiGain = std::clamp(static_cast<float>(midi[2]) / 127.0F, 0.0F, 1.0F);
      }
    }
    offset = nextOffset;
  }
}

void run(LV2_Handle instance, std::uint32_t sampleCount) {
  auto* plugin = static_cast<GainPlugin*>(instance);
  applyMidi(*plugin);
  const float gain = std::clamp(plugin->gain == nullptr ? 1.0F : *plugin->gain, 0.0F, 2.0F) * plugin->midiGain;
  for (std::uint32_t frame = 0; frame < sampleCount; ++frame) {
    if (plugin->outputLeft != nullptr) {
      plugin->outputLeft[frame] = (plugin->inputLeft == nullptr ? 0.0F : plugin->inputLeft[frame]) * gain;
    }
    if (plugin->outputRight != nullptr) {
      plugin->outputRight[frame] = (plugin->inputRight == nullptr ? 0.0F : plugin->inputRight[frame]) * gain;
    }
  }
}

LV2_State_Status saveState(
    LV2_Handle instance,
    LV2_State_Store_Function store,
    LV2_State_Handle handle,
    std::uint32_t /* flags */,
    const LV2_Feature* const* /* features */) {
  auto* plugin = static_cast<GainPlugin*>(instance);
  if (store == nullptr || plugin->midiGainKeyUrid == 0 || plugin->atomFloatUrid == 0) {
    return kLv2StateErrNoFeature;
  }
  const float value = std::clamp(plugin->midiGain, 0.0F, 1.0F);
  return store(
      handle,
      plugin->midiGainKeyUrid,
      &value,
      sizeof(value),
      plugin->atomFloatUrid,
      kLv2StateIsPod | kLv2StateIsPortable);
}

LV2_State_Status restoreState(
    LV2_Handle instance,
    LV2_State_Retrieve_Function retrieve,
    LV2_State_Handle handle,
    std::uint32_t /* flags */,
    const LV2_Feature* const* /* features */) {
  auto* plugin = static_cast<GainPlugin*>(instance);
  if (retrieve == nullptr || plugin->midiGainKeyUrid == 0 || plugin->atomFloatUrid == 0) {
    return kLv2StateErrNoFeature;
  }

  std::size_t size = 0;
  std::uint32_t type = 0;
  std::uint32_t flags = 0;
  const auto* value = retrieve(handle, plugin->midiGainKeyUrid, &size, &type, &flags);
  if (value == nullptr) {
    return kLv2StateSuccess;
  }
  if (size != sizeof(float) || type != plugin->atomFloatUrid || (flags & kLv2StateIsPod) == 0) {
    return kLv2StateErrBadType;
  }

  float restored = 1.0F;
  std::memcpy(&restored, value, sizeof(restored));
  plugin->midiGain = std::clamp(restored, 0.0F, 1.0F);
  return kLv2StateSuccess;
}

void cleanup(LV2_Handle instance) {
  delete static_cast<GainPlugin*>(instance);
}

const LV2_State_Interface kStateInterface {
    saveState,
    restoreState};

const void* extensionData(const char* uri) {
  if (uri != nullptr && std::strcmp(uri, kLv2StateInterfaceUri) == 0) {
    return &kStateInterface;
  }
  return nullptr;
}

const LV2_Descriptor kDescriptor {
    "urn:soundbridge:example:lv2-gain",
    instantiate,
    connectPort,
    nullptr,
    run,
    nullptr,
    cleanup,
    extensionData};

} // namespace

extern "C" const LV2_Descriptor* lv2_descriptor(std::uint32_t index) {
  return index == 0 ? &kDescriptor : nullptr;
}
