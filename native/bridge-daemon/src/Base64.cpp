#include "SoundBridge/Base64.h"

#include <array>
#include <stdexcept>

namespace soundbridge {

namespace {

constexpr char kBase64Alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::array<int, 256> makeDecodeTable() {
  std::array<int, 256> table {};
  table.fill(-1);
  for (int index = 0; index < 64; ++index) {
    table[static_cast<unsigned char>(kBase64Alphabet[index])] = index;
  }
  return table;
}

const std::array<int, 256>& decodeTable() {
  static const auto table = makeDecodeTable();
  return table;
}

std::size_t decodedSizeForBase64(const std::string& text) {
  if (text.empty()) {
    return 0;
  }
  if (text.size() % 4 != 0) {
    throw std::runtime_error("invalid_base64_state");
  }
  std::size_t padding = 0;
  if (!text.empty() && text[text.size() - 1] == '=') {
    ++padding;
  }
  if (text.size() > 1 && text[text.size() - 2] == '=') {
    ++padding;
  }
  return (text.size() / 4) * 3 - padding;
}

} // namespace

std::string base64Encode(const std::uint8_t* data, std::size_t size) {
  if (data == nullptr || size == 0) {
    return "";
  }

  std::string output;
  output.reserve(((size + 2) / 3) * 4);
  for (std::size_t index = 0; index < size; index += 3) {
    const auto byte0 = data[index];
    const auto byte1 = index + 1 < size ? data[index + 1] : 0;
    const auto byte2 = index + 2 < size ? data[index + 2] : 0;
    const auto triple = (static_cast<unsigned int>(byte0) << 16) |
        (static_cast<unsigned int>(byte1) << 8) |
        static_cast<unsigned int>(byte2);

    output.push_back(kBase64Alphabet[(triple >> 18) & 0x3F]);
    output.push_back(kBase64Alphabet[(triple >> 12) & 0x3F]);
    output.push_back(index + 1 < size ? kBase64Alphabet[(triple >> 6) & 0x3F] : '=');
    output.push_back(index + 2 < size ? kBase64Alphabet[triple & 0x3F] : '=');
  }
  return output;
}

bool isBase64Text(const std::string& text) {
  if (text.size() % 4 != 0) {
    return false;
  }
  const auto& table = decodeTable();
  bool seenPadding = false;
  for (std::size_t index = 0; index < text.size(); ++index) {
    const unsigned char character = static_cast<unsigned char>(text[index]);
    if (character == '=') {
      seenPadding = true;
      if (index < text.size() - 2) {
        return false;
      }
      continue;
    }
    if (seenPadding || table[character] < 0) {
      return false;
    }
  }
  return true;
}

std::vector<std::uint8_t> base64Decode(const std::string& text, std::size_t maxDecodedBytes) {
  if (!isBase64Text(text)) {
    throw std::runtime_error("invalid_base64_state");
  }
  const auto decodedSize = decodedSizeForBase64(text);
  if (decodedSize > maxDecodedBytes) {
    throw std::runtime_error("state_too_large");
  }

  std::vector<std::uint8_t> output;
  output.reserve(decodedSize);
  const auto& table = decodeTable();
  for (std::size_t index = 0; index < text.size(); index += 4) {
    const auto value0 = table[static_cast<unsigned char>(text[index])];
    const auto value1 = table[static_cast<unsigned char>(text[index + 1])];
    const auto value2 = text[index + 2] == '=' ? 0 : table[static_cast<unsigned char>(text[index + 2])];
    const auto value3 = text[index + 3] == '=' ? 0 : table[static_cast<unsigned char>(text[index + 3])];
    const auto triple = (static_cast<unsigned int>(value0) << 18) |
        (static_cast<unsigned int>(value1) << 12) |
        (static_cast<unsigned int>(value2) << 6) |
        static_cast<unsigned int>(value3);

    output.push_back(static_cast<std::uint8_t>((triple >> 16) & 0xFF));
    if (text[index + 2] != '=') {
      output.push_back(static_cast<std::uint8_t>((triple >> 8) & 0xFF));
    }
    if (text[index + 3] != '=') {
      output.push_back(static_cast<std::uint8_t>(triple & 0xFF));
    }
  }
  return output;
}

} // namespace soundbridge
