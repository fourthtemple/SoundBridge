import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MAX_SOURCE_LINES = 1200;

const OVERSIZED_BASELINE = new Map([
  ["native/bridge-daemon/src/Lv2HostWorker.cpp", 2017],
  ["native/bridge-daemon/src/Vst3HostWorker.cpp", 1750],
  ["scripts/mock-daemon.mjs", 3687],
  ["scripts/smoke-test.mjs", 1535]
]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".js",
  ".mjs",
  ".mm",
  ".ts",
  ".tsx"
]);

const IGNORED_DIRS = new Set([
  ".git",
  "build",
  "build-current",
  "dist",
  "node_modules"
]);

function shouldSkipDirectory(name) {
  return IGNORED_DIRS.has(name) || name.endsWith(".build");
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        files.push(...sourceFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function repoRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function lineCount(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) {
    return 0;
  }
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

const failures = [];
for (const file of sourceFiles(ROOT)) {
  const relative = repoRelative(file);
  const lines = lineCount(file);
  const baseline = OVERSIZED_BASELINE.get(relative);
  if (baseline != null) {
    if (lines > baseline) {
      failures.push(`${relative}: ${lines} lines exceeds oversized baseline ${baseline}; split it or reduce it.`);
    }
    continue;
  }
  if (lines > MAX_SOURCE_LINES) {
    failures.push(`${relative}: ${lines} lines exceeds ${MAX_SOURCE_LINES}; split the file before adding more behavior.`);
  }
}

for (const relative of OVERSIZED_BASELINE.keys()) {
  if (!fs.existsSync(path.join(ROOT, relative))) {
    failures.push(`${relative}: oversized baseline points to a missing file; remove the baseline entry.`);
  }
}

if (failures.length > 0) {
  console.error("File-size fitness check failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`File-size fitness check passed (${MAX_SOURCE_LINES} line cap, ${OVERSIZED_BASELINE.size} legacy baselines).`);
