cmake_minimum_required(VERSION 3.20)

project(SoundBridgeDaemon VERSION 0.1.0 LANGUAGES CXX)

add_executable(soundbridge-daemon
  src/main.cpp
  src/AudioUnitHostWorker.cpp
  src/AudioUnitHostWorkerSupport.cpp
  src/AudioUnitScanner.cpp
  src/Base64.cpp
  src/ExampleInstrumentRenderer.cpp
  src/Lv2AtomSupport.cpp
  src/Lv2BusSupport.cpp
  src/Lv2HostWorker.cpp
  src/Lv2HostWorkerSupport.cpp
  src/Lv2StateSupport.cpp
  src/Lv2Scanner.cpp
  src/NativePlugin.cpp
  src/NativeFileGrantSupport.cpp
  src/PluginCatalog.cpp
  src/Vst3Scanner.cpp
  src/Vst3Host.cpp
  src/Vst3HostWorker.cpp
  src/Vst3HostInfoSupport.cpp
  src/Vst3HostWorkerProcessSupport.cpp
  src/Vst3HostWorkerSupport.cpp
  src/Vst3PluginMetadataSupport.cpp
  src/Vst3ProgramDataSupport.cpp
  src/Vst3StateSupport.cpp
  src/Vst3StreamSupport.cpp
)

add_executable(soundbridge-example-instrument
  src/ExampleInstrumentBundleMain.cpp
  src/ExampleInstrumentRenderer.cpp
)

add_library(soundbridge-example-lv2-gain MODULE
  src/ExampleLv2GainPlugin.cpp
)

target_compile_features(soundbridge-daemon PRIVATE cxx_std_17)
target_compile_features(soundbridge-example-instrument PRIVATE cxx_std_17)
target_compile_features(soundbridge-example-lv2-gain PRIVATE cxx_std_17)
target_include_directories(soundbridge-daemon PRIVATE include)
target_include_directories(soundbridge-example-instrument PRIVATE include)
target_include_directories(soundbridge-example-lv2-gain PRIVATE include)
set_target_properties(soundbridge-example-lv2-gain PROPERTIES
  PREFIX ""
  OUTPUT_NAME "soundbridge-example-lv2-gain"
  SUFFIX ".so"
)
target_compile_definitions(soundbridge-daemon PRIVATE
  SOUNDBRIDGE_VERSION="${PROJECT_VERSION}"
  SOUNDBRIDGE_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../.."
)
target_link_libraries(soundbridge-daemon PRIVATE ${CMAKE_DL_LIBS})

if(APPLE)
  target_compile_definitions(soundbridge-daemon PRIVATE SOUNDBRIDGE_MACOS=1)
  target_link_libraries(soundbridge-daemon PRIVATE
    "-framework AudioToolbox"
    "-framework CoreFoundation"
  )
endif()

set(SOUNDBRIDGE_VST3_SDK_PATH "$ENV{SOUNDBRIDGE_VST3_SDK_PATH}" CACHE PATH "Path to Steinberg VST3 SDK")
if(NOT SOUNDBRIDGE_VST3_SDK_PATH AND EXISTS "/Users/sethtenenbaum/wadspa/adlplug/thirdparty/vst3sdk/pluginterfaces/vst/ivstaudioprocessor.h")
  set(SOUNDBRIDGE_VST3_SDK_PATH "/Users/sethtenenbaum/wadspa/adlplug/thirdparty/vst3sdk" CACHE PATH "Path to Steinberg VST3 SDK" FORCE)
endif()

if(APPLE AND SOUNDBRIDGE_VST3_SDK_PATH AND EXISTS "${SOUNDBRIDGE_VST3_SDK_PATH}/pluginterfaces/vst/ivstaudioprocessor.h")
  enable_language(OBJCXX)
  target_compile_definitions(soundbridge-daemon PRIVATE
    RELEASE=1
    SOUNDBRIDGE_ENABLE_VST3_SDK=1
  )
  target_include_directories(soundbridge-daemon PRIVATE "${SOUNDBRIDGE_VST3_SDK_PATH}")
  target_sources(soundbridge-daemon PRIVATE
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/source/baseiids.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/source/fbuffer.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/source/fdebug.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/source/fobject.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/source/fstring.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/source/updatehandler.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/base/thread/source/flock.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/pluginterfaces/base/conststringtable.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/pluginterfaces/base/coreiids.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/pluginterfaces/base/funknown.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/pluginterfaces/base/ustring.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/common/memorystream.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/main/pluginfactoryvst3.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/hosting/eventlist.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/hosting/hostclasses.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/hosting/module.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/hosting/module_mac.mm"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/hosting/parameterchanges.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/hosting/stringconvert.cpp"
    "${SOUNDBRIDGE_VST3_SDK_PATH}/public.sdk/source/vst/vstinitiids.cpp"
  )
  target_link_libraries(soundbridge-daemon PRIVATE
    "-framework Cocoa"
  )
endif()

set(SOUNDBRIDGE_EXAMPLE_VST3_EXECUTABLE
  "${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/VST3/soundbridge-example-polysynth.vst3/Contents/MacOS/soundbridge-example-polysynth"
)
set(SOUNDBRIDGE_EXAMPLE_AU_EXECUTABLE
  "${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/Components/soundbridge-example-tonewheel.component/Contents/MacOS/soundbridge-example-tonewheel"
)
set(SOUNDBRIDGE_EXAMPLE_LV2_EXECUTABLE
  "${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/LV2/soundbridge-example-wavefold.lv2/soundbridge-example-wavefold"
)
set(SOUNDBRIDGE_EXAMPLE_LV2_GAIN_MODULE
  "${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/LV2/soundbridge-example-gain.lv2/soundbridge-example-lv2-gain.so"
)
set(SOUNDBRIDGE_BLOCK_PROFILE_LV2_GAIN_MODULE
  "${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/LV2/soundbridge-block-profile-gain.lv2/soundbridge-example-lv2-gain.so"
)

add_custom_command(TARGET soundbridge-example-instrument POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<SHELL_PATH:${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/VST3/soundbridge-example-polysynth.vst3/Contents/MacOS>"
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<SHELL_PATH:${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/Components/soundbridge-example-tonewheel.component/Contents/MacOS>"
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<SHELL_PATH:${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/LV2/soundbridge-example-wavefold.lv2>"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:soundbridge-example-instrument>" "$<SHELL_PATH:${SOUNDBRIDGE_EXAMPLE_VST3_EXECUTABLE}>"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:soundbridge-example-instrument>" "$<SHELL_PATH:${SOUNDBRIDGE_EXAMPLE_AU_EXECUTABLE}>"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:soundbridge-example-instrument>" "$<SHELL_PATH:${SOUNDBRIDGE_EXAMPLE_LV2_EXECUTABLE}>"
  COMMENT "Installing SoundBridge example instrument executables into repo-local AU/VST/LV2 bundles"
)

add_custom_command(TARGET soundbridge-example-lv2-gain POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<SHELL_PATH:${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/LV2/soundbridge-example-gain.lv2>"
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<SHELL_PATH:${CMAKE_CURRENT_SOURCE_DIR}/../example-plugins/LV2/soundbridge-block-profile-gain.lv2>"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:soundbridge-example-lv2-gain>" "$<SHELL_PATH:${SOUNDBRIDGE_EXAMPLE_LV2_GAIN_MODULE}>"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:soundbridge-example-lv2-gain>" "$<SHELL_PATH:${SOUNDBRIDGE_BLOCK_PROFILE_LV2_GAIN_MODULE}>"
  COMMENT "Installing SoundBridge LV2 gain fixture into repo-local LV2 bundle"
)
