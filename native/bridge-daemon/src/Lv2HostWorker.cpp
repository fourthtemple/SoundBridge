#include "SoundBridge/Lv2HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/NativePlugin.h"

#ifndef _WIN32
#include <dlfcn.h>
#endif

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
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
using LV2_URID = std::uint32_t;
using LV2_URID_Map_Handle = void*;
using LV2_URID_Unmap_Handle = void*;
using LV2_State_Handle = void*;
using LV2_State_Free_Path_Handle = void*;
using LV2_State_Map_Path_Handle = void*;
using LV2_State_Make_Path_Handle = void*;

struct LV2_URID_Map {
  LV2_URID_Map_Handle handle;
  LV2_URID (*map)(LV2_URID_Map_Handle handle, const char* uri);
};

struct LV2_URID_Unmap {
  LV2_URID_Unmap_Handle handle;
  const char* (*unmap)(LV2_URID_Unmap_Handle handle, LV2_URID urid);
};

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

struct LV2_State_Map_Path {
  LV2_State_Map_Path_Handle handle;
  char* (*abstract_path)(LV2_State_Map_Path_Handle handle, const char* absolutePath);
  char* (*absolute_path)(LV2_State_Map_Path_Handle handle, const char* abstractPath);
};

struct LV2_State_Make_Path {
  LV2_State_Make_Path_Handle handle;
  char* (*path)(LV2_State_Make_Path_Handle handle, const char* path);
};

struct LV2_State_Free_Path {
  LV2_State_Free_Path_Handle handle;
  void (*free_path)(LV2_State_Free_Path_Handle handle, char* path);
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

struct LV2_Atom_Int {
  LV2_Atom atom;
  std::int32_t body;
};

struct LV2_Atom_Long {
  LV2_Atom atom;
  std::int64_t body;
};

struct LV2_Atom_Float {
  LV2_Atom atom;
  float body;
};

struct LV2_Atom_Double {
  LV2_Atom atom;
  double body;
};

struct LV2_Atom_Object_Body {
  std::uint32_t id;
  std::uint32_t otype;
};

struct LV2_Atom_Property_Body {
  LV2_URID key;
  LV2_URID context;
  LV2_Atom value;
};

constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerAudioPorts = 32;
constexpr std::uint32_t kMaxWorkerPortIndex = 4096;
constexpr std::size_t kMaxWorkerPorts = 1024;
constexpr std::size_t kMaxWorkerParameters = 1024;
constexpr std::size_t kMaxWorkerParameterChanges = 4096;
constexpr std::size_t kMaxWorkerMidiEvents = 4096;
constexpr std::size_t kMaxWorkerStateProperties = 1024;
constexpr std::size_t kMaxWorkerStatePropertyBytes = 64 * 1024;
constexpr std::size_t kMaxWorkerStateFiles = 64;
constexpr std::size_t kMaxWorkerStateFileBytes = 64 * 1024;
constexpr std::size_t kMaxWorkerStateFileTotalBytes = 192 * 1024;
constexpr std::size_t kMaxWorkerStatePathBytes = 256;
constexpr std::size_t kMaxWorkerUriBytes = 512;
constexpr std::size_t kMaxWorkerUridMappings = 4096;
constexpr std::size_t kMaxWorkerParameterStringBytes = 160;
constexpr std::size_t kMaxWorkerStateBytes = 384 * 1024;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr std::uint32_t kMaxWorkerLatencySamples = 1'048'576;
constexpr std::uint32_t kMaxWorkerParameterStepCount = 4096;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;
constexpr double kMaxWorkerTransportTempoBpm = 960.0;
constexpr double kMaxWorkerTransportPositionMusic = 1'000'000'000.0;
constexpr long long kMaxWorkerTransportSamplePosition = 9'007'199'254'740'991LL;
constexpr const char* kLv2ControlStateMagic = "soundbridge-lv2-control-state-v1";
constexpr const char* kLv2StateMagic = "soundbridge-lv2-state-v2";
constexpr const char* kLv2LatencyUri = "http://lv2plug.in/ns/lv2core#latency";
constexpr const char* kLv2ReportsLatencyUri = "http://lv2plug.in/ns/lv2core#reportsLatency";
constexpr const char* kLv2ToggledUri = "http://lv2plug.in/ns/lv2core#toggled";
constexpr const char* kLv2IntegerUri = "http://lv2plug.in/ns/lv2core#integer";
constexpr const char* kLv2EnumerationUri = "http://lv2plug.in/ns/lv2core#enumeration";
constexpr const char* kLv2UridMapUri = "http://lv2plug.in/ns/ext/urid#map";
constexpr const char* kLv2UridUnmapUri = "http://lv2plug.in/ns/ext/urid#unmap";
constexpr const char* kLv2AtomSequenceUri = "http://lv2plug.in/ns/ext/atom#Sequence";
constexpr const char* kLv2AtomFrameTimeUri = "http://lv2plug.in/ns/ext/atom#frameTime";
constexpr const char* kLv2AtomIntUri = "http://lv2plug.in/ns/ext/atom#Int";
constexpr const char* kLv2AtomLongUri = "http://lv2plug.in/ns/ext/atom#Long";
constexpr const char* kLv2AtomFloatUri = "http://lv2plug.in/ns/ext/atom#Float";
constexpr const char* kLv2AtomDoubleUri = "http://lv2plug.in/ns/ext/atom#Double";
constexpr const char* kLv2AtomObjectUri = "http://lv2plug.in/ns/ext/atom#Object";
constexpr const char* kLv2AtomPathUri = "http://lv2plug.in/ns/ext/atom#Path";
constexpr const char* kLv2MidiEventUri = "http://lv2plug.in/ns/ext/midi#MidiEvent";
constexpr const char* kLv2StateInterfaceUri = "http://lv2plug.in/ns/ext/state#interface";
constexpr const char* kLv2StateFreePathUri = "http://lv2plug.in/ns/ext/state#freePath";
constexpr const char* kLv2StateMakePathUri = "http://lv2plug.in/ns/ext/state#makePath";
constexpr const char* kLv2StateMapPathUri = "http://lv2plug.in/ns/ext/state#mapPath";
constexpr const char* kLv2TimePositionUri = "http://lv2plug.in/ns/ext/time#Position";
constexpr const char* kLv2TimeFrameUri = "http://lv2plug.in/ns/ext/time#frame";
constexpr const char* kLv2TimeSpeedUri = "http://lv2plug.in/ns/ext/time#speed";
constexpr const char* kLv2TimeBeatUri = "http://lv2plug.in/ns/ext/time#beat";
constexpr const char* kLv2TimeBarBeatUri = "http://lv2plug.in/ns/ext/time#barBeat";
constexpr const char* kLv2TimeBeatUnitUri = "http://lv2plug.in/ns/ext/time#beatUnit";
constexpr const char* kLv2TimeBeatsPerBarUri = "http://lv2plug.in/ns/ext/time#beatsPerBar";
constexpr const char* kLv2TimeBeatsPerMinuteUri = "http://lv2plug.in/ns/ext/time#beatsPerMinute";
constexpr LV2_URID kUridAtomSequence = 1;
constexpr LV2_URID kUridAtomFrameTime = 2;
constexpr LV2_URID kUridMidiEvent = 3;
constexpr LV2_URID kUridAtomFloat = 4;
constexpr LV2_URID kUridAtomPath = 5;
constexpr LV2_URID kUridAtomInt = 6;
constexpr LV2_URID kUridAtomLong = 7;
constexpr LV2_URID kUridAtomDouble = 8;
constexpr LV2_URID kUridAtomObject = 9;
constexpr LV2_URID kUridTimePosition = 10;
constexpr LV2_URID kUridTimeFrame = 11;
constexpr LV2_URID kUridTimeSpeed = 12;
constexpr LV2_URID kUridTimeBeat = 13;
constexpr LV2_URID kUridTimeBarBeat = 14;
constexpr LV2_URID kUridTimeBeatUnit = 15;
constexpr LV2_URID kUridTimeBeatsPerBar = 16;
constexpr LV2_URID kUridTimeBeatsPerMinute = 17;
constexpr std::uint32_t kLv2StateSuccess = 0;
constexpr std::uint32_t kLv2StateErrUnknown = 1;
constexpr std::uint32_t kLv2StateErrBadType = 2;
constexpr std::uint32_t kLv2StateErrBadFlags = 3;
constexpr std::uint32_t kLv2StateErrNoSpace = 6;
constexpr std::uint32_t kLv2StateIsPod = 1U << 0U;
constexpr std::uint32_t kLv2StateIsPortable = 1U << 1U;
constexpr std::uint32_t kLv2StateIsNative = 1U << 2U;

enum class Lv2PortDirection {
  Input,
  Output,
};

enum class Lv2PortType {
  Audio,
  Control,
  Midi,
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
  bool acceptsMidi = false;
  bool acceptsTimePosition = false;
  bool reportsLatency = false;
  bool isToggled = false;
  bool isInteger = false;
  bool isEnumeration = false;
};

struct Lv2BundleMetadata {
  std::string pluginUri;
  std::filesystem::path binaryPath;
  std::vector<Lv2Port> ports;
};

struct PendingParameterChange {
  std::string parameterId;
  double normalizedValue = 0.0;
  std::uint32_t sampleOffset = 0;
};

struct PendingMidiMessage {
  std::uint8_t status = 0x90;
  std::uint8_t data1 = 60;
  std::uint8_t data2 = 100;
  std::uint32_t sampleOffset = 0;
};

struct HostTransportContext {
  bool explicitTransport = false;
  bool playing = false;
  bool recording = false;
  bool loopActive = false;
  bool hasTempo = false;
  double tempo = 120.0;
  bool hasTimeSignature = false;
  std::uint32_t timeSignatureNumerator = 4;
  std::uint32_t timeSignatureDenominator = 4;
  bool hasProjectTimeMusic = false;
  double projectTimeMusic = 0.0;
  bool hasBarPositionMusic = false;
  double barPositionMusic = 0.0;
  bool hasCycle = false;
  double cycleStartMusic = 0.0;
  double cycleEndMusic = 0.0;
  std::int64_t samplePosition = 0;
};

struct Lv2StateProperty {
  std::string keyUri;
  std::string typeUri;
  std::uint32_t flags = 0;
  std::vector<std::uint8_t> value;
};

struct Lv2StateFile {
  std::string abstractPath;
  std::vector<std::uint8_t> value;
};

struct Lv2SavedExtensionState {
  std::vector<Lv2StateProperty> properties;
  std::vector<Lv2StateFile> files;
};

struct Lv2RestoredStateProperty {
  LV2_URID key = 0;
  LV2_URID type = 0;
  std::uint32_t flags = 0;
  std::vector<std::uint8_t> value;
};

class Lv2UridMapper {
public:
  Lv2UridMapper() {
    mappings_.reserve(kMaxWorkerUridMappings);
    addKnown(kUridAtomSequence, kLv2AtomSequenceUri);
    addKnown(kUridAtomFrameTime, kLv2AtomFrameTimeUri);
    addKnown(kUridMidiEvent, kLv2MidiEventUri);
    addKnown(kUridAtomFloat, kLv2AtomFloatUri);
    addKnown(kUridAtomPath, kLv2AtomPathUri);
    addKnown(kUridAtomInt, kLv2AtomIntUri);
    addKnown(kUridAtomLong, kLv2AtomLongUri);
    addKnown(kUridAtomDouble, kLv2AtomDoubleUri);
    addKnown(kUridAtomObject, kLv2AtomObjectUri);
    addKnown(kUridTimePosition, kLv2TimePositionUri);
    addKnown(kUridTimeFrame, kLv2TimeFrameUri);
    addKnown(kUridTimeSpeed, kLv2TimeSpeedUri);
    addKnown(kUridTimeBeat, kLv2TimeBeatUri);
    addKnown(kUridTimeBarBeat, kLv2TimeBarBeatUri);
    addKnown(kUridTimeBeatUnit, kLv2TimeBeatUnitUri);
    addKnown(kUridTimeBeatsPerBar, kLv2TimeBeatsPerBarUri);
    addKnown(kUridTimeBeatsPerMinute, kLv2TimeBeatsPerMinuteUri);
    nextUrid_ = kUridTimeBeatsPerMinute + 1;
  }

  LV2_URID map(const char* uri) {
    if (uri == nullptr || *uri == '\0') {
      return 0;
    }
    const std::string text(uri);
    if (text.size() > kMaxWorkerUriBytes) {
      return 0;
    }
    for (const auto& mapping : mappings_) {
      if (mapping.uri == text) {
        return mapping.urid;
      }
    }
    if (mappings_.size() >= kMaxWorkerUridMappings) {
      return 0;
    }
    const auto urid = nextUrid_++;
    mappings_.push_back(Lv2MappedUri{urid, text});
    return urid;
  }

  const char* unmap(LV2_URID urid) const {
    for (const auto& mapping : mappings_) {
      if (mapping.urid == urid) {
        return mapping.uri.c_str();
      }
    }
    return nullptr;
  }

private:
  struct Lv2MappedUri {
    LV2_URID urid = 0;
    std::string uri;
  };

  void addKnown(LV2_URID urid, const char* uri) {
    mappings_.push_back(Lv2MappedUri{urid, uri});
  }

  std::vector<Lv2MappedUri> mappings_;
  LV2_URID nextUrid_ = kUridTimeBeatsPerMinute + 1;
};

class Lv2StateFileBroker;

struct Lv2StateSaveContext {
  Lv2UridMapper* mapper = nullptr;
  std::vector<Lv2StateProperty>* properties = nullptr;
  std::vector<Lv2StateFile>* files = nullptr;
  Lv2StateFileBroker* fileBroker = nullptr;
  std::size_t totalValueBytes = 0;
  std::size_t totalFileBytes = 0;
};

struct Lv2StateRestoreContext {
  const std::vector<Lv2RestoredStateProperty>* properties = nullptr;
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

float sanitizeStateValue(float value) {
  if (!std::isfinite(value)) {
    return 0.0F;
  }
  return std::clamp(value, -1.0e9F, 1.0e9F);
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

bool parseStateValue(const std::string& text, double& out) {
  return parseDoubleArg(text.c_str(), -1.0e9, 1.0e9, out);
}

bool parseSampleRateArg(const char* text, double& out) {
  return parseDoubleArg(text, kMinWorkerSampleRate, kMaxWorkerSampleRate, out);
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

LV2_URID mapLv2Urid(LV2_URID_Map_Handle handle, const char* uri) {
  if (handle == nullptr) {
    return 0;
  }
  return static_cast<Lv2UridMapper*>(handle)->map(uri);
}

const char* unmapLv2Urid(LV2_URID_Unmap_Handle handle, LV2_URID urid) {
  if (handle == nullptr) {
    return nullptr;
  }
  return static_cast<const Lv2UridMapper*>(handle)->unmap(urid);
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

class Lv2StateFileBroker {
public:
  Lv2StateFileBroker() {
    const auto seed = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto base = std::filesystem::temp_directory_path() /
        ("soundbridge-lv2-state-" + std::to_string(seed));
    for (std::uint32_t index = 0; index < 32; ++index) {
      auto candidate = base;
      if (index > 0) {
        candidate += "-" + std::to_string(index);
      }
      std::error_code error;
      if (std::filesystem::create_directory(candidate, error)) {
        root_ = std::move(candidate);
        return;
      }
    }
    throw std::runtime_error("lv2_state_broker_unavailable");
  }

  Lv2StateFileBroker(const Lv2StateFileBroker&) = delete;
  Lv2StateFileBroker& operator=(const Lv2StateFileBroker&) = delete;

  ~Lv2StateFileBroker() {
    std::error_code error;
    std::filesystem::remove_all(root_, error);
  }

  char* makePath(const char* pathText) {
    const auto relativePath = safeRelativePath(pathText);
    if (!relativePath) {
      return nullptr;
    }
    const auto absolutePath = (root_ / *relativePath).lexically_normal();
    std::error_code error;
    std::filesystem::create_directories(absolutePath.parent_path(), error);
    if (error) {
      return nullptr;
    }
    return duplicateCString(absolutePath.string());
  }

  char* abstractPath(const char* absolutePathText) {
    if (absolutePathText == nullptr || *absolutePathText == '\0') {
      return nullptr;
    }
    std::error_code error;
    const auto root = std::filesystem::weakly_canonical(root_, error);
    if (error) {
      return nullptr;
    }
    const auto absolutePath = std::filesystem::weakly_canonical(std::filesystem::path(absolutePathText), error);
    if (error || !pathIsInsideRoot(absolutePath, root)) {
      return nullptr;
    }
    const auto relativePath = std::filesystem::relative(absolutePath, root, error);
    if (error || !safeRelativePath(relativePath.generic_string().c_str())) {
      return nullptr;
    }
    return duplicateCString(relativePath.generic_string());
  }

  char* absolutePath(const char* abstractPathText) {
    const auto relativePath = safeRelativePath(abstractPathText);
    if (!relativePath) {
      return nullptr;
    }
    return duplicateCString((root_ / *relativePath).lexically_normal().string());
  }

  bool recordFile(const std::string& abstractPath, std::vector<Lv2StateFile>& files, std::size_t& totalFileBytes) const {
    if (files.size() >= kMaxWorkerStateFiles) {
      return false;
    }
    for (const auto& file : files) {
      if (file.abstractPath == abstractPath) {
        return true;
      }
    }
    const auto relativePath = safeRelativePath(abstractPath.c_str());
    if (!relativePath) {
      return false;
    }
    const auto absolutePath = (root_ / *relativePath).lexically_normal();
    std::error_code error;
    if (std::filesystem::is_symlink(std::filesystem::symlink_status(absolutePath, error)) || error ||
        !std::filesystem::is_regular_file(absolutePath, error) || error) {
      return false;
    }
    const auto size = std::filesystem::file_size(absolutePath, error);
    if (error || size == 0 || size > kMaxWorkerStateFileBytes ||
        totalFileBytes + size > kMaxWorkerStateFileTotalBytes) {
      return false;
    }
    std::ifstream input(absolutePath, std::ios::binary);
    if (!input) {
      return false;
    }
    std::vector<std::uint8_t> bytes(size);
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!input) {
      return false;
    }
    totalFileBytes += bytes.size();
    files.push_back(Lv2StateFile{abstractPath, std::move(bytes)});
    return true;
  }

  bool materializeFiles(const std::vector<Lv2StateFile>& files) {
    std::size_t totalFileBytes = 0;
    std::set<std::string> seenPaths;
    for (const auto& file : files) {
      if (file.value.empty() || file.value.size() > kMaxWorkerStateFileBytes ||
          totalFileBytes + file.value.size() > kMaxWorkerStateFileTotalBytes) {
        return false;
      }
      if (!seenPaths.insert(file.abstractPath).second) {
        return false;
      }
      const auto relativePath = safeRelativePath(file.abstractPath.c_str());
      if (!relativePath) {
        return false;
      }
      const auto absolutePath = (root_ / *relativePath).lexically_normal();
      std::error_code error;
      std::filesystem::create_directories(absolutePath.parent_path(), error);
      if (error || std::filesystem::is_symlink(std::filesystem::symlink_status(absolutePath, error))) {
        return false;
      }
      std::ofstream output(absolutePath, std::ios::binary | std::ios::trunc);
      if (!output) {
        return false;
      }
      output.write(reinterpret_cast<const char*>(file.value.data()), static_cast<std::streamsize>(file.value.size()));
      if (!output) {
        return false;
      }
      totalFileBytes += file.value.size();
    }
    return true;
  }

  static void freePath(char* path) {
    delete[] path;
  }

private:
  static char* duplicateCString(const std::string& value) {
    auto* output = new char[value.size() + 1];
    std::memcpy(output, value.c_str(), value.size() + 1);
    return output;
  }

  static std::optional<std::filesystem::path> safeRelativePath(const char* pathText) {
    if (pathText == nullptr || *pathText == '\0') {
      return std::nullopt;
    }
    const std::string text(pathText);
    if (text.size() > kMaxWorkerStatePathBytes || text.find('\\') != std::string::npos) {
      return std::nullopt;
    }
    if (std::any_of(text.begin(), text.end(), [](unsigned char character) {
      return character == '\0' || character < 0x20 || character == 0x7F;
    })) {
      return std::nullopt;
    }
    const std::filesystem::path relativePath(text);
    if (relativePath.empty() || relativePath.is_absolute()) {
      return std::nullopt;
    }
    for (const auto& part : relativePath) {
      const auto partText = part.generic_string();
      if (partText.empty() || partText == "." || partText == "..") {
        return std::nullopt;
      }
    }
    return relativePath.lexically_normal();
  }

  static bool pathIsInsideRoot(const std::filesystem::path& child, const std::filesystem::path& root) {
    auto childIterator = child.begin();
    auto rootIterator = root.begin();
    for (; rootIterator != root.end(); ++rootIterator, ++childIterator) {
      if (childIterator == child.end() || *childIterator != *rootIterator) {
        return false;
      }
    }
    return true;
  }

  std::filesystem::path root_;
};

char* makeLv2StatePath(LV2_State_Make_Path_Handle handle, const char* path) {
  if (handle == nullptr) {
    return nullptr;
  }
  return static_cast<Lv2StateFileBroker*>(handle)->makePath(path);
}

char* abstractLv2StatePath(LV2_State_Map_Path_Handle handle, const char* absolutePath) {
  if (handle == nullptr) {
    return nullptr;
  }
  return static_cast<Lv2StateFileBroker*>(handle)->abstractPath(absolutePath);
}

char* absoluteLv2StatePath(LV2_State_Map_Path_Handle handle, const char* abstractPath) {
  if (handle == nullptr) {
    return nullptr;
  }
  return static_cast<Lv2StateFileBroker*>(handle)->absolutePath(abstractPath);
}

void freeLv2StatePath(LV2_State_Free_Path_Handle /* handle */, char* path) {
  Lv2StateFileBroker::freePath(path);
}

std::string statePathValueToString(const void* value, std::size_t size) {
  if (value == nullptr || size == 0 || size > kMaxWorkerStatePathBytes + 1) {
    return "";
  }
  const auto* bytes = static_cast<const char*>(value);
  std::size_t length = 0;
  while (length < size && bytes[length] != '\0') {
    ++length;
  }
  if (length == size) {
    return "";
  }
  return std::string(bytes, bytes + length);
}

LV2_State_Status storeLv2StateProperty(
    LV2_State_Handle handle,
    std::uint32_t key,
    const void* value,
    std::size_t size,
    std::uint32_t type,
    std::uint32_t flags) {
  auto* context = static_cast<Lv2StateSaveContext*>(handle);
  if (context == nullptr || context->mapper == nullptr || context->properties == nullptr || value == nullptr || size == 0) {
    return kLv2StateErrUnknown;
  }
  if (size > kMaxWorkerStatePropertyBytes ||
      context->totalValueBytes + size > kMaxWorkerStateBytes / 2 ||
      context->properties->size() >= kMaxWorkerStateProperties) {
    return kLv2StateErrNoSpace;
  }

  const char* keyUri = context->mapper->unmap(key);
  const char* typeUri = context->mapper->unmap(type);
  if (keyUri == nullptr || typeUri == nullptr || !isValidStateUri(keyUri) || !isValidStateUri(typeUri)) {
    return kLv2StateErrBadType;
  }
  if (type == kUridAtomPath) {
    if ((flags & kLv2StateIsPod) == 0 || (flags & kLv2StateIsNative) != 0 ||
        context->fileBroker == nullptr || context->files == nullptr) {
      return kLv2StateErrBadFlags;
    }
    const auto abstractPath = statePathValueToString(value, size);
    if (abstractPath.empty() ||
        !context->fileBroker->recordFile(abstractPath, *context->files, context->totalFileBytes)) {
      return kLv2StateErrNoSpace;
    }
  } else if (!isPortablePodState(flags)) {
    return kLv2StateErrBadFlags;
  }

  auto* bytes = static_cast<const std::uint8_t*>(value);
  context->properties->push_back(Lv2StateProperty{
      keyUri,
      typeUri,
      flags,
      std::vector<std::uint8_t>(bytes, bytes + size)});
  context->totalValueBytes += size;
  return kLv2StateSuccess;
}

const void* retrieveLv2StateProperty(
    LV2_State_Handle handle,
    std::uint32_t key,
    std::size_t* size,
    std::uint32_t* type,
    std::uint32_t* flags) {
  auto* context = static_cast<Lv2StateRestoreContext*>(handle);
  if (context == nullptr || context->properties == nullptr) {
    return nullptr;
  }
  for (const auto& property : *context->properties) {
    if (property.key != key) {
      continue;
    }
    if (size != nullptr) {
      *size = property.value.size();
    }
    if (type != nullptr) {
      *type = property.type;
    }
    if (flags != nullptr) {
      *flags = property.flags;
    }
    return property.value.data();
  }
  return nullptr;
}

std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes) {
  if (value.size() > maxBytes) {
    value.resize(maxBytes);
  }
  return value;
}

bool blockContainsUri(const std::string& block, const char* prefixedName, const char* uri) {
  return block.find(prefixedName) != std::string::npos || block.find(uri) != std::string::npos;
}

std::uint32_t boundedLatencySamples(double value) {
  if (!std::isfinite(value) || value <= 0.0) {
    return 0;
  }
  return static_cast<std::uint32_t>(
      std::clamp(std::llround(value), 0LL, static_cast<long long>(kMaxWorkerLatencySamples)));
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

std::string mainOutputBusBlockToJson(const std::vector<std::vector<float>>& channels) {
  const auto channelsJson = audioChannelsToJson(channels);
  return std::string("{\"channels\":") + channelsJson +
      ",\"outputBuses\":[{\"index\":0,\"channels\":" + channelsJson + "}]}";
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
      std::vector<std::vector<float>> inputChannels,
      HostTransportContext transport) {
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
    renderSegments(frames, transport);
    pendingMidiMessages_.clear();
    for (auto& channel : outputBuffers_) {
      for (auto& sample : channel) {
        sample = sanitizeSample(sample);
      }
    }
    sampleTime_ = std::min(
        static_cast<double>(kMaxWorkerTransportSamplePosition),
        static_cast<double>(transport.samplePosition) + frames);
    return outputBuffers_;
  }

  double sampleTime() const {
    return sampleTime_;
  }

  void enqueueMidiEvents(std::vector<PendingMidiMessage> messages) {
    if (messages.empty()) {
      return;
    }
    const auto capacity = kMaxWorkerMidiEvents - std::min<std::size_t>(pendingMidiMessages_.size(), kMaxWorkerMidiEvents);
    if (messages.size() > capacity) {
      throw std::runtime_error("too_many_queued_midi_events");
    }
    pendingMidiMessages_.insert(pendingMidiMessages_.end(), messages.begin(), messages.end());
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
      output << parameterInfoToJson(ports_[portIndex], ports_[portIndex].value);
      first = false;
      ++emitted;
    }
    output << "]}";
    return output.str();
  }

  std::string setParameter(const std::string& parameterId, double value, std::uint32_t sampleOffset) {
    for (const auto portIndex : inputControlPortIndexes_) {
      auto& port = ports_[portIndex];
      if (parameterIdForPort(port) != parameterId && std::to_string(port.index) != parameterId) {
        continue;
      }
      const auto normalized = std::clamp(value, 0.0, 1.0);
      const auto plainValue = plainValueForPort(port, normalized);
      if (sampleOffset == 0) {
        port.value = plainValue;
      } else {
        if (pendingParameterChanges_.size() >= kMaxWorkerParameterChanges) {
          throw std::runtime_error("too_many_queued_parameter_changes");
        }
        pendingParameterChanges_.push_back(PendingParameterChange{
            parameterIdForPort(port),
            normalized,
            std::clamp<std::uint32_t>(sampleOffset, 0, maxBlockSize_ - 1)});
      }
      return std::string("{\"parameter\":") + parameterInfoToJson(port, plainValue) + "}";
    }
    throw std::runtime_error("unknown_parameter");
  }

  std::string latencyToJson() {
    if (latencyPortIndex_) {
      refreshInstantOutputPorts();
    }
    const auto latencySamples = latencyPortIndex_
        ? boundedLatencySamples(ports_[*latencyPortIndex_].value)
        : 0U;
    return std::string("{\"latencySamples\":") + std::to_string(latencySamples) + "}";
  }

  std::string tailTimeToJson() const {
    return "{\"tailSamples\":0,\"infiniteTail\":false}";
  }

  std::string stateToJson() {
    const auto state = stateBase64();
    return std::string("{\"state\":\"") + state + "\"}";
  }

  std::string setState(const std::string& stateText) {
    if (stateText == "-") {
      return "{\"ok\":true}";
    }
    restoreState(stateText);
    return "{\"ok\":true}";
  }

  std::string layoutToJson() const {
    std::ostringstream output;
    output << "{\"requestedInputChannels\":" << requestedInputChannels_
           << ",\"requestedOutputChannels\":" << requestedOutputChannels_
           << ",\"inputChannels\":" << inputChannels_
           << ",\"outputChannels\":" << outputChannels_
           << ",\"inputBuses\":" << (inputChannels_ > 0 ? 1 : 0)
           << ",\"outputBuses\":1"
           << ",\"inputBusLayouts\":" << mainBusLayoutToJson("input", inputChannels_, inputChannels_ > 0)
           << ",\"outputBusLayouts\":" << mainBusLayoutToJson("output", outputChannels_, true)
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

private:
  static std::string mainBusLayoutToJson(const char* direction, std::uint32_t channels, bool active) {
    const std::string directionText(direction);
    if (!active && directionText == "input") {
      return "[]";
    }
    std::ostringstream output;
    output << "[{\"index\":0"
           << ",\"direction\":\"" << directionText << "\""
           << ",\"mediaType\":\"audio\""
           << ",\"name\":\"" << (directionText == "input" ? "Main Input" : "Main Output") << "\""
           << ",\"type\":\"main\""
           << ",\"channels\":" << std::min<std::uint32_t>(channels, kMaxWorkerAudioPorts)
           << ",\"active\":" << (active ? "true" : "false")
           << "}]";
    return output.str();
  }

  std::string stateBase64() {
    std::ostringstream state;
    state << kLv2StateMagic << "\n";
    state << std::setprecision(9);
    for (const auto portIndex : inputControlPortIndexes_) {
      const auto& port = ports_[portIndex];
      state << "p " << port.index << " " << sanitizeStateValue(port.value) << "\n";
    }
    const auto extensionState = extensionStateProperties();
    for (const auto& property : extensionState.properties) {
      state << "s "
            << stateStringToBase64(property.keyUri) << " "
            << stateStringToBase64(property.typeUri) << " "
            << property.flags << " "
            << base64Encode(property.value.data(), property.value.size()) << "\n";
    }
    for (const auto& file : extensionState.files) {
      state << "f "
            << stateStringToBase64(file.abstractPath) << " "
            << base64Encode(file.value.data(), file.value.size()) << "\n";
    }
    const auto text = state.str();
    if (text.size() > kMaxWorkerStateBytes) {
      throw std::runtime_error("state_too_large");
    }
    return base64Encode(reinterpret_cast<const std::uint8_t*>(text.data()), text.size());
  }

  void restoreState(const std::string& encodedState) {
    const auto decoded = base64Decode(encodedState, kMaxWorkerStateBytes);
    const std::string text(decoded.begin(), decoded.end());
    std::stringstream lines(text);
    std::string line;
    if (!std::getline(lines, line)) {
      throw std::runtime_error("invalid_lv2_state");
    }
    if (line == kLv2ControlStateMagic) {
      restoreControlStateLines(lines);
      return;
    }
    if (line != kLv2StateMagic) {
      throw std::runtime_error("invalid_lv2_state");
    }

    std::size_t restored = 0;
    std::size_t totalExtensionBytes = 0;
    std::size_t totalFileBytes = 0;
    std::vector<Lv2RestoredStateProperty> extensionProperties;
    std::vector<Lv2StateFile> extensionFiles;
    while (std::getline(lines, line)) {
      if (line.empty()) {
        continue;
      }
      if (++restored > kMaxWorkerParameters + kMaxWorkerStateProperties) {
        throw std::runtime_error("state_too_large");
      }

      std::stringstream entry(line);
      std::string prefix;
      entry >> prefix;
      if (prefix == "p") {
        restoreControlStateEntry(entry);
        continue;
      }
      if (prefix == "s") {
        std::string keyText;
        std::string typeText;
        std::string flagsText;
        std::string valueText;
        entry >> keyText;
        entry >> typeText;
        entry >> flagsText;
        entry >> valueText;
        std::string extra;
        entry >> extra;
        std::uint32_t flags = 0;
        if (!extra.empty() || !parseUint32Arg(flagsText.c_str(), 0, 0xFFFFFFFFU, flags)) {
          throw std::runtime_error("invalid_lv2_state");
        }

        const auto keyUri = base64ToStateString(keyText, kMaxWorkerUriBytes);
        const auto typeUri = base64ToStateString(typeText, kMaxWorkerUriBytes);
        auto value = base64Decode(valueText, kMaxWorkerStatePropertyBytes);
        if (!isValidStateUri(keyUri) || !isValidStateUri(typeUri) || value.empty() || !isPortablePodState(flags)) {
          throw std::runtime_error("invalid_lv2_state");
        }
        totalExtensionBytes += value.size();
        if (totalExtensionBytes > kMaxWorkerStateBytes / 2) {
          throw std::runtime_error("state_too_large");
        }
        const auto key = uridMapper_.map(keyUri.c_str());
        const auto type = uridMapper_.map(typeUri.c_str());
        if (key == 0 || type == 0) {
          throw std::runtime_error("invalid_lv2_state");
        }
        if (extensionProperties.size() >= kMaxWorkerStateProperties) {
          throw std::runtime_error("state_too_large");
        }
        extensionProperties.push_back(Lv2RestoredStateProperty{key, type, flags, std::move(value)});
        continue;
      }
      if (prefix == "f") {
        std::string pathText;
        std::string valueText;
        entry >> pathText;
        entry >> valueText;
        std::string extra;
        entry >> extra;
        if (!extra.empty() || extensionFiles.size() >= kMaxWorkerStateFiles) {
          throw std::runtime_error("invalid_lv2_state");
        }
        auto abstractPath = base64ToStateString(pathText, kMaxWorkerStatePathBytes);
        auto value = base64Decode(valueText, kMaxWorkerStateFileBytes);
        if (abstractPath.empty() || value.empty()) {
          throw std::runtime_error("invalid_lv2_state");
        }
        totalFileBytes += value.size();
        if (totalFileBytes > kMaxWorkerStateFileTotalBytes) {
          throw std::runtime_error("state_too_large");
        }
        extensionFiles.push_back(Lv2StateFile{std::move(abstractPath), std::move(value)});
        continue;
      }
      throw std::runtime_error("invalid_lv2_state");
    }
    restoreExtensionState(extensionProperties, extensionFiles);
  }

  void restoreControlStateLines(std::stringstream& lines) {
    std::size_t restored = 0;
    std::string line;
    while (std::getline(lines, line)) {
      if (line.empty()) {
        continue;
      }
      if (++restored > kMaxWorkerParameters) {
        throw std::runtime_error("state_too_large");
      }
      std::stringstream entry(line);
      std::string prefix;
      entry >> prefix;
      if (prefix != "p") {
        throw std::runtime_error("invalid_lv2_state");
      }
      restoreControlStateEntry(entry);
    }
  }

  void restoreControlStateEntry(std::stringstream& entry) {
    std::string portIndexText;
    std::string valueText;
    entry >> portIndexText;
    entry >> valueText;
    std::string extra;
    entry >> extra;
    std::uint32_t portIndex = 0;
    double value = 0.0;
    if (!extra.empty() ||
        !parseUint32Arg(portIndexText.c_str(), 0, kMaxWorkerPortIndex, portIndex) ||
        !parseStateValue(valueText, value)) {
      throw std::runtime_error("invalid_lv2_state");
    }

    for (const auto controlPortIndex : inputControlPortIndexes_) {
      auto& port = ports_[controlPortIndex];
      if (port.index == portIndex) {
        port.value = static_cast<float>(std::clamp(
            value,
            static_cast<double>(port.minimum),
            static_cast<double>(port.maximum)));
        break;
      }
    }
  }

  Lv2SavedExtensionState extensionStateProperties() {
    Lv2SavedExtensionState savedState;
    if (stateInterface_ == nullptr || stateInterface_->save == nullptr || handle_ == nullptr) {
      return savedState;
    }

    Lv2StateFileBroker fileBroker;
    LV2_URID_Map uridMap {&uridMapper_, &mapLv2Urid};
    LV2_URID_Unmap uridUnmap {&uridMapper_, &unmapLv2Urid};
    LV2_State_Map_Path mapPath {&fileBroker, &abstractLv2StatePath, &absoluteLv2StatePath};
    LV2_State_Make_Path makePath {&fileBroker, &makeLv2StatePath};
    LV2_State_Free_Path freePath {&fileBroker, &freeLv2StatePath};
    LV2_Feature uridMapFeature {kLv2UridMapUri, &uridMap};
    LV2_Feature uridUnmapFeature {kLv2UridUnmapUri, &uridUnmap};
    LV2_Feature mapPathFeature {kLv2StateMapPathUri, &mapPath};
    LV2_Feature makePathFeature {kLv2StateMakePathUri, &makePath};
    LV2_Feature freePathFeature {kLv2StateFreePathUri, &freePath};
    const LV2_Feature* const features[] = {
        &uridMapFeature,
        &uridUnmapFeature,
        &mapPathFeature,
        &makePathFeature,
        &freePathFeature,
        nullptr};
    Lv2StateSaveContext context {
        &uridMapper_,
        &savedState.properties,
        &savedState.files,
        &fileBroker,
        0,
        0};
    const auto status = stateInterface_->save(
        handle_,
        &storeLv2StateProperty,
        &context,
        kLv2StateIsPod | kLv2StateIsPortable,
        features);
    if (status != kLv2StateSuccess) {
      throw std::runtime_error("lv2_state_save_failed");
    }
    return savedState;
  }

  void restoreExtensionState(
      const std::vector<Lv2RestoredStateProperty>& properties,
      const std::vector<Lv2StateFile>& files) {
    if (properties.empty() && files.empty()) {
      return;
    }
    if (stateInterface_ == nullptr || stateInterface_->restore == nullptr || handle_ == nullptr) {
      throw std::runtime_error("lv2_state_extension_unavailable");
    }

    Lv2StateFileBroker fileBroker;
    if (!fileBroker.materializeFiles(files)) {
      throw std::runtime_error("lv2_state_file_restore_failed");
    }
    LV2_URID_Map uridMap {&uridMapper_, &mapLv2Urid};
    LV2_URID_Unmap uridUnmap {&uridMapper_, &unmapLv2Urid};
    LV2_State_Map_Path mapPath {&fileBroker, &abstractLv2StatePath, &absoluteLv2StatePath};
    LV2_State_Free_Path freePath {&fileBroker, &freeLv2StatePath};
    LV2_Feature uridMapFeature {kLv2UridMapUri, &uridMap};
    LV2_Feature uridUnmapFeature {kLv2UridUnmapUri, &uridUnmap};
    LV2_Feature mapPathFeature {kLv2StateMapPathUri, &mapPath};
    LV2_Feature freePathFeature {kLv2StateFreePathUri, &freePath};
    const LV2_Feature* const features[] = {
        &uridMapFeature,
        &uridUnmapFeature,
        &mapPathFeature,
        &freePathFeature,
        nullptr};
    Lv2StateRestoreContext context {&properties};
    const bool reactivate = activated_ && descriptor_->deactivate != nullptr && descriptor_->activate != nullptr;
    if (reactivate) {
      descriptor_->deactivate(handle_);
      activated_ = false;
    }
    try {
      const auto status = stateInterface_->restore(handle_, &retrieveLv2StateProperty, &context, 0, features);
      if (status != kLv2StateSuccess) {
        throw std::runtime_error("lv2_state_restore_failed");
      }
    } catch (...) {
      if (reactivate) {
        descriptor_->activate(handle_);
        activated_ = true;
      }
      throw;
    }
    if (reactivate) {
      descriptor_->activate(handle_);
      activated_ = true;
    }
  }

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
        if (port.reportsLatency && !latencyPortIndex_) {
          latencyPortIndex_ = index;
        }
      } else if (port.type == Lv2PortType::Midi && port.direction == Lv2PortDirection::Input) {
        inputMidiPortIndexes_.push_back(index);
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
        if (descriptor_->extension_data != nullptr) {
          auto* stateInterface = static_cast<const LV2_State_Interface*>(descriptor_->extension_data(kLv2StateInterfaceUri));
          if (stateInterface != nullptr && (stateInterface->save != nullptr || stateInterface->restore != nullptr)) {
            stateInterface_ = stateInterface;
          }
        }
        return;
      }
    }

    throw std::runtime_error("LV2 descriptor did not match the bundle plugin URI.");
  }

  void instantiate() {
    LV2_URID_Map uridMap {&uridMapper_, &mapLv2Urid};
    LV2_URID_Unmap uridUnmap {&uridMapper_, &unmapLv2Urid};
    LV2_Feature uridMapFeature {kLv2UridMapUri, &uridMap};
    LV2_Feature uridUnmapFeature {kLv2UridUnmapUri, &uridUnmap};
    const LV2_Feature* const features[] = {&uridMapFeature, &uridUnmapFeature, nullptr};
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
    midiBuffers_.assign(inputMidiPortIndexes_.size(), emptyMidiSequenceBuffer());
    connectPorts(0);
    if (descriptor_->activate != nullptr) {
      descriptor_->activate(handle_);
      activated_ = true;
    }
  }

  void renderSegments(std::uint32_t frames, const HostTransportContext& transport) {
    if (pendingParameterChanges_.empty()) {
      runSegment(0, frames, frames, transport);
      return;
    }

    auto parameterEvents = std::move(pendingParameterChanges_);
    pendingParameterChanges_.clear();
    std::stable_sort(parameterEvents.begin(), parameterEvents.end(), [](const auto& left, const auto& right) {
      return left.sampleOffset < right.sampleOffset;
    });

    std::size_t eventIndex = 0;
    std::uint32_t frameOffset = 0;
    while (frameOffset < frames) {
      while (eventIndex < parameterEvents.size() &&
          std::clamp<std::uint32_t>(parameterEvents[eventIndex].sampleOffset, 0, frames - 1) <= frameOffset) {
        applyParameterChange(parameterEvents[eventIndex]);
        ++eventIndex;
      }

      std::uint32_t nextOffset = frames;
      if (eventIndex < parameterEvents.size()) {
        nextOffset = std::clamp<std::uint32_t>(parameterEvents[eventIndex].sampleOffset, 0, frames - 1);
      }
      runSegment(frameOffset, nextOffset - frameOffset, frames, transport);
      frameOffset = nextOffset;
    }
  }

  void runSegment(
      std::uint32_t frameOffset,
      std::uint32_t frames,
      std::uint32_t totalFrames,
      const HostTransportContext& transport) {
    if (frames == 0) {
      return;
    }
    prepareMidiBuffers(frameOffset, frames, totalFrames, transport);
    connectPorts(frameOffset);
    descriptor_->run(handle_, frames);
  }

  void refreshInstantOutputPorts() {
    if (handle_ == nullptr || descriptor_ == nullptr || descriptor_->run == nullptr) {
      return;
    }
    prepareEmptyMidiBuffers();
    connectPorts(0);
    descriptor_->run(handle_, 0);
  }

  void applyParameterChange(const PendingParameterChange& change) {
    for (const auto portIndex : inputControlPortIndexes_) {
      auto& port = ports_[portIndex];
      if (parameterIdForPort(port) == change.parameterId || std::to_string(port.index) == change.parameterId) {
        port.value = plainValueForPort(port, change.normalizedValue);
        return;
      }
    }
  }

  void connectPorts(std::uint32_t frameOffset) {
    if (handle_ == nullptr || descriptor_ == nullptr) {
      return;
    }

    for (std::size_t channel = 0; channel < inputPortIndexes_.size(); ++channel) {
      descriptor_->connect_port(
          handle_,
          ports_[inputPortIndexes_[channel]].index,
          inputBuffers_.empty() ? nullptr : inputBuffers_[channel].data() + frameOffset);
    }
    for (std::size_t channel = 0; channel < outputPortIndexes_.size(); ++channel) {
      descriptor_->connect_port(
          handle_,
          ports_[outputPortIndexes_[channel]].index,
          outputBuffers_.empty() ? nullptr : outputBuffers_[channel].data() + frameOffset);
    }
    for (const auto portIndex : inputControlPortIndexes_) {
      descriptor_->connect_port(handle_, ports_[portIndex].index, &ports_[portIndex].value);
    }
    for (const auto portIndex : outputControlPortIndexes_) {
      descriptor_->connect_port(handle_, ports_[portIndex].index, &ports_[portIndex].value);
    }
    for (std::size_t index = 0; index < inputMidiPortIndexes_.size(); ++index) {
      descriptor_->connect_port(
          handle_,
          ports_[inputMidiPortIndexes_[index]].index,
          index < midiBuffers_.size() ? midiBuffers_[index].data() : nullptr);
    }
  }

  std::vector<std::uint64_t> emptyMidiSequenceBuffer() const {
    Lv2Port emptyPort;
    emptyPort.acceptsMidi = true;
    return midiSequenceBuffer(emptyPort, {}, 0, maxBlockSize_, maxBlockSize_, HostTransportContext {});
  }

  void prepareMidiBuffers(
      std::uint32_t frameOffset,
      std::uint32_t frames,
      std::uint32_t totalFrames,
      const HostTransportContext& transport) {
    midiBuffers_.resize(inputMidiPortIndexes_.size());
    for (std::size_t index = 0; index < inputMidiPortIndexes_.size(); ++index) {
      const auto& port = ports_[inputMidiPortIndexes_[index]];
      midiBuffers_[index] = midiSequenceBuffer(port, pendingMidiMessages_, frameOffset, frames, totalFrames, transport);
    }
  }

  void prepareEmptyMidiBuffers() {
    midiBuffers_.resize(inputMidiPortIndexes_.size());
    for (std::size_t index = 0; index < inputMidiPortIndexes_.size(); ++index) {
      const auto& port = ports_[inputMidiPortIndexes_[index]];
      midiBuffers_[index] = midiSequenceBuffer(port, {}, 0, maxBlockSize_, maxBlockSize_, HostTransportContext {});
    }
  }

  enum class Lv2AtomScalarKind {
    Int,
    Long,
    Float,
    Double,
  };

  struct Lv2AtomScalarProperty {
    LV2_URID key = 0;
    Lv2AtomScalarKind kind = Lv2AtomScalarKind::Float;
    double value = 0.0;
  };

  static LV2_URID atomTypeForScalar(Lv2AtomScalarKind kind) {
    switch (kind) {
      case Lv2AtomScalarKind::Int:
        return kUridAtomInt;
      case Lv2AtomScalarKind::Long:
        return kUridAtomLong;
      case Lv2AtomScalarKind::Float:
        return kUridAtomFloat;
      case Lv2AtomScalarKind::Double:
        return kUridAtomDouble;
    }
    return kUridAtomFloat;
  }

  static std::size_t atomScalarBodySize(Lv2AtomScalarKind kind) {
    switch (kind) {
      case Lv2AtomScalarKind::Int:
        return sizeof(std::int32_t);
      case Lv2AtomScalarKind::Long:
        return sizeof(std::int64_t);
      case Lv2AtomScalarKind::Float:
        return sizeof(float);
      case Lv2AtomScalarKind::Double:
        return sizeof(double);
    }
    return sizeof(float);
  }

  static std::size_t atomScalarPropertyBytes(Lv2AtomScalarKind kind) {
    return alignAtomSize(sizeof(LV2_Atom_Property_Body) + atomScalarBodySize(kind));
  }

  static void writeAtomScalarBody(std::uint8_t* body, const Lv2AtomScalarProperty& property) {
    switch (property.kind) {
      case Lv2AtomScalarKind::Int: {
        const auto value = static_cast<std::int32_t>(std::clamp(property.value, -2147483648.0, 2147483647.0));
        std::memcpy(body, &value, sizeof(value));
        return;
      }
      case Lv2AtomScalarKind::Long: {
        const auto value = static_cast<std::int64_t>(std::clamp(
            property.value,
            static_cast<double>(-kMaxWorkerTransportSamplePosition),
            static_cast<double>(kMaxWorkerTransportSamplePosition)));
        std::memcpy(body, &value, sizeof(value));
        return;
      }
      case Lv2AtomScalarKind::Float: {
        const auto value = static_cast<float>(property.value);
        std::memcpy(body, &value, sizeof(value));
        return;
      }
      case Lv2AtomScalarKind::Double: {
        const auto value = property.value;
        std::memcpy(body, &value, sizeof(value));
        return;
      }
    }
  }

  static std::vector<Lv2AtomScalarProperty> transportScalarProperties(const HostTransportContext& transport) {
    std::vector<Lv2AtomScalarProperty> properties;
    properties.reserve(8);
    properties.push_back(Lv2AtomScalarProperty{
        kUridTimeFrame,
        Lv2AtomScalarKind::Long,
        static_cast<double>(transport.samplePosition)});
    properties.push_back(Lv2AtomScalarProperty{
        kUridTimeSpeed,
        Lv2AtomScalarKind::Float,
        transport.playing ? 1.0 : 0.0});

    const auto beatFactor = transport.hasTimeSignature
        ? static_cast<double>(transport.timeSignatureDenominator) / 4.0
        : 1.0;
    if (transport.hasProjectTimeMusic) {
      properties.push_back(Lv2AtomScalarProperty{
          kUridTimeBeat,
          Lv2AtomScalarKind::Double,
          transport.projectTimeMusic * beatFactor});
    }
    if (transport.hasProjectTimeMusic && transport.hasBarPositionMusic) {
      auto barBeat = (transport.projectTimeMusic - transport.barPositionMusic) * beatFactor;
      if (transport.hasTimeSignature) {
        barBeat = std::clamp(barBeat, 0.0, static_cast<double>(transport.timeSignatureNumerator));
      }
      properties.push_back(Lv2AtomScalarProperty{
          kUridTimeBarBeat,
          Lv2AtomScalarKind::Float,
          std::max(0.0, barBeat)});
    }
    if (transport.hasTimeSignature) {
      properties.push_back(Lv2AtomScalarProperty{
          kUridTimeBeatUnit,
          Lv2AtomScalarKind::Int,
          static_cast<double>(transport.timeSignatureDenominator)});
      properties.push_back(Lv2AtomScalarProperty{
          kUridTimeBeatsPerBar,
          Lv2AtomScalarKind::Float,
          static_cast<double>(transport.timeSignatureNumerator)});
    }
    if (transport.hasTempo) {
      properties.push_back(Lv2AtomScalarProperty{
          kUridTimeBeatsPerMinute,
          Lv2AtomScalarKind::Float,
          transport.tempo});
    }
    return properties;
  }

  static std::size_t transportObjectBodyBytes(const std::vector<Lv2AtomScalarProperty>& properties) {
    std::size_t bytes = sizeof(LV2_Atom_Object_Body);
    for (const auto& property : properties) {
      bytes += atomScalarPropertyBytes(property.kind);
    }
    return bytes;
  }

  static std::size_t writeTransportEvent(
      std::uint8_t* bytes,
      std::size_t offset,
      const std::vector<Lv2AtomScalarProperty>& properties) {
    const auto objectBodyBytes = transportObjectBodyBytes(properties);
    auto* event = reinterpret_cast<LV2_Atom_Event*>(bytes + offset);
    event->time.frames = 0;
    event->body.type = kUridAtomObject;
    event->body.size = static_cast<std::uint32_t>(objectBodyBytes);

    auto* objectBody = reinterpret_cast<LV2_Atom_Object_Body*>(bytes + offset + sizeof(LV2_Atom_Event));
    objectBody->id = 0;
    objectBody->otype = kUridTimePosition;

    std::size_t propertyOffset = offset + sizeof(LV2_Atom_Event) + sizeof(LV2_Atom_Object_Body);
    for (const auto& property : properties) {
      auto* propertyBody = reinterpret_cast<LV2_Atom_Property_Body*>(bytes + propertyOffset);
      propertyBody->key = property.key;
      propertyBody->context = 0;
      propertyBody->value.type = atomTypeForScalar(property.kind);
      propertyBody->value.size = static_cast<std::uint32_t>(atomScalarBodySize(property.kind));
      writeAtomScalarBody(bytes + propertyOffset + sizeof(LV2_Atom_Property_Body), property);
      propertyOffset += atomScalarPropertyBytes(property.kind);
    }
    return offset + alignAtomSize(sizeof(LV2_Atom_Event) + objectBodyBytes);
  }

  std::vector<std::uint64_t> midiSequenceBuffer(
      const Lv2Port& port,
      const std::vector<PendingMidiMessage>& messages,
      std::uint32_t frameOffset,
      std::uint32_t frames,
      std::uint32_t totalFrames,
      const HostTransportContext& transport) const {
    const auto eventBytes = alignAtomSize(sizeof(LV2_Atom_Event) + 3);
    const auto includeTransport = port.acceptsTimePosition && transport.explicitTransport && frameOffset == 0;
    const auto transportProperties = includeTransport
        ? transportScalarProperties(transport)
        : std::vector<Lv2AtomScalarProperty> {};
    const auto transportEventBytes = includeTransport
        ? alignAtomSize(sizeof(LV2_Atom_Event) + transportObjectBodyBytes(transportProperties))
        : std::size_t {0};
    const auto segmentEnd = static_cast<std::uint64_t>(frameOffset) + frames;
    const auto lastFrame = totalFrames > 0 ? totalFrames - 1 : 0;
    std::size_t boundedCount = 0;
    if (port.acceptsMidi) {
      for (const auto& message : messages) {
        const auto effectiveOffset = std::min<std::uint32_t>(message.sampleOffset, lastFrame);
        if (effectiveOffset >= frameOffset && effectiveOffset < segmentEnd) {
          ++boundedCount;
        }
      }
    }
    boundedCount = std::min<std::size_t>(boundedCount, kMaxWorkerMidiEvents);
    const auto totalBytes = sizeof(LV2_Atom_Sequence) + transportEventBytes + eventBytes * boundedCount;
    std::vector<std::uint64_t> storage((alignAtomSize(totalBytes) + sizeof(std::uint64_t) - 1) / sizeof(std::uint64_t), 0);
    auto* sequence = reinterpret_cast<LV2_Atom_Sequence*>(storage.data());
    sequence->atom.type = kUridAtomSequence;
    sequence->atom.size = static_cast<std::uint32_t>(totalBytes - sizeof(LV2_Atom));
    sequence->body.unit = kUridAtomFrameTime;
    sequence->body.pad = 0;

    auto* bytes = reinterpret_cast<std::uint8_t*>(storage.data());
    std::size_t offset = sizeof(LV2_Atom_Sequence);
    if (includeTransport) {
      offset = writeTransportEvent(bytes, offset, transportProperties);
    }
    std::size_t emitted = 0;
    if (!port.acceptsMidi) {
      return storage;
    }
    for (const auto& message : messages) {
      if (emitted >= boundedCount) {
        break;
      }
      const auto effectiveOffset = std::min<std::uint32_t>(message.sampleOffset, lastFrame);
      if (effectiveOffset < frameOffset || effectiveOffset >= segmentEnd) {
        continue;
      }
      auto* event = reinterpret_cast<LV2_Atom_Event*>(bytes + offset);
      event->time.frames = effectiveOffset - frameOffset;
      event->body.type = kUridMidiEvent;
      event->body.size = 3;
      auto* body = bytes + offset + sizeof(LV2_Atom_Event);
      body[0] = message.status;
      body[1] = message.data1;
      body[2] = message.data2;
      offset += eventBytes;
      ++emitted;
    }
    return storage;
  }

  std::string parameterIdForPort(const Lv2Port& port) const {
    return port.symbol.empty() ? std::to_string(port.index) : port.symbol;
  }

  float plainValueForPort(const Lv2Port& port, double normalizedValue) const {
    const auto range = static_cast<double>(port.maximum) - static_cast<double>(port.minimum);
    return quantizedPlainValueForPort(
        port,
        static_cast<double>(port.minimum) + range * std::clamp(normalizedValue, 0.0, 1.0),
        normalizedValue);
  }

  double normalizedValueForPort(const Lv2Port& port, float plainValue) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    if (std::abs(maxValue - minValue) < 0.000001) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(plainValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  double defaultNormalizedValueForPort(const Lv2Port& port) const {
    return normalizedValueForPort(port, quantizedPlainValueForPort(port, port.defaultValue, defaultNormalizedHint(port)));
  }

  float quantizedPlainValueForPort(const Lv2Port& port, double plainValue, double normalizedHint) const {
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

  double defaultNormalizedHint(const Lv2Port& port) const {
    const auto minValue = static_cast<double>(port.minimum);
    const auto maxValue = static_cast<double>(port.maximum);
    if (std::abs(maxValue - minValue) < 0.000001) {
      return 0.0;
    }
    return std::clamp((static_cast<double>(port.defaultValue) - minValue) / (maxValue - minValue), 0.0, 1.0);
  }

  std::uint32_t stepCountForPort(const Lv2Port& port) const {
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

  std::string parameterInfoToJson(const Lv2Port& port, float plainValue) const {
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

  std::string bundlePath_;
  Lv2BundleMetadata metadata_;
  std::unique_ptr<void, DlCloser> module_;
  Lv2DescriptorFunction descriptorFunction_ = nullptr;
  const LV2_Descriptor* descriptor_ = nullptr;
  const LV2_State_Interface* stateInterface_ = nullptr;
  LV2_Handle handle_ = nullptr;
  Lv2UridMapper uridMapper_;
  double sampleRate_ = 48000.0;
  double sampleTime_ = 0.0;
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
  std::vector<std::size_t> inputMidiPortIndexes_;
  std::optional<std::size_t> latencyPortIndex_;
  std::vector<std::vector<float>> inputBuffers_;
  std::vector<std::vector<float>> outputBuffers_;
  std::vector<std::vector<std::uint64_t>> midiBuffers_;
  std::vector<PendingParameterChange> pendingParameterChanges_;
  std::vector<PendingMidiMessage> pendingMidiMessages_;
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
          int note = 60;
          double velocity = command == "noteOn" ? 0.8 : 0.0;
          int channel = 0;
          int sampleOffset = 0;
          stream >> note >> velocity >> channel >> sampleOffset;
          PendingMidiMessage message;
          message.status = static_cast<std::uint8_t>((command == "noteOn" ? 0x90 : 0x80) | std::clamp(channel, 0, 15));
          message.data1 = static_cast<std::uint8_t>(std::clamp(note, 0, 127));
          message.data2 = command == "noteOn" ? scaled7Bit(std::clamp(velocity, 0.0, 1.0)) : 0;
          message.sampleOffset = static_cast<std::uint32_t>(std::clamp(sampleOffset, 0, static_cast<int>(kMaxWorkerFrames - 1)));
          host.enqueueMidiEvents({message});
          std::cout << "{\"ok\":true}" << std::endl;
          continue;
        }

        if (command == "midi") {
          std::string encodedEvents;
          stream >> encodedEvents;
          std::vector<PendingMidiMessage> messages;
          if (!parseMidiEvents(encodedEvents, messages)) {
            std::cout << "{\"error\":\"invalid_midi_events\"}" << std::endl;
            continue;
          }
          host.enqueueMidiEvents(messages);
          std::cout << "{\"ok\":true,\"eventCount\":" << messages.size() << "}" << std::endl;
          continue;
        }

        if (command == "parameters") {
          std::cout << host.parametersToJson() << std::endl;
          continue;
        }

        if (command == "getState") {
          std::cout << host.stateToJson() << std::endl;
          continue;
        }

        if (command == "setState") {
          std::string stateText;
          stream >> stateText;
          if (stateText.empty()) {
            std::cout << "{\"error\":\"invalid_state_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setState(stateText) << std::endl;
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
          std::uint32_t sampleOffset = 0;
          double value = 0.0;
          stream >> parameterId;
          stream >> valueText;
          stream >> sampleOffsetText;
          if (parameterId.empty() ||
              !parseDoubleArg(valueText.c_str(), 0.0, 1.0, value) ||
              (!sampleOffsetText.empty() && !parseUint32Arg(sampleOffsetText.c_str(), 0, kMaxWorkerFrames - 1, sampleOffset))) {
            std::cout << "{\"error\":\"invalid_parameter_arguments\"}" << std::endl;
            continue;
          }
          std::cout << host.setParameter(parameterId, value, sampleOffset) << std::endl;
          continue;
        }

        if (command == "render") {
          std::uint32_t frames = 128;
          double renderSampleRate = sampleRate;
          std::string encodedChannels;
          std::string encodedInputBuses;
          std::string encodedTransport;
          std::string framesText;
          std::string sampleRateText;
          stream >> framesText;
          stream >> sampleRateText;
          stream >> encodedChannels;
          stream >> encodedInputBuses;
          stream >> encodedTransport;
          (void)encodedInputBuses;
          HostTransportContext transport;
          if (!parseUint32Arg(framesText.c_str(), 1, kMaxWorkerFrames, frames) ||
              !parseSampleRateArg(sampleRateText.c_str(), renderSampleRate) ||
              !parseTransportContext(encodedTransport, host.sampleTime(), transport)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          const auto channels = host.render(frames, renderSampleRate, parseChannels(encodedChannels, frames), transport);
          std::cout << mainOutputBusBlockToJson(channels) << std::endl;
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
  return "Basic LV2 audio/control host worker is available with bounded atom MIDI, atom time-position transport, standard latency output-port reporting, and brokered portable/file-backed state delivery; LV2 UI extensions remain disabled.";
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
