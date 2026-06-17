#pragma once

#ifdef SOUNDBRIDGE_ENABLE_VST3_SDK

#include "SoundBridge/NativeFileGrantSupport.h"
#include "SoundBridge/Vst3HostWorkerSupport.h"

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstnoteexpression.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace soundbridge::vst3_worker {

class HostedVst3Effect {
public:
  HostedVst3Effect(
      std::string bundlePath,
      double sampleRate,
      std::uint32_t maxBlockSize,
      std::uint32_t inputChannels,
      std::uint32_t outputChannels);
  HostedVst3Effect(const HostedVst3Effect&) = delete;
  HostedVst3Effect& operator=(const HostedVst3Effect&) = delete;
  ~HostedVst3Effect();

  double sampleTime() const;
  RenderedAudio render(
      std::uint32_t frames,
      double sampleRate,
      std::vector<std::vector<float>> inputChannels,
      std::vector<IndexedAudioBus> inputBuses,
      HostTransportContext transport);
  void enqueueMidiEvents(std::vector<PendingMidiEvent> events);
  std::vector<std::string> parameterJsonList() const;
  std::string parametersToJson() const;
  std::string noteExpressionsToJson() const;
  std::string programListsToJson() const;
  std::string programDataToJson(Steinberg::Vst::ProgramListID programListId, Steinberg::int32 programIndex) const;
  std::string setProgramData(
      Steinberg::Vst::ProgramListID programListId,
      Steinberg::int32 programIndex,
      const std::string& dataText);
  std::string setParameter(Steinberg::Vst::ParamID id, double value, std::uint32_t sampleOffset);
  std::string setParameterDisplayValue(Steinberg::Vst::ParamID id, const std::string& displayValue);
  std::string stateToJson() const;
  void writeStateFile(const worker_file_grants::NativeFileGrantCommand& command) const;
  std::string setState(const std::string& componentStateText, const std::string& controllerStateText);
  std::string latencyToJson() const;
  std::string tailTimeToJson() const;
  std::string layoutToJson() const;

private:
  bool parameterInfoForId(Steinberg::Vst::ParamID id, Steinberg::Vst::ParameterInfo& info) const;
  bool midiEventToParameterChange(const PendingMidiEvent& event, PendingParameterChange& parameterChange);
  void initializeController();
  void connectController();
  void disconnectController();
  void configure();

  std::shared_ptr<VST3::Hosting::Module> module_;
  Steinberg::Vst::HostApplication hostApplication_;
  Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
  Steinberg::IPtr<Steinberg::Vst::IEditController> controller_;
  Steinberg::IPtr<Steinberg::Vst::IConnectionPoint> componentConnection_;
  Steinberg::IPtr<Steinberg::Vst::IConnectionPoint> controllerConnection_;
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
  Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping_;
  Steinberg::IPtr<Steinberg::Vst::INoteExpressionController> noteExpressionController_;
  Steinberg::IPtr<Steinberg::Vst::IUnitInfo> unitInfo_;
  Steinberg::IPtr<Steinberg::Vst::IProgramListData> programListData_;
  double sampleRate_ = 48000.0;
  std::uint32_t maxBlockSize_ = 128;
  std::uint32_t requestedInputChannels_ = 2;
  std::uint32_t requestedOutputChannels_ = 2;
  std::uint32_t inputChannels_ = 2;
  std::uint32_t outputChannels_ = 2;
  Steinberg::int32 inputBusCount_ = 0;
  Steinberg::int32 outputBusCount_ = 0;
  std::vector<std::uint32_t> inputBusChannels_;
  std::vector<std::uint32_t> outputBusChannels_;
  std::vector<PendingMidiEvent> pendingMidiEvents_;
  std::vector<PendingParameterChange> pendingParameterChanges_;
  double sampleTime_ = 0.0;
  bool initialized_ = false;
  bool controllerInitialized_ = false;
  bool componentConnected_ = false;
  bool controllerConnected_ = false;
  bool active_ = false;
};

} // namespace soundbridge::vst3_worker

#endif
