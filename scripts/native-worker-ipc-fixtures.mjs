import fs from "node:fs";
import path from "node:path";

export async function exerciseGrantAwareNativeWorker({
  check,
  createTestWorkers,
  fixtureGrantPath,
  nativeWorkerInstance,
  tempDir,
  workerPath
}) {
  const grantWorkers = createTestWorkers(workerPath, {
    maxWorkerCommandBytes: 4096,
    maxWorkerPendingCommandBytes: 4096
  });
  const grantWorker = new grantWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await grantWorker.ready;
  const grantWorkerResult = await grantWorker.useFileGrant({
    operation: "loadSample",
    grant: {
      grantId: "filegrant-test",
      purpose: "sample",
      access: "read",
      kind: "file",
      displayName: "Fixture Grant.wav",
      absolutePath: fixtureGrantPath
    }
  });
  check(
    grantWorkerResult.applied === true && grantWorkerResult.status === "grant-ok",
    "native host workers encode bounded file grant commands"
  );
  const presetGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "loadPreset",
    grant: {
      grantId: "filegrant-preset",
      purpose: "preset",
      access: "read",
      kind: "file",
      displayName: "Fixture Preset.fxp",
      absolutePath: path.join(tempDir, "Fixture Preset.fxp")
    }
  });
  check(
    presetGrantWorkerResult.applied === true && presetGrantWorkerResult.status === "preset-ok",
    "native host workers encode bounded preset file grant commands"
  );
  const cacheDirectoryGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "openCacheDirectory",
    grant: {
      grantId: "filegrant-cache-dir",
      purpose: "cache",
      access: "readWrite",
      kind: "directory",
      displayName: "Fixture Cache",
      absolutePath: tempDir
    }
  });
  check(
    cacheDirectoryGrantWorkerResult.applied === true && cacheDirectoryGrantWorkerResult.status === "cache-dir-ok",
    "native host workers encode bounded cache directory grant commands"
  );
  const licenseGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "loadLicense",
    grant: {
      grantId: "filegrant-license",
      purpose: "license",
      access: "read",
      kind: "file",
      displayName: "Fixture License.key",
      absolutePath: path.join(tempDir, "Fixture License.key")
    }
  });
  check(
    licenseGrantWorkerResult.applied === true && licenseGrantWorkerResult.status === "license-ok",
    "native host workers encode bounded license file grant commands"
  );
  const otherPresetGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "other",
    grant: {
      grantId: "filegrant-vendor-preset",
      purpose: "preset",
      access: "read",
      kind: "file",
      displayName: "Fixture Vendor Preset.vstpreset",
      absolutePath: path.join(tempDir, "Fixture Vendor Preset.vstpreset")
    }
  });
  check(
    otherPresetGrantWorkerResult.applied === true && otherPresetGrantWorkerResult.status === "other-preset-ok",
    "native host workers encode bounded explicit other file grant commands"
  );
  const stateDirectoryGrantWorkerResult = await grantWorker.useFileGrant({
    operation: "saveStateDirectory",
    grant: {
      grantId: "filegrant-state-dir",
      purpose: "state",
      access: "readWrite",
      kind: "directory",
      displayName: "Fixture Grants",
      absolutePath: tempDir
    }
  });
  check(
    stateDirectoryGrantWorkerResult.applied === true && stateDirectoryGrantWorkerResult.status === "state-dir-ok",
    "native host workers encode bounded directory file grant commands"
  );
  const parameterWorker = new grantWorkers.NativeHostWorker(
    { format: "lv2", bundlePath: tempDir, renderEngine: "native-lv2" },
    nativeWorkerInstance()
  );
  await parameterWorker.ready;
  const spacedParameter = await parameterWorker.setParameter("gain amount", 0.25, 7);
  check(
    spacedParameter?.id === "gain amount" &&
      Math.abs(spacedParameter.normalizedValue - 0.25) < 0.000001 &&
      spacedParameter.displayValue === "offset-ok",
    "native host workers encode bounded parameter id commands"
  );
  parameterWorker.destroy();
  const textWorker = new grantWorkers.NativeHostWorker(
    { format: "vst3", bundlePath: tempDir, renderEngine: "native-vst3" },
    nativeWorkerInstance()
  );
  await textWorker.ready;
  const textParameter = await textWorker.setParameterDisplayValue("42", "0.0 dB");
  check(
    textParameter?.id === "42" &&
      textParameter.displayValue === "0.0 dB" &&
      Math.abs(textParameter.normalizedValue - 0.5) < 0.000001,
    "native host workers encode bounded parameter display text commands"
  );
  textWorker.destroy();
  grantWorker.destroy();
}

export function writeNativeWorkerIpcFixtures({ tempDir, fixtureGrantPath }) {
  return {
    exampleWorkerPath: writeExecutable(
      tempDir,
      "oversized-example-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("x".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    nativeWorkerPath: writeExecutable(
      tempDir,
      "oversized-native-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("y".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    exampleStderrWorkerPath: writeExecutable(
      tempDir,
      "oversized-example-stderr-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("e".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    nativeStderrWorkerPath: writeExecutable(
      tempDir,
      "oversized-native-stderr-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write("n".repeat(2048));
});
setTimeout(() => {}, 30000);
`
    ),
    exampleStderrBudgetWorkerPath: writeExecutable(
      tempDir,
      "stderr-budget-example-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write(" ".repeat(40) + "\\n" + " ".repeat(40) + "\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    nativeStderrBudgetWorkerPath: writeExecutable(
      tempDir,
      "stderr-budget-native-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stderr.write(" ".repeat(40) + "\\n" + " ".repeat(40) + "\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    diagnosticControlWorkerPath: writeExecutable(
      tempDir,
      "diagnostic-control-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let handled = false;
process.stdin.on("data", () => {
  if (handled) {
    return;
  }
  handled = true;
  process.stderr.write("\\u001b[31mwarning\\rfake\\x7f\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ channels: [[0]] }) + "\\n");
  }, 10);
});
setTimeout(() => {}, 30000);
`
    ),
    malformedExampleWorkerPath: writeExecutable(
      tempDir,
      "malformed-example-worker.mjs",
      `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("not-json\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    malformedNativeReadyWorkerPath: writeExecutable(
      tempDir,
      "malformed-native-ready-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write("not-json\\n");
setTimeout(() => {}, 30000);
`
    ),
    invalidNativeReadyWorkerPath: writeExecutable(
      tempDir,
      "invalid-native-ready-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: false, error: "bad-ready" }) + "\\n");
setTimeout(() => {}, 30000);
`
    ),
    malformedNativeCommandWorkerPath: writeExecutable(
      tempDir,
      "malformed-native-command-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write("not-json\\n");
});
setTimeout(() => {}, 30000);
`
    ),
    unsolicitedExampleWorkerPath: writeExecutable(
      tempDir,
      "unsolicited-example-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
setTimeout(() => {}, 30000);
`
    ),
    unsolicitedNativeWorkerPath: writeExecutable(
      tempDir,
      "unsolicited-native-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
setTimeout(() => {}, 30000);
`
    ),
    hangingNativeWorkerPath: writeExecutable(
      tempDir,
      "hanging-native-worker.mjs",
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    hangingExampleCommandWorkerPath: writeExecutable(
      tempDir,
      "hanging-example-command-worker.mjs",
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    hangingNativeCommandWorkerPath: writeExecutable(
      tempDir,
      "hanging-native-command-worker.mjs",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    stubbornExampleCommandWorkerPath: writeExecutable(
      tempDir,
      "stubborn-example-command-worker.mjs",
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    stubbornNativeCommandWorkerPath: writeExecutable(
      tempDir,
      "stubborn-native-command-worker.mjs",
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.resume();
setTimeout(() => {}, 30000);
`
    ),
    grantAwareNativeWorkerPath: writeGrantAwareNativeWorker(tempDir, fixtureGrantPath)
  };
}

function writeGrantAwareNativeWorker(tempDir, fixtureGrantPath) {
  const presetPath = path.join(tempDir, "Fixture Preset.fxp");
  const licensePath = path.join(tempDir, "Fixture License.key");
  const vendorPresetPath = path.join(tempDir, "Fixture Vendor Preset.vstpreset");
  return writeExecutable(
    tempDir,
    "grant-aware-native-worker.mjs",
    `#!/usr/bin/env node
const expectedFilePath = ${JSON.stringify(fixtureGrantPath)};
const expectedDirectoryPath = ${JSON.stringify(tempDir)};
const expectedPresetPath = ${JSON.stringify(presetPath)};
const expectedLicensePath = ${JSON.stringify(licensePath)};
const expectedVendorPresetPath = ${JSON.stringify(vendorPresetPath)};
process.stdout.write(JSON.stringify({ ok: true, ready: true }) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    const parts = line.split(" ");
    const workerText = (token) => Buffer.from(token === "-" ? "" : token, "base64").toString("utf8");
    if (parts[0] === "setParameter") {
      const parameterId = workerText(parts[1]);
      process.stdout.write(JSON.stringify({
        parameter: {
          id: parameterId,
          normalizedValue: Number(parts[2]),
          displayValue: parts[3] === "7" ? "offset-ok" : "offset-missing"
        }
      }) + "\\n");
      continue;
    }
    if (parts[0] === "setParameterDisplayValue") {
      const parameterId = workerText(parts[1]);
      const displayValue = workerText(parts[2]);
      process.stdout.write(JSON.stringify({
        parameter: {
          id: parameterId,
          normalizedValue: displayValue === "0.0 dB" ? 0.5 : 0,
          displayValue
        }
      }) + "\\n");
      continue;
    }
    if (parts[0] !== "fileGrant") {
      process.stdout.write(JSON.stringify({ error: "unknown_command" }) + "\\n");
      continue;
    }
    const displayName = workerText(parts[6]);
    const absolutePath = workerText(parts[7]);
    const sampleApplied = parts[1] === "loadSample" &&
      parts[2] === "sample" &&
      parts[3] === "read" &&
      parts[4] === "file" &&
      parts[5] === "filegrant-test" &&
      displayName === "Fixture Grant.wav" &&
      absolutePath === expectedFilePath;
    const presetApplied = parts[1] === "loadPreset" &&
      parts[2] === "preset" &&
      parts[3] === "read" &&
      parts[4] === "file" &&
      parts[5] === "filegrant-preset" &&
      displayName === "Fixture Preset.fxp" &&
      absolutePath === expectedPresetPath;
    const cacheDirectoryApplied = parts[1] === "openCacheDirectory" &&
      parts[2] === "cache" &&
      parts[3] === "readWrite" &&
      parts[4] === "directory" &&
      parts[5] === "filegrant-cache-dir" &&
      displayName === "Fixture Cache" &&
      absolutePath === expectedDirectoryPath;
    const licenseApplied = parts[1] === "loadLicense" &&
      parts[2] === "license" &&
      parts[3] === "read" &&
      parts[4] === "file" &&
      parts[5] === "filegrant-license" &&
      displayName === "Fixture License.key" &&
      absolutePath === expectedLicensePath;
    const otherPresetApplied = parts[1] === "other" &&
      parts[2] === "preset" &&
      parts[3] === "read" &&
      parts[4] === "file" &&
      parts[5] === "filegrant-vendor-preset" &&
      displayName === "Fixture Vendor Preset.vstpreset" &&
      absolutePath === expectedVendorPresetPath;
    const stateDirectoryApplied = parts[1] === "saveStateDirectory" &&
      parts[2] === "state" &&
      parts[3] === "readWrite" &&
      parts[4] === "directory" &&
      parts[5] === "filegrant-state-dir" &&
      displayName === "Fixture Grants" &&
      absolutePath === expectedDirectoryPath;
    process.stdout.write(JSON.stringify({
      applied: sampleApplied || presetApplied || cacheDirectoryApplied || licenseApplied || otherPresetApplied || stateDirectoryApplied,
      status: stateDirectoryApplied ? "state-dir-ok" :
        cacheDirectoryApplied ? "cache-dir-ok" :
        licenseApplied ? "license-ok" :
        otherPresetApplied ? "other-preset-ok" :
        presetApplied ? "preset-ok" :
        "grant-ok"
    }) + "\\n");
  }
});
setTimeout(() => {}, 30000);
`
  );
}

function writeExecutable(tempDir, filename, source) {
  const file = path.join(tempDir, filename);
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}
