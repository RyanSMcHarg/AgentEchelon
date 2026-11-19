/**
 * A RELEASE IS PROVEN ONLY BY EVIDENCE ABOUT ITS OWN COMMIT (DESIGN-RELEASE-EVIDENCE section 9).
 *
 * The report's verdict (`scripts/lib/release-report.cjs`) is fed a complete, passing set of records, and then
 * each way a release has been mistaken for proven: a missing shard, a shard run against another commit, a
 * skipped smoke item, a deny script that crashed, a stack running other code, a dirty checkout. Each must read
 * `not-proven` and name the reason.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { releaseVerdict, configurationOf, applicable } = require('../scripts/lib/release-report.cjs');
const { SMOKE_ITEMS, DENY_SCRIPTS, GATES } = require('../scripts/lib/release-smoke.cjs');
/* eslint-enable @typescript-eslint/no-var-requires */

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const CONFIG = { analyticsMode: 'aurora', capabilities: ['chat', 'admin'], appUrl: 'https://d123.cloudfront.net', _comment: 'x' };
const configuration = configurationOf(CONFIG);
const green = { failed: 0, failedSuites: 0, success: true, skipped: 0 };

/** The built smoke items only: a test of the verdict's logic, independent of which specs exist today. */
const BUILT = SMOKE_ITEMS.filter((i: { pending?: string }) => !i.pending);

function proven(over: Record<string, unknown> = {}) {
  return {
    commit: COMMIT,
    dirty: false,
    configuration,
    shards: { declared: 2, found: [1, 2].map((shard) => ({ shard, counts: green, commit: COMMIT, dirty: false, shards: 2 })) },
    deployedCommits: { AgentEchelonIdentity: { commit: COMMIT }, AgentEchelonConversations: { commit: COMMIT } },
    smokeItems: BUILT,
    smoke: BUILT.map((i: { id: string }) => ({ id: i.id, commit: COMMIT, outcome: 'passed' })),
    denyScripts: DENY_SCRIPTS,
    deny: DENY_SCRIPTS.map((d: { name: string }) => ({ name: d.name, commit: COMMIT, kind: 'held' })),
    gates: GATES.map((g: { id: string }) => ({ id: g.id, commit: COMMIT, outcome: 'passed' })),
    gateIds: GATES.map((g: { id: string }) => g.id),
    otherReports: [{ analyticsMode: 'athena', verdict: 'proven' }],
    ...over,
  };
}

describe('the release verdict', () => {
  it('is proven when every record is about this commit and passed', () => {
    const v = releaseVerdict(proven());
    expect(v.reasons).toEqual([]);
    expect(v.verdict).toBe('proven');
    expect(v.release).toBe('proven');
  });

  it.each([
    ['a missing shard', { shards: { declared: 2, found: [{ shard: 1, counts: green, commit: COMMIT, shards: 2 }] } }, 'shard 2/2 has no report'],
    ['a shard run against another commit', { shards: { declared: 2, found: [1, 2].map((shard) => ({ shard, counts: green, commit: shard === 2 ? OTHER : COMMIT, shards: 2 })) } }, 'shard 2/2 ran against bbbbbbbb'],
    ['a shard with no commit stamp', { shards: { declared: 2, found: [1, 2].map((shard) => ({ shard, counts: green, commit: shard === 1 ? undefined : COMMIT, shards: 2 })) } }, 'shard 1/2 records no commit'],
    ['a filtered shard', { shards: { declared: 2, found: [1, 2].map((shard) => ({ shard, counts: green, commit: COMMIT, shards: 2, filtered: shard === 2 })) } }, 'shard 2/2 ran a filtered subset'],
    ['a failed suite', { shards: { declared: 2, found: [1, 2].map((shard) => ({ shard, counts: shard === 2 ? { ...green, failedSuites: 1 } : green, commit: COMMIT, shards: 2 })) } }, 'shard 2/2 records a failure'],
    ['a skipped smoke item', { smoke: BUILT.map((i: { id: string }) => ({ id: i.id, commit: COMMIT, outcome: i.id === 'sign-in' ? 'failed' : 'passed', exit: 1 })) }, 'smoke sign-in failed'],
    ['a smoke item that did not run', { smoke: [] }, 'smoke setup did not run against this commit'],
    ['a smoke item run against another commit', { smoke: BUILT.map((i: { id: string }) => ({ id: i.id, commit: OTHER, outcome: 'passed' })) }, 'smoke setup did not run against this commit'],
    ['a deny script that crashed', { deny: DENY_SCRIPTS.map((d: { name: string }) => ({ name: d.name, commit: COMMIT, kind: d.name === 'owner-team-tag' ? 'crashed' : 'held' })) }, 'deny owner-team-tag: crashed'],
    ['a deny script that did not run', { deny: [] }, 'deny admin-capabilities did not run against this commit'],
    ['a stack running other code', { deployedCommits: { AgentEchelonIdentity: { commit: OTHER } } }, 'stack AgentEchelonIdentity runs bbbbbbbb'],
    ['unreadable deployed-commit records', { deployedCommits: null }, 'could not be read'],
    ['a failed gate', { gates: GATES.map((g: { id: string }) => ({ id: g.id, commit: COMMIT, outcome: g.id === 'frontend-test' ? 'failed' : 'passed' })) }, 'gate frontend-test failed'],
    ['a dirty checkout', { dirty: true }, 'uncommitted changes'],
  ])('is not proven on %s', (_name, over, reason) => {
    const v = releaseVerdict(proven(over));
    expect(v.verdict).toBe('not-proven');
    expect(v.reasons.join('\n')).toContain(reason);
  });

  it('names an item the design calls for and nothing builds yet, rather than excusing it', () => {
    const owed = { id: 'owed-item', only: 'user', spec: 'owed-item', requires: ['chat'], pending: 'nothing drives it yet' };
    const v = releaseVerdict(proven({ smokeItems: [...SMOKE_ITEMS, owed] }));
    expect(v.verdict).toBe('not-proven');
    expect(v.reasons.join('\n')).toMatch(/smoke owed-item is NOT BUILT/);
  });

  it('keeps a release unproven until the other analytics mode has a proven report', () => {
    const v = releaseVerdict(proven({ otherReports: [] }));
    expect(v.verdict).toBe('proven');
    expect(v.release).toBe('not-proven');
    expect(v.releaseReasons).toEqual(['no proven report for athena mode at this commit']);
  });

  it('counts an item whose capability the configuration does not declare as not applicable, never as passed', () => {
    const chatOnly = configurationOf({ ...CONFIG, capabilities: ['chat'] });
    const v = releaseVerdict(proven({ configuration: chatOnly }));
    // The removal is given by a share and taken by the owner, both the notifications capability's routes.
    expect(v.smoke.notApplicable).toEqual(['removal', 'admin-console-role']);
    expect(v.deny.notApplicable).toEqual(['admin-capabilities', 'owner-team-tag']);
    expect(v.smoke.rows.map((r: { id: string }) => r.id)).not.toContain('admin-console-role');
  });
});

describe('the configuration key', () => {
  it('names what the deployment is, not where it is, so two deployments of one configuration share it', () => {
    const elsewhere = configurationOf({ ...CONFIG, appUrl: 'https://d999.cloudfront.net', testInboxBucket: 'other' });
    expect(elsewhere.key).toBe(configuration.key);
    expect(configuration.key).toMatch(/^aurora-[0-9a-f]{8}$/);
    expect(configurationOf({ ...CONFIG, capabilities: ['chat'] }).key).not.toBe(configuration.key);
  });

  it('selects an item by the capabilities it requires', () => {
    expect(applicable([{ requires: ['admin'] }, { requires: [] }], ['chat'])).toEqual([{ requires: [] }]);
  });
});
