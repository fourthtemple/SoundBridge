#include "SoundBridge/Vst3HostWorkerSupport.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/NativePlugin.h"

#include "public.sdk/source/vst/hosting/stringconvert.h"

#include <algorithm>
#include <sstream>

namespace soundbridge::vst3_worker {

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

std::uint32_t defaultBusChannels(
    Steinberg::Vst::IComponent* component,
    Steinberg::Vst::BusDirection direction,
    Steinberg::int32 index,
    std::uint32_t fallback) {
  Steinberg::Vst::BusInfo info {};
  if (component != nullptr &&
      component->getBusInfo(Steinberg::Vst::kAudio, direction, index, info) == Steinberg::kResultOk) {
    return static_cast<std::uint32_t>(std::clamp<Steinberg::int32>(
        info.channelCount,
        0,
        static_cast<Steinberg::int32>(kMaxWorkerChannels)));
  }
  return std::min<std::uint32_t>(fallback, kMaxWorkerChannels);
}

std::vector<Steinberg::Vst::SpeakerArrangement> desiredBusArrangements(
    Steinberg::Vst::IComponent* component,
    Steinberg::Vst::BusDirection direction,
    Steinberg::int32 busCount,
    std::uint32_t mainChannels) {
  const auto count = std::clamp<Steinberg::int32>(busCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels));
  std::vector<Steinberg::Vst::SpeakerArrangement> arrangements;
  arrangements.reserve(static_cast<std::size_t>(count));
  for (Steinberg::int32 index = 0; index < count; ++index) {
    const auto channels = index == 0
        ? mainChannels
        : defaultBusChannels(component, direction, index, 0);
    arrangements.push_back(arrangementForChannels(channels));
  }
  return arrangements;
}

std::uint32_t negotiatedBusChannels(
    Steinberg::Vst::IAudioProcessor* processor,
    Steinberg::Vst::BusDirection direction,
    Steinberg::int32 index,
    Steinberg::Vst::SpeakerArrangement fallbackArrangement,
    std::uint32_t fallbackChannels,
    bool requireOutput) {
  Steinberg::Vst::SpeakerArrangement currentArrangement {};
  const auto arrangement = processor != nullptr &&
          processor->getBusArrangement(direction, index, currentArrangement) == Steinberg::kResultOk
      ? currentArrangement
      : fallbackArrangement;
  auto channels = std::min<std::uint32_t>(
      channelsForArrangement(arrangement, fallbackChannels),
      kMaxWorkerChannels);
  if (requireOutput && channels == 0) {
    channels = std::clamp<std::uint32_t>(fallbackChannels, 1, kMaxWorkerChannels);
  }
  return channels;
}

std::vector<std::uint32_t> negotiatedBusChannelList(
    Steinberg::Vst::IComponent* component,
    Steinberg::Vst::IAudioProcessor* processor,
    Steinberg::Vst::BusDirection direction,
    Steinberg::int32 busCount,
    const std::vector<Steinberg::Vst::SpeakerArrangement>& arrangements,
    std::uint32_t requestedOutputChannels,
    bool requireMainOutput) {
  const auto count = std::clamp<Steinberg::int32>(busCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels));
  std::vector<std::uint32_t> channels;
  channels.reserve(static_cast<std::size_t>(count));
  for (Steinberg::int32 index = 0; index < count; ++index) {
    const auto fallbackArrangement = static_cast<std::size_t>(index) < arrangements.size()
        ? arrangements[static_cast<std::size_t>(index)]
        : Steinberg::Vst::SpeakerArr::kEmpty;
    const auto fallbackChannels = channelsForArrangement(
        fallbackArrangement,
        defaultBusChannels(component, direction, index, index == 0 && requireMainOutput ? requestedOutputChannels : 0));
    channels.push_back(negotiatedBusChannels(
        processor,
        direction,
        index,
        fallbackArrangement,
        fallbackChannels,
        requireMainOutput && index == 0));
  }
  return channels;
}

std::string busLayoutsToJson(
    Steinberg::Vst::IComponent* component,
    Steinberg::Vst::BusDirection direction,
    Steinberg::int32 busCount,
    const std::vector<std::uint32_t>& activeChannels) {
  std::ostringstream output;
  output << "[";
  const auto count = std::clamp<Steinberg::int32>(busCount, 0, static_cast<Steinberg::int32>(kMaxWorkerChannels));
  for (Steinberg::int32 index = 0; index < count; ++index) {
    if (index > 0) {
      output << ",";
    }
    Steinberg::Vst::BusInfo info {};
    if (component == nullptr ||
        component->getBusInfo(Steinberg::Vst::kAudio, direction, index, info) != Steinberg::kResultOk) {
      info.mediaType = Steinberg::Vst::kAudio;
      info.direction = direction;
      info.channelCount = 0;
      info.busType = index == 0 ? Steinberg::Vst::kMain : Steinberg::Vst::kAux;
    }

    const auto active = static_cast<std::size_t>(index) < activeChannels.size() &&
        activeChannels[static_cast<std::size_t>(index)] > 0;
    const auto channels = active
        ? activeChannels[static_cast<std::size_t>(index)]
        : static_cast<std::uint32_t>(std::clamp<Steinberg::int32>(
            info.channelCount,
            0,
            static_cast<Steinberg::int32>(kMaxWorkerChannels)));
    const auto name = cappedString(VST3::StringConvert::convert(info.name));
    output << "{\"index\":" << index
           << ",\"direction\":\"" << (direction == Steinberg::Vst::kInput ? "input" : "output") << "\""
           << ",\"mediaType\":\"audio\""
           << ",\"name\":\"" << jsonEscape(name.empty() ? (direction == Steinberg::Vst::kInput ? "Input" : "Output") : name) << "\""
           << ",\"type\":\"" << (info.busType == Steinberg::Vst::kMain ? "main" : info.busType == Steinberg::Vst::kAux ? "aux" : "unknown") << "\""
           << ",\"channels\":" << std::min<std::uint32_t>(channels, kMaxWorkerChannels)
           << ",\"active\":" << (active ? "true" : "false")
           << "}";
  }
  output << "]";
  return output.str();
}

} // namespace soundbridge::vst3_worker

#endif
