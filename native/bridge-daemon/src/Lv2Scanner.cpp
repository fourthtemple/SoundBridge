#include "SoundBridge/Lv2Scanner.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <set>

namespace soundbridge {

namespace {

constexpr const char* kLv2UridMapUri = "http://lv2plug.in/ns/ext/urid#map";
constexpr const char* kLv2UridUnmapUri = "http://lv2plug.in/ns/ext/urid#unmap";
constexpr const char* kLv2WorkerScheduleUri = "http://lv2plug.in/ns/ext/worker#schedule";
constexpr const char* kLv2OptionsOptionsUri = "http://lv2plug.in/ns/ext/options#options";
constexpr const char* kLv2OptionsRequiredOptionUri = "http://lv2plug.in/ns/ext/options#requiredOption";
constexpr const char* kLv2BufSizeBoundedBlockLengthUri = "http://lv2plug.in/ns/ext/buf-size#boundedBlockLength";
constexpr const char* kLv2BufSizeMaxBlockLengthUri = "http://lv2plug.in/ns/ext/buf-size#maxBlockLength";
constexpr const char* kLv2BufSizeMinBlockLengthUri = "http://lv2plug.in/ns/ext/buf-size#minBlockLength";
constexpr const char* kLv2BufSizeNominalBlockLengthUri = "http://lv2plug.in/ns/ext/buf-size#nominalBlockLength";
constexpr const char* kLv2BufSizeSequenceSizeUri = "http://lv2plug.in/ns/ext/buf-size#sequenceSize";
constexpr std::uint32_t kMaxLv2UiDeclarations = 32;

struct Lv2UiType {
  const char* token;
  const char* uri;
  const char* label;
};

constexpr Lv2UiType kKnownLv2UiTypes[] = {
    {"ui:X11UI", "http://lv2plug.in/ns/extensions/ui#X11UI", "x11"},
    {"ui:CocoaUI", "http://lv2plug.in/ns/extensions/ui#CocoaUI", "cocoa"},
    {"ui:WindowsUI", "http://lv2plug.in/ns/extensions/ui#WindowsUI", "windows"},
    {"ui:GtkUI", "http://lv2plug.in/ns/extensions/ui#GtkUI", "gtk"},
    {"ui:Gtk3UI", "http://lv2plug.in/ns/extensions/ui#Gtk3UI", "gtk3"},
    {"ui:Qt4UI", "http://lv2plug.in/ns/extensions/ui#Qt4UI", "qt4"},
    {"ui:Qt5UI", "http://lv2plug.in/ns/extensions/ui#Qt5UI", "qt5"},
    {"ui:external", "http://lv2plug.in/ns/extensions/ui#external", "external"},
    {"ui:UI", "http://lv2plug.in/ns/extensions/ui#UI", "generic"}};

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
  bool inAngle = false;
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

    if (inAngle) {
      output.push_back(character);
      if (character == '>') {
        inAngle = false;
      }
      continue;
    }

    if (character == '<') {
      inAngle = true;
      output.push_back(character);
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

std::map<std::string, std::string> turtlePrefixes(const std::string& text) {
  std::map<std::string, std::string> prefixes{
      {"lv2", "http://lv2plug.in/ns/lv2core#"},
      {"urid", "http://lv2plug.in/ns/ext/urid#"},
      {"state", "http://lv2plug.in/ns/ext/state#"},
      {"worker", "http://lv2plug.in/ns/ext/worker#"},
      {"buf-size", "http://lv2plug.in/ns/ext/buf-size#"},
      {"options", "http://lv2plug.in/ns/ext/options#"},
      {"opts", "http://lv2plug.in/ns/ext/options#"},
      {"atom", "http://lv2plug.in/ns/ext/atom#"},
      {"midi", "http://lv2plug.in/ns/ext/midi#"},
      {"time", "http://lv2plug.in/ns/ext/time#"},
      {"ui", "http://lv2plug.in/ns/extensions/ui#"},
  };

  std::size_t position = 0;
  while ((position = text.find("@prefix", position)) != std::string::npos && prefixes.size() < 64) {
    const auto nameStart = text.find_first_not_of(" \t\r\n", position + 7);
    if (nameStart == std::string::npos) {
      break;
    }
    const auto colon = text.find(':', nameStart);
    if (colon == std::string::npos || colon <= nameStart || colon - nameStart > 32) {
      position = nameStart + 1;
      continue;
    }
    const auto angleStart = text.find('<', colon + 1);
    const auto angleEnd = angleStart == std::string::npos ? std::string::npos : text.find('>', angleStart + 1);
    if (angleStart == std::string::npos || angleEnd == std::string::npos || angleEnd <= angleStart + 1) {
      position = colon + 1;
      continue;
    }
    const auto name = text.substr(nameStart, colon - nameStart);
    const auto uri = text.substr(angleStart + 1, angleEnd - angleStart - 1);
    if (uri.size() <= 256) {
      prefixes[name] = uri;
    }
    position = angleEnd + 1;
  }

  return prefixes;
}

std::optional<std::string> expandPrefixedUri(
    const std::string& token,
    const std::map<std::string, std::string>& prefixes) {
  const auto colon = token.find(':');
  if (colon == std::string::npos || colon == 0 || colon + 1 >= token.size()) {
    return std::nullopt;
  }
  const auto prefix = token.substr(0, colon);
  const auto local = token.substr(colon + 1);
  const auto found = prefixes.find(prefix);
  if (found == prefixes.end() || local.size() > 128) {
    return std::nullopt;
  }
  return found->second + local;
}

std::size_t turtleObjectListEnd(const std::string& text, std::size_t start) {
  bool inUri = false;
  bool inString = false;
  bool escapingString = false;
  char stringQuote = '\0';
  for (std::size_t index = start; index < text.size(); ++index) {
    const char current = text[index];
    if (inString) {
      if (escapingString) {
        escapingString = false;
      } else if (current == '\\') {
        escapingString = true;
      } else if (current == stringQuote) {
        inString = false;
      }
      continue;
    }
    if (inUri) {
      if (current == '>') {
        inUri = false;
      }
      continue;
    }
    if (current == '<') {
      inUri = true;
      continue;
    }
    if (current == '"' || current == '\'') {
      inString = true;
      stringQuote = current;
      continue;
    }
    if (current == ';' || current == ']') {
      return index;
    }
    if (current == '.' && (index + 1 == text.size() || std::isspace(static_cast<unsigned char>(text[index + 1])))) {
      return index;
    }
  }
  return std::string::npos;
}

std::set<std::string> predicateUris(const std::string& text, const std::string& predicate) {
  std::set<std::string> values;
  const auto prefixes = turtlePrefixes(text);
  std::size_t position = 0;
  while ((position = text.find(predicate, position)) != std::string::npos && values.size() < 64) {
    const auto valueStart = position + predicate.size();
    const auto valueEnd = turtleObjectListEnd(text, valueStart);
    const auto segment = text.substr(valueStart, valueEnd == std::string::npos ? std::string::npos : valueEnd - valueStart);

    std::size_t anglePosition = 0;
    while ((anglePosition = segment.find('<', anglePosition)) != std::string::npos && values.size() < 64) {
      const auto end = segment.find('>', anglePosition + 1);
      if (end == std::string::npos || end <= anglePosition + 1) {
        break;
      }
      const auto uri = segment.substr(anglePosition + 1, end - anglePosition - 1);
      if (uri.size() <= 256) {
        values.insert(uri);
      }
      anglePosition = end + 1;
    }

    std::size_t tokenPosition = 0;
    while (tokenPosition < segment.size() && values.size() < 64) {
      const auto start = segment.find_first_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", tokenPosition);
      if (start == std::string::npos) {
        break;
      }
      const auto end = segment.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_:-", start);
      const auto token = segment.substr(start, end == std::string::npos ? std::string::npos : end - start);
      if (auto expanded = expandPrefixedUri(token, prefixes)) {
        if (expanded->size() <= 256) {
          values.insert(*expanded);
        }
      }
      tokenPosition = end == std::string::npos ? segment.size() : end + 1;
    }

    position = valueEnd == std::string::npos ? text.size() : valueEnd + 1;
  }
  return values;
}

std::set<std::string> requiredFeatureUris(const std::string& text) {
  return predicateUris(text, "lv2:requiredFeature");
}

std::set<std::string> requiredOptionUris(const std::string& text) {
  auto options = predicateUris(text, "opts:requiredOption");
  for (const auto& uri : predicateUris(text, "options:requiredOption")) {
    options.insert(uri);
  }
  for (const auto& uri : predicateUris(text, std::string("<") + kLv2OptionsRequiredOptionUri + ">")) {
    options.insert(uri);
  }
  return options;
}

bool lv2RequiredFeatureSupported(const std::string& uri) {
  return uri == kLv2UridMapUri ||
      uri == kLv2UridUnmapUri ||
      uri == kLv2WorkerScheduleUri ||
      uri == kLv2OptionsOptionsUri ||
      uri == kLv2BufSizeBoundedBlockLengthUri;
}

bool lv2RequiredOptionSupported(const std::string& uri) {
  return uri == kLv2BufSizeMaxBlockLengthUri ||
      uri == kLv2BufSizeMinBlockLengthUri ||
      uri == kLv2BufSizeNominalBlockLengthUri ||
      uri == kLv2BufSizeSequenceSizeUri;
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

std::uint32_t countOccurrences(const std::string& text, const std::string& needle) {
  if (needle.empty()) {
    return 0;
  }
  std::uint32_t count = 0;
  std::size_t position = 0;
  while ((position = text.find(needle, position)) != std::string::npos && count < kMaxLv2UiDeclarations) {
    ++count;
    position += needle.size();
  }
  return count;
}

bool turtleMentionsType(const std::string& text, const Lv2UiType& type) {
  return text.find(type.token) != std::string::npos ||
      text.find(std::string("<") + type.uri + ">") != std::string::npos;
}

std::vector<std::string> lv2UiTypes(const std::string& text) {
  std::vector<std::string> types;
  for (const auto& type : kKnownLv2UiTypes) {
    if (turtleMentionsType(text, type)) {
      types.push_back(type.label);
    }
    if (types.size() >= kMaxLv2UiDeclarations) {
      break;
    }
  }
  return types;
}

std::uint32_t lv2UiDeclarationCount(const std::string& text) {
  std::uint32_t count = 0;
  for (const auto& type : kKnownLv2UiTypes) {
    count = std::min<std::uint32_t>(
        kMaxLv2UiDeclarations,
        count + countOccurrences(text, type.token) +
            countOccurrences(text, std::string("<") + type.uri + ">"));
  }
  return count;
}

std::uint32_t lv2UiBinaryCount(const std::filesystem::path& bundlePath, const std::string& text) {
  std::uint32_t count = 0;
  for (const auto& binary : angleValuesAfter(text, "ui:binary")) {
    if (!bundleLocalRegularFile(bundlePath, binary).empty()) {
      ++count;
    }
    if (count >= kMaxLv2UiDeclarations) {
      break;
    }
  }
  return count;
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

  std::uint32_t unsupportedRequiredFeatures = 0;
  for (const auto& uri : requiredFeatureUris(turtle)) {
    if (!lv2RequiredFeatureSupported(uri)) {
      ++unsupportedRequiredFeatures;
    }
  }
  info.unsupportedRequiredFeatureCount = unsupportedRequiredFeatures;
  info.hasUnsupportedRequiredFeatures = unsupportedRequiredFeatures > 0;
  std::uint32_t unsupportedRequiredOptions = 0;
  for (const auto& uri : requiredOptionUris(turtle)) {
    if (!lv2RequiredOptionSupported(uri)) {
      ++unsupportedRequiredOptions;
    }
  }
  info.unsupportedRequiredOptionCount = unsupportedRequiredOptions;
  info.hasUnsupportedRequiredOptions = unsupportedRequiredOptions > 0;
  info.lv2UiTypes = lv2UiTypes(turtle);
  info.lv2UiCount = std::max<std::uint32_t>(
      static_cast<std::uint32_t>(info.lv2UiTypes.size()),
      lv2UiDeclarationCount(turtle));
  info.lv2UiBinaryCount = info.lv2UiCount > 0 ? lv2UiBinaryCount(bundlePath, turtle) : 0;

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
