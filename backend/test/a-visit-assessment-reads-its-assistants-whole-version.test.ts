/**
 * A VISIT ASSESSMENT READS ITS ASSISTANT'S WHOLE VERSION.
 *
 * The visitors' conversation creator asks the visitor's assistant's model to assess a visit when it carries over.
 * It resolves that assistant's active version, and a version whose persona or pack it cannot read is refused rather
 * than served as the seed, so the creator holds the body store's location and the read of `profiles/*`. Read from
 * C7-custom's synthesized templates, which configure a guest issuer.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';

type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

describe('the visitors\' conversation creator reads profile bodies', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'athena');
  }, SYNTH_TIMEOUT_MS);

  it('names the body store and may read profiles/* where it assesses visits', () => {
    const found: string[] = [];
    for (const [stack, t] of Object.entries(app.templates)) {
      const resources = (t.Resources ?? {}) as Record<string, Resource>;
      for (const [id, r] of Object.entries(resources)) {
        const env = r.Type === 'AWS::Lambda::Function' ? r.Properties?.Environment?.Variables ?? {} : {};
        // The visitors' creator is the one creator that names the account, for the visitor's assistant's model.
        if (!env.CREATOR_CLASSIFICATION || !env.AWS_ACCOUNT_ID) continue;
        found.push(`${stack}/${id}`);
        expect(env.PROFILE_BODY_BUCKET).toBeDefined();
        const roleId = (r.Properties?.Role?.['Fn::GetAtt'] as string[])[0];
        const role = resources[roleId];
        const statements = [
          ...list(role.Properties?.Policies).flatMap((p: any) => list(p.PolicyDocument?.Statement)),
          ...Object.values(resources)
            .filter((p) => p.Type === 'AWS::IAM::Policy' && JSON.stringify(p.Properties?.Roles).includes(roleId))
            .flatMap((p: any) => list(p.Properties.PolicyDocument.Statement)),
        ] as Array<{ Action: unknown; Resource: unknown }>;
        const reads = statements.filter((s) => list(s.Action).includes('s3:GetObject') && JSON.stringify(s.Resource).includes('/profiles/*'));
        expect(reads).not.toHaveLength(0);
      }
    }
    expect(found).toHaveLength(1);
  });
});
