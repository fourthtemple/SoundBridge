#pragma once

#ifndef _WIN32

#include "SoundBridge/Lv2HostWorkerSupport.h"
#include "SoundBridge/Lv2StateSupport.h"

#include <cstddef>
#include <functional>
#include <string>
#include <vector>

namespace soundbridge::lv2_worker {

using Lv2ExtensionStateRestorer = std::function<void(
    const std::vector<Lv2RestoredStateProperty>& properties,
    const std::vector<Lv2StateFile>& files)>;

std::string lv2HostedPluginStateBase64(
    const std::vector<Lv2Port>& ports,
    const std::vector<std::size_t>& inputControlPortIndexes,
    const Lv2SavedExtensionState& extensionState);

void restoreLv2HostedPluginState(
    const std::string& encodedState,
    std::vector<Lv2Port>& ports,
    const std::vector<std::size_t>& inputControlPortIndexes,
    Lv2UridMapper& uridMapper,
    const Lv2ExtensionStateRestorer& restoreExtensionState);

} // namespace soundbridge::lv2_worker

#endif
