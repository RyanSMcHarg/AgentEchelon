/**
 * A READER NEVER WRITES WHAT IT READS.
 *
 * Two places where a role that reads held a write over the whole store it reads:
 *  - Athena mode: every role that queries the archive (the evaluation runner, the admin analytics query, the admin
 *    conversation reader) held `s3:PutObject` on the whole conversation archive bucket, where it needs only Athena's
 *    results (and, for the runner, its own evaluation families). The conversation record is append-only.
 *  - The console's profile role held `ssm:PutParameter` on every key under `/assistant/*`, which includes what a deploy
 *    publishes there for the turn to read: the guardrail catalog, the context-source catalog, the pack pointer, the
 *    persona, the intake and the orientation.
 * Read from C7-custom's synthesized templates.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';
import { DEPLOY_OWNED_ASSISTANT_KEYS } from '../lib/stacks/agent-classification-common';

const DEPLOY_OWNED = Object.values(DEPLOY_OWNED_ASSISTANT_KEYS) as string[];
/** What the console writes at runtime under an assistant's own path, and the routing keys the registry aspect refuses to all. */
const RUNTIME_WRITTEN = new Set(['definition', 'draft', 'advertisement']);

type Resource = { Type: string; Properties?: Record<string, any> };
type Statement = { Effect?: string; Action?: unknown; Resource?: unknown };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Every statement attached to each role, inline or by a policy resource naming it. */
function statementsByRole(app: Synthesized): Array<{ role: string; statements: Statement[] }> {
  const out: Array<{ role: string; statements: Statement[] }> = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    const resources = (t.Resources ?? {}) as Record<string, Resource>;
    for (const [id, r] of Object.entries(resources)) {
      if (r.Type !== 'AWS::IAM::Role') continue;
      const inline = list(r.Properties?.Policies).flatMap((p: any) => list(p.PolicyDocument?.Statement)) as Statement[];
      const attached = Object.values(resources)
        .filter((p) => (p.Type === 'AWS::IAM::Policy') && JSON.stringify(p.Properties?.Roles ?? []).includes(`"${id}"`))
        .flatMap((p: any) => list(p.Properties.PolicyDocument.Statement)) as Statement[];
      out.push({ role: `${stack}/${id}`, statements: [...inline, ...attached] });
    }
  }
  return out;
}
const actions = (s: Statement) => list(s.Action).map(String);
const resources = (s: Statement) => list(s.Resource).map((r) => JSON.stringify(r));

describe('a reader never writes what it reads', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'athena');
  }, SYNTH_TIMEOUT_MS);

  it('a role that queries the archive writes only Athena results and its own evaluation families', () => {
    const allowed = /\/(athena-results|evaluations|agent-scores|delivered-documents)\/\*/;
    const queriers = statementsByRole(app).filter(({ statements }) =>
      statements.some((s) => actions(s).includes('athena:StartQueryExecution')));
    expect(queriers.length).toBeGreaterThanOrEqual(3);
    for (const { role, statements } of queriers) {
      for (const s of statements.filter((x) => x.Effect !== 'Deny' && actions(x).includes('s3:PutObject'))) {
        for (const r of resources(s).filter((x) => /conversation-archive|ConversationArchive/.test(x))) {
          expect({ role, resource: r, scoped: allowed.test(r) }).toEqual({ role, resource: r, scoped: true });
        }
      }
    }
  });

  it("the console's profile role writes an assistant's versions, draft and advertisement, and is refused the deploy's keys", () => {
    const [manage] = statementsByRole(app).filter(({ role }) => /ManageProfilesRole/.test(role));
    expect(manage).toBeDefined();
    const writes = manage.statements.filter((s) => s.Effect !== 'Deny' && actions(s).some((a) => /ssm:(PutParameter|LabelParameterVersion)/.test(a)));
    const written = writes.flatMap(resources).filter((x) => x.includes('/assistant/'));
    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const r of written) expect(r).toMatch(/\/assistant\/\*\/(definition|draft|advertisement)"|\/templates\//);
    const denied = manage.statements.filter((s) => s.Effect === 'Deny' && actions(s).includes('ssm:PutParameter')).flatMap(resources).join(' ');
    for (const key of DEPLOY_OWNED) expect(denied).toContain(`/assistant/*/${key}`);
  });

  it('every key a deploy publishes under /assistant/<classification>/ is one the console role is refused', () => {
    // Read from the parameters the stacks synthesize, so a key published by a new name is caught here rather than
    // left writable because nobody added it to the list.
    const published = new Set<string>();
    for (const t of Object.values(app.templates)) {
      for (const r of Object.values((t.Resources ?? {}) as Record<string, Resource>)) {
        if (r.Type !== 'AWS::SSM::Parameter') continue;
        const name = r.Properties?.Name;
        if (typeof name !== 'string') continue;
        const m = /\/assistant\/[^/]+\/([^/]+)$/.exec(name);
        if (m) published.add(m[1]);
      }
    }
    const unprotected = [...published].filter((k) => !k.endsWith('-arn') && !RUNTIME_WRITTEN.has(k) && !DEPLOY_OWNED.includes(k));
    expect(published.size).toBeGreaterThan(0);
    expect(unprotected).toEqual([]);
  });
});
