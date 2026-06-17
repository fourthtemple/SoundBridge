#include "SoundBridge/Vst3HostWorkerSupport.h"

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/NativePlugin.h"

#include "public.sdk/source/vst/hosting/stringconvert.h"

#include <algorithm>
#include <cmath>
#include <sstream>

namespace soundbridge::vst3_worker {
namespace {

bool unitInfoForParameter(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::UnitInfo& unit);
bool unitIdForProgramList(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::Vst::UnitID& unitId);
std::string programListInfoToJson(
    const Steinberg::Vst::ProgramListInfo& programList,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData);

bool programListForParameter(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListInfo& programList) {
  if (unitInfo == nullptr) {
    return false;
  }
  Steinberg::Vst::UnitInfo unit {};
  if (!unitInfoForParameter(parameter, unitInfo, unit)) {
    return false;
  }
  const auto programListId = unit.programListId;
  if (programListId == Steinberg::Vst::kNoProgramListId) {
    return false;
  }

  const auto listCount = std::clamp<Steinberg::int32>(
      unitInfo->getProgramListCount(),
      0,
      kMaxWorkerProgramLists);
  for (Steinberg::int32 listIndex = 0; listIndex < listCount; ++listIndex) {
    Steinberg::Vst::ProgramListInfo info {};
    if (unitInfo->getProgramListInfo(listIndex, info) == Steinberg::kResultOk && info.id == programListId) {
      programList = info;
      return true;
    }
  }
  return false;
}

bool unitInfoForParameter(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::UnitInfo& unit) {
  if (unitInfo == nullptr) {
    return false;
  }
  const auto unitCount = std::clamp<Steinberg::int32>(
      unitInfo->getUnitCount(),
      0,
      kMaxWorkerUnits);
  for (Steinberg::int32 unitIndex = 0; unitIndex < unitCount; ++unitIndex) {
    Steinberg::Vst::UnitInfo candidate {};
    if (unitInfo->getUnitInfo(unitIndex, candidate) == Steinberg::kResultOk && candidate.id == parameter.unitId) {
      unit = candidate;
      return true;
    }
  }
  return false;
}

bool unitIdForProgramList(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::ProgramListID programListId,
    Steinberg::Vst::UnitID& unitId) {
  if (unitInfo == nullptr || programListId == Steinberg::Vst::kNoProgramListId) {
    return false;
  }
  const auto unitCount = std::clamp<Steinberg::int32>(
      unitInfo->getUnitCount(),
      0,
      kMaxWorkerUnits);
  for (Steinberg::int32 unitIndex = 0; unitIndex < unitCount; ++unitIndex) {
    Steinberg::Vst::UnitInfo unit {};
    if (unitInfo->getUnitInfo(unitIndex, unit) == Steinberg::kResultOk && unit.programListId == programListId) {
      unitId = unit.id;
      return true;
    }
  }
  return false;
}

std::string unitInfoToJson(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo) {
  Steinberg::Vst::UnitInfo unit {};
  if (!unitInfoForParameter(parameter, unitInfo, unit)) {
    return "";
  }
  auto name = cappedString(VST3::StringConvert::convert(unit.name));
  if (name.empty()) {
    name = "Unit " + std::to_string(unit.id);
  }
  std::ostringstream output;
  output << "{\"id\":" << unit.id
         << ",\"parentUnitId\":" << unit.parentUnitId
         << ",\"name\":\"" << jsonEscape(name) << "\"";
  if (unit.programListId != Steinberg::Vst::kNoProgramListId) {
    output << ",\"programListId\":" << unit.programListId;
  }
  output << "}";
  return output.str();
}

std::string programListToJson(
    const Steinberg::Vst::ParameterInfo& parameter,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData) {
  Steinberg::Vst::ProgramListInfo programList {};
  if (!programListForParameter(parameter, unitInfo, programList)) {
    return "";
  }
  return programListInfoToJson(programList, unitInfo, programListData);
}

std::string programListInfoToJson(
    const Steinberg::Vst::ProgramListInfo& programList,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData) {
  const auto programCount = std::clamp<Steinberg::int32>(
      programList.programCount,
      0,
      kMaxWorkerProgramsPerParameter);
  if (programList.id == Steinberg::Vst::kNoProgramListId || programCount <= 0) {
    return "";
  }

  const auto listName = cappedString(VST3::StringConvert::convert(programList.name));
  const bool listNameFallback = listName.empty();
  Steinberg::Vst::UnitID unitId = Steinberg::Vst::kNoParentUnitId;
  std::ostringstream output;
  output << "{\"id\":" << programList.id
         << ",\"name\":\"" << jsonEscape(listName.empty() ? "Programs" : listName) << "\"";
  if (listNameFallback) {
    output << ",\"nameFallback\":true";
  }
  if (unitIdForProgramList(unitInfo, programList.id, unitId)) {
    output << ",\"unitId\":" << unitId;
  }
  if (programListData != nullptr) {
    output << ",\"programDataSupported\":"
           << (programListData->programDataSupported(programList.id) == Steinberg::kResultTrue ? "true" : "false");
  }
  output << ",\"programs\":[";
  for (Steinberg::int32 programIndex = 0; programIndex < programCount; ++programIndex) {
    if (programIndex > 0) {
      output << ",";
    }
    Steinberg::Vst::String128 programName {};
    std::string name;
    if (unitInfo != nullptr && unitInfo->getProgramName(programList.id, programIndex, programName) == Steinberg::kResultOk) {
      name = cappedString(VST3::StringConvert::convert(programName));
    }
    const bool nameFallback = name.empty();
    if (name.empty()) {
      name = "Program " + std::to_string(programIndex + 1);
    }
    const double normalizedValue = programCount <= 1
        ? 0.0
        : static_cast<double>(programIndex) / static_cast<double>(programCount - 1);
    output << "{\"index\":" << programIndex
           << ",\"name\":\"" << jsonEscape(name) << "\""
           << ",\"normalizedValue\":" << std::clamp(normalizedValue, 0.0, 1.0);
    if (nameFallback) {
      output << ",\"nameFallback\":true";
    }
    output << "}";
  }
  output << "]}";
  return output.str();
}

std::string noteExpressionInfoToJson(
    const Steinberg::Vst::NoteExpressionTypeInfo& info,
    Steinberg::int32 busIndex,
    Steinberg::int16 channel) {
  const auto name = cappedString(VST3::StringConvert::convert(info.title));
  const auto shortName = cappedString(VST3::StringConvert::convert(info.shortTitle));
  const auto unit = cappedString(VST3::StringConvert::convert(info.units), 64);
  const auto minValue = std::clamp(info.valueDesc.minimum, 0.0, 1.0);
  const auto maxValue = std::clamp(info.valueDesc.maximum, minValue, 1.0);
  const auto defaultValue = std::clamp(info.valueDesc.defaultValue, minValue, maxValue);

  std::ostringstream output;
  output << "{\"typeId\":" << info.typeId
         << ",\"name\":\"" << jsonEscape(name.empty() ? shortName : name) << "\""
         << ",\"defaultValue\":" << defaultValue
         << ",\"minValue\":" << minValue
         << ",\"maxValue\":" << maxValue
         << ",\"stepCount\":" << std::max<Steinberg::int32>(0, info.valueDesc.stepCount)
         << ",\"busIndex\":" << busIndex
         << ",\"channel\":" << channel;
  if (!shortName.empty()) {
    output << ",\"shortName\":\"" << jsonEscape(shortName) << "\"";
  }
  if (!unit.empty()) {
    output << ",\"unit\":\"" << jsonEscape(unit) << "\"";
  }
  if (info.unitId >= 0) {
    output << ",\"unitId\":" << info.unitId;
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kIsBipolar) != 0) {
    output << ",\"bipolar\":true";
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kIsOneShot) != 0) {
    output << ",\"oneShot\":true";
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kIsAbsolute) != 0) {
    output << ",\"absolute\":true";
  }
  if ((info.flags & Steinberg::Vst::NoteExpressionTypeInfo::kAssociatedParameterIDValid) != 0 &&
      info.associatedParameterId != Steinberg::Vst::kNoParamId) {
    output << ",\"associatedParameterId\":\"" << info.associatedParameterId << "\"";
  }
  output << "}";
  return output.str();
}

std::string parameterDisplayValue(
    const Steinberg::Vst::ParameterInfo& info,
    Steinberg::Vst::IEditController* controller,
    Steinberg::Vst::ParamValue normalizedValue) {
  Steinberg::Vst::String128 text {};
  if (controller == nullptr ||
      controller->getParamStringByValue(info.id, normalizedValue, text) != Steinberg::kResultOk) {
    return {};
  }
  return cappedString(VST3::StringConvert::convert(text));
}

} // namespace

std::string programListsToJson(
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData) {
  std::ostringstream output;
  output << "{\"vst3ProgramLists\":[";
  if (unitInfo != nullptr) {
    const auto listCount = std::clamp<Steinberg::int32>(
        unitInfo->getProgramListCount(),
        0,
        kMaxWorkerProgramLists);
    bool first = true;
    for (Steinberg::int32 listIndex = 0; listIndex < listCount; ++listIndex) {
      Steinberg::Vst::ProgramListInfo info {};
      if (unitInfo->getProgramListInfo(listIndex, info) != Steinberg::kResultOk) {
        continue;
      }
      const auto listJson = programListInfoToJson(info, unitInfo, programListData);
      if (listJson.empty()) {
        continue;
      }
      if (!first) {
        output << ",";
      }
      output << listJson;
      first = false;
    }
  }
  output << "]}";
  return output.str();
}

std::string noteExpressionsToJson(
    Steinberg::Vst::IComponent* component,
    Steinberg::Vst::INoteExpressionController* noteExpressionController) {
  std::ostringstream output;
  output << "{\"vst3NoteExpressions\":[";
  if (noteExpressionController != nullptr) {
    bool first = true;
    Steinberg::int32 total = 0;
    const auto eventBusCount = std::clamp<Steinberg::int32>(
        component != nullptr ? component->getBusCount(Steinberg::Vst::kEvent, Steinberg::Vst::kInput) : 1,
        1,
        static_cast<Steinberg::int32>(kMaxWorkerChannels));
    for (Steinberg::int32 busIndex = 0; busIndex < eventBusCount && total < kMaxWorkerNoteExpressionTypes; ++busIndex) {
      for (Steinberg::int16 channel = 0; channel < 16 && total < kMaxWorkerNoteExpressionTypes; ++channel) {
        const auto count = std::clamp<Steinberg::int32>(
            noteExpressionController->getNoteExpressionCount(busIndex, channel),
            0,
            kMaxWorkerNoteExpressionTypes - total);
        for (Steinberg::int32 index = 0; index < count && total < kMaxWorkerNoteExpressionTypes; ++index) {
          Steinberg::Vst::NoteExpressionTypeInfo info {};
          if (noteExpressionController->getNoteExpressionInfo(busIndex, channel, index, info) != Steinberg::kResultOk) {
            continue;
          }
          if (!first) {
            output << ",";
          }
          output << noteExpressionInfoToJson(info, busIndex, channel);
          first = false;
          ++total;
        }
      }
    }
  }
  output << "]}";
  return output.str();
}

std::string parameterInfoToJson(
    const Steinberg::Vst::ParameterInfo& info,
    Steinberg::Vst::IEditController* controller,
    Steinberg::Vst::IUnitInfo* unitInfo,
    Steinberg::Vst::IProgramListData* programListData) {
  const auto normalizedValue = std::clamp(controller->getParamNormalized(info.id), 0.0, 1.0);
  const auto defaultValue = std::clamp(info.defaultNormalizedValue, 0.0, 1.0);
  const auto name = cappedString(VST3::StringConvert::convert(info.title));
  const auto shortName = cappedString(VST3::StringConvert::convert(info.shortTitle));
  const auto unit = cappedString(VST3::StringConvert::convert(info.units), 64);
  const auto plainValue = controller->normalizedParamToPlain(info.id, normalizedValue);
  const auto minPlain = controller->normalizedParamToPlain(info.id, 0.0);
  const auto maxPlain = controller->normalizedParamToPlain(info.id, 1.0);
  const auto displayValue = parameterDisplayValue(info, controller, normalizedValue);
  const bool programChange = (info.flags & Steinberg::Vst::ParameterInfo::kIsProgramChange) != 0;

  std::ostringstream output;
  output << "{\"id\":\"" << info.id << "\""
         << ",\"name\":\"" << jsonEscape(name.empty() ? shortName : name) << "\""
         << ",\"normalizedValue\":" << normalizedValue
         << ",\"defaultNormalizedValue\":" << defaultValue
         << ",\"plainValue\":" << (std::isfinite(plainValue) ? plainValue : normalizedValue)
         << ",\"minPlain\":" << (std::isfinite(minPlain) ? minPlain : 0.0)
         << ",\"maxPlain\":" << (std::isfinite(maxPlain) ? maxPlain : 1.0)
         << ",\"automatable\":" << (parameterIsAutomatable(info) ? "true" : "false");
  if (!displayValue.empty()) {
    output << ",\"displayValue\":\"" << jsonEscape(displayValue) << "\"";
  }
  if (!unit.empty()) {
    output << ",\"unit\":\"" << jsonEscape(unit) << "\"";
  }
  const auto vst3Unit = unitInfoToJson(info, unitInfo);
  if (!vst3Unit.empty()) {
    output << ",\"vst3Unit\":" << vst3Unit;
  }
  output << ",\"stepCount\":" << std::max<Steinberg::int32>(0, info.stepCount)
         << ",\"readOnly\":" << ((info.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) ? "true" : "false");
  if (programChange) {
    output << ",\"programChange\":true";
    const auto programList = programListToJson(info, unitInfo, programListData);
    if (!programList.empty()) {
      output << ",\"programList\":" << programList;
    }
  }
  output << "}";
  return output.str();
}

} // namespace soundbridge::vst3_worker

#endif
