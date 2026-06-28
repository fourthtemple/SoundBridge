#include "SoundBridge/Vst3HostWorkerSupport.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/Base64.h"

#include "public.sdk/source/vst/hosting/stringconvert.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <system_error>

namespace soundbridge::vst3_worker {
namespace {

bool parseTransportBool(std::string_view text, bool& out) {
  if (text != "0" && text != "1") return false;
  out = text == "1";
  return true;
}

bool parseTransportSamplePosition(std::string_view text, Steinberg::Vst::TSamples& out) {
  if (text.empty()) {
    return false;
  }
  long long value = 0;
  const char* const begin = text.data();
  const char* const end = begin + text.size();
  const auto parsed = std::from_chars(begin, end, value);
  if (parsed.ec != std::errc{} || parsed.ptr != end || value < 0 ||
      value > kMaxWorkerTransportSamplePosition) {
    return false;
  }
  out = static_cast<Steinberg::Vst::TSamples>(value);
  return true;
}

bool isPowerOfTwo(std::uint32_t value) {
  return value > 0 && (value & (value - 1U)) == 0;
}

bool isBusIndexToken(const std::string& token) {
  return token.rfind("bus=", 0) == 0;
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

  auto parseOptionalBusIndex = [&](std::size_t busIndexPart) -> bool {
    if (parts.size() == busIndexPart) {
      return true;
    }
    if (parts.size() != busIndexPart + 1 || !isBusIndexToken(parts[busIndexPart])) {
      return false;
    }
    std::uint32_t busIndex = 0;
    if (!parseUint32Arg(parts[busIndexPart].c_str() + 4, 0, kMaxWorkerChannels - 1, busIndex)) {
      return false;
    }
    event.busIndex = busIndex;
    return true;
  };

  if (parts[0] == "on" || parts[0] == "off" || parts[0] == "poly") {
    if (parts.size() < 5 || parts.size() > 7) {
      return false;
    }
    std::uint32_t note = 60;
    std::uint32_t noteId = 0;
    double value = parts[0] == "off" ? 0.0 : 0.8;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, note) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4)) {
      return false;
    }
    const bool hasNoteId = parts.size() >= 6 && !isBusIndexToken(parts[5]);
    if ((hasNoteId && !parseUint32Arg(parts[5].c_str(), 0, 2147483647U, noteId)) ||
        !parseOptionalBusIndex(hasNoteId ? 6 : 5)) {
      return false;
    }
    event.type = parts[0] == "on"
        ? PendingMidiEventType::NoteOn
        : parts[0] == "off" ? PendingMidiEventType::NoteOff : PendingMidiEventType::PolyPressure;
    event.note = static_cast<std::uint8_t>(note);
    event.noteId = hasNoteId ? static_cast<Steinberg::int32>(noteId) : -1;
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "cc") {
    if (parts.size() != 5 && parts.size() != 6) {
      return false;
    }
    std::uint32_t controller = 0;
    double value = 0.0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, controller) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseChannelAndOffset(3, 4) ||
        !parseOptionalBusIndex(5)) {
      return false;
    }
    event.type = PendingMidiEventType::ControlChange;
    event.controller = static_cast<std::uint8_t>(controller);
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "bend") {
    if (parts.size() != 4 && parts.size() != 5) {
      return false;
    }
    double value = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), -1.0, 1.0, value) ||
        !parseChannelAndOffset(2, 3) ||
        !parseOptionalBusIndex(4)) {
      return false;
    }
    event.type = PendingMidiEventType::PitchBend;
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "pressure") {
    if (parts.size() != 4 && parts.size() != 5) {
      return false;
    }
    double pressure = 0.0;
    if (!parseDoubleArg(parts[1].c_str(), 0.0, 1.0, pressure) ||
        !parseChannelAndOffset(2, 3) ||
        !parseOptionalBusIndex(4)) {
      return false;
    }
    event.type = PendingMidiEventType::ChannelPressure;
    event.value = static_cast<float>(pressure);
    return true;
  }

  if (parts[0] == "program") {
    if (parts.size() != 4 && parts.size() != 5) {
      return false;
    }
    std::uint32_t program = 0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 127, program) ||
        !parseChannelAndOffset(2, 3) ||
        !parseOptionalBusIndex(4)) {
      return false;
    }
    event.type = PendingMidiEventType::ProgramChange;
    event.program = static_cast<std::uint8_t>(program);
    return true;
  }

  if (parts[0] == "expr") {
    if (parts.size() != 6 && parts.size() != 7) {
      return false;
    }
    std::uint32_t typeId = 0;
    std::uint32_t noteId = 0;
    double value = 0.0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 4294967295U, typeId) ||
        !parseDoubleArg(parts[2].c_str(), 0.0, 1.0, value) ||
        !parseUint32Arg(parts[3].c_str(), 0, 2147483647U, noteId) ||
        !parseChannelAndOffset(4, 5) ||
        !parseOptionalBusIndex(6)) {
      return false;
    }
    event.type = PendingMidiEventType::NoteExpression;
    event.noteExpressionTypeId = typeId;
    event.noteId = static_cast<Steinberg::int32>(noteId);
    event.value = static_cast<float>(value);
    return true;
  }

  if (parts[0] == "exprText") {
    if (parts.size() != 6 && parts.size() != 7) {
      return false;
    }
    std::uint32_t typeId = 0;
    std::uint32_t noteId = 0;
    if (!parseUint32Arg(parts[1].c_str(), 0, 4294967295U, typeId) ||
        !parseUint32Arg(parts[3].c_str(), 0, 2147483647U, noteId) ||
        !parseChannelAndOffset(4, 5) ||
        !parseOptionalBusIndex(6)) {
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

} // namespace

namespace {

float clampSample(double value) {
  if (!std::isfinite(value)) {
    return 0.0F;
  }
  return static_cast<float>(std::clamp(value, -16.0, 16.0));
}

} // namespace

float sanitizeSample(const std::string& text) {
  char* end = nullptr;
  const double value = std::strtod(text.c_str(), &end);
  if (end == text.c_str()) {
    return 0.0F;
  }
  return clampSample(value);
}

namespace {

float sanitizeSampleSlice(const char* begin, const char* end) {
  if (begin == nullptr || end == nullptr || begin >= end) {
    return 0.0F;
  }

  double value = 0.0;
  const auto parsed = std::from_chars(begin, end, value);
  if (parsed.ec == std::errc{} && parsed.ptr != begin) {
    return clampSample(value);
  }

  return sanitizeSample(std::string(begin, static_cast<std::size_t>(end - begin)));
}

void appendJsonSample(std::string& output, float sample) {
  const float value = std::isfinite(sample) ? sample : 0.0F;
  char buffer[64] {};
  const auto converted = std::to_chars(
      buffer,
      buffer + sizeof(buffer),
      value,
      std::chars_format::general,
      6);
  if (converted.ec != std::errc{}) {
    output.push_back('0');
    return;
  }
  output.append(buffer, static_cast<std::size_t>(converted.ptr - buffer));
}

} // namespace

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

  const char* cursor = encoded.data();
  const char* const end = cursor + encoded.size();
  while (cursor < end) {
    const char* const tokenEnd = std::find(cursor, end, ',');
    if (cursor == tokenEnd) {
      cursor = tokenEnd == end ? end : tokenEnd + 1;
      continue;
    }
    const char* const separator = std::find(cursor, tokenEnd, '=');
    if (separator == tokenEnd) {
      return false;
    }
    const std::string_view key(cursor, static_cast<std::size_t>(separator - cursor));
    const std::string_view valueText(separator + 1, static_cast<std::size_t>(tokenEnd - separator - 1));
    const auto valueString = [&]() { return std::string(valueText.data(), valueText.size()); };

    if (key == "playing") {
      if (!parseTransportBool(valueText, out.playing)) {
        return false;
      }
    } else if (key == "recording") {
      if (!parseTransportBool(valueText, out.recording)) {
        return false;
      }
    } else if (key == "loop") {
      if (!parseTransportBool(valueText, out.loopActive)) {
        return false;
      }
    } else if (key == "tempo") {
      const auto value = valueString();
      if (!parseDoubleArg(value.c_str(), 1.0, kMaxWorkerTransportTempoBpm, out.tempo)) {
        return false;
      }
      out.hasTempo = true;
    } else if (key == "num") {
      const auto value = valueString();
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed)) {
        return false;
      }
      out.timeSignatureNumerator = static_cast<Steinberg::int32>(parsed);
      sawNumerator = true;
    } else if (key == "den") {
      const auto value = valueString();
      std::uint32_t parsed = 4;
      if (!parseUint32Arg(value.c_str(), 1, 64, parsed) || !isPowerOfTwo(parsed)) {
        return false;
      }
      out.timeSignatureDenominator = static_cast<Steinberg::int32>(parsed);
      sawDenominator = true;
    } else if (key == "ppq") {
      const auto value = valueString();
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.projectTimeMusic)) {
        return false;
      }
      out.hasProjectTimeMusic = true;
    } else if (key == "bar") {
      const auto value = valueString();
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.barPositionMusic)) {
        return false;
      }
      out.hasBarPositionMusic = true;
    } else if (key == "cycleStart") {
      const auto value = valueString();
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.cycleStartMusic)) {
        return false;
      }
      sawCycleStart = true;
    } else if (key == "cycleEnd") {
      const auto value = valueString();
      if (!parseDoubleArg(value.c_str(), 0.0, kMaxWorkerTransportPositionMusic, out.cycleEndMusic)) {
        return false;
      }
      sawCycleEnd = true;
    } else if (key == "sample") {
      if (!parseTransportSamplePosition(valueText, out.samplePosition)) {
        return false;
      }
    } else {
      return false;
    }
    cursor = tokenEnd == end ? end : tokenEnd + 1;
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

std::vector<std::vector<float>> parseChannels(std::string_view encoded, std::uint32_t frames) {
  frames = std::clamp<std::uint32_t>(frames, 1, kMaxWorkerFrames);
  if (encoded.empty() || encoded == "-") {
    return {};
  }

  std::vector<std::vector<float>> channels;
  const char* cursor = encoded.data();
  const char* const end = cursor + encoded.size();
  while (channels.size() < kMaxWorkerChannels && cursor < end) {
    const char* const channelEnd = std::find(cursor, end, '|');
    std::vector<float> channel;
    channel.reserve(frames);
    const char* sampleStart = cursor;
    while (channel.size() < frames && sampleStart < channelEnd) {
      const char* const sampleEnd = std::find(sampleStart, channelEnd, ',');
      channel.push_back(sanitizeSampleSlice(sampleStart, sampleEnd));
      if (sampleEnd == channelEnd) {
        break;
      }
      sampleStart = sampleEnd + 1;
    }
    channel.resize(frames, 0.0F);
    channels.push_back(std::move(channel));
    if (channelEnd == end) {
      break;
    }
    cursor = channelEnd + 1;
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

  std::array<bool, kMaxWorkerChannels> seenIndexes {};
  const char* cursor = encoded.data();
  const char* const end = cursor + encoded.size();
  while (cursor < end) {
    const char* const tokenEnd = std::find(cursor, end, ';');
    if (cursor == tokenEnd) return false;
    if (buses.size() >= kMaxWorkerChannels) {
      return false;
    }
    const char* const separator = std::find(cursor, tokenEnd, '=');
    if (separator == tokenEnd) return false;
    std::uint32_t index = 0;
    const auto parsed = std::from_chars(cursor, separator, index);
    if (parsed.ec != std::errc{} || parsed.ptr != separator || index >= kMaxWorkerChannels) {
      return false;
    }
    if (seenIndexes[index]) {
      return false;
    }
    seenIndexes[index] = true;
    buses.push_back(IndexedAudioBus{
        index,
        parseChannels(std::string_view(separator + 1, static_cast<std::size_t>(tokenEnd - separator - 1)), frames)});
    cursor = tokenEnd == end ? end : tokenEnd + 1;
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
  event.busIndex = static_cast<Steinberg::int32>(
      std::clamp<std::uint32_t>(pending.busIndex, 0, kMaxWorkerChannels - 1));
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

std::string audioChannelsToJson(const std::vector<std::vector<float>>& channels) {
  std::size_t sampleCount = 0;
  for (const auto& channel : channels) {
    sampleCount += channel.size();
  }

  std::string output;
  output.reserve(2 + channels.size() * 2 + sampleCount * 12);
  output.push_back('[');
  for (std::size_t channelIndex = 0; channelIndex < channels.size(); ++channelIndex) {
    if (channelIndex > 0) {
      output.push_back(',');
    }
    output.push_back('[');
    for (std::size_t frame = 0; frame < channels[channelIndex].size(); ++frame) {
      if (frame > 0) {
        output.push_back(',');
      }
      appendJsonSample(output, channels[channelIndex][frame]);
    }
    output.push_back(']');
  }
  output.push_back(']');
  return output;
}

std::string renderedAudioToJson(const RenderedAudio& rendered) {
  const auto channelsJson = audioChannelsToJson(rendered.channels);
  std::string output;
  output.reserve(channelsJson.size() * 2 + rendered.outputBuses.size() * 48 + 64);
  output.append("{\"channels\":").append(channelsJson).append(",\"outputBuses\":[{\"index\":0,\"channels\":");
  output.append(channelsJson).push_back('}');
  for (std::size_t index = 0; index < rendered.outputBuses.size(); ++index) {
    if (rendered.outputBuses[index].index == 0) {
      continue;
    }
    output.append(",{\"index\":").append(std::to_string(rendered.outputBuses[index].index)).append(",\"channels\":");
    output.append(audioChannelsToJson(rendered.outputBuses[index].channels)).push_back('}');
  }
  output.append("]}");
  return output;
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

const VST3::Hosting::ClassInfo* findAudioClass(const VST3::Hosting::PluginFactory::ClassInfos& classes) {
  for (const auto& classInfo : classes) {
    if (classInfo.category() == kVstAudioEffectClass) {
      return &classInfo;
    }
  }
  return nullptr;
}

} // namespace soundbridge::vst3_worker

#endif
