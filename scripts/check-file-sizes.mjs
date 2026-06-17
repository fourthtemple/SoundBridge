import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_LINE_EXCLUSIVE_CAP = 800;
const MAX_ALLOWED_SOURCE_LINES = SOURCE_LINE_EXCLUSIVE_CAP - 1;
const NEAR_LIMIT_LINES = 750;

const NEAR_LIMIT_BUDGETS = new Map([]);

const CHECKED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mm",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
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

function checkedFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        files.push(...checkedFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name))) {
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
for (const file of checkedFiles(ROOT)) {
  const relative = repoRelative(file);
  const lines = lineCount(file);
  const nearLimitBudget = NEAR_LIMIT_BUDGETS.get(relative);
  if (nearLimitBudget != null) {
    if (nearLimitBudget >= SOURCE_LINE_EXCLUSIVE_CAP) {
      failures.push(
        `${relative}: near-limit budget ${nearLimitBudget} must be at most ${MAX_ALLOWED_SOURCE_LINES} lines.`
      );
    }
    if (lines > nearLimitBudget) {
      failures.push(`${relative}: ${lines} lines exceeds reviewed near-limit budget ${nearLimitBudget}; split it or reduce it.`);
    }
    if (lines < NEAR_LIMIT_LINES) {
      failures.push(`${relative}: ${lines} lines is below near-limit threshold ${NEAR_LIMIT_LINES}; remove its reviewed budget.`);
    }
    continue;
  }
  if (lines >= SOURCE_LINE_EXCLUSIVE_CAP) {
    failures.push(
      `${relative}: ${lines} lines exceeds the ${MAX_ALLOWED_SOURCE_LINES}-line maximum; split the file before adding more behavior.`
    );
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
  `File-size fitness check passed (${MAX_ALLOWED_SOURCE_LINES} line maximum, ${NEAR_LIMIT_LINES} line near-limit threshold, ${NEAR_LIMIT_BUDGETS.size} reviewed near-limit budgets).`
);
