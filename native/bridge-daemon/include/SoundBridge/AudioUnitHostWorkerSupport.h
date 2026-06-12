#pragma once

#ifdef SOUNDBRIDGE_MACOS

#include <AudioToolbox/AudioToolbox.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace soundbridge::audio_unit_worker {

constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerChannels = 32;
constexpr std::size_t kMaxWorkerMidiEvents = 4096;
constexpr std::size_t kMaxWorkerParameters = 1024;
constexpr std::size_t kMaxWorkerParameterStringBytes = 160;
constexpr std::size_t kMaxWorkerStateBytes = 384 * 1024;
constexpr std::uint32_t kMaxWorkerLatencySamples = 1'048'576;
constexpr std::uint32_t kMaxWorkerTailSamples = 1'048'576;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;
constexpr double kMaxWorkerTransportTempoBpm = 960.0;
constexpr double kMaxWorkerTransportPositionMusic = 1'000'000'000.0;
constexpr long long kMaxWorkerTransportSamplePosition = 9'007'199'254'740'991LL;
constexpr OSStatus kAudioUnitUnimplementedStatus = -4;

struct PendingMidiMessage {
  UInt32 status = 0x90;
  UInt32 data1 = 60;
  UInt32 data2 = 100;
  std::uint32_t sampleOffset = 0;
};

struct IndexedAudioBus {
  std::uint32_t index = 0;
  std::vector<std::vector<float>> channels;
};

struct RenderedAudio {
  std::vector<std::vector<float>> channels;
  std::vector<IndexedAudioBus> outputBuses;
};

struct HostTransportContext {
  bool playing = false;
  bool recording = false;
  bool loopActive = false;
  bool hasTempo = false;
  double tempo = 120.0;
  bool hasTimeSignature = false;
  Float32 timeSignatureNumerator = 4.0F;
  UInt32 timeSignatureDenominator = 4;
  bool hasProjectTimeMusic = false;
  Float64 projectTimeMusic = 0.0;
  bool hasBarPositionMusic = false;
  Float64 barPositionMusic = 0.0;
  bool hasCycle = false;
  Float64 cycleStartMusic = 0.0;
  Float64 cycleEndMusic = 0.0;
  Float64 samplePosition = 0.0;
};

float sanitizeSample(const std::string& text);
bool parseUint32Arg(const char* text, std::uint32_t minValue, std::uint32_t maxValue, std::uint32_t& out);
bool parseDoubleArg(const char* text, double minValue, double maxValue, double& out);
bool parseSampleRateArg(const char* text, double& out);
bool parseTransportContext(const std::string& encoded, double fallbackSampleTime, HostTransportContext& out);
UInt32 scaled7Bit(double value);
bool parseMidiEvents(const std::string& encoded, std::vector<PendingMidiMessage>& messages);
std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes);
std::string cfStringToUtf8(CFStringRef value);
OSType fourCharCodeFromString(const std::string& value);
std::string osStatusText(OSStatus status);
void checkStatus(OSStatus status, const std::string& operation);
bool isUnsupportedMidiStatus(OSStatus status);
AudioUnitParameterValue plainValueForNormalized(const AudioUnitParameterInfo& info, double normalizedValue);
double normalizedValueForPlain(const AudioUnitParameterInfo& info, AudioUnitParameterValue value);
std::string displayValueForParameter(AudioUnit unit, AudioUnitParameterID parameterId, AudioUnitParameterValue plainValue);
std::string parameterInfoToJson(AudioUnit unit, AudioUnitParameterID parameterId, AudioUnitParameterInfo& info);
AudioStreamBasicDescription streamDescription(double sampleRate, std::uint32_t channels);
std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames);
bool parseAudioBuses(const std::string& encoded, std::uint32_t frames, std::vector<IndexedAudioBus>& buses);
const std::vector<std::vector<float>>* findBusChannels(const std::vector<IndexedAudioBus>& buses, std::uint32_t index);
std::string audioChannelsToJson(const std::vector<std::vector<float>>& channels);
std::string renderedAudioToJson(const RenderedAudio& rendered);
std::unique_ptr<AudioBufferList, void (*)(AudioBufferList*)> makeAudioBufferList(
    std::vector<std::vector<float>>& channels,
    std::uint32_t channelCount,
    std::uint32_t frames);

} // namespace soundbridge::audio_unit_worker

#endif
