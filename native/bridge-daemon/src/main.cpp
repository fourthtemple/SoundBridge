#include "SoundBridge/AudioUnitHostWorker.h"
#include "SoundBridge/AudioUnitScanner.h"
#include "SoundBridge/ExampleInstrumentRenderer.h"
#include "SoundBridge/Lv2HostWorker.h"
#include "SoundBridge/Lv2Scanner.h"
#include "SoundBridge/NativePlugin.h"
#include "SoundBridge/PluginCatalog.h"
#include "SoundBridge/Vst3HostWorker.h"
#include "SoundBridge/Vst3Scanner.h"

#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

void printUsage() {
  std::cout << "soundbridge-daemon " << SOUNDBRIDGE_VERSION << "\n";
  std::cout << "Usage:\n";
  std::cout << "  soundbridge-daemon --scan\n";
  std::cout << "  soundbridge-daemon --scan-installed\n";
  std::cout << "  soundbridge-daemon --scan-examples\n";
  std::cout << "  soundbridge-daemon --scan-vst3\n";
  std::cout << "  soundbridge-daemon --scan-au\n";
  std::cout << "  soundbridge-daemon --scan-lv2\n";
  std::cout << "  soundbridge-daemon --host-status\n";
  std::cout << "  soundbridge-daemon --host-au-worker <type> <subtype> <manufacturer> <sample-rate> <max-block> <inputs> <outputs> <kind>\n";
  std::cout << "  soundbridge-daemon --host-lv2-worker <bundle-path> <sample-rate> <max-block> <inputs> <outputs> <kind>\n";
  std::cout << "  soundbridge-daemon --host-vst3-worker <bundle-path> <sample-rate> <max-block> <inputs> <outputs> <kind>\n";
  std::cout << "  soundbridge-daemon --render-example-block <plugin-id> <frames> <sample-rate> <gain> <tone> <detune> <note:velocity,...>\n";
}

std::string formatStatusToJson(
    soundbridge::PluginFormat format,
    bool scanAvailable,
    bool hostAvailable,
    bool exampleHostAvailable,
    const std::string& notes) {
  std::ostringstream output;
  output << "{";
  output << "\"format\":\"" << soundbridge::pluginFormatToString(format) << "\",";
  output << "\"scanAvailable\":" << (scanAvailable ? "true" : "false") << ",";
  output << "\"hostAvailable\":" << (hostAvailable ? "true" : "false") << ",";
  output << "\"exampleHostAvailable\":" << (exampleHostAvailable ? "true" : "false") << ",";
  output << "\"notes\":\"" << soundbridge::jsonEscape(notes) << "\"";
  output << "}";
  return output.str();
}

std::string hostStatusToJson() {
  std::ostringstream output;
  output << "{";
  output << "\"formats\":[";
  output << formatStatusToJson(
      soundbridge::PluginFormat::Vst3,
      true,
      soundbridge::vst3HostWorkerAvailable(),
      true,
      soundbridge::vst3HostWorkerStatus());
  output << ",";
  output << formatStatusToJson(
      soundbridge::PluginFormat::AudioUnit,
#ifdef SOUNDBRIDGE_MACOS
      true,
#else
      false,
#endif
      soundbridge::audioUnitHostAvailable(),
      true,
      soundbridge::audioUnitHostStatus());
  output << ",";
  output << formatStatusToJson(
      soundbridge::PluginFormat::Lv2,
      true,
      soundbridge::lv2HostWorkerAvailable(),
      true,
      soundbridge::lv2HostWorkerStatus());
  output << "]";
  output << "}";
  return output.str();
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    printUsage();
    return 0;
  }

  const std::string command = argv[1];

  if (command == "--scan") {
    const soundbridge::PluginCatalog catalog;
    std::cout << soundbridge::nativePluginListToJson(catalog.scanAll()) << "\n";
    return 0;
  }

  if (command == "--scan-installed") {
    const soundbridge::PluginCatalog catalog;
    std::cout << soundbridge::nativePluginListToJson(catalog.scanAll(false)) << "\n";
    return 0;
  }

  if (command == "--scan-examples") {
    const soundbridge::PluginCatalog catalog;
    std::cout << soundbridge::nativePluginListToJson(catalog.scanExamples()) << "\n";
    return 0;
  }

  if (command == "--scan-vst3") {
    const soundbridge::Vst3Scanner scanner;
    std::cout << soundbridge::vst3BundleListToJson(scanner.scan()) << "\n";
    return 0;
  }

  if (command == "--scan-au") {
    const soundbridge::AudioUnitScanner scanner;
    std::cout << soundbridge::nativePluginListToJson(scanner.scan()) << "\n";
    return 0;
  }

  if (command == "--scan-lv2") {
    const soundbridge::Lv2Scanner scanner;
    std::cout << soundbridge::nativePluginListToJson(scanner.scan()) << "\n";
    return 0;
  }

  if (command == "--host-status") {
    std::cout << hostStatusToJson() << "\n";
    return 0;
  }

  if (command == "--host-au-worker") {
    return soundbridge::runAudioUnitHostWorker(argc, argv);
  }

  if (command == "--host-lv2-worker") {
    return soundbridge::runLv2HostWorker(argc, argv);
  }

  if (command == "--host-vst3-worker") {
    return soundbridge::runVst3HostWorker(argc, argv);
  }

  if (command == "--render-example-block") {
    if (argc < 9) {
      std::cerr << "--render-example-block requires plugin id, frames, sample rate, gain, tone, detune, and voices.\n";
      return 2;
    }

    soundbridge::ExampleRenderConfig config;
    config.pluginId = argv[2];
    if (!soundbridge::isExampleInstrumentPluginId(config.pluginId)) {
      std::cerr << "Unknown example instrument plugin id: " << config.pluginId << "\n";
      return 3;
    }

    try {
      config.frames = static_cast<std::uint32_t>(std::stoul(argv[3]));
      config.sampleRate = std::stod(argv[4]);
      config.gain = std::stod(argv[5]);
      config.tone = std::stod(argv[6]);
      config.detune = std::stod(argv[7]);
    } catch (const std::exception& error) {
      std::cerr << "--render-example-block received invalid numeric arguments: " << error.what() << "\n";
      return 2;
    }
    config.voices = soundbridge::parseExampleVoices(argv[8]);

    std::cout << soundbridge::exampleInstrumentBlockToJson(
        soundbridge::renderExampleInstrumentBlock(config)) << "\n";
    return 0;
  }

  printUsage();
  return 1;
}
