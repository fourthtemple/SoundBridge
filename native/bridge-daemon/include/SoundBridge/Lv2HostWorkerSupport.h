#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace soundbridge::lv2_worker {

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
constexpr const char* kLv2PortGroupsGroupUri = "http://lv2plug.in/ns/ext/port-groups#group";
constexpr const char* kLv2PortGroupsMainInputUri = "http://lv2plug.in/ns/ext/port-groups#mainInput";
constexpr const char* kLv2PortGroupsMainOutputUri = "http://lv2plug.in/ns/ext/port-groups#mainOutput";
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
constexpr std::uint32_t kUridAtomSequence = 1;
constexpr std::uint32_t kUridAtomFrameTime = 2;
constexpr std::uint32_t kUridMidiEvent = 3;
constexpr std::uint32_t kUridAtomFloat = 4;
constexpr std::uint32_t kUridAtomPath = 5;
constexpr std::uint32_t kUridAtomInt = 6;
constexpr std::uint32_t kUridAtomLong = 7;
constexpr std::uint32_t kUridAtomDouble = 8;
constexpr std::uint32_t kUridAtomObject = 9;
constexpr std::uint32_t kUridTimePosition = 10;
constexpr std::uint32_t kUridTimeFrame = 11;
constexpr std::uint32_t kUridTimeSpeed = 12;
constexpr std::uint32_t kUridTimeBeat = 13;
constexpr std::uint32_t kUridTimeBarBeat = 14;
constexpr std::uint32_t kUridTimeBeatUnit = 15;
constexpr std::uint32_t kUridTimeBeatsPerBar = 16;
constexpr std::uint32_t kUridTimeBeatsPerMinute = 17;
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
  std::string groupUri;
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
  std::string mainInputGroupUri;
  std::string mainOutputGroupUri;
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

struct IndexedAudioBus {
  std::uint32_t index = 0;
  std::vector<std::vector<float>> channels;
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

float sanitizeSample(float value);
float sanitizeStateValue(float value);
bool parseUint32Arg(const char* text, std::uint32_t minValue, std::uint32_t maxValue, std::uint32_t& out);
bool parseDoubleArg(const char* text, double minValue, double maxValue, double& out);
bool parseStateValue(const std::string& text, double& out);
bool parseSampleRateArg(const char* text, double& out);
bool parseTransportContext(const std::string& encoded, double fallbackSampleTime, HostTransportContext& out);
std::uint8_t scaled7Bit(double value);
bool parseMidiEvents(const std::string& encoded, std::vector<PendingMidiMessage>& messages);
std::size_t alignAtomSize(std::size_t size);
std::string stateStringToBase64(const std::string& value);
bool isPortablePodState(std::uint32_t flags);
bool isValidStateUri(const std::string& value);
std::string base64ToStateString(const std::string& encoded, std::size_t maxBytes);
std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes);
std::uint32_t boundedLatencySamples(double value);
Lv2BundleMetadata loadBundleMetadata(const std::filesystem::path& bundlePath);
std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames);
bool parseAudioBuses(const std::string& encoded, std::uint32_t frames, std::vector<IndexedAudioBus>& buses);
const std::vector<std::vector<float>>* findBusChannels(const std::vector<IndexedAudioBus>& buses, std::uint32_t index);
std::string audioChannelsToJson(const std::vector<std::vector<float>>& channels);
std::string lv2OutputBusBlockToJson(const std::vector<std::vector<float>>& channels);

} // namespace soundbridge::lv2_worker
