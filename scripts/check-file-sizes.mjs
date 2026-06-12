import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MAX_SOURCE_LINES = 1200;
const NEAR_LIMIT_LINES = 1000;

const NEAR_LIMIT_BUDGETS = new Map([
  ["native/bridge-daemon/src/Lv2HostWorker.cpp", 1095],
  ["native/bridge-daemon/src/Lv2HostWorkerSupport.cpp", 1056]
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
  const nearLimitBudget = NEAR_LIMIT_BUDGETS.get(relative);
  if (nearLimitBudget != null) {
    if (nearLimitBudget >= MAX_SOURCE_LINES) {
      failures.push(`${relative}: near-limit budget ${nearLimitBudget} must stay below hard cap ${MAX_SOURCE_LINES}.`);
    }
    if (lines > nearLimitBudget) {
      failures.push(`${relative}: ${lines} lines exceeds reviewed near-limit budget ${nearLimitBudget}; split it or reduce it.`);
    }
    if (lines < NEAR_LIMIT_LINES) {
      failures.push(`${relative}: ${lines} lines is below near-limit threshold ${NEAR_LIMIT_LINES}; remove its reviewed budget.`);
    }
    continue;
  }
  if (lines > MAX_SOURCE_LINES) {
    failures.push(`${relative}: ${lines} lines exceeds ${MAX_SOURCE_LINES}; split the file before adding more behavior.`);
  } else if (lines >= NEAR_LIMIT_LINES) {
    failures.push(`${relative}: ${lines} lines exceeds near-limit threshold ${NEAR_LIMIT_LINES}; extract a focused module or add a reviewed budget.`);
  }
}

for (const relative of NEAR_LIMIT_BUDGETS.keys()) {
  if (!fs.existsSync(path.join(ROOT, relative))) {
    failures.push(`${relative}: reviewed near-limit budget points to a missing file; remove the budget entry.`);
  }
}

if (failures.length > 0) {
  console.error("File-size fitness check failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `File-size fitness check passed (${MAX_SOURCE_LINES} line hard cap, ${NEAR_LIMIT_LINES} line near-limit threshold, ${NEAR_LIMIT_BUDGETS.size} reviewed near-limit budgets).`
);
