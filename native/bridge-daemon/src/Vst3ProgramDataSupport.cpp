#include "SoundBridge/Vst3HostWorkerSupport.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/Base64.h"

#include "public.sdk/source/common/memorystream.h"

#include <algorithm>
#include <cstdint>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace soundbridge::vst3_worker {
namespace {

std::string streamToBase64(
    Steinberg::MemoryStream& stream,
    std::size_t maxBytes,
    const std::string& sizeError) {
  const auto size = stream.getSize();
  if (size <= 0) {
    return "";
  }
  if (static_cast<std::size_t>(size) > maxBytes) {
    throw std::runtime_error(sizeError);
  }
  const auto* data = reinterpret_cast<const std::uint8_t*>(stream.getData());
  return base64Encode(data, static_cast<std::size_t>(size));
}

bool programDataSupported(
    Steinberg::Vst::IProgramListData* programListData,
    Steinberg::Vst::ProgramListID programListId) {
  return programListData != nullptr &&
      programListData->programDataSupported(programListId) == Steinberg::kResultTrue;
}

bool knownProgram(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::int32 programIndex) {
  if (unitInfo == nullptr || programIndex < 0) {
    return false;
  }
  const auto listCount = std::clamp<Steinberg::int32>(
      unitInfo->getProgramListCount(),
      0,
      kMaxWorkerProgramLists);
  for (Steinberg::int32 listIndex = 0; listIndex < listCount; ++listIndex) {
    Steinberg::Vst::ProgramListInfo info {};
    if (unitInfo->getProgramListInfo(listIndex, info) != Steinberg::kResultOk || info.id != programListId) {
      continue;
    }
    const auto programCount = std::clamp<Steinberg::int32>(
        info.programCount,
        0,
        kMaxWorkerProgramsPerParameter);
    return programIndex < programCount;
  }
  return false;
}

void requireProgramDataTarget(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::int32 programIndex) {
  if (!programDataSupported(programListData, programListId) ||
      !knownProgram(unitInfo, programListId, programIndex)) {
    throw std::runtime_error("program_data_not_supported");
  }
}

} // namespace

std::string programDataToJson(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::int32 programIndex) {
  requireProgramDataTarget(unitInfo, programListData, programListId, programIndex);

  Steinberg::MemoryStream stream;
  checkResult(
      programListData->getProgramData(programListId, programIndex, &stream),
      "IProgramListData::getProgramData");
  const auto rawSize = stream.getSize();
  const auto size = rawSize > 0 ? static_cast<std::size_t>(rawSize) : 0;
  std::ostringstream output;
  output << "{\"programData\":{"
         << "\"format\":\"vst3\""
         << ",\"programListId\":" << programListId
         << ",\"programIndex\":" << programIndex
         << ",\"size\":" << size
         << ",\"data\":\"" << streamToBase64(stream, kMaxWorkerProgramDataBytes, "program_data_too_large") << "\""
         << "}}";
  return output.str();
}

std::string setProgramData(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::int32 programIndex,
    const std::string& dataText) {
  requireProgramDataTarget(unitInfo, programListData, programListId, programIndex);

  auto data = dataText == "-"
      ? std::vector<std::uint8_t> {}
      : base64Decode(dataText, kMaxWorkerProgramDataBytes);
  Steinberg::MemoryStream stream(data.data(), static_cast<Steinberg::TSize>(data.size()));
  checkResult(
      programListData->setProgramData(programListId, programIndex, &stream),
      "IProgramListData::setProgramData");
  return "{\"ok\":true}";
}

} // namespace soundbridge::vst3_worker

#endif
