#pragma once

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstnoteexpression.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "public.sdk/source/vst/hosting/module.h"

#include <cstdint>
#include <string>
#include <vector>

namespace soundbridge::vst3_worker {

constexpr std::uint32_t kMaxWorkerFrames = 8192;
constexpr std::uint32_t kMaxWorkerChannels = 32;
constexpr std::size_t kMaxWorkerMidiEvents = 4096;
constexpr std::size_t kMaxWorkerParameters = 1024;
constexpr std::size_t kMaxWorkerParameterChanges = 4096;
constexpr std::size_t kMaxWorkerParameterStringBytes = 160;
constexpr Steinberg::int32 kMaxWorkerProgramLists = 256;
constexpr Steinberg::int32 kMaxWorkerProgramsPerParameter = 256;
constexpr Steinberg::int32 kMaxWorkerUnits = 1024;
constexpr Steinberg::int32 kMaxWorkerNoteExpressionTypes = 256;
constexpr std::size_t kMaxWorkerStateBytes = 384 * 1024;
constexpr std::uint32_t kMaxWorkerLatencySamples = 1'048'576;
constexpr std::uint32_t kMaxWorkerTailSamples = 1'048'576;
constexpr std::size_t kMaxWorkerLineBytes = 16 * 1024 * 1024;
constexpr double kMinWorkerSampleRate = 8000.0;
constexpr double kMaxWorkerSampleRate = 384000.0;
constexpr double kMaxWorkerTransportTempoBpm = 960.0;
constexpr double kMaxWorkerTransportPositionMusic = 1'000'000'000.0;
constexpr long long kMaxWorkerTransportSamplePosition = 9'007'199'254'740'991LL;

enum class PendingMidiEventType {
  NoteOn,
  NoteOff,
  ControlChange,
  PitchBend,
  ChannelPressure,
  PolyPressure,
  ProgramChange,
  NoteExpression
};

struct PendingMidiEvent {
  PendingMidiEventType type = PendingMidiEventType::NoteOn;
  std::uint8_t note = 60;
  std::uint8_t controller = 0;
  std::uint8_t program = 0;
  Steinberg::Vst::NoteExpressionTypeID noteExpressionTypeId = 0;
  Steinberg::int32 noteId = -1;
  float value = 0.8F;
  std::uint8_t channel = 0;
  std::uint32_t sampleOffset = 0;
};

struct PendingParameterChange {
  Steinberg::Vst::ParamID id = 0;
  Steinberg::Vst::ParamValue value = 0.0;
  std::uint32_t sampleOffset = 0;
};

struct IndexedAudioBus {
  std::uint32_t index = 0;
  std::vector<std::vector<float>> channels;
};

struct HostTransportContext {
  bool playing = false;
  bool recording = false;
  bool loopActive = false;
  bool hasTempo = false;
  double tempo = 120.0;
  bool hasTimeSignature = false;
  Steinberg::int32 timeSignatureNumerator = 4;
  Steinberg::int32 timeSignatureDenominator = 4;
  bool hasProjectTimeMusic = false;
  double projectTimeMusic = 0.0;
  bool hasBarPositionMusic = false;
  double barPositionMusic = 0.0;
  bool hasCycle = false;
  double cycleStartMusic = 0.0;
  double cycleEndMusic = 0.0;
  Steinberg::Vst::TSamples samplePosition = 0;
};

struct RenderedAudio {
  std::vector<std::vector<float>> channels;
  std::vector<IndexedAudioBus> outputBuses;
};

float sanitizeSample(const std::string& text);
bool parseUint32Arg(const char* text, std::uint32_t minValue, std::uint32_t maxValue, std::uint32_t& out);
bool parseParamIdArg(const char* text, Steinberg::Vst::ParamID& out);
bool parseSampleRateArg(const char* text, double& out);
bool parseDoubleArg(const char* text, double minValue, double maxValue, double& out);
bool parseTransportContext(const std::string& encoded, double fallbackSampleTime, HostTransportContext& out);
std::string cappedString(std::string value, std::size_t maxBytes = kMaxWorkerParameterStringBytes);
std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames);
bool parseAudioBuses(const std::string& encoded, std::uint32_t frames, std::vector<IndexedAudioBus>& buses);
const std::vector<std::vector<float>>* findBusChannels(const std::vector<IndexedAudioBus>& buses, std::uint32_t index);
bool parseMidiEvents(const std::string& encoded, std::vector<PendingMidiEvent>& events);
bool makeVst3Event(const PendingMidiEvent& pending, std::uint32_t frames, Steinberg::Vst::Event& event);
std::string programListsToJson(Steinberg::Vst::IUnitInfo* unitInfo);
std::string noteExpressionsToJson(Steinberg::Vst::INoteExpressionController* noteExpressionController);
std::string audioChannelsToJson(const std::vector<std::vector<float>>& channels);
std::string renderedAudioToJson(const RenderedAudio& rendered);
bool parameterIsAutomatable(const Steinberg::Vst::ParameterInfo& info);
void checkResult(Steinberg::tresult result, const std::string& operation);
Steinberg::Vst::SpeakerArrangement arrangementForChannels(std::uint32_t channels);
std::uint32_t channelsForArrangement(Steinberg::Vst::SpeakerArrangement arrangement, std::uint32_t fallbackChannels);
const VST3::Hosting::ClassInfo* findAudioClass(const VST3::Hosting::PluginFactory::ClassInfos& classes);
std::string parameterInfoToJson(
    const Steinberg::Vst::ParameterInfo& info,
    Steinberg::Vst::IEditController* controller,
    Steinberg::Vst::IUnitInfo* unitInfo);

} // namespace soundbridge::vst3_worker

#endif
