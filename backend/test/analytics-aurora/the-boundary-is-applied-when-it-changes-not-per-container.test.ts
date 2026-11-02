/**
 * THE CLASSIFICATION BOUNDARY IS RE-APPLIED WHEN IT CHANGES, NOT ONCE PER WARM CONTAINER.
 *
 * WHY THIS EXISTS. `ensureSchema()` ran all 52 generated boundary statements on every cold start,
 * and that is ~900 ms measured on the development deployment. It is not background work: `ensureSchema`
 * is on the cold path of every Lambda that touches a bounded table, including the data plane that live
 * drift calls, which runs in front of the placeholder. A person's time to first feedback included the
 * platform re-asserting a boundary that had not changed since the last deploy. Measured 2026-09-17: a
 * turn whose data plane was cold spent 3.2 s where the same turn warm spends ~600 ms.
 *
 * WHY IT IS NOT SIMPLY RECORDED LIKE A MIGRATION. The statements are GENERATED from the classification
 * ladder in deployment config, so unlike a fixed `schema/*.sql` file their content legitimately changes
 * between deploys. A filename-only record would never re-apply. So the record carries a checksum of the
 * generated set, and a changed ladder re-applies by construction.
 *
 * AND WHY IT STILL RE-ASSERTS ON A BOUND. This is a security boundary (ADR-028, tenet P4). A checksum
 * proves what this deployment last WROTE, not what the database currently HAS: a grant revoked out of
 * band would stand until the next deploy. The bound makes the repair periodic instead of per-container.
 * That is a change in how often the 900 ms is paid, not in whether the boundary is established.
 *
 * The decision is a pure function so this test is about the rule rather than about a log line.
 */
import { boundaryNeedsApplying } from '../../lambda/src/analytics-aurora/db-client';

const SUM = 'abc123';
const NOW = Date.parse('2026-09-17T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000);

describe('when the boundary must be applied', () => {
  it('applies on a first run, when nothing has been recorded', () => {
    expect(boundaryNeedsApplying(null, SUM, NOW)).toEqual({ apply: true, why: 'first run' });
    expect(boundaryNeedsApplying(undefined, SUM, NOW).apply).toBe(true);
  });

  it('applies when the generated definition changed, which is what a new classification does', () => {
    const prior = { checksum: 'an-older-ladder', applied_at: hoursAgo(1) };
    expect(boundaryNeedsApplying(prior, SUM, NOW)).toEqual({ apply: true, why: 'definition changed' });
  });

  it('does NOT apply when it is unchanged and recent: this is the ~900 ms that stops being paid', () => {
    const prior = { checksum: SUM, applied_at: hoursAgo(1) };
    expect(boundaryNeedsApplying(prior, SUM, NOW)).toEqual({ apply: false, why: 'unchanged' });
  });

  it('applies again once the re-assert bound has elapsed, so an out-of-band change is repaired', () => {
    const prior = { checksum: SUM, applied_at: hoursAgo(13) };
    expect(boundaryNeedsApplying(prior, SUM, NOW))
      .toEqual({ apply: true, why: 're-assert bound reached' });
  });

  it('treats a record with no timestamp as stale rather than fresh', () => {
    // The fail direction for a security boundary is to re-assert it. A row that cannot be shown to be
    // recent must not be trusted into skipping.
    expect(boundaryNeedsApplying({ checksum: SUM, applied_at: null }, SUM, NOW).apply).toBe(true);
    expect(boundaryNeedsApplying({ checksum: SUM, applied_at: 'not a date' }, SUM, NOW).apply).toBe(true);
  });

  it('accepts a timestamp as a string, which is what the driver may hand back', () => {
    const prior = { checksum: SUM, applied_at: hoursAgo(1).toISOString() };
    expect(boundaryNeedsApplying(prior, SUM, NOW).apply).toBe(false);
  });

  it('is decided by the bound it is given, not by a wall clock the test cannot control', () => {
    const prior = { checksum: SUM, applied_at: hoursAgo(2) };
    expect(boundaryNeedsApplying(prior, SUM, NOW, 60 * 60 * 1000).apply).toBe(true);
    expect(boundaryNeedsApplying(prior, SUM, NOW, 24 * 60 * 60 * 1000).apply).toBe(false);
  });
});

describe('the record cannot collide with a real migration', () => {
  it('keys itself on something that can never be a schema filename', () => {
    // `ensureSchema` builds its applied-set from the same table and compares it against `schema/*.sql`
    // names. A key that cannot be a filename can never make a real migration look already applied.
    const src: string = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/analytics-aurora/db-client.ts'), 'utf8',
    );
    const key = /const BOUNDARY_MIGRATION_KEY = '([^']+)'/.exec(src)?.[1];
    expect(key).toBeTruthy();
    expect(key!.endsWith('.sql')).toBe(false);
    expect(key).toContain('__');
  });
});
