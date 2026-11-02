/**
 * END A SCRIPT WITH AN EXIT CODE, WITHOUT `process.exit()` RACING ITS OPEN SOCKETS.
 *
 * On Windows, `process.exit()` called after any `fetch` aborts the process inside libuv
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`): undici's handles are still
 * closing when the exit tears the loop down. The process then ends with the abort's status
 * (-1073740791, shown as 127 by some shells) instead of the code the script chose, so a deny-test that held
 * every refusal reads as a crash, and one that found a gap loses its 1. Draining a response body first does
 * not avoid it; only not calling `process.exit()` does.
 *
 * So the code is set on `process.exitCode` and the loop is left to drain, which it does once the last
 * request's sockets are idle (idle keep-alive sockets do not hold it open). An unref'd timer is the
 * backstop: if something still holds the loop after `graceMs`, the script exits with its code anyway,
 * saying so, rather than hanging a run.
 */
function exitWhenDrained(code, { graceMs = 15000 } = {}) {
  process.exitCode = code;
  const backstop = setTimeout(() => {
    console.error(`(still running ${graceMs} ms after finishing; exiting with ${code})`);
    process.exit(code);
  }, graceMs);
  backstop.unref();
}

/** Destroy AWS SDK clients so their connection pools do not hold the loop open. Ignores a missing one. */
function destroyClients(...clients) {
  for (const c of clients) {
    try { c?.destroy?.(); } catch { /* already destroyed */ }
  }
}

module.exports = { exitWhenDrained, destroyClients };
