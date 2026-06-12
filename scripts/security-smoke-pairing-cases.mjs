export function createSecurityPairingCases({
  check,
  connect,
  disallowedOrigin,
  host,
  origin,
  port,
  request,
  token
}) {
  async function checkPairingBoundaries() {
    const noOriginSocket = await connect(host, port, `${host}:${port}`);
    const noOriginPair = await request(noOriginSocket, "pair", { pairingToken: token }, false).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(noOriginPair.code === "origin_required", "pairing without a WebSocket Origin header is rejected");
    noOriginSocket.socket?.destroy();

    const lockSocket = await connect(host, port, `${host}:${port}`, origin);
    const r1 = await pairAttempt(lockSocket, origin, request, "wrong-1");
    const r2 = await pairAttempt(lockSocket, origin, request, "wrong-2");
    const r3 = await pairAttempt(lockSocket, origin, request, "wrong-3");
    check(r1.code === "pairing_denied", "1st wrong token -> pairing_denied");
    check(r2.code === "pairing_denied", "2nd wrong token -> pairing_denied");
    check(r3.code === "pairing_denied" || r3.closed === true, "3rd wrong token -> denied then connection closed");
    const r4 = await pairAttempt(lockSocket, origin, request, token);
    check(r4.closed === true || r4.code === "pairing_locked", "after lockout the correct token cannot pair on that connection");
    lockSocket.socket?.destroy();

    const mismatchSocket = await connect(host, port, `${host}:${port}`, origin);
    const originMismatch = await request(
      mismatchSocket,
      "pair",
      { origin: disallowedOrigin, pairingToken: token },
      false
    ).then(
      () => ({ ok: true }),
      (error) => ({ code: error.code })
    );
    check(originMismatch.code === "origin_mismatch", "pair rejects origins that do not match the WebSocket Origin header");
    mismatchSocket.socket?.destroy();
  }

  return {
    checkPairingBoundaries
  };
}

async function pairAttempt(ctx, origin, request, token) {
  if (ctx.closed) return { closed: true };
  try {
    await request(ctx, "pair", { origin, pairingToken: token }, false);
    return { ok: true };
  } catch (error) {
    if (error.code === "closed" || error.code === "timeout") return { closed: true };
    return { code: error.code };
  }
}
