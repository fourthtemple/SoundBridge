#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace soundbridge {

std::string base64Encode(const std::uint8_t* data, std::size_t size);
std::vector<std::uint8_t> base64Decode(const std::string& text, std::size_t maxDecodedBytes);
bool isBase64Text(const std::string& text);

} // namespace soundbridge
