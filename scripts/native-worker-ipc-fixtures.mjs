import fs from "node:fs";
import path from "node:path";

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
  return writeExecutable(
    tempDir,
    "grant-aware-native-worker.mjs",
    `#!/usr/bin/env node
const expectedFilePath = ${JSON.stringify(fixtureGrantPath)};
const expectedDirectoryPath = ${JSON.stringify(tempDir)};
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
    if (parts[0] === "setParameterDisplayValue") {
      const displayValue = Buffer.from(parts[2] === "-" ? "" : parts[2], "base64").toString("utf8");
      process.stdout.write(JSON.stringify({
        parameter: {
          id: parts[1],
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
    const displayName = Buffer.from(parts[6] === "-" ? "" : parts[6], "base64").toString("utf8");
    const absolutePath = Buffer.from(parts[7] === "-" ? "" : parts[7], "base64").toString("utf8");
    const sampleApplied = parts[1] === "loadSample" &&
      parts[2] === "sample" &&
      parts[3] === "read" &&
      parts[4] === "file" &&
      parts[5] === "filegrant-test" &&
      displayName === "Fixture Grant.wav" &&
      absolutePath === expectedFilePath;
    const stateDirectoryApplied = parts[1] === "saveStateDirectory" &&
      parts[2] === "state" &&
      parts[3] === "readWrite" &&
      parts[4] === "directory" &&
      parts[5] === "filegrant-state-dir" &&
      displayName === "Fixture Grants" &&
      absolutePath === expectedDirectoryPath;
    process.stdout.write(JSON.stringify({
      applied: sampleApplied || stateDirectoryApplied,
      status: stateDirectoryApplied ? "state-dir-ok" : "grant-ok"
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
