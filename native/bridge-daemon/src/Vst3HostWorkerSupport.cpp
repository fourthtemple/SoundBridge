#include "SoundBridge/Vst3HostWorkerSupport.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/Base64.h"
#include "SoundBridge/NativePlugin.h"

#include "public.sdk/source/vst/hosting/stringconvert.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <set>
#include <sstream>
#include <stdexcept>

namespace soundbridge::vst3_worker {
namespace {

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

bool parseTransportSamplePosition(const std::string& text, Steinberg::Vst::TSamples& out) {
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
  out = static_cast<Steinberg::Vst::TSamples>(value);
  return true;
}

bool isPowerOfTwo(std::uint32_t value) {
  return value > 0 && (value & (value - 1U)) == 0;
}

bool parseMidiEventToken(const std::string& token, PendingMidiEvent& event) {
  std::vector<std::string> parts;
  std::stringstream stream(token);
  std::string part;
  while (std::getline(stream, part, ':')) {
    parts.push_back(part);
  }
  if (parts.empty()) {
    return false;
  }

  auto parseChannelAndOffset = [&](std::size_t channelIndex, std::size_t offsetIndex) -> bool {
    std::uint32_t channel = 0;
    std::uint32_t sampleOffset = 0;
    if (!parseUint32Arg(parts[channelIndex].c_str(), 0, 15, channel) ||
        !parseUint32Arg(parts[offsetIndex].c_str(), 0, kMaxWorkerFrames - 1, sampleOffset)) {
      return false;
    }
    event.channel = static_cast<std::uint8_t>(channel);
    event.sampleOffset = sampleOffset;
    return true;
  };

  if (parts[0] == "on" || parts[0] == "off" || parts[0] == "poly") {
    if (parts.size() != 5 && parts.size() != 6) {
      return false;
    }
    std::uint32_t note = 60;
    std::uint32_t noteId = 0;
    double value = parts[0] == "off" ? 0.0 : 0.8;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, note) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4) ||
        (parts.size() == 6 && !parseUint32Arg(parts[5].c_str(), 0, 2147483647U, noteId))) {
      return false;
    }
    event.type = parts[0] == "on"
        ? PendingMidiEventType::NoteOn
        : parts[0] == "off" ? PendingMidiEventType::NoteOff : PendingMidiEventType::PolyPressure;
    event.note = static_cast<std::uint8_t>(note);
    event.noteId = parts.size() == 6 ? static_cast<Steinberg::int32>(noteId) : -1;
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "cc") {
    if (parts.size() != 5) {
      return false;
    }
    std::uint32_t controller = 0;
    double value = 0.0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, controller) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4)) {
      return false;
    }
    event.type = PendingMidiEventType::ControlChange;
    event.controller = static_cast<std::uint8_t>(controller);
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "bend") {
    if (parts.size() != 4) {
      return false;
    }
    double value = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), -1.0, 1.0, value) ||
        !parseChannelAndOffset(2, 3)) {
      return false;
    }
    event.type = PendingMidiEventType::PitchBend;
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "pressure") {
    if (parts.size() != 4) {
      return false;
    }
    double pressure = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), 0.0, 1.0, pressure) ||
        !parseChannelAndOffset(2, 3)) {
      return false;
    }
    event.type = PendingMidiEventType::ChannelPressure;
    event.value = static_cast<float>(pressure);
    return true;
  }

  if (parts[0] == "program") {
    if (parts.size() != 4) {
      return false;
    }
    std::uint32_t program = 0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, program) ||
        !parseChannelAndOffset(2, 3)) {
      return false;
    }
    event.type = PendingMidiEventType::ProgramChange;
    event.program = static_cast<std::uint8_t>(program);
    return true;
  }

  if (parts[0] == "expr") {
    if (parts.size() != 6) {
      return false;
    }
    std::uint32_t typeId = 0;
    std::uint32_t noteId = 0;
    double value = 0.0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 4294967295U, typeId) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseUint32Arg(parts[3].c_str(), 0, 2147483647U, noteId) ||
        !parseChannelAndOffset(4, 5)) {
      return false;
    }
    event.type = PendingMidiEventType::NoteExpression;
    event.noteExpressionTypeId = typeId;
    event.noteId = static_cast<Steinberg::int32>(noteId);
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "exprText") {
    if (parts.size() != 6) {
      return false;
    }
    std::uint32_t typeId = 0;
    std::uint32_t noteId = 0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 4294967295U, typeId) ||
        !parseUint32Arg(parts[3].c_str(), 0, 2147483647U, noteId) ||
        !parseChannelAndOffset(4, 5)) {
      return false;
    }
    try {
      const auto decoded = soundbridge::base64Decode(parts[2], kMaxWorkerNoteExpressionTextBytes);
      if (decoded.empty() || std::find(decoded.begin(), decoded.end(), 0) != decoded.end()) {
        return false;
      }
      const std::string text(decoded.begin(), decoded.end());
      event.noteExpressionText = VST3::StringConvert::convert(text);
    } catch (...) {
      return false;
    }
    if (event.noteExpressionText.empty()) {
      return false;
    }
    event.type = PendingMidiEventType::NoteExpressionText;
    event.noteExpressionTypeId = typeId;
    event.noteId = static_cast<Steinberg::int32>(noteId);
    return true;
  }

  return false;
}

bool unitInfoForParameter(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::UnitInfo& unit);
bool unitIdForProgramList(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::Vst::UnitID& unitId);
std::string programListInfoToJson(
    const Steinberg::Vst::ProgramListInfo& programList,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData);

bool programListForParameter(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListInfo& programList) {
  if (unitInfo == nullptr) {
    return false;
  }
  Steinberg::Vst::UnitInfo unit {};
  if (!unitInfoForParameter(parameter, unitInfo, unit)) {
    return false;
  }
  const auto programListId = unit.programListId;
  if (programListId == Steinberg::Vst::kNoProgramListId) {
    return false;
  }

  const auto listCount = std::clamp<Steinberg::int32>(
      unitInfo->getProgramListCount(),
      0,
      kMaxWorkerProgramLists);
  for (Steinberg::int32 listIndex = 0; listIndex < listCount; ++listIndex) {
    Steinberg::Vst::ProgramListInfo info {};
    if (unitInfo->getProgramListInfo(listIndex, info) == Steinberg::kResultOk && info.id == programListId) {
      programList = info;
      return true;
    }
  }
  return false;
}

bool unitInfoForParameter(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::UnitInfo& unit) {
  if (unitInfo == nullptr) {
    return false;
  }
  const auto unitCount = std::clamp<Steinberg::int32>(
      unitInfo->getUnitCount(),
      0,
      kMaxWorkerUnits);
  for (Steinberg::int32 unitIndex = 0; unitIndex < unitCount; ++unitIndex) {
    Steinberg::Vst::UnitInfo candidate {};
    if (unitInfo->getUnitInfo(unitIndex, candidate) == Steinberg::kResultOk && candidate.id == parameter.unitId) {
      unit = candidate;
      return true;
    }
  }
  return false;
}

bool unitIdForProgramList(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::Vst::UnitID& unitId) {
  if (unitInfo == nullptr || programListId == Steinberg::Vst::kNoProgramListId) {
    return false;
  }
  const auto unitCount = std::clamp<Steinberg::int32>(
      unitInfo->getUnitCount(),
      0,
      kMaxWorkerUnits);
  for (Steinberg::int32 unitIndex = 0; unitIndex < unitCount; ++unitIndex) {
    Steinberg::Vst::UnitInfo unit {};
    if (unitInfo->getUnitInfo(unitIndex, unit) == Steinberg::kResultOk && unit.programListId == programListId) {
      unitId = unit.id;
      return true;
    }
  }
  return false;
}

std::string unitInfoToJson(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo) {
  Steinberg::Vst::UnitInfo unit {};
  if (!unitInfoForParameter(parameter, unitInfo, unit)) {
    return "";
  }
  auto name = cappedString(VST3::StringConvert::convert(unit.name));
  if (name.empty()) {
    name = "Unit " + std::to_string(unit.id);
  }
  std::ostringstream output;
  output << "{\"id\":" << unit.id
         << ",\"parentUnitId\":" << unit.parentUnitId
         << ",\"name\":\"" << jsonEscape(name) << "\"";
  if (unit.programListId != Steinberg::Vst::kNoProgramListId) {
    output << ",\"programListId\":" << unit.programListId;
  }
  output << "}";
  return output.str();
}

std::string programListToJson(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo) {
  Steinberg::Vst::ProgramListInfo programList {};
  if (!programListForParameter(parameter, unitInfo, programList)) {
    return "";
  }
  return programListInfoToJson(programList, unitInfo, nullptr);
}

std::string programListInfoToJson(
    const Steinberg::Vst::ProgramListInfo& programList,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData) {
  const auto programCount = std::clamp<Steinberg::int32>(
      programList.programCount,
      0,
      kMaxWorkerProgramsPerParameter);
  if (programCount <= 0) {
    return "";
  }

  const auto listName = cappedString(VST3::StringConvert::convert(programList.name));
  Steinberg::Vst::UnitID unitId = Steinberg::Vst::kNoParentUnitId;
  std::ostringstream output;
  output << "{\"id\":" << programList.id
         << ",\"name\":\"" << jsonEscape(listName.empty() ? "Programs" : listName) << "\"";
  if (unitIdForProgramList(unitInfo, programList.id, unitId)) {
    output << ",\"unitId\":" << unitId;
  }
  if (programListData != nullptr &&
      programListData->programDataSupported(programList.id) == Steinberg::kResultTrue) {
    output << ",\"programDataSupported\":true";
  }
  output << ",\"programs\":[";
  for (Steinberg::int32 programIndex = 0; programIndex < programCount; ++programIndex) {
    if (programIndex > 0) {
      output << ",";
    }
    Steinberg::Vst::String128 programName {};
    std::string name;
    if (unitInfo != nullptr && unitInfo->getProgramName(programList.id, programIndex, programName) == Steinberg::kResultOk) {
      name = cappedString(VST3::StringConvert::convert(programName));
    }
    if (name.empty()) {
      name = "Program " + std::to_string(programIndex + 1);
    }
    const double normalizedValue = programCount <= 1
        ? 0.0
        : static_cast<double>(programIndex) / static_cast<double>(programCount - 1);
    output << "{\"index\":" << programIndex
           << ",\"name\":\"" << jsonEscape(name) << "\""
           << ",\"normalizedValue\":" << std::clamp(normalizedValue, 0.0, 1.0)
           << "}";
  }
  output << "]}";
  return output.str();
}

std::string noteExpressionInfoToJson(
    const Steinberg::Vst::NoteExpressionTypeInfo& info,
    Steinberg::int32 busIndex,
    Steinberg::int16 channel) {
  const auto name = cappedString(VST3::StringConvert::convert(info.title));
  const auto shortName = cappedString(VST3::StringConvert::convert(info.shortTitle));
  const auto unit = cappedString(VST3::StringConvert::convert(info.units), 64);
  const auto minValue = std::clamp(info.valueDesc.minimum, 0.0, 1.0);
  const auto maxValue = std::clamp(info.valueDesc.maximum, minValue, 1.0);
  const auto defaultValue = std::clamp(info.valueDesc.defaultValue, minValue, maxValue);

  std::ostringstream output;
  output << "{\"typeId\":" << info.typeId
         << ",\"name\":\"" << jsonEscape(name.empty() ? shortName : name) << "\""
         << ",\"defaultValue\":" << defaultValue
         << ",\"minValue\":" << minValue
         << ",\"maxValue\":" << maxValue
         << ",\"stepCount\":" << std::max<Steinberg::int32>(0, info.valueDesc.stepCount)
         << ",\"busIndex\":" << busIndex
         << ",\"channel\":" << channel;
  if (!shortName.empty()) {
    output << ",\"shortName\":\"" << jsonEscape(shortName) << "\"";
  }
  if (!unit.empty()) {
    output << ",\"unit\":\"" << jsonEscape(unit) << "\"";
  }
  if (info.unitId >= 0) {
    output << ",\"unitId\":" << info.unitId;
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kIsBipolar) != 0) {
    output << ",\"bipolar\":true";
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kIsOneShot) != 0) {
    output << ",\"oneShot\":true";
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kIsAbsolute) != 0) {
    output << ",\"absolute\":true";
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kAssociatedParameterIDValid) != 0) {
    output << ",\"associatedParameterId\":\"" << info.associatedParameterId << "\"";
  }
  output << "}";
  return output.str();
}

} // namespace

float sanitizeSample(const std::string& text) {
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

bool parseInt32Arg(const char* text, std::int32_t minValue, std::int32_t maxValue, std::int32_t& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const long value = std::strtol(text, &end, 10);
  if (end == text || *end != '\0' || errno == ERANGE || value < minValue || value > maxValue) {
    return false;
  }
  out = static_cast<std::int32_t>(value);
  return true;
}

bool parseParamIdArg(const char* text, Steinberg::Vst::ParamID& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char* end = nullptr;
  const unsigned long value = std::strtoul(text, &end, 10);
  if (end == text || *end != '\0' || value > 0xFFFFFFFFUL) {
    return false;
  }
  out = static_cast<Steinberg::Vst::ParamID>(value);
  return true;
}

bool parseSampleRateArg(const char* text, double& out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char* end = nullptr;
  const double value = std::strtod(text, &end);
  if (end == text || *end != '\0' || !std::isfinite(value) ||
      value < kMinWorkerSampleRate || value > kMaxWorkerSampleRate) {
    return false;
  }
  out = value;
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

bool parseTransportContext(
    const std::string& encoded,
    double fallbackSampleTime,
    HostTransportContext& out) {
  out = HostTransportContext {};
  out.samplePosition = static_cast<Steinberg::Vst::TSamples>(std::max(0.0, fallbackSampleTime));
  if (encoded.empty() || encoded == "-") {
    return true;
  }

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
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed)) {
        return false;
      }
      out.timeSignatureNumerator = static_cast<Steinberg::int32>(parsed);
      sawNumerator = true;
    } else if (key == "den") {
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed) || !isPowerOfTwo(parsed)) {
        return false;
      }
      out.timeSignatureDenominator = static_cast<Steinberg::int32>(parsed);
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

std::string cappedString(std::string value, std::size_t maxBytes) {
  if (value.size() > maxBytes) {
    value.resize(maxBytes);
  }
  return value;
}

std::vector<std::vector<float>> parseChannels(const std::string& encoded, std::uint32_t frames) {
  frames = std::clamp<std::uint32_t>(frames, 1, kMaxWorkerFrames);
  if (encoded.empty() || encoded == "-") {
    return {};
  }

  std::vector<std::vector<float>> channels;
  std::stringstream channelStream(encoded);
  std::string channelText;
  while (channels.size() < kMaxWorkerChannels && std::getline(channelStream, channelText, '|')) {
    std::vector<float> channel;
    channel.reserve(frames);
    std::stringstream sampleStream(channelText);
    std::string sampleText;
    while (channel.size() < frames && std::getline(sampleStream, sampleText, ',')) {
      if (sampleText.empty()) {
        channel.push_back(0.0F);
        continue;
      }
      channel.push_back(sanitizeSample(sampleText));
    }
    channel.resize(frames, 0.0F);
    channels.push_back(std::move(channel));
  }
  return channels;
}

bool parseAudioBuses(
    const std::string& encoded,
    std::uint32_t frames,
    std::vector<IndexedAudioBus>& buses) {
  buses.clear();
  if (encoded.empty() || encoded == "-") {
    return true;
  }

  std::stringstream stream(encoded);
  std::string token;
  std::set<std::uint32_t> seenIndexes;
  while (std::getline(stream, token, ';')) {
    if (token.empty()) {
      return false;
    }
    if (buses.size() >= kMaxWorkerChannels) {
      return false;
    }
    const auto separator = token.find('=');
    if (separator == std::string::npos) {
      return false;
    }
    std::uint32_t index = 0;
    if (!parseUint32Arg(token.substr(0, separator).c_str(), 0, kMaxWorkerChannels - 1, index)) {
      return false;
    }
    if (!seenIndexes.insert(index).second) {
      return false;
    }
    buses.push_back(IndexedAudioBus{
        index,
        parseChannels(token.substr(separator + 1), frames)});
  }
  return true;
}

const std::vector<std::vector<float>>* findBusChannels(const std::vector<IndexedAudioBus>& buses, std::uint32_t index) {
  for (const auto& bus : buses) {
    if (bus.index == index) {
      return &bus.channels;
    }
  }
  return nullptr;
}

bool parseMidiEvents(const std::string& encoded, std::vector<PendingMidiEvent>& events) {
  events.clear();
  if (encoded.empty() || encoded == "-") {
    return true;
  }

  std::stringstream stream(encoded);
  std::string token;
  while (std::getline(stream, token, ';')) {
    if (token.empty()) {
      continue;
    }
    if (events.size() >= kMaxWorkerMidiEvents) {
      return false;
    }
    PendingMidiEvent event;
    if (!parseMidiEventToken(token, event)) {
      return false;
    }
    events.push_back(event);
  }
  return true;
}

bool makeVst3Event(const PendingMidiEvent& pending, std::uint32_t frames, Steinberg::Vst::Event& event) {
  event = {};
  event.busIndex = 0;
  event.sampleOffset = static_cast<Steinberg::int32>(
      std::clamp<std::uint32_t>(pending.sampleOffset, 0, frames > 0 ? frames - 1 : 0));
  event.ppqPosition = 0.0;
  event.flags = Steinberg::Vst::Event::kIsLive;
  if (pending.type == PendingMidiEventType::NoteOn && pending.value > 0.0F) {
    event.type = Steinberg::Vst::Event::kNoteOnEvent;
    event.noteOn.channel = static_cast<Steinberg::int16>(pending.channel);
    event.noteOn.pitch = static_cast<Steinberg::int16>(pending.note);
    event.noteOn.tuning = 0.0F;
    event.noteOn.velocity = std::clamp(pending.value, 0.0F, 1.0F);
    event.noteOn.length = 0;
    event.noteOn.noteId = pending.noteId;
    return true;
  }
  if (pending.type == PendingMidiEventType::NoteOff ||
      pending.type == PendingMidiEventType::NoteOn) {
    event.type = Steinberg::Vst::Event::kNoteOffEvent;
    event.noteOff.channel = static_cast<Steinberg::int16>(pending.channel);
    event.noteOff.pitch = static_cast<Steinberg::int16>(pending.note);
    event.noteOff.velocity = std::clamp(pending.value, 0.0F, 1.0F);
    event.noteOff.noteId = pending.noteId;
    event.noteOff.tuning = 0.0F;
    return true;
  }
  if (pending.type == PendingMidiEventType::PolyPressure) {
    event.type = Steinberg::Vst::Event::kPolyPressureEvent;
    event.polyPressure.channel = static_cast<Steinberg::int16>(pending.channel);
    event.polyPressure.pitch = static_cast<Steinberg::int16>(pending.note);
    event.polyPressure.pressure = std::clamp(pending.value, 0.0F, 1.0F);
    event.polyPressure.noteId = pending.noteId;
    return true;
  }
  if (pending.type == PendingMidiEventType::NoteExpression && pending.noteId >= 0) {
    event.type = Steinberg::Vst::Event::kNoteExpressionValueEvent;
    event.noteExpressionValue.typeId = pending.noteExpressionTypeId;
    event.noteExpressionValue.noteId = pending.noteId;
    event.noteExpressionValue.value = std::clamp(static_cast<double>(pending.value), 0.0, 1.0);
    return true;
  }
  if (pending.type == PendingMidiEventType::NoteExpressionText && pending.noteId >= 0 && !pending.noteExpressionText.empty()) {
    event.type = Steinberg::Vst::Event::kNoteExpressionTextEvent;
    event.noteExpressionText.typeId = pending.noteExpressionTypeId;
    event.noteExpressionText.noteId = pending.noteId;
    event.noteExpressionText.textLen = static_cast<Steinberg::uint32>(pending.noteExpressionText.size());
    event.noteExpressionText.text = VST3::toTChar(pending.noteExpressionText);
    return true;
  }
  return false;
}

std::string programListsToJson(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData) {
  std::ostringstream output;
  output << "{\"vst3ProgramLists\":[";
  if (unitInfo != nullptr) {
    const auto listCount = std::clamp<Steinberg::int32>(
        unitInfo->getProgramListCount(),
        0,
        kMaxWorkerProgramLists);
    bool first = true;
    for (Steinberg::int32 listIndex = 0; listIndex < listCount; ++listIndex) {
      Steinberg::Vst::ProgramListInfo info {};
      if (unitInfo->getProgramListInfo(listIndex, info) != Steinberg::kResultOk) {
        continue;
      }
      const auto listJson = programListInfoToJson(info, unitInfo, programListData);
      if (listJson.empty()) {
        continue;
      }
      if (!first) {
        output << ",";
      }
      output << listJson;
      first = false;
    }
  }
  output << "]}";
  return output.str();
}

std::string noteExpressionsToJson(Steinberg::Vst::INoteExpressionController* noteExpressionController) {
  std::ostringstream output;
  output << "{\"vst3NoteExpressions\":[";
  if (noteExpressionController != nullptr) {
    bool first = true;
    Steinberg::int32 total = 0;
    for (Steinberg::int16 channel = 0; channel < 16 && total < kMaxWorkerNoteExpressionTypes; ++channel) {
      const auto count = std::clamp<Steinberg::int32>(
          noteExpressionController->getNoteExpressionCount(0, channel),
          0,
          kMaxWorkerNoteExpressionTypes - total);
      for (Steinberg::int32 index = 0; index < count && total < kMaxWorkerNoteExpressionTypes; ++index) {
        Steinberg::Vst::NoteExpressionTypeInfo info {};
        if (noteExpressionController->getNoteExpressionInfo(0, channel, index, info) != Steinberg::kResultOk) {
          continue;
        }
        if (!first) {
          output << ",";
        }
        output << noteExpressionInfoToJson(info, 0, channel);
        first = false;
        ++total;
      }
    }
  }
  output << "]}";
  return output.str();
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
      const auto sample = channels[channelIndex][frame];
      output << (std::isfinite(sample) ? sample : 0.0F);
    }
    output << "]";
  }
  output << "]";
  return output.str();
}

std::string renderedAudioToJson(const RenderedAudio& rendered) {
  std::ostringstream output;
  output << "{\"channels\":" << audioChannelsToJson(rendered.channels)
         << ",\"outputBuses\":[";
  for (std::size_t index = 0; index < rendered.outputBuses.size(); ++index) {
    if (index > 0) {
      output << ",";
    }
    output << "{\"index\":" << rendered.outputBuses[index].index
           << ",\"channels\":" << audioChannelsToJson(rendered.outputBuses[index].channels)
           << "}";
  }
  output << "]}";
  return output.str();
}

bool parameterIsAutomatable(const Steinberg::Vst::ParameterInfo& info) {
  return (info.flags & Steinberg::Vst::ParameterInfo::kCanAutomate) != 0 &&
      (info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) == 0;
}

void checkResult(Steinberg::tresult result, const std::string& operation) {
  if (result != Steinberg::kResultOk) {
    std::ostringstream message;
    message << operation << " failed with VST3 result " << result;
    throw std::runtime_error(message.str());
  }
}

Steinberg::Vst::SpeakerArrangement arrangementForChannels(std::uint32_t channels) {
  if (channels == 0) {
    return Steinberg::Vst::SpeakerArr::kEmpty;
  }
  if (channels == 1) {
    return Steinberg::Vst::SpeakerArr::kMono;
  }
  return Steinberg::Vst::SpeakerArr::kStereo;
}

std::uint32_t channelsForArrangement(
    Steinberg::Vst::SpeakerArrangement arrangement,
    std::uint32_t fallbackChannels) {
  if (arrangement == Steinberg::Vst::SpeakerArr::kEmpty) {
    return 0;
  }

  std::uint32_t channels = 0;
  while (arrangement != 0) {
    channels += static_cast<std::uint32_t>(arrangement & 1U);
    arrangement >>= 1U;
  }
  return channels == 0 ? fallbackChannels : channels;
}

const VST3::Hosting::ClassInfo* findAudioClass(const VST3::Hosting::PluginFactory::ClassInfos& classes) {
  for (const auto& classInfo : classes) {
    if (classInfo.category() == kVstAudioEffectClass) {
      return &classInfo;
    }
  }
  return nullptr;
}

std::string parameterDisplayValue(
    const Steinberg::Vst::ParameterInfo& info,
    Steinberg::Vst::IEditController* controller,
    Steinberg::Vst::ParamValue normalizedValue) {
  Steinberg::Vst::String128 text {};
  if (controller == nullptr ||
      controller->getParamStringByValue(info.id, normalizedValue, text) != Steinberg::kResultOk) {
    return {};
  }
  return cappedString(VST3::StringConvert::convert(text));
}

std::string parameterInfoToJson(
    const Steinberg::Vst::ParameterInfo& info,
    Steinberg::Vst::IEditController* controller,
    Steinberg::Vst::IUnitInfo* unitInfo) {
  const auto normalizedValue = std::clamp(controller->getParamNormalized(info.id), 0.0, 1.0);
  const auto defaultValue = std::clamp(info.defaultNormalizedValue, 0.0, 1.0);
  const auto name = cappedString(VST3::StringConvert::convert(info.title));
  const auto shortName = cappedString(VST3::StringConvert::convert(info.shortTitle));
  const auto unit = cappedString(VST3::StringConvert::convert(info.units), 64);
  const auto plainValue = controller->normalizedParamToPlain(info.id, normalizedValue);
  const auto minPlain = controller->normalizedParamToPlain(info.id, 0.0);
  const auto maxPlain = controller->normalizedParamToPlain(info.id, 1.0);
  const auto displayValue = parameterDisplayValue(info, controller, normalizedValue);
  const bool programChange = (info.flags & Steinberg::Vst::ParameterInfo::kIsProgramChange) != 0;

  std::ostringstream output;
  output << "{\"id\":\"" << info.id << "\""
         << ",\"name\":\"" << jsonEscape(name.empty() ? shortName : name) << "\""
         << ",\"normalizedValue\":" << normalizedValue
         << ",\"defaultNormalizedValue\":" << defaultValue
         << ",\"plainValue\":" << (std::isfinite(plainValue) ? plainValue : normalizedValue)
         << ",\"minPlain\":" << (std::isfinite(minPlain) ? minPlain : 0.0)
         << ",\"maxPlain\":" << (std::isfinite(maxPlain) ? maxPlain : 1.0)
         << ",\"automatable\":" << (parameterIsAutomatable(info) ? "true" : "false");
  if (!displayValue.empty()) {
    output << ",\"displayValue\":\"" << jsonEscape(displayValue) << "\"";
  }
  if (!unit.empty()) {
    output << ",\"unit\":\"" << jsonEscape(unit) << "\"";
  }
  const auto vst3Unit = unitInfoToJson(info, unitInfo);
  if (!vst3Unit.empty()) {
    output << ",\"vst3Unit\":" << vst3Unit;
  }
  output << ",\"stepCount\":" << std::max<Steinberg::int32>(0, info.stepCount)
         << ",\"readOnly\":" << ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) ? "true" : "false");
  if (programChange) {
    output << ",\"programChange\":true";
    const auto programList = programListToJson(info, unitInfo);
    if (!programList.empty()) {
      output << ",\"programList\":" << programList;
    }
  }
  output << "}";
  return output.str();
}

} // namespace soundbridge::vst3_worker

#endif
