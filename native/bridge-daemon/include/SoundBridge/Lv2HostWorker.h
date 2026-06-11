#pragma once

#include <string>

namespace soundbridge {

bool lv2HostWorkerAvailable();
std::string lv2HostWorkerStatus();
int runLv2HostWorker(int argc, char** argv);

} // namespace soundbridge
