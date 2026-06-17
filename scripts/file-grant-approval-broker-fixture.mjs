const mode = process.argv[2] ?? "ok";
const approvedPath = process.argv[3] ?? process.cwd();

if (mode === "bad-ready") {
  process.stdout.write(`${JSON.stringify({ ok: false, ready: true })}\n`);
} else if (mode === "malformed-ready") {
  process.stdout.write("{not-json\n");
} else if (mode === "ready-timeout") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, ready: true })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    const message = JSON.parse(line);
    if (message.command === "requestFileGrant") {
      if (mode === "request-timeout") {
        continue;
      }
      if (mode === "request-error") {
        process.stdout.write(`${JSON.stringify({ error: "fixture_file_grant_denied" })}\n`);
        continue;
      }
      if (mode === "request-path-error") {
        process.stdout.write(`${JSON.stringify({ error: "denied while opening /tmp/private-license.lic" })}\n`);
        continue;
      }
      if (mode === "missing-path") {
        process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
        continue;
      }
      if (mode === "malformed-request") {
        process.stdout.write("{not-json\n");
        continue;
      }
      if (mode === "oversized-request") {
        process.stdout.write(`${"x".repeat(4096)}\n`);
        continue;
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          path: approvedPath,
          displayName: mode === "control-display-name" ? "Approved\u0000 Fixture\n\t" : "Approved Fixture"
        })}\n`
      );
    } else if (message.command === "quit") {
      process.exit(0);
    } else {
      process.stdout.write(`${JSON.stringify({ error: "unknown_command" })}\n`);
    }
  }
});
