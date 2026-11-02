/**
 * A DENY-TEST THAT CRASHES HAS NOT SAID WHETHER ITS REFUSALS HELD.
 *
 * Observed: `node scripts/deny-test-invitations.mjs` on Windows ended with a libuv assertion at exit
 * (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) and status 127 in the shell, after it had
 * printed its checks. The script exits 0, 1 or 2 by design; that status is none of them, and reading it as
 * either a gap or a setup error misreports the run. `scripts/run-deny-tests.mjs` reads each exit through
 * `scripts/lib/deny-test-verdict.cjs`, and this pins that function. The abort's own cause is fixed in the
 * scripts by `scripts/lib/exit-when-drained.cjs`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verdictOf, runExitCode } = require('../scripts/lib/deny-test-verdict.cjs');

describe('a deny-test exit is read for what it says', () => {
  it('reads 0, 1 and 2 as the verdicts the scripts choose', () => {
    expect(verdictOf(0, null).kind).toBe('held');
    expect(verdictOf(1, null).kind).toBe('gap');
    expect(verdictOf(2, null).kind).toBe('setup-error');
  });

  it('reads a Windows abort at exit, a shell 127 and a signal as crashed, keeping the raw code', () => {
    expect(verdictOf(3221226505, null)).toEqual({ kind: 'crashed', code: 3221226505, signal: null });
    expect(verdictOf(127, null)).toEqual({ kind: 'crashed', code: 127, signal: null });
    expect(verdictOf(null, 'SIGKILL')).toEqual({ kind: 'crashed', code: null, signal: 'SIGKILL' });
    expect(verdictOf(null, null).kind).toBe('crashed');
  });

  it('ends the run on a gap first, then a crash, then a setup error', () => {
    const v = (code: number) => verdictOf(code, null);
    expect(runExitCode([v(0), v(0)])).toBe(0);
    expect(runExitCode([v(0), v(127)])).toBe(3);
    expect(runExitCode([v(2), v(127)])).toBe(3);
    expect(runExitCode([v(1), v(127), v(2)])).toBe(1);
    expect(runExitCode([v(0), v(2)])).toBe(2);
  });
});
