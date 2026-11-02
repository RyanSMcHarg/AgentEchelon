/**
 * WHAT A DENY-TEST'S EXIT SAYS, AND WHAT IT DOES NOT.
 *
 * Every deny-test exits 0 when every refusal and control held, 1 when one did not (a gap), and 2 when it
 * could not set up. Anything else is not a verdict: a crash at exit (Windows reports a libuv abort as
 * 3221226505, a shell as 127), a signal, or an exit code the script never chooses. Filing that as a gap
 * or a setup error would misreport it, and filing it as neither would hide it, so it is its own kind:
 * `crashed`, with the raw code, and the run's verdict is unknown.
 */
const KINDS = { 0: 'held', 1: 'gap', 2: 'setup-error' };

/** The verdict for one script's exit: `{ kind, code, signal }`, where `kind` is held | gap | setup-error | crashed. */
function verdictOf(code, signal) {
  if (signal) return { kind: 'crashed', code, signal };
  const kind = Object.prototype.hasOwnProperty.call(KINDS, code) ? KINDS[code] : 'crashed';
  return { kind, code, signal: null };
}

/**
 * The runner's own exit for a set of verdicts: 1 when any gap was found (a real finding outranks
 * everything), else 3 when any script crashed (its verdict is unknown), else 2 for a setup error, else 0.
 */
function runExitCode(verdicts) {
  if (verdicts.some((v) => v.kind === 'gap')) return 1;
  if (verdicts.some((v) => v.kind === 'crashed')) return 3;
  if (verdicts.some((v) => v.kind === 'setup-error')) return 2;
  return 0;
}

module.exports = { verdictOf, runExitCode };
