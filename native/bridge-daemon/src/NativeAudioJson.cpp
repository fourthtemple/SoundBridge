#include "SoundBridge/NativeAudioJson.h"

#include <charconv>
#include <cmath>
#include <system_error>

namespace soundbridge::worker_audio_json {
namespace {

void appendJsonSample(std::string& output, float sample) {
  const float value = std::isfinite(sample) ? sample : 0.0F;
  char buffer[64] {};
  const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::general, 6);
  if (converted.ec != std::errc{}) {
    output.push_back('0');
    return;
  }
  output.append(buffer, static_cast<std::size_t>(converted.ptr - buffer));
}

} // namespace

std::size_t estimatedChannelsJsonBytes(const std::vector<std::vector<float>>& channels) {
  std::size_t sampleCount = 0;
  for (const auto& channel : channels) sampleCount += channel.size();
  return 2 + channels.size() * 2 + sampleCount * 12;
}

void appendChannelsJson(std::string& output, const std::vector<std::vector<float>>& channels) {
  output.push_back('[');
  for (std::size_t channelIndex = 0; channelIndex < channels.size(); ++channelIndex) {
    if (channelIndex > 0) output.push_back(',');
    output.push_back('[');
    for (std::size_t frame = 0; frame < channels[channelIndex].size(); ++frame) {
      if (frame > 0) output.push_back(',');
      appendJsonSample(output, channels[channelIndex][frame]);
    }
    output.push_back(']');
  }
  output.push_back(']');
}

std::string channelsToJson(const std::vector<std::vector<float>>& channels) {
  std::string output;
  output.reserve(estimatedChannelsJsonBytes(channels));
  appendChannelsJson(output, channels);
  return output;
}

} // namespace soundbridge::worker_audio_json
