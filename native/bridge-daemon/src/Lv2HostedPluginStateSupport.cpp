#include "SoundBridge/Lv2HostedPluginStateSupport.h"

#ifndef _WIN32

#include "SoundBridge/Base64.h"

#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace soundbridge::lv2_worker {
namespace {

void restoreControlStateEntry(
    std::stringstream& entry,
    std::vector<Lv2Port>& ports,
    const std::vector<std::size_t>& inputControlPortIndexes) {
  std::string portIndexText;
  std::string valueText;
  entry >> portIndexText;
  entry >> valueText;
  std::string extra;
  entry >> extra;
  std::uint32_t portIndex = 0;
  double value = 0.0;
  if (!extra.empty() ||
      !parseUint32Arg(portIndexText.c_str(), 0, kMaxWorkerPortIndex, portIndex) ||
      !parseStateValue(valueText, value)) {
    throw std::runtime_error("invalid_lv2_state");
  }

  for (const auto controlPortIndex : inputControlPortIndexes) {
    auto& port = ports[controlPortIndex];
    if (port.index == portIndex) {
      port.value = static_cast<float>(std::clamp(
          value,
          static_cast<double>(port.minimum),
          static_cast<double>(port.maximum)));
      break;
    }
  }
}

void restoreControlStateLines(
    std::stringstream& lines,
    std::vector<Lv2Port>& ports,
    const std::vector<std::size_t>& inputControlPortIndexes) {
  std::size_t restored = 0;
  std::string line;
  while (std::getline(lines, line)) {
    if (line.empty()) {
      continue;
    }
    if (++restored > kMaxWorkerParameters) {
      throw std::runtime_error("state_too_large");
    }
    std::stringstream entry(line);
    std::string prefix;
    entry >> prefix;
    if (prefix != "p") {
      throw std::runtime_error("invalid_lv2_state");
    }
    restoreControlStateEntry(entry, ports, inputControlPortIndexes);
  }
}

} // namespace

std::string lv2HostedPluginStateBase64(
    const std::vector<Lv2Port>& ports,
    const std::vector<std::size_t>& inputControlPortIndexes,
    const Lv2SavedExtensionState& extensionState) {
  std::ostringstream state;
  state << kLv2StateMagic << "\n";
  state << std::setprecision(9);
  for (const auto portIndex : inputControlPortIndexes) {
    const auto& port = ports[portIndex];
    state << "p " << port.index << " " << sanitizeStateValue(port.value) << "\n";
  }
  for (const auto& property : extensionState.properties) {
    state << "s "
          << stateStringToBase64(property.keyUri) << " "
          << stateStringToBase64(property.typeUri) << " "
          << property.flags << " "
          << base64Encode(property.value.data(), property.value.size()) << "\n";
  }
  for (const auto& file : extensionState.files) {
    state << "f "
          << stateStringToBase64(file.abstractPath) << " "
          << base64Encode(file.value.data(), file.value.size()) << "\n";
  }
  const auto text = state.str();
  if (text.size() > kMaxWorkerStateBytes) {
    throw std::runtime_error("state_too_large");
  }
  return base64Encode(reinterpret_cast<const std::uint8_t*>(text.data()), text.size());
}

void restoreLv2HostedPluginState(
    const std::string& encodedState,
    std::vector<Lv2Port>& ports,
    const std::vector<std::size_t>& inputControlPortIndexes,
    Lv2UridMapper& uridMapper,
    const Lv2ExtensionStateRestorer& restoreExtensionState) {
  const auto decoded = base64Decode(encodedState, kMaxWorkerStateBytes);
  const std::string text(decoded.begin(), decoded.end());
  std::stringstream lines(text);
  std::string line;
  if (!std::getline(lines, line)) {
    throw std::runtime_error("invalid_lv2_state");
  }
  if (line == kLv2ControlStateMagic) {
    restoreControlStateLines(lines, ports, inputControlPortIndexes);
    return;
  }
  if (line != kLv2StateMagic) {
    throw std::runtime_error("invalid_lv2_state");
  }

  std::size_t restored = 0;
  std::size_t totalExtensionBytes = 0;
  std::size_t totalFileBytes = 0;
  std::vector<Lv2RestoredStateProperty> extensionProperties;
  std::vector<Lv2StateFile> extensionFiles;
  while (std::getline(lines, line)) {
    if (line.empty()) {
      continue;
    }
    if (++restored > kMaxWorkerParameters + kMaxWorkerStateProperties) {
      throw std::runtime_error("state_too_large");
    }

    std::stringstream entry(line);
    std::string prefix;
    entry >> prefix;
    if (prefix == "p") {
      restoreControlStateEntry(entry, ports, inputControlPortIndexes);
      continue;
    }
    if (prefix == "s") {
      std::string keyText;
      std::string typeText;
      std::string flagsText;
      std::string valueText;
      entry >> keyText;
      entry >> typeText;
      entry >> flagsText;
      entry >> valueText;
      std::string extra;
      entry >> extra;
      std::uint32_t flags = 0;
      if (!extra.empty() || !parseUint32Arg(flagsText.c_str(), 0, 0xFFFFFFFFU, flags)) {
        throw std::runtime_error("invalid_lv2_state");
      }

      const auto keyUri = base64ToStateString(keyText, kMaxWorkerUriBytes);
      const auto typeUri = base64ToStateString(typeText, kMaxWorkerUriBytes);
      auto value = base64Decode(valueText, kMaxWorkerStatePropertyBytes);
      if (!isValidStateUri(keyUri) || !isValidStateUri(typeUri) || value.empty() || !isPortablePodState(flags)) {
        throw std::runtime_error("invalid_lv2_state");
      }
      totalExtensionBytes += value.size();
      if (totalExtensionBytes > kMaxWorkerStateBytes / 2) {
        throw std::runtime_error("state_too_large");
      }
      const auto key = uridMapper.map(keyUri.c_str());
      const auto type = uridMapper.map(typeUri.c_str());
      if (key == 0 || type == 0) {
        throw std::runtime_error("invalid_lv2_state");
      }
      if (extensionProperties.size() >= kMaxWorkerStateProperties) {
        throw std::runtime_error("state_too_large");
      }
      extensionProperties.push_back(Lv2RestoredStateProperty{key, type, flags, std::move(value)});
      continue;
    }
    if (prefix == "f") {
      std::string pathText;
      std::string valueText;
      entry >> pathText;
      entry >> valueText;
      std::string extra;
      entry >> extra;
      if (!extra.empty() || extensionFiles.size() >= kMaxWorkerStateFiles) {
        throw std::runtime_error("invalid_lv2_state");
      }
      auto abstractPath = base64ToStateString(pathText, kMaxWorkerStatePathBytes);
      auto value = base64Decode(valueText, kMaxWorkerStateFileBytes);
      if (abstractPath.empty() || value.empty()) {
        throw std::runtime_error("invalid_lv2_state");
      }
      totalFileBytes += value.size();
      if (totalFileBytes > kMaxWorkerStateFileTotalBytes) {
        throw std::runtime_error("state_too_large");
      }
      extensionFiles.push_back(Lv2StateFile{std::move(abstractPath), std::move(value)});
      continue;
    }
    throw std::runtime_error("invalid_lv2_state");
  }

  if (restoreExtensionState) {
    restoreExtensionState(extensionProperties, extensionFiles);
  }
}

} // namespace soundbridge::lv2_worker

#endif
