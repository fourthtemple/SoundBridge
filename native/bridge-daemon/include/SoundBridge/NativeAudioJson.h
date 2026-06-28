#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace soundbridge::worker_audio_json {

std::size_t estimatedChannelsJsonBytes(const std::vector<std::vector<float>>& channels);
void appendChannelsJson(std::string& output, const std::vector<std::vector<float>>& channels);
std::string channelsToJson(const std::vector<std::vector<float>>& channels);

} // namespace soundbridge::worker_audio_json
