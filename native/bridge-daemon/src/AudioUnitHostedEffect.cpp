#include "SoundBridge/AudioUnitHostedEffect.h"

#ifdef SOUNDBRIDGE_MACOS

#include "SoundBridge/Base64.h"

#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace soundbridge::audio_unit_worker {

namespace {

std::vector<std::vector<float>> renderedChannels(
    const std::vector<std::vector<float>>& storage,
    std::uint32_t frames) {
  std::vector<std::vector<float>> channels;
  channels.reserve(storage.size());
  for (const auto& channel : storage) channels.emplace_back(channel.begin(), channel.begin() + std::min<std::size_t>(frames, channel.size()));
  return channels;
}

} // namespace

HostedAudioUnit::HostedAudioUnit(
    std::string componentType,
    std::string componentSubType,
    std::string componentManufacturer,
    double sampleRate,
    std::uint32_t maxBlockSize,
    std::uint32_t inputChannels,
    std::uint32_t outputChannels)
    : sampleRate_(sampleRate),
      maxBlockSize_(std::clamp<std::uint32_t>(maxBlockSize, 1, 8192)),
      requestedInputChannels_(std::min<std::uint32_t>(inputChannels, 32)),
      requestedOutputChannels_(std::clamp<std::uint32_t>(outputChannels, 1, 32)),
      inputChannels_(std::min<std::uint32_t>(inputChannels, 32)),
      outputChannels_(std::clamp<std::uint32_t>(outputChannels, 1, 32)) {
  AudioComponentDescription description {};
  description.componentType = fourCharCodeFromString(componentType);
  description.componentSubType = fourCharCodeFromString(componentSubType);
  description.componentManufacturer = fourCharCodeFromString(componentManufacturer);
  description.componentFlags = 0;
  description.componentFlagsMask = 0;

  AudioComponent component = AudioComponentFindNext(nullptr, &description);
  if (component == nullptr) {
    throw std::runtime_error("AudioComponentFindNext did not find the requested Audio Unit.");
  }

  checkStatus(AudioComponentInstanceNew(component, &unit_), "AudioComponentInstanceNew");
  configure();
}

HostedAudioUnit::~HostedAudioUnit() {
  for (auto* outputList : outputBufferLists_) std::free(outputList);
  if (unit_ != nullptr) {
    AudioUnitUninitialize(unit_);
    AudioComponentInstanceDispose(unit_);
  }
}

bool HostedAudioUnit::sendMidi(UInt32 status, UInt32 data1, UInt32 data2, std::uint32_t sampleOffset) {
  const auto result = MusicDeviceMIDIEvent(
      unit_,
      status & 0xFF,
      data1 & 0x7F,
      data2 & 0x7F,
      std::min<std::uint32_t>(sampleOffset, maxBlockSize_ - 1));
  if (result == noErr) {
    return true;
  }
  if (isUnsupportedMidiStatus(result)) {
    return false;
  }
  checkStatus(result, "MusicDeviceMIDIEvent");
  return false;
}

void HostedAudioUnit::sendMidiEvents(const std::vector<PendingMidiMessage>& messages) {
  for (const auto& message : messages) {
    sendMidi(message.status, message.data1, message.data2, message.sampleOffset);
  }
}

void HostedAudioUnit::noteOn(
    std::uint8_t note,
    double velocity,
    std::uint8_t channel,
    std::uint32_t sampleOffset) {
  const auto scaledVelocity = std::max<UInt32>(1, scaled7Bit(velocity));
  sendMidi(0x90 | std::min<UInt32>(channel, 15), note, scaledVelocity, sampleOffset);
}

void HostedAudioUnit::noteOff(std::uint8_t note, std::uint8_t channel, std::uint32_t sampleOffset) {
  sendMidi(0x80 | std::min<UInt32>(channel, 15), note, 0, sampleOffset);
}

std::string HostedAudioUnit::parametersToJson() const {
  const auto parameters = parameterJsonList();
  std::ostringstream output;
  output << "{\"parameters\":[";
  for (std::size_t index = 0; index < parameters.size(); ++index) {
    if (index > 0) {
      output << ",";
    }
    output << parameters[index];
  }
  output << "]}";
  return output.str();
}

std::string HostedAudioUnit::setParameter(
    AudioUnitParameterID parameterId,
    double normalizedValue,
    std::uint32_t sampleOffset) {
  AudioUnitParameterInfo info {};
  UInt32 infoSize = sizeof(info);
  checkStatus(
      AudioUnitGetProperty(
          unit_,
          kAudioUnitProperty_ParameterInfo,
          kAudioUnitScope_Global,
          parameterId,
          &info,
          &infoSize),
      "AudioUnitGetProperty ParameterInfo");

  const auto value = plainValueForNormalized(info, normalizedValue);
  checkStatus(
      AudioUnitSetParameter(
          unit_,
          parameterId,
          kAudioUnitScope_Global,
          0,
          value,
          std::min<std::uint32_t>(sampleOffset, maxBlockSize_ - 1)),
      "AudioUnitSetParameter");
  return std::string("{\"parameter\":") + parameterInfoToJson(unit_, parameterId, info) + "}";
}

std::string HostedAudioUnit::setParameterDisplayValue(
    AudioUnitParameterID parameterId,
    const std::string& displayValue) {
  AudioUnitParameterInfo info {};
  UInt32 infoSize = sizeof(info);
  checkStatus(
      AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, parameterId, &info, &infoSize),
      "AudioUnitGetProperty ParameterInfo");
  CFStringRef text = CFStringCreateWithCString(kCFAllocatorDefault, displayValue.c_str(), kCFStringEncodingUTF8);
  if (text == nullptr) {
    throw std::runtime_error("invalid_parameter_display_value");
  }
  AudioUnitParameterValueFromString request {};
  request.inParamID = parameterId;
  request.inString = text;
  UInt32 requestSize = sizeof(request);
  const auto status = AudioUnitGetProperty(
      unit_,
      kAudioUnitProperty_ParameterValueFromString,
      kAudioUnitScope_Global,
      0,
      &request,
      &requestSize);
  CFRelease(text);
  checkStatus(status, "AudioUnitGetProperty ParameterValueFromString");
  return setParameter(parameterId, normalizedValueForPlain(info, request.outValue), 0);
}

std::string HostedAudioUnit::stateToJson() const {
  return std::string("{\"state\":\"") + stateBase64() + "\"}";
}

void HostedAudioUnit::writeStateFile(const worker_file_grants::NativeFileGrantCommand& command) const {
  writeSingleStateFile(command, stateBase64(), kMaxWorkerStateBytes);
}

std::string HostedAudioUnit::setState(const std::string& stateText) {
  if (stateText == "-") {
    return "{\"ok\":true}";
  }

  const auto decoded = base64Decode(stateText, kMaxWorkerStateBytes);
  CFDataRef data = CFDataCreate(kCFAllocatorDefault, decoded.data(), static_cast<CFIndex>(decoded.size()));
  if (data == nullptr) {
    throw std::runtime_error("Audio Unit state data allocation failed.");
  }

  CFErrorRef error = nullptr;
  CFPropertyListRef classInfo = CFPropertyListCreateWithData(
      kCFAllocatorDefault,
      data,
      kCFPropertyListImmutable,
      nullptr,
      &error);
  CFRelease(data);
  if (error != nullptr) {
    CFRelease(error);
  }
  if (classInfo == nullptr) {
    throw std::runtime_error("Audio Unit state was not a valid property list.");
  }

  const auto status = AudioUnitSetProperty(
      unit_,
      kAudioUnitProperty_ClassInfo,
      kAudioUnitScope_Global,
      0,
      &classInfo,
      sizeof(classInfo));
  CFRelease(classInfo);
  checkStatus(status, "AudioUnitSetProperty ClassInfo");
  return "{\"ok\":true}";
}

std::string HostedAudioUnit::latencyToJson() const {
  Float64 latencySeconds = 0.0;
  UInt32 propertySize = sizeof(latencySeconds);
  if (AudioUnitGetProperty(
          unit_,
          kAudioUnitProperty_Latency,
          kAudioUnitScope_Global,
          0,
          &latencySeconds,
          &propertySize) != noErr ||
      !std::isfinite(latencySeconds) ||
      latencySeconds < 0.0) {
    latencySeconds = 0.0;
  }

  const auto latencySamples = static_cast<std::uint32_t>(std::clamp<double>(
      std::round(latencySeconds * sampleRate_),
      0.0,
      static_cast<double>(kMaxWorkerLatencySamples)));
  std::ostringstream output;
  output << "{\"latencySamples\":" << latencySamples << "}";
  return output.str();
}

std::string HostedAudioUnit::tailTimeToJson() const {
  Float64 tailSeconds = 0.0;
  UInt32 propertySize = sizeof(tailSeconds);
  if (AudioUnitGetProperty(
          unit_,
          kAudioUnitProperty_TailTime,
          kAudioUnitScope_Global,
          0,
          &tailSeconds,
          &propertySize) != noErr ||
      !std::isfinite(tailSeconds) ||
      tailSeconds < 0.0) {
    tailSeconds = 0.0;
  }

  const auto tailSamples = static_cast<std::uint32_t>(std::clamp<double>(
      std::round(tailSeconds * sampleRate_),
      0.0,
      static_cast<double>(kMaxWorkerTailSamples)));
  std::ostringstream output;
  output << "{\"tailSamples\":" << tailSamples << ",\"infiniteTail\":false}";
  return output.str();
}

std::string HostedAudioUnit::layoutToJson() const {
  std::ostringstream output;
  output << "{\"requestedInputChannels\":" << requestedInputChannels_
         << ",\"requestedOutputChannels\":" << requestedOutputChannels_
         << ",\"inputChannels\":" << inputChannels_
         << ",\"outputChannels\":" << outputChannels_
         << ",\"inputBuses\":" << activeInputBusCount()
         << ",\"outputBuses\":" << activeOutputBusCount()
         << ",\"inputBusLayouts\":" << inputBusLayoutsToJson()
         << ",\"outputBusLayouts\":" << outputBusLayoutsToJson()
         << ",\"sampleRate\":" << sampleRate_
         << ",\"maxBlockSize\":" << maxBlockSize_
         << "}";
  return output.str();
}

RenderedAudio HostedAudioUnit::render(
    std::uint32_t frames,
    double sampleRate,
    std::vector<std::vector<float>> inputChannels,
    std::vector<IndexedAudioBus> inputBuses,
    HostTransportContext transport) {
  if (std::abs(sampleRate - sampleRate_) > 0.01) {
    throw std::runtime_error("Audio Unit worker cannot change sample rate after initialization.");
  }

  frames = std::clamp<std::uint32_t>(frames, 1, maxBlockSize_);
  transportStateChanged_ = currentTransportInitialized_ &&
      (transport.playing != currentTransport_.playing ||
       transport.recording != currentTransport_.recording ||
       transport.loopActive != currentTransport_.loopActive ||
       std::abs(transport.samplePosition - sampleTime_) > 0.5);
  currentTransport_ = transport;
  currentTransportInitialized_ = true;
  if (inputBuses.empty() && !inputChannels.empty()) {
    inputBuses.push_back(IndexedAudioBus{0, std::move(inputChannels)});
  }
  currentInputBuses_ = std::move(inputBuses);
  currentInputFrames_ = frames;
  for (auto& bus : currentInputBuses_) {
    for (auto& channel : bus.channels) {
      channel.resize(frames, 0.0F);
    }
  }

  AudioTimeStamp timeStamp {};
  timeStamp.mFlags = kAudioTimeStampSampleTimeValid;
  timeStamp.mSampleTime = currentTransport_.samplePosition;
  AudioUnitRenderActionFlags flags = 0;
  checkStatus(AudioUnitRender(unit_, &flags, &timeStamp, 0, frames, outputBufferListFor(0, frames)), "AudioUnitRender");
  RenderedAudio rendered;
  rendered.channels = renderedChannels(outputStorage_[0], frames);
  rendered.outputBuses.reserve(outputBusActive_.size() > 1 ? outputBusActive_.size() - 1 : 0);

  for (std::uint32_t busIndex = 1; busIndex < outputBusActive_.size(); ++busIndex) {
    if (!outputBusActive_[busIndex]) {
      continue;
    }
    AudioUnitRenderActionFlags busFlags = 0;
    checkStatus(
        AudioUnitRender(unit_, &busFlags, &timeStamp, busIndex, frames, outputBufferListFor(busIndex, frames)),
        "AudioUnitRender auxiliary output");
    rendered.outputBuses.push_back(IndexedAudioBus{busIndex, renderedChannels(outputStorage_[busIndex], frames)});
  }

  sampleTime_ = currentTransport_.samplePosition + frames;
  return rendered;
}

double HostedAudioUnit::sampleTime() const {
  return sampleTime_;
}

std::uint32_t HostedAudioUnit::activeInputBusCount() const {
  return static_cast<std::uint32_t>(std::count(inputBusActive_.begin(), inputBusActive_.end(), true));
}

std::uint32_t HostedAudioUnit::activeOutputBusCount() const {
  return static_cast<std::uint32_t>(std::count(outputBusActive_.begin(), outputBusActive_.end(), true));
}

std::string HostedAudioUnit::inputBusLayoutsToJson() const {
  return audioUnitBusLayoutsToJson(inputBusActive_, "input", inputChannels_);
}

std::string HostedAudioUnit::outputBusLayoutsToJson() const {
  return audioUnitBusLayoutsToJson(outputBusActive_, "output", outputChannels_);
}

std::string HostedAudioUnit::stateBase64() const {
  CFPropertyListRef classInfo = nullptr;
  UInt32 classInfoSize = sizeof(classInfo);
  const auto status = AudioUnitGetProperty(
      unit_,
      kAudioUnitProperty_ClassInfo,
      kAudioUnitScope_Global,
      0,
      &classInfo,
      &classInfoSize);
  if (status != noErr || classInfo == nullptr) {
    return "";
  }

  CFErrorRef error = nullptr;
  CFDataRef data = CFPropertyListCreateData(
      kCFAllocatorDefault,
      classInfo,
      kCFPropertyListBinaryFormat_v1_0,
      0,
      &error);
  CFRelease(classInfo);
  if (error != nullptr) {
    CFRelease(error);
  }
  if (data == nullptr) {
    return "";
  }

  const auto size = static_cast<std::size_t>(CFDataGetLength(data));
  if (size > kMaxWorkerStateBytes) {
    CFRelease(data);
    throw std::runtime_error("state_too_large");
  }
  const auto encoded = base64Encode(CFDataGetBytePtr(data), size);
  CFRelease(data);
  return encoded;
}

std::vector<std::string> HostedAudioUnit::parameterJsonList() const {
  UInt32 propertySize = 0;
  Boolean writable = false;
  const auto status = AudioUnitGetPropertyInfo(
      unit_,
      kAudioUnitProperty_ParameterList,
      kAudioUnitScope_Global,
      0,
      &propertySize,
      &writable);
  if (status != noErr || propertySize == 0) {
    return {};
  }

  std::vector<AudioUnitParameterID> parameterIds(propertySize / sizeof(AudioUnitParameterID));
  if (parameterIds.empty()) {
    return {};
  }
  parameterIds.resize(std::min<std::size_t>(parameterIds.size(), kMaxWorkerParameters));
  propertySize = static_cast<UInt32>(parameterIds.size() * sizeof(AudioUnitParameterID));
  checkStatus(
      AudioUnitGetProperty(
          unit_,
          kAudioUnitProperty_ParameterList,
          kAudioUnitScope_Global,
          0,
          parameterIds.data(),
          &propertySize),
      "AudioUnitGetProperty ParameterList");

  std::vector<std::string> parameters;
  parameters.reserve(parameterIds.size());
  for (const auto parameterId : parameterIds) {
    AudioUnitParameterInfo info {};
    UInt32 infoSize = sizeof(info);
    if (AudioUnitGetProperty(
            unit_,
            kAudioUnitProperty_ParameterInfo,
            kAudioUnitScope_Global,
            parameterId,
            &info,
            &infoSize) != noErr) {
      continue;
    }
    parameters.push_back(parameterInfoToJson(unit_, parameterId, info));
  }
  return parameters;
}

OSStatus HostedAudioUnit::inputCallback(
    void* refCon,
    AudioUnitRenderActionFlags* /* actionFlags */,
    const AudioTimeStamp* /* timeStamp */,
    UInt32 busNumber,
    UInt32 frameCount,
    AudioBufferList* ioData) {
  auto* host = static_cast<HostedAudioUnit*>(refCon);
  const auto* sourceBus = findBusChannels(host->currentInputBuses_, busNumber);
  for (UInt32 bufferIndex = 0; bufferIndex < ioData->mNumberBuffers; ++bufferIndex) {
    auto* output = static_cast<Float32*>(ioData->mBuffers[bufferIndex].mData);
    const auto bytes = frameCount * sizeof(Float32);
    ioData->mBuffers[bufferIndex].mDataByteSize = bytes;
    if (output == nullptr) {
      continue;
    }
    if (sourceBus != nullptr && bufferIndex < sourceBus->size()) {
      const auto& source = (*sourceBus)[bufferIndex];
      const auto copyFrames = std::min<std::size_t>(frameCount, source.size());
      if (copyFrames > 0) std::memcpy(output, source.data(), copyFrames * sizeof(Float32));
      if (copyFrames < frameCount) std::memset(output + copyFrames, 0, bytes - copyFrames * sizeof(Float32));
    } else {
      std::memset(output, 0, bytes);
    }
  }
  return noErr;
}

OSStatus HostedAudioUnit::beatAndTempoCallback(
    void* userData,
    Float64* currentBeat,
    Float64* currentTempo) {
  auto* host = static_cast<HostedAudioUnit*>(userData);
  if (host == nullptr) {
    return kAudioUnitErr_CannotDoInCurrentContext;
  }
  const auto& transport = host->currentTransport_;
  if ((currentBeat != nullptr && !transport.hasProjectTimeMusic) ||
      (currentTempo != nullptr && !transport.hasTempo)) {
    return kAudioUnitErr_CannotDoInCurrentContext;
  }
  if (currentBeat != nullptr) {
    *currentBeat = transport.projectTimeMusic;
  }
  if (currentTempo != nullptr) {
    *currentTempo = transport.tempo;
  }
  return noErr;
}

OSStatus HostedAudioUnit::musicalTimeLocationCallback(
    void* userData,
    UInt32* deltaSampleOffsetToNextBeat,
    Float32* timeSigNumerator,
    UInt32* timeSigDenominator,
    Float64* currentMeasureDownBeat) {
  auto* host = static_cast<HostedAudioUnit*>(userData);
  if (host == nullptr) {
    return kAudioUnitErr_CannotDoInCurrentContext;
  }
  const auto& transport = host->currentTransport_;
  if ((deltaSampleOffsetToNextBeat != nullptr && (!transport.hasProjectTimeMusic || !transport.hasTempo)) ||
      ((timeSigNumerator != nullptr || timeSigDenominator != nullptr) && !transport.hasTimeSignature) ||
      (currentMeasureDownBeat != nullptr && !transport.hasBarPositionMusic)) {
    return kAudioUnitErr_CannotDoInCurrentContext;
  }
  if (deltaSampleOffsetToNextBeat != nullptr) {
    *deltaSampleOffsetToNextBeat = host->samplesUntilNextBeat(transport);
  }
  if (timeSigNumerator != nullptr) {
    *timeSigNumerator = transport.timeSignatureNumerator;
  }
  if (timeSigDenominator != nullptr) {
    *timeSigDenominator = transport.timeSignatureDenominator;
  }
  if (currentMeasureDownBeat != nullptr) {
    *currentMeasureDownBeat = transport.barPositionMusic;
  }
  return noErr;
}

OSStatus HostedAudioUnit::transportStateCallback(
    void* userData,
    Boolean* isPlaying,
    Boolean* transportStateChanged,
    Float64* currentSampleInTimeLine,
    Boolean* isCycling,
    Float64* cycleStartBeat,
    Float64* cycleEndBeat) {
  return fillTransportState(userData, isPlaying, nullptr, transportStateChanged, currentSampleInTimeLine, isCycling, cycleStartBeat, cycleEndBeat);
}

OSStatus HostedAudioUnit::transportState2Callback(
    void* userData,
    Boolean* isPlaying,
    Boolean* isRecording,
    Boolean* transportStateChanged,
    Float64* currentSampleInTimeLine,
    Boolean* isCycling,
    Float64* cycleStartBeat,
    Float64* cycleEndBeat) {
  return fillTransportState(userData, isPlaying, isRecording, transportStateChanged, currentSampleInTimeLine, isCycling, cycleStartBeat, cycleEndBeat);
}

OSStatus HostedAudioUnit::fillTransportState(
    void* userData,
    Boolean* isPlaying,
    Boolean* isRecording,
    Boolean* transportStateChanged,
    Float64* currentSampleInTimeLine,
    Boolean* isCycling,
    Float64* cycleStartBeat,
    Float64* cycleEndBeat) {
  auto* host = static_cast<HostedAudioUnit*>(userData);
  if (host == nullptr) {
    return kAudioUnitErr_CannotDoInCurrentContext;
  }
  const auto& transport = host->currentTransport_;
  if ((cycleStartBeat != nullptr || cycleEndBeat != nullptr) && !transport.hasCycle) {
    return kAudioUnitErr_CannotDoInCurrentContext;
  }
  if (isPlaying != nullptr) {
    *isPlaying = transport.playing ? 1 : 0;
  }
  if (isRecording != nullptr) {
    *isRecording = transport.recording ? 1 : 0;
  }
  if (transportStateChanged != nullptr) {
    *transportStateChanged = host->transportStateChanged_ ? 1 : 0;
  }
  if (currentSampleInTimeLine != nullptr) {
    *currentSampleInTimeLine = transport.samplePosition;
  }
  if (isCycling != nullptr) {
    *isCycling = (transport.loopActive && transport.hasCycle) ? 1 : 0;
  }
  if (cycleStartBeat != nullptr) {
    *cycleStartBeat = transport.cycleStartMusic;
  }
  if (cycleEndBeat != nullptr) {
    *cycleEndBeat = transport.cycleEndMusic;
  }
  return noErr;
}

UInt32 HostedAudioUnit::samplesUntilNextBeat(const HostTransportContext& transport) const {
  const auto beatFraction = transport.projectTimeMusic - std::floor(transport.projectTimeMusic);
  if (beatFraction <= 0.000000001 || !transport.hasTempo || transport.tempo <= 0.0) {
    return 0;
  }
  const auto samplesPerBeat = (60.0 / transport.tempo) * sampleRate_;
  const auto samples = std::round((1.0 - beatFraction) * samplesPerBeat);
  return static_cast<UInt32>(std::clamp<double>(
      samples,
      0.0,
      static_cast<double>(std::numeric_limits<UInt32>::max())));
}

void HostedAudioUnit::installHostCallbacks() {
  HostCallbackInfo callbacks {};
  callbacks.hostUserData = this;
  callbacks.beatAndTempoProc = &HostedAudioUnit::beatAndTempoCallback;
  callbacks.musicalTimeLocationProc = &HostedAudioUnit::musicalTimeLocationCallback;
  callbacks.transportStateProc = &HostedAudioUnit::transportStateCallback;
  callbacks.transportStateProc2 = &HostedAudioUnit::transportState2Callback;
  AudioUnitSetProperty(
      unit_,
      kAudioUnitProperty_HostCallbacks,
      kAudioUnitScope_Global,
      0,
      &callbacks,
      sizeof(callbacks));
}

std::uint32_t HostedAudioUnit::audioUnitElementCount(AudioUnitScope scope, std::uint32_t fallback) const {
  UInt32 count = 0;
  UInt32 countSize = sizeof(count);
  const auto status = AudioUnitGetProperty(
      unit_,
      kAudioUnitProperty_ElementCount,
      scope,
      0,
      &count,
      &countSize);
  if (status != noErr || count == 0) {
    return fallback;
  }
  return std::clamp<std::uint32_t>(count, 0, kMaxWorkerChannels);
}

void HostedAudioUnit::prepareOutputBuffers() {
  for (auto* outputList : outputBufferLists_) std::free(outputList);
  outputStorage_.resize(outputBusActive_.size());
  outputBufferLists_.assign(outputBusActive_.size(), nullptr);
  const auto listBytes = sizeof(AudioBufferList) + sizeof(AudioBuffer) * (outputChannels_ > 0 ? outputChannels_ - 1 : 0);
  for (std::uint32_t busIndex = 0; busIndex < outputBusActive_.size(); ++busIndex) {
    if (!outputBusActive_[busIndex]) {
      continue;
    }
    auto* list = static_cast<AudioBufferList*>(std::calloc(1, listBytes));
    if (list == nullptr) {
      throw std::bad_alloc();
    }
    outputStorage_[busIndex].assign(outputChannels_, std::vector<float>(maxBlockSize_, 0.0F));
    list->mNumberBuffers = outputChannels_;
    for (std::uint32_t channelIndex = 0; channelIndex < outputChannels_; ++channelIndex) {
      list->mBuffers[channelIndex].mNumberChannels = 1;
      list->mBuffers[channelIndex].mDataByteSize = maxBlockSize_ * sizeof(Float32);
      list->mBuffers[channelIndex].mData = outputStorage_[busIndex][channelIndex].data();
    }
    outputBufferLists_[busIndex] = list;
  }
}

AudioBufferList* HostedAudioUnit::outputBufferListFor(std::uint32_t busIndex, std::uint32_t frames) {
  if (busIndex >= outputBufferLists_.size() || outputBufferLists_[busIndex] == nullptr) {
    throw std::runtime_error("Audio Unit output bus is not prepared.");
  }
  auto* list = outputBufferLists_[busIndex];
  for (std::uint32_t channelIndex = 0; channelIndex < outputChannels_; ++channelIndex) {
    auto& channel = outputStorage_[busIndex][channelIndex];
    std::fill(channel.begin(), channel.begin() + frames, 0.0F);
    list->mBuffers[channelIndex].mDataByteSize = frames * sizeof(Float32);
  }
  return list;
}

void HostedAudioUnit::configure() {
  UInt32 maxFrames = maxBlockSize_;
  checkStatus(
      AudioUnitSetProperty(
          unit_,
          kAudioUnitProperty_MaximumFramesPerSlice,
          kAudioUnitScope_Global,
          0,
          &maxFrames,
          sizeof(maxFrames)),
      "AudioUnitSetProperty MaximumFramesPerSlice");

  outputBusCount_ = audioUnitElementCount(kAudioUnitScope_Output, 1);
  outputBusActive_.assign(outputBusCount_, false);
  const auto outputFormat = streamDescription(sampleRate_, outputChannels_);
  for (std::uint32_t busIndex = 0; busIndex < outputBusCount_; ++busIndex) {
    const auto formatStatus = AudioUnitSetProperty(
        unit_,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output,
        busIndex,
        &outputFormat,
        sizeof(outputFormat));
    if (busIndex == 0) {
      checkStatus(formatStatus, "AudioUnitSetProperty output StreamFormat");
    }
    outputBusActive_[busIndex] = formatStatus == noErr;
  }

  if (inputChannels_ > 0) {
    inputBusCount_ = audioUnitElementCount(kAudioUnitScope_Input, 1);
    inputBusActive_.assign(inputBusCount_, false);
    const auto inputFormat = streamDescription(sampleRate_, inputChannels_);
    for (std::uint32_t busIndex = 0; busIndex < inputBusCount_; ++busIndex) {
      const auto formatStatus = AudioUnitSetProperty(
          unit_,
          kAudioUnitProperty_StreamFormat,
          kAudioUnitScope_Input,
          busIndex,
          &inputFormat,
          sizeof(inputFormat));

      AURenderCallbackStruct callback {};
      callback.inputProc = &HostedAudioUnit::inputCallback;
      callback.inputProcRefCon = this;
      const auto callbackStatus = AudioUnitSetProperty(
          unit_,
          kAudioUnitProperty_SetRenderCallback,
          kAudioUnitScope_Input,
          busIndex,
          &callback,
          sizeof(callback));

      if (busIndex == 0) {
        checkStatus(formatStatus, "AudioUnitSetProperty input StreamFormat");
        checkStatus(callbackStatus, "AudioUnitSetProperty input RenderCallback");
      }
      inputBusActive_[busIndex] = formatStatus == noErr && callbackStatus == noErr;
    }
  } else {
    inputBusCount_ = 0;
    inputBusActive_.clear();
  }

  installHostCallbacks();
  prepareOutputBuffers();
  checkStatus(AudioUnitInitialize(unit_), "AudioUnitInitialize");
}

} // namespace soundbridge::audio_unit_worker

#endif
