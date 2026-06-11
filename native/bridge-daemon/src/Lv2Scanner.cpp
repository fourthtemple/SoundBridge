#include "SoundBridge/Lv2Scanner.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <optional>
#include <set>

namespace soundbridge {

namespace {

std::filesystem::path repositoryExampleLv2Path() {
#ifdef SOUNDBRIDGE_SOURCE_DIR
  return std::filesystem::path(SOUNDBRIDGE_SOURCE_DIR) / "native" / "example-plugins" / "LV2";
#else
  return {};
#endif
}

std::filesystem::path homeLibraryLv2Path() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || std::string(home).empty()) {
    return {};
  }
  return std::filesystem::path(home) / "Library" / "Audio" / "Plug-Ins" / "LV2";
}

std::filesystem::path homeDotLv2Path() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || std::string(home).empty()) {
    return {};
  }
  return std::filesystem::path(home) / ".lv2";
}

std::string lv2NameFromPath(const std::filesystem::path& path) {
  auto name = path.stem().string();
  return name.empty() ? path.filename().string() : name;
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) {
    return {};
  }
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

std::optional<std::string> manifestStringValue(const std::string& manifest, const std::string& key) {
  const auto keyPosition = manifest.find("\"" + key + "\"");
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto colonPosition = manifest.find(':', keyPosition);
  if (colonPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto quoteStart = manifest.find('"', colonPosition + 1);
  if (quoteStart == std::string::npos) {
    return std::nullopt;
  }
  const auto quoteEnd = manifest.find('"', quoteStart + 1);
  if (quoteEnd == std::string::npos) {
    return std::nullopt;
  }
  return manifest.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
}

std::optional<std::uint32_t> manifestIntValue(const std::string& manifest, const std::string& key) {
  const auto keyPosition = manifest.find("\"" + key + "\"");
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto colonPosition = manifest.find(':', keyPosition);
  if (colonPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto valueStart = manifest.find_first_of("0123456789", colonPosition + 1);
  if (valueStart == std::string::npos) {
    return std::nullopt;
  }
  const auto valueEnd = manifest.find_first_not_of("0123456789", valueStart);
  const auto text = manifest.substr(valueStart, valueEnd - valueStart);
  char* end = nullptr;
  errno = 0;
  const auto value = std::strtoul(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0' || errno == ERANGE || value > 32) {
    return std::nullopt;
  }
  return static_cast<std::uint32_t>(value);
}

bool hasSharedLibrary(const std::filesystem::path& bundlePath) {
  std::error_code error;
  for (const auto& entry : std::filesystem::directory_iterator(bundlePath, error)) {
    if (error) {
      return false;
    }
    if (!entry.is_regular_file(error) || error) {
      continue;
    }
    const auto extension = entry.path().extension().string();
    if (extension == ".dylib" || extension == ".so") {
      return true;
    }
  }
  return false;
}

bool manifestDeclaresPlugin(const std::filesystem::path& bundlePath) {
  const auto content = readTextFile(bundlePath / "manifest.ttl");
  return content.find("lv2:Plugin") != std::string::npos;
}

std::string stripTurtleComments(const std::string& input) {
  std::string output;
  output.reserve(input.size());
  bool inString = false;
  bool escaped = false;
  bool inComment = false;
  for (const char character : input) {
    if (inComment) {
      if (character == '\n' || character == '\r') {
        inComment = false;
        output.push_back(character);
      }
      continue;
    }

    if (inString) {
      output.push_back(character);
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        inString = false;
      }
      continue;
    }

    if (character == '#') {
      inComment = true;
      continue;
    }
    if (character == '"') {
      inString = true;
    }
    output.push_back(character);
  }
  return output;
}

std::optional<std::string> angleValueAfter(const std::string& text, const std::string& key) {
  const auto keyPosition = text.find(key);
  if (keyPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto start = text.find('<', keyPosition + key.size());
  if (start == std::string::npos) {
    return std::nullopt;
  }
  const auto end = text.find('>', start + 1);
  if (end == std::string::npos || end <= start + 1) {
    return std::nullopt;
  }
  return text.substr(start + 1, end - start - 1);
}

std::optional<std::string> firstPluginUri(const std::string& text) {
  const auto pluginPosition = text.find("lv2:Plugin");
  if (pluginPosition == std::string::npos) {
    return std::nullopt;
  }
  const auto start = text.rfind('<', pluginPosition);
  if (start == std::string::npos) {
    return std::nullopt;
  }
  const auto end = text.find('>', start + 1);
  if (end == std::string::npos || end > pluginPosition || end <= start + 1) {
    return std::nullopt;
  }
  return text.substr(start + 1, end - start - 1);
}

std::vector<std::string> angleValuesAfter(const std::string& text, const std::string& key) {
  std::vector<std::string> values;
  std::size_t position = 0;
  while ((position = text.find(key, position)) != std::string::npos && values.size() < 64) {
    auto restPosition = position + key.size();
    while (true) {
      const auto start = text.find('<', restPosition);
      if (start == std::string::npos) {
        position = restPosition;
        break;
      }
      const auto separator = text.find_first_of(".;", restPosition);
      if (separator != std::string::npos && separator < start) {
        position = separator + 1;
        break;
      }
      const auto end = text.find('>', start + 1);
      if (end == std::string::npos) {
        position = restPosition;
        break;
      }
      values.push_back(text.substr(start + 1, end - start - 1));
      restPosition = end + 1;
      if (values.size() >= 64) {
        break;
      }
    }
  }
  return values;
}

std::filesystem::path canonicalPathOrInput(const std::filesystem::path& path) {
  std::error_code error;
  const auto canonical = std::filesystem::weakly_canonical(path, error);
  if (error) {
    return path;
  }
  return canonical;
}

bool pathIsWithin(const std::filesystem::path& child, const std::filesystem::path& parent) {
  auto childIt = child.begin();
  for (auto parentIt = parent.begin(); parentIt != parent.end(); ++parentIt, ++childIt) {
    if (childIt == child.end() || *childIt != *parentIt) {
      return false;
    }
  }
  return true;
}

std::filesystem::path bundleLocalRegularFile(
    const std::filesystem::path& bundlePath,
    const std::string& relativeText) {
  const std::filesystem::path relativePath(relativeText);
  if (relativePath.empty() || relativePath.is_absolute() || relativePath.filename() != relativePath) {
    return {};
  }

  std::error_code error;
  const auto candidate = bundlePath / relativePath;
  if (!std::filesystem::is_regular_file(candidate, error) || error) {
    return {};
  }
  if (std::filesystem::is_symlink(std::filesystem::symlink_status(candidate, error)) || error) {
    return {};
  }

  const auto canonicalBundle = std::filesystem::canonical(bundlePath, error);
  if (error) {
    return {};
  }
  const auto canonicalCandidate = std::filesystem::canonical(candidate, error);
  if (error || !pathIsWithin(canonicalCandidate, canonicalBundle)) {
    return {};
  }
  return canonicalCandidate;
}

std::filesystem::path lv2BinaryPath(const std::filesystem::path& bundlePath, const std::string& manifest) {
  const auto binary = angleValueAfter(manifest, "lv2:binary");
  if (!binary) {
    return {};
  }
  return bundleLocalRegularFile(bundlePath, *binary);
}

bool parseNumberAfter(const std::string& text, const std::string& key, double& out) {
  const auto keyPosition = text.find(key);
  if (keyPosition == std::string::npos) {
    return false;
  }
  const auto valueStart = text.find_first_of("-+0123456789.", keyPosition + key.size());
  if (valueStart == std::string::npos) {
    return false;
  }
  char* end = nullptr;
  const double value = std::strtod(text.c_str() + valueStart, &end);
  if (end == text.c_str() + valueStart || !std::isfinite(value)) {
    return false;
  }
  out = value;
  return true;
}

std::optional<std::uint32_t> parsePortIndex(const std::string& block) {
  double value = 0.0;
  if (!parseNumberAfter(block, "lv2:index", value) || value < 0.0 || value > 4096.0) {
    return std::nullopt;
  }
  return static_cast<std::uint32_t>(value);
}

std::vector<std::string> extractPortBlocks(const std::string& text) {
  std::vector<std::string> blocks;
  std::size_t position = 0;
  while ((position = text.find("lv2:port", position)) != std::string::npos && blocks.size() < 1024) {
    auto scan = position + 8;
    std::size_t depth = 0;
    bool inString = false;
    bool escaped = false;
    std::string current;

    for (; scan < text.size(); ++scan) {
      const char character = text[scan];
      if (inString) {
        if (depth > 0) {
          current.push_back(character);
        }
        if (escaped) {
          escaped = false;
        } else if (character == '\\') {
          escaped = true;
        } else if (character == '"') {
          inString = false;
        }
        continue;
      }

      if (character == '"') {
        inString = true;
        if (depth > 0) {
          current.push_back(character);
        }
        continue;
      }

      if (character == '[') {
        if (depth == 0) {
          current.clear();
        } else {
          current.push_back(character);
        }
        ++depth;
        continue;
      }

      if (character == ']' && depth > 0) {
        --depth;
        if (depth == 0) {
          blocks.push_back(current);
          current.clear();
          if (blocks.size() >= 1024) {
            return blocks;
          }
        } else {
          current.push_back(character);
        }
        continue;
      }

      if (character == '.' && depth == 0) {
        ++scan;
        break;
      }

      if (depth > 0) {
        current.push_back(character);
      }
    }
    position = std::max(scan, position + 1);
  }
  return blocks;
}

std::string lv2BundleTurtle(const std::filesystem::path& bundlePath, const std::string& manifest) {
  std::string turtle = manifest;
  for (const auto& seeAlso : angleValuesAfter(manifest, "rdfs:seeAlso")) {
    const auto metadataPath = bundleLocalRegularFile(bundlePath, seeAlso);
    if (!metadataPath.empty()) {
      turtle += "\n";
      turtle += stripTurtleComments(readTextFile(metadataPath));
    }
  }
  return turtle;
}

void applyLv2TurtleMetadata(
    NativePluginInfo& info,
    const std::filesystem::path& bundlePath,
    const std::string& manifest) {
  const auto turtle = lv2BundleTurtle(bundlePath, manifest);
  if (turtle.find("lv2:InstrumentPlugin") != std::string::npos) {
    info.kind = "instrument";
    info.category = "Instrument|LV2";
  }

  std::uint32_t inputs = 0;
  std::uint32_t outputs = 0;
  std::set<std::uint32_t> indexes;
  for (const auto& block : extractPortBlocks(turtle)) {
    const auto index = parsePortIndex(block);
    if (!index || indexes.count(*index) > 0 || block.find("lv2:AudioPort") == std::string::npos) {
      continue;
    }
    indexes.insert(*index);
    if (block.find("lv2:InputPort") != std::string::npos) {
      ++inputs;
    } else if (block.find("lv2:OutputPort") != std::string::npos) {
      ++outputs;
    }
  }
  if (inputs > 0 || outputs > 0) {
    info.inputs = std::min<std::uint32_t>(inputs, 32);
    info.outputs = std::min<std::uint32_t>(outputs, 32);
    if (info.kind == "unknown" && outputs > 0) {
      info.kind = inputs > 0 ? "effect" : "instrument";
    }
  }
}

std::filesystem::path exampleExecutablePath(
    const std::filesystem::path& bundlePath,
    const std::string& manifest) {
  const auto executableName = manifestStringValue(manifest, "executable");
  if (!executableName || executableName->empty()) {
    return {};
  }

  // Reject anything that is not a plain file name. The manifest is untrusted
  // content; a relative or absolute path here could point the daemon at an
  // arbitrary binary outside the bundle.
  const std::filesystem::path namePath(*executableName);
  if (namePath.is_absolute() || namePath.filename() != namePath) {
    return {};
  }

  const auto executablePath = bundlePath / namePath;
  std::error_code error;
  if (!std::filesystem::is_regular_file(executablePath, error) || error) {
    return {};
  }
  if (std::filesystem::is_symlink(std::filesystem::symlink_status(executablePath, error)) || error) {
    return {};
  }

  // Resolve symlinks in the full path and require the result to stay inside
  // the (resolved) bundle directory.
  const auto canonicalBundle = std::filesystem::canonical(bundlePath, error);
  if (error) {
    return {};
  }
  const auto canonicalExecutable = std::filesystem::canonical(executablePath, error);
  if (error || !pathIsWithin(canonicalExecutable, canonicalBundle)) {
    return {};
  }
  return canonicalExecutable;
}

void applySoundBridgeManifest(NativePluginInfo& info, const std::filesystem::path& bundlePath) {
  const auto manifest = readTextFile(bundlePath / "SoundBridgePlugin.json");
  if (manifest.empty()) {
    return;
  }

  if (auto value = manifestStringValue(manifest, "pluginId")) {
    info.pluginId = *value;
  }
  if (auto value = manifestStringValue(manifest, "name")) {
    info.name = *value;
  }
  if (auto value = manifestStringValue(manifest, "vendor")) {
    info.vendor = *value;
  }
  if (auto value = manifestStringValue(manifest, "category")) {
    info.category = *value;
  }
  if (auto value = manifestStringValue(manifest, "kind")) {
    info.kind = *value;
  }
  if (auto value = manifestStringValue(manifest, "source")) {
    info.source = *value;
  }
  if (auto value = manifestIntValue(manifest, "inputs")) {
    info.inputs = *value;
  }
  if (auto value = manifestIntValue(manifest, "outputs")) {
    info.outputs = *value;
  }

  info.isExample = info.source == "example-bundle";
  info.hasManifest = true;

  if (const auto executablePath = exampleExecutablePath(bundlePath, manifest); !executablePath.empty()) {
    info.executablePath = executablePath.string();
    info.hasExecutable = true;
  }
}

} // namespace

Lv2Scanner::Lv2Scanner()
    : paths_{
          repositoryExampleLv2Path(),
          std::filesystem::path("/Library/Audio/Plug-Ins/LV2"),
          homeLibraryLv2Path(),
          homeDotLv2Path(),
          std::filesystem::path("/opt/homebrew/lib/lv2"),
          std::filesystem::path("/usr/local/lib/lv2"),
          std::filesystem::path("/usr/lib/lv2"),
      } {}

std::vector<std::filesystem::path> Lv2Scanner::searchPaths() const {
  std::vector<std::filesystem::path> paths;
  for (const auto& path : paths_) {
    if (!path.empty()) {
      paths.push_back(path);
    }
  }
  return paths;
}

std::vector<NativePluginInfo> Lv2Scanner::scan() const {
  std::vector<NativePluginInfo> plugins;

  for (const auto& root : searchPaths()) {
    std::error_code error;
    if (!std::filesystem::is_directory(root, error)) {
      continue;
    }

    for (const auto& entry : std::filesystem::directory_iterator(root, error)) {
      if (error) {
        break;
      }

      const auto path = entry.path();
      if (path.extension() != ".lv2") {
        continue;
      }

      const bool isBundle = entry.is_directory(error);
      if (error || !isBundle) {
        continue;
      }

      const bool hasManifest = std::filesystem::is_regular_file(path / "manifest.ttl", error) && !error;
      if (!hasManifest || !manifestDeclaresPlugin(path)) {
        continue;
      }

      NativePluginInfo info;
      const auto manifest = stripTurtleComments(readTextFile(path / "manifest.ttl"));
      info.pluginId = "lv2:" + path.filename().string();
      info.format = PluginFormat::Lv2;
      info.name = lv2NameFromPath(path);
      info.vendor = "Unknown";
      info.category = "LV2";
      info.kind = "unknown";
      info.lv2Uri = firstPluginUri(manifest).value_or("");
      info.bundlePath = canonicalPathOrInput(path).string();
      info.hasContents = true;
      info.hasManifest = hasManifest;
      info.hasExecutable = hasSharedLibrary(path) || !lv2BinaryPath(path, manifest).empty();
      applyLv2TurtleMetadata(info, path, manifest);
      applySoundBridgeManifest(info, path);
      plugins.push_back(std::move(info));
    }
  }

  return plugins;
}

} // namespace soundbridge
