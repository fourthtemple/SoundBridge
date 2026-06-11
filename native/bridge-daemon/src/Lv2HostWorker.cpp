#include "SoundBridge/Lv2HostWorker.h"

#include "SoundBridge/Base64.h"
#include "SoundBridge/Lv2HostWorkerSupport.h"
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

using namespace lv2_worker;

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

struct Lv2AudioBusGroup {
  std::uint32_t index = 0;
  std::string name;
  std::vector<std::size_t> portIndexes;
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

    buildAudioBusGroups();
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
      std::vector<IndexedAudioBus> inputBuses,
      HostTransportContext transport) {
    if (std::abs(sampleRate - sampleRate_) > 0.01) {
      throw std::runtime_error("LV2 worker cannot change sample rate after initialization.");
    }

    frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
    if (inputBuses.empty() && !inputChannels.empty()) {
      inputBuses.push_back(IndexedAudioBus{0, std::move(inputChannels)});
    }
    inputBuffers_.resize(inputPortIndexes_.size());
    outputBuffers_.resize(outputPortIndexes_.size());

    for (std::size_t index = 0; index < inputBuffers_.size(); ++index) {
      inputBuffers_[index].assign(frames, 0.0F);
      copyInputBusChannels(index, inputBuses, frames);
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
           << ",\"inputBuses\":" << inputBusCount()
           << ",\"outputBuses\":" << outputBusCount()
           << ",\"inputBusLayouts\":" << inputBusLayoutsToJson()
           << ",\"outputBusLayouts\":" << outputBusLayoutsToJson()
           << ",\"sampleRate\":" << sampleRate_
           << ",\"maxBlockSize\":" << maxBlockSize_
           << "}";
    return output.str();
  }

  std::string outputAudioToJson(const std::vector<std::vector<float>>& channels) const {
    const auto channelsJson = audioChannelsToJson(channels);
    std::ostringstream output;
    output << "{\"channels\":" << channelsJson << ",\"outputBuses\":[";
    for (std::size_t busIndex = 0; busIndex < outputBusGroups_.size(); ++busIndex) {
      const auto& bus = outputBusGroups_[busIndex];
      if (busIndex > 0) {
        output << ",";
      }
      std::vector<std::vector<float>> busChannels;
      for (const auto portIndex : bus.portIndexes) {
        const auto channelOffset = outputChannelOffsetForPort(portIndex);
        if (channelOffset && *channelOffset < channels.size()) {
          busChannels.push_back(channels[*channelOffset]);
        }
      }
      output << "{\"index\":" << bus.index << ",\"channels\":" << audioChannelsToJson(busChannels) << "}";
    }
    output << "]}";
    return output.str();
  }

private:
  std::uint32_t inputBusCount() const {
    return static_cast<std::uint32_t>(std::min<std::size_t>(inputBusGroups_.size(), kMaxWorkerAudioPorts));
  }

  std::uint32_t outputBusCount() const {
    return static_cast<std::uint32_t>(std::min<std::size_t>(outputBusGroups_.size(), kMaxWorkerAudioPorts));
  }

  std::string inputBusLayoutsToJson() const {
    return busLayoutsToJson(inputBusGroups_, "input");
  }

  std::string outputBusLayoutsToJson() const {
    return busLayoutsToJson(outputBusGroups_, "output");
  }

  std::string busLayoutsToJson(const std::vector<Lv2AudioBusGroup>& groups, const char* direction) const {
    std::ostringstream output;
    output << "[";
    for (std::size_t index = 0; index < groups.size(); ++index) {
      const auto& group = groups[index];
      if (index > 0) {
        output << ",";
      }
      output << "{\"index\":" << group.index
             << ",\"direction\":\"" << direction << "\""
             << ",\"mediaType\":\"audio\""
             << ",\"name\":\"" << jsonEscape(group.name) << "\""
             << ",\"type\":\"" << (group.index == 0 ? "main" : "aux") << "\""
             << ",\"channels\":" << std::min<std::size_t>(group.portIndexes.size(), kMaxWorkerAudioPorts)
             << ",\"active\":true}";
    }
    output << "]";
    return output.str();
  }

  void copyInputBusChannels(
      std::size_t inputBufferIndex,
      const std::vector<IndexedAudioBus>& inputBuses,
      std::uint32_t frames) {
    if (inputBufferIndex >= inputPortIndexes_.size()) {
      return;
    }
    const auto portIndex = inputPortIndexes_[inputBufferIndex];
    for (const auto& busGroup : inputBusGroups_) {
      const auto* busChannels = findBusChannels(inputBuses, busGroup.index);
      if (busChannels == nullptr) {
        continue;
      }
      const auto position = std::find(busGroup.portIndexes.begin(), busGroup.portIndexes.end(), portIndex);
      if (position == busGroup.portIndexes.end()) {
        continue;
      }
      std::fill(inputBuffers_[inputBufferIndex].begin(), inputBuffers_[inputBufferIndex].end(), 0.0F);
      const auto channelIndex = static_cast<std::size_t>(std::distance(busGroup.portIndexes.begin(), position));
      if (channelIndex >= busChannels->size()) {
        continue;
      }
      const auto copyFrames = std::min<std::size_t>(frames, (*busChannels)[channelIndex].size());
      for (std::size_t frame = 0; frame < copyFrames; ++frame) {
        inputBuffers_[inputBufferIndex][frame] = sanitizeSample((*busChannels)[channelIndex][frame]);
      }
    }
  }

  std::optional<std::size_t> outputChannelOffsetForPort(std::size_t portIndex) const {
    const auto position = std::find(outputPortIndexes_.begin(), outputPortIndexes_.end(), portIndex);
    if (position == outputPortIndexes_.end()) {
      return std::nullopt;
    }
    return static_cast<std::size_t>(std::distance(outputPortIndexes_.begin(), position));
  }

  static std::string groupNameFromUri(const std::string& uri, const std::string& fallback) {
    if (uri.empty()) {
      return fallback;
    }
    const auto separator = uri.find_last_of("#/");
    auto name = separator == std::string::npos ? uri : uri.substr(separator + 1);
    if (name.empty()) {
      name = fallback;
    }
    for (auto& character : name) {
      if (character == '_' || character == '-') {
        character = ' ';
      }
    }
    return cappedString(name);
  }

  std::vector<Lv2AudioBusGroup> groupedAudioBuses(
      const std::vector<std::size_t>& portIndexes,
      const std::string& mainGroupUri,
      const char* mainName,
      const char* fallbackPortName) const {
    std::vector<Lv2AudioBusGroup> groups;
    if (portIndexes.empty()) {
      return groups;
    }

    const bool hasDeclaredGroups = std::any_of(portIndexes.begin(), portIndexes.end(), [&](std::size_t portIndex) {
      return !ports_[portIndex].groupUri.empty();
    });
    if (!hasDeclaredGroups) {
      groups.push_back(Lv2AudioBusGroup{0, mainName, portIndexes});
      for (std::size_t offset = 0; offset < portIndexes.size() && groups.size() < kMaxWorkerAudioPorts; ++offset) {
        const auto portIndex = portIndexes[offset];
        const auto fallback = std::string(fallbackPortName) + " " + std::to_string(offset + 1);
        groups.push_back(Lv2AudioBusGroup{
            static_cast<std::uint32_t>(groups.size()),
            ports_[portIndex].name.empty() ? fallback : ports_[portIndex].name,
            {portIndex}});
      }
      return groups;
    }

    std::vector<std::string> orderedGroupUris;
    for (const auto portIndex : portIndexes) {
      const auto& uri = ports_[portIndex].groupUri;
      if (!uri.empty() && std::find(orderedGroupUris.begin(), orderedGroupUris.end(), uri) == orderedGroupUris.end()) {
        orderedGroupUris.push_back(uri);
      }
    }

    std::string effectiveMainUri = mainGroupUri;
    if (effectiveMainUri.empty() ||
        std::find(orderedGroupUris.begin(), orderedGroupUris.end(), effectiveMainUri) == orderedGroupUris.end()) {
      effectiveMainUri = orderedGroupUris.empty() ? std::string {} : orderedGroupUris.front();
    }

    auto appendGroup = [&](const std::string& uri, const std::string& name) {
      if (groups.size() >= kMaxWorkerAudioPorts) {
        return;
      }
      std::vector<std::size_t> members;
      for (const auto portIndex : portIndexes) {
        if (ports_[portIndex].groupUri == uri) {
          members.push_back(portIndex);
        }
      }
      if (!members.empty()) {
        groups.push_back(Lv2AudioBusGroup{static_cast<std::uint32_t>(groups.size()), name, std::move(members)});
      }
    };

    appendGroup(effectiveMainUri, mainName);
    for (const auto& uri : orderedGroupUris) {
      if (uri != effectiveMainUri) {
        appendGroup(uri, groupNameFromUri(uri, std::string(fallbackPortName) + " Group"));
      }
    }
    for (const auto portIndex : portIndexes) {
      if (!ports_[portIndex].groupUri.empty() || groups.size() >= kMaxWorkerAudioPorts) {
        continue;
      }
      groups.push_back(Lv2AudioBusGroup{
          static_cast<std::uint32_t>(groups.size()),
          ports_[portIndex].name.empty() ? std::string(fallbackPortName) : ports_[portIndex].name,
          {portIndex}});
    }
    return groups;
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

  void buildAudioBusGroups() {
    inputBusGroups_ = groupedAudioBuses(
        inputPortIndexes_,
        metadata_.mainInputGroupUri,
        "Main Input",
        "Input Port");
    outputBusGroups_ = groupedAudioBuses(
        outputPortIndexes_,
        metadata_.mainOutputGroupUri,
        "Main Output",
        "Output Port");
    if (!outputPortIndexes_.empty() && outputBusGroups_.empty()) {
      outputBusGroups_.push_back(Lv2AudioBusGroup{0, "Main Output", outputPortIndexes_});
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
  std::vector<Lv2AudioBusGroup> inputBusGroups_;
  std::vector<Lv2AudioBusGroup> outputBusGroups_;
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
          HostTransportContext transport;
          if (!parseUint32Arg(framesText.c_str(), 1, kMaxWorkerFrames, frames) ||
              !parseSampleRateArg(sampleRateText.c_str(), renderSampleRate) ||
              !parseTransportContext(encodedTransport, host.sampleTime(), transport)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          auto channels = parseChannels(encodedChannels, frames);
          std::vector<IndexedAudioBus> inputBuses;
          if (!parseAudioBuses(encodedInputBuses, frames, inputBuses)) {
            std::cout << "{\"error\":\"invalid_render_arguments\"}" << std::endl;
            continue;
          }
          const auto renderedChannels = host.render(
              frames,
              renderSampleRate,
              std::move(channels),
              std::move(inputBuses),
              transport);
          std::cout << host.outputAudioToJson(renderedChannels) << std::endl;
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
  return "Basic LV2 audio/control host worker is available with bounded atom MIDI, atom time-position transport, LV2 port-group bus routing with per-port fallback, standard latency output-port reporting, and brokered portable/file-backed state delivery; LV2 UI extensions remain disabled.";
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
