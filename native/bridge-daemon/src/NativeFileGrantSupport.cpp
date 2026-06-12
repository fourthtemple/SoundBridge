#include "SoundBridge/NativeFileGrantSupport.h"

#include "SoundBridge/Base64.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>

#ifndef _WIN32
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace soundbridge::worker_file_grants {

namespace {

constexpr std::size_t kMaxGrantIdBytes = 80;
constexpr std::size_t kMaxDisplayNameBytes = 256;
constexpr std::size_t kMaxPathBytes = 4096;
constexpr char kSavedStatePrefix[] = "soundbridge-state-";
constexpr char kSavedStateExtension[] = ".txt";

std::string requireToken(std::istream& stream) {
  std::string token;
  stream >> token;
  if (token.empty()) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
  return token;
}

void rejectExtraTokens(std::istream& stream) {
  std::string extra;
  if (stream >> extra) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
}

std::string boundedToken(std::string value, std::size_t maxBytes) {
  if (value.empty() || value.size() > maxBytes) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
  return value;
}

std::string decodeTextToken(const std::string& token, std::size_t maxBytes) {
  if (token == "-") {
    return "";
  }
  const auto decoded = base64Decode(token, maxBytes);
  return std::string(decoded.begin(), decoded.end());
}

bool hasControlCharacter(const std::string& value) {
  return std::any_of(value.begin(), value.end(), [](unsigned char character) {
    return character == '\0' || character < 0x20 || character == 0x7F;
  });
}

std::size_t checkedFileSize(std::uintmax_t size, std::size_t maxBytes) {
  if (size == 0 || size > maxBytes || size > std::numeric_limits<std::size_t>::max()) {
    throw std::runtime_error("file_grant_state_file_too_large");
  }
  return static_cast<std::size_t>(size);
}

std::size_t maxBase64TokenBytes(std::size_t maxDecodedBytes) {
  if (maxDecodedBytes == 0 || maxDecodedBytes > (std::numeric_limits<std::size_t>::max() / 4) * 3) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
  return ((maxDecodedBytes + 2) / 3) * 4;
}

std::size_t maxStateFileBytes(std::size_t maxDecodedBytes, std::size_t maxTokens) {
  const auto tokenBytes = maxBase64TokenBytes(maxDecodedBytes);
  if (maxTokens == 0 || tokenBytes > (std::numeric_limits<std::size_t>::max() - 16) / maxTokens) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
  return tokenBytes * maxTokens + maxTokens + 16;
}

void requireStateGrantKind(const NativeFileGrantCommand& command, const std::string& operation, const std::string& kind) {
  if (command.operation != operation) {
    throw std::runtime_error("unsupported_file_grant_operation");
  }
  if (
      command.purpose != "state" ||
      command.kind != kind ||
      command.absolutePath.empty() ||
      hasControlCharacter(command.absolutePath) ||
      hasControlCharacter(command.displayName)) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
}

void requireRestoreStateGrant(const NativeFileGrantCommand& command) {
  requireStateGrantKind(command, "restoreState", "file");
  if (command.access != "read" && command.access != "readWrite") {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
}

void requireSaveStateDirectoryGrant(const NativeFileGrantCommand& command) {
  requireStateGrantKind(command, "saveStateDirectory", "directory");
  if (command.access != "readWrite") {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
}

std::string stateTokenOrSentinel(const std::string& token, std::size_t maxDecodedBytes) {
  if (token.empty()) {
    return "-";
  }
  if (token.size() > maxBase64TokenBytes(maxDecodedBytes)) {
    throw std::runtime_error("file_grant_state_file_too_large");
  }
  for (const auto character : token) {
    if (std::isspace(static_cast<unsigned char>(character)) || character == '\0') {
      throw std::runtime_error("invalid_file_grant_state_file");
    }
  }
  base64Decode(token, maxDecodedBytes);
  return token;
}

std::string safeFileNamePart(const std::string& value) {
  std::string output;
  output.reserve(std::min<std::size_t>(value.size(), kMaxGrantIdBytes));
  for (const auto character : value) {
    const unsigned char byte = static_cast<unsigned char>(character);
    if (std::isalnum(byte) || character == '_' || character == '-') {
      output.push_back(static_cast<char>(character));
    } else if (character == '.') {
      output.push_back('-');
    } else if (output.empty() || output.back() != '-') {
      output.push_back('-');
    }
    if (output.size() >= kMaxGrantIdBytes) {
      break;
    }
  }
  while (!output.empty() && output.back() == '-') {
    output.pop_back();
  }
  return output.empty() ? "grant" : output;
}

std::string savedStateFileName(const NativeFileGrantCommand& command) {
  return std::string(kSavedStatePrefix) + safeFileNamePart(command.grantId) + kSavedStateExtension;
}

#ifndef _WIN32
class FileDescriptor {
public:
  explicit FileDescriptor(int value) : value_(value) {}

  ~FileDescriptor() {
    if (value_ >= 0) {
      close(value_);
    }
  }

  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  FileDescriptor(FileDescriptor&& other) noexcept : value_(other.value_) {
    other.value_ = -1;
  }
  FileDescriptor& operator=(FileDescriptor&& other) noexcept {
    if (this != &other) {
      if (value_ >= 0) {
        close(value_);
      }
      value_ = other.value_;
      other.value_ = -1;
    }
    return *this;
  }

  int get() const {
    return value_;
  }

private:
  int value_ = -1;
};

std::string readRegularFileNoFollow(const std::filesystem::path& path, std::size_t maxBytes) {
  int flags = O_RDONLY;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif

  const FileDescriptor descriptor(open(path.c_str(), flags));
  if (descriptor.get() < 0) {
    throw std::runtime_error("file_grant_state_file_unavailable");
  }

  struct stat info {};
  if (fstat(descriptor.get(), &info) != 0 || !S_ISREG(info.st_mode)) {
    throw std::runtime_error("file_grant_state_file_unavailable");
  }

  if (info.st_size <= 0) {
    throw std::runtime_error("file_grant_state_file_too_large");
  }
  const auto size = checkedFileSize(static_cast<std::uintmax_t>(info.st_size), maxBytes);
  std::string text(size, '\0');
  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto bytesRead = read(descriptor.get(), text.data() + offset, text.size() - offset);
    if (bytesRead < 0 && errno == EINTR) {
      continue;
    }
    if (bytesRead <= 0) {
      throw std::runtime_error("file_grant_state_file_unavailable");
    }
    offset += static_cast<std::size_t>(bytesRead);
  }
  return text;
}

FileDescriptor openDirectoryNoFollow(const std::filesystem::path& path) {
  int flags = O_RDONLY;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
#ifdef O_DIRECTORY
  flags |= O_DIRECTORY;
#endif
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif

  FileDescriptor descriptor(open(path.c_str(), flags));
  if (descriptor.get() < 0) {
    throw std::runtime_error("file_grant_state_directory_unavailable");
  }
  struct stat info {};
  if (fstat(descriptor.get(), &info) != 0 || !S_ISDIR(info.st_mode)) {
    throw std::runtime_error("file_grant_state_directory_unavailable");
  }
  return descriptor;
}

void writeAll(int descriptor, const std::string& text) {
  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto bytesWritten = write(descriptor, text.data() + offset, text.size() - offset);
    if (bytesWritten < 0 && errno == EINTR) {
      continue;
    }
    if (bytesWritten <= 0) {
      throw std::runtime_error("file_grant_state_file_unavailable");
    }
    offset += static_cast<std::size_t>(bytesWritten);
  }
}

void writeStateFileNoFollow(const std::filesystem::path& directory, const std::string& fileName, const std::string& text) {
  const auto directoryDescriptor = openDirectoryNoFollow(directory);
  const std::string temporaryName = fileName + ".tmp";
  unlinkat(directoryDescriptor.get(), temporaryName.c_str(), 0);

  int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif

  {
    const FileDescriptor fileDescriptor(openat(directoryDescriptor.get(), temporaryName.c_str(), flags, 0600));
    if (fileDescriptor.get() < 0) {
      throw std::runtime_error("file_grant_state_file_unavailable");
    }
    writeAll(fileDescriptor.get(), text);
    if (fsync(fileDescriptor.get()) != 0) {
      throw std::runtime_error("file_grant_state_file_unavailable");
    }
  }

  if (renameat(directoryDescriptor.get(), temporaryName.c_str(), directoryDescriptor.get(), fileName.c_str()) != 0) {
    unlinkat(directoryDescriptor.get(), temporaryName.c_str(), 0);
    throw std::runtime_error("file_grant_state_file_unavailable");
  }
  fsync(directoryDescriptor.get());
}
#endif

std::string readRegularFilePortable(const std::filesystem::path& path, std::size_t maxBytes) {
  std::error_code error;
  if (
      std::filesystem::is_symlink(std::filesystem::symlink_status(path, error)) ||
      error ||
      !std::filesystem::is_regular_file(path, error) ||
      error) {
    throw std::runtime_error("file_grant_state_file_unavailable");
  }
  const auto fileSize = std::filesystem::file_size(path, error);
  if (error) {
    throw std::runtime_error("file_grant_state_file_unavailable");
  }
  const auto size = checkedFileSize(fileSize, maxBytes);
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("file_grant_state_file_unavailable");
  }
  std::string text(size, '\0');
  input.read(text.data(), static_cast<std::streamsize>(text.size()));
  if (!input) {
    throw std::runtime_error("file_grant_state_file_unavailable");
  }
  return text;
}

void requireDirectoryPortable(const std::filesystem::path& path) {
  std::error_code error;
  if (
      std::filesystem::is_symlink(std::filesystem::symlink_status(path, error)) ||
      error ||
      !std::filesystem::is_directory(path, error) ||
      error) {
    throw std::runtime_error("file_grant_state_directory_unavailable");
  }
}

void writeStateFilePortable(const std::filesystem::path& directory, const std::string& fileName, const std::string& text) {
  requireDirectoryPortable(directory);
  std::error_code error;
  const auto temporaryPath = directory / (fileName + ".tmp");
  const auto finalPath = directory / fileName;
  std::filesystem::remove(temporaryPath, error);

  {
    std::ofstream output(temporaryPath, std::ios::binary | std::ios::trunc);
    if (!output) {
      throw std::runtime_error("file_grant_state_file_unavailable");
    }
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    if (!output) {
      throw std::runtime_error("file_grant_state_file_unavailable");
    }
  }

  std::filesystem::remove(finalPath, error);
  std::filesystem::rename(temporaryPath, finalPath, error);
  if (error) {
    std::filesystem::remove(temporaryPath, error);
    throw std::runtime_error("file_grant_state_file_unavailable");
  }
}

std::string readStateFileText(const std::string& absolutePath, std::size_t maxBytes) {
  if (maxBytes == 0 || absolutePath.size() > kMaxPathBytes) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
  const std::filesystem::path path(absolutePath);
  if (!path.is_absolute()) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }

#ifndef _WIN32
  return readRegularFileNoFollow(path, maxBytes);
#else
  return readRegularFilePortable(path, maxBytes);
#endif
}

void writeStateFileText(const NativeFileGrantCommand& command, const std::string& text, std::size_t maxDecodedBytes, std::size_t maxTokens) {
  requireSaveStateDirectoryGrant(command);
  if (text.empty() || text.size() > maxStateFileBytes(maxDecodedBytes, maxTokens)) {
    throw std::runtime_error("file_grant_state_file_too_large");
  }
  const std::filesystem::path directory(command.absolutePath);
  if (!directory.is_absolute()) {
    throw std::runtime_error("invalid_file_grant_arguments");
  }
  const auto fileName = savedStateFileName(command);
#ifndef _WIN32
  writeStateFileNoFollow(directory, fileName, text);
#else
  writeStateFilePortable(directory, fileName, text);
#endif
}

std::vector<std::string> stateFileTokens(const NativeFileGrantCommand& command, std::size_t maxDecodedBytes, std::size_t maxTokens) {
  requireRestoreStateGrant(command);
  const auto text = readStateFileText(command.absolutePath, maxStateFileBytes(maxDecodedBytes, maxTokens));
  std::stringstream stream(text);
  std::vector<std::string> tokens;
  std::string token;
  while (stream >> token) {
    if (token.size() > maxBase64TokenBytes(maxDecodedBytes)) {
      throw std::runtime_error("file_grant_state_file_too_large");
    }
    tokens.push_back(token);
    if (tokens.size() > maxTokens) {
      throw std::runtime_error("invalid_file_grant_state_file");
    }
  }
  if (tokens.empty()) {
    throw std::runtime_error("invalid_file_grant_state_file");
  }
  return tokens;
}

} // namespace

NativeFileGrantCommand parseFileGrantCommand(std::istream& stream) {
  NativeFileGrantCommand command;
  command.operation = boundedToken(requireToken(stream), 64);
  command.purpose = boundedToken(requireToken(stream), 32);
  command.access = boundedToken(requireToken(stream), 32);
  command.kind = boundedToken(requireToken(stream), 32);
  command.grantId = boundedToken(requireToken(stream), kMaxGrantIdBytes);
  command.displayName = decodeTextToken(requireToken(stream), kMaxDisplayNameBytes);
  command.absolutePath = decodeTextToken(requireToken(stream), kMaxPathBytes);
  rejectExtraTokens(stream);
  return command;
}

std::string readSingleStateFile(const NativeFileGrantCommand& command, std::size_t maxBytes) {
  const auto tokens = stateFileTokens(command, maxBytes, 1);
  if (tokens.size() != 1) {
    throw std::runtime_error("invalid_file_grant_state_file");
  }
  return tokens[0];
}

DualStateFile readDualStateFile(const NativeFileGrantCommand& command, std::size_t maxBytes) {
  const auto tokens = stateFileTokens(command, maxBytes, 2);
  return {
    tokens[0],
    tokens.size() > 1 ? tokens[1] : "-"
  };
}

void writeSingleStateFile(const NativeFileGrantCommand& command, const std::string& state, std::size_t maxBytes) {
  const auto text = stateTokenOrSentinel(state, maxBytes) + "\n";
  writeStateFileText(command, text, maxBytes, 1);
}

void writeDualStateFile(
    const NativeFileGrantCommand& command,
    const std::string& primary,
    const std::string& secondary,
    std::size_t maxBytes) {
  const auto text = stateTokenOrSentinel(primary, maxBytes) + " " + stateTokenOrSentinel(secondary, maxBytes) + "\n";
  writeStateFileText(command, text, maxBytes, 2);
}

std::string fileGrantAppliedJson() {
  return "{\"applied\":true,\"status\":\"state-restored\"}";
}

std::string fileGrantSavedJson() {
  return "{\"applied\":true,\"status\":\"state-saved\"}";
}

} // namespace soundbridge::worker_file_grants
