/**
 * WHAT A DEMO RESET TOUCHES, decided from data alone so it can be tested without AWS.
 *
 * A demo creates assistants in the console and conversations as the demo cast. A reset returns the
 * deployment to the state the demo started from: the assistants the console created during the demo are
 * retired, and the demo cast's conversations from the same window are deleted. Everything the deployment
 * declares stays exactly as the deploy made it.
 *
 * Only console-created assistants are selected. A declared assistant comes from `deploy.config.json`, and
 * retiring one is a tombstone its next deploy respects, so a reset never touches it. A duel's alt belongs to
 * its experiment and is removed with it.
 */

/** Statuses an assistant can be retired from. A retired one is already a tombstone. */
const RETIRABLE_STATUS = new Set(['active', 'provisioning', 'failed']);

/**
 * The assistants a reset retires: created in the console at or after `since`, not an experiment's alt, and
 * not already retired. `directory` is the assistant directory as `[name, entry]` pairs.
 */
function assistantsToRetire(directory, since) {
  const from = since.getTime();
  return directory
    .filter(([, e]) => (e.origin ?? 'console') === 'console')
    .filter(([, e]) => e.occupancy !== 'alt')
    .filter(([, e]) => RETIRABLE_STATUS.has(e.status))
    .filter(([, e]) => {
      const at = Date.parse(e.createdAt ?? '');
      return Number.isFinite(at) && at >= from;
    })
    .map(([name, e]) => ({ name, classification: e.classification, status: e.status, createdAt: e.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The options a reset runs with. `--since` is required, so a reset always names its window. */
function parseResetArgs(argv) {
  const value = (flag) => argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  const sinceArg = value('since');
  if (!sinceArg) throw new Error('Name the demo window: --since=<ISO time>, for example --since=2026-10-27T09:00:00Z.');
  const since = new Date(sinceArg);
  if (Number.isNaN(since.getTime())) throw new Error(`--since is not a time: ${sinceArg}`);
  return {
    since,
    apply: argv.includes('--apply'),
    assistants: !argv.includes('--skip-assistants'),
    conversations: !argv.includes('--skip-conversations'),
    secret: value('secret') || 'agent-interface/demo-credentials',
    reason: value('reason') || `Demo reset: assistants created since ${since.toISOString()}`,
  };
}

module.exports = { assistantsToRetire, parseResetArgs, RETIRABLE_STATUS };
