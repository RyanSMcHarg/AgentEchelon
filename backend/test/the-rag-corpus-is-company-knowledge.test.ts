/**
 * THE RAG CORPUS IS COMPANY KNOWLEDGE, KEPT IN THE COMPANY BUCKET.
 *
 * It sat under `rag/` in the Aurora-mode archive bucket, whose bucket-wide 90-day expiry deleted the seeded corpus.
 * The company bucket expires nothing, and DocumentIngestion follows the corpus there: its read, its notifications and
 * the bucket it accepts events from all name the company bucket, and nothing grants `rag/` in the archive.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';

type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

describe('the Aurora-mode RAG corpus', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'aurora');
  }, SYNTH_TIMEOUT_MS);

  const all = () => Object.entries(app.templates).flatMap(([stack, t]) =>
    Object.entries((t.Resources ?? {}) as Record<string, Resource>).map(([id, r]) => ({ stack, id, r })));

  it('is ingested from the company bucket and from nowhere else', () => {
    const ingestion = all().filter(({ r }) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Environment?.Variables?.CORPUS_BUCKET);
    expect(ingestion).toHaveLength(1);
    // A cross-stack reference to the Conversations stack's company bucket, never the archive bucket's name.
    expect(JSON.stringify(ingestion[0].r.Properties!.Environment.Variables.CORPUS_BUCKET)).toMatch(/CompanyBucket/);

    const notifications = all().filter(({ r }) => r.Type === 'Custom::S3BucketNotifications');
    const rag = notifications.filter(({ r }) => JSON.stringify(r.Properties?.NotificationConfiguration ?? {}).includes('"rag/"'));
    expect(rag).toHaveLength(1);
    expect(JSON.stringify(rag[0].r.Properties!.BucketName)).toMatch(/CompanyBucket/);
  });

  it('is granted on the company bucket, and nothing grants rag/ in an archive bucket', () => {
    const statements = all()
      .filter(({ r }) => r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy')
      .flatMap(({ r }) => [
        ...list(r.Properties?.Policies).flatMap((p: any) => list(p.PolicyDocument?.Statement)),
        ...list(r.Properties?.PolicyDocument?.Statement),
      ]) as Array<{ Resource?: unknown }>;
    const ragGrants = statements.map((s) => JSON.stringify(s.Resource ?? '')).filter((r) => r.includes('/rag/*'));
    expect(ragGrants.length).toBeGreaterThan(0);
    for (const g of ragGrants) {
      expect(g).not.toMatch(/archive/i);
      expect(g).toMatch(/CompanyBucket/);
    }
  });
});
