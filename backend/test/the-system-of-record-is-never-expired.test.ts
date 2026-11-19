/**
 * THE SYSTEM OF RECORD IS NEVER EXPIRED (tenet D7), AND EVERY OTHER FAMILY IN ITS BUCKET EXPIRES BY NAME (tenet D15).
 *
 * The conversation archive is append-only and survives the conversation; in both modes it shipped with a bucket-wide
 * 90-day expiry, which made it a 90-day window. Read from the synthesized templates of both modes, so a rule written in
 * a stack or a construct is seen the same way.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';

type Rule = { Id?: string; Prefix?: string; ExpirationInDays?: number; Status?: string };
const RECORD = ['conversations/', 'evaluations/'];

function archiveRules(app: Synthesized): Map<string, Rule[]> {
  const out = new Map<string, Rule[]>();
  for (const t of Object.values(app.templates)) {
    for (const [id, r] of Object.entries((t.Resources ?? {}) as Record<string, { Type: string; Properties?: any }>)) {
      if (r.Type !== 'AWS::S3::Bucket') continue;
      const name = JSON.stringify(r.Properties?.BucketName ?? '');
      if (!/conversation-archive|aurora-archive/.test(name)) continue;
      out.set(id, (r.Properties?.LifecycleConfiguration?.Rules ?? []) as Rule[]);
    }
  }
  return out;
}

describe.each(['athena', 'aurora'] as const)('the %s-mode archive', (mode) => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), mode);
  }, SYNTH_TIMEOUT_MS);

  it('expires nothing in the system of record, and names the prefix of every rule that expires', () => {
    const buckets = archiveRules(app);
    expect(buckets.size).toBeGreaterThan(0);
    for (const [bucket, rules] of buckets) {
      for (const rule of rules.filter((r) => r.ExpirationInDays !== undefined)) {
        expect({ bucket, rule: rule.Id, prefix: rule.Prefix ?? '(whole bucket)' })
          .toEqual({ bucket, rule: rule.Id, prefix: expect.stringMatching(/^[a-z_-]+\//) });
        expect(RECORD.some((p) => (rule.Prefix ?? '').startsWith(p))).toBe(false);
      }
    }
  });
});
