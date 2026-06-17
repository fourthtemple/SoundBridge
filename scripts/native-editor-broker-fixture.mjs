const mode = process.argv[2] ?? "ok";
const expectedPath = process.argv[3];

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
    if (message.command === "openEditor") {
      if (mode === "open-timeout") {
        continue;
      }
      if (mode === "open-error") {
        process.stdout.write(`${JSON.stringify({ error: "fixture_open_failed" })}\n`);
        continue;
      }
      if (mode === "malformed-open") {
        process.stdout.write("{not-json\n");
        continue;
      }
      if (mode === "oversized-open") {
        process.stdout.write(`${"x".repeat(4096)}\n`);
        continue;
      }
      if (mode === "bad-open-ok") {
        process.stdout.write(`${JSON.stringify({ ok: false, brokerSessionId: `fixture-${message.editorId}` })}\n`);
        continue;
      }
      if (mode === "missing-session-id") {
        process.stdout.write(`${JSON.stringify({ ok: true, capabilities: { nativeWindow: true } })}\n`);
        continue;
      }
      if (mode === "oversized-session-id") {
        process.stdout.write(`${JSON.stringify({ ok: true, brokerSessionId: "x".repeat(81) })}\n`);
        continue;
      }
      if (mode === "require-default-policy" && !matchesPolicy(message.capabilityPolicy, false)) {
        process.stdout.write(`${JSON.stringify({ error: "bad_capability_policy" })}\n`);
        continue;
      }
      if (mode === "require-allowed-policy" && !matchesPolicy(message.capabilityPolicy, true)) {
        process.stdout.write(`${JSON.stringify({ error: "bad_capability_policy" })}\n`);
        continue;
      }
      if (mode === "require-file-grants") {
        const grant = Array.isArray(message.fileGrants) ? message.fileGrants[0] : undefined;
        if (
          !grant ||
          grant.absolutePath !== expectedPath ||
          grant.grantId !== "filegrant-00000000-0000-4000-8000-000000000001" ||
          grant.purpose !== "sample" ||
          grant.access !== "read" ||
          grant.kind !== "file"
        ) {
          process.stdout.write(`${JSON.stringify({ error: "missing_file_grants" })}\n`);
          continue;
        }
      }
      if (mode === "require-any-file-grant") {
        const grant = Array.isArray(message.fileGrants) ? message.fileGrants[0] : undefined;
        if (
          !grant ||
          grant.absolutePath !== expectedPath ||
          !/^filegrant-[0-9a-f-]{36}$/.test(grant.grantId) ||
          grant.purpose !== "sample" ||
          grant.access !== "read" ||
          grant.kind !== "file"
        ) {
          process.stdout.write(`${JSON.stringify({ error: "missing_file_grants" })}\n`);
          continue;
        }
      }
      if (mode === "require-vst3-native-host") {
        const nativeHost = message.nativeHost;
        if (
          !nativeHost ||
          nativeHost.format !== "vst3" ||
          nativeHost.renderEngine !== "native-vst3" ||
          nativeHost.bundlePath !== expectedPath ||
          Object.hasOwn(nativeHost, "extraLaunchSecret")
        ) {
          process.stdout.write(`${JSON.stringify({ error: "bad_vst3_native_host" })}\n`);
          continue;
        }
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          brokerSessionId: `fixture-${message.editorId}`,
          capabilities: {
            nativeWindow: true,
            parameterEditing: false,
            fileDialogs: mode === "privileged-capabilities",
            clipboard: mode === "privileged-capabilities",
            dragAndDrop: mode === "privileged-capabilities"
          }
        })}\n`
      );
    } else if (message.command === "closeEditor") {
      process.stdout.write(`${JSON.stringify({ ok: true, closed: true })}\n`);
    } else if (message.command === "quit") {
      process.exit(0);
    } else {
      process.stdout.write(`${JSON.stringify({ error: "unknown_command" })}\n`);
    }
  }
});

function matchesPolicy(policy, expected) {
  return policy &&
    policy.fileDialogs === expected &&
    policy.clipboard === expected &&
    policy.dragAndDrop === expected;
}
