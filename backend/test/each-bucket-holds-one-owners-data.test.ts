/**
 * EACH BUCKET HOLDS ONE OWNER'S DATA.
 *
 * The attachments bucket holds what conversations produce: members' uploads, assistants' deliverables and generated
 * images. The company bucket holds the company corpus (`context/`) and the platform's self-knowledge
 * (`platform-knowledge/`). The profile bucket holds what an assistant is: profile bodies (`profiles/`), intent packs
 * (`classification-packs/`), templates (`templates/`) and the golden-set entries that evaluate it (`golden-uploads/`). A lifecycle rule or a grant written for one owner's data
 * therefore cannot reach another's.
 *
 * Read from C7-custom's synthesized templates (Battle Mode, experiments, a guest issuer, a host's context
 * issuer), so every stack that touches a bucket is present.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';

type Resource = { Type: string; Properties?: Record<string, any> };
type Statement = { Effect: string; Action: unknown; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const MOVED = /(^|\/)(profiles|templates|classification-packs|golden-uploads|context|platform-knowledge)\//;

describe('each bucket holds one owner\'s data', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'athena');
  }, SYNTH_TIMEOUT_MS);

  /** Every Allow statement in every template, with the stack and the logical id it came from. */
  const statements = (): Array<{ where: string; s: Statement }> => {
    const out: Array<{ where: string; s: Statement }> = [];
    for (const [stack, t] of Object.entries(app.templates)) {
      for (const [id, r] of Object.entries((t.Resources ?? {}) as Record<string, Resource>)) {
        const docs = r.Type === 'AWS::IAM::Role'
          ? list(r.Properties?.Policies).map((p: any) => p.PolicyDocument)
          : ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(r.Type) ? [r.Properties?.PolicyDocument] : [];
        for (const d of docs) for (const s of list(d?.Statement) as Statement[]) if (s.Effect === 'Allow') out.push({ where: `${stack}/${id}`, s });
      }
    }
    return out;
  };

  it('grants nothing on the attachments bucket under a company or profile key family', () => {
    const offenders: string[] = [];
    for (const { where, s } of statements()) {
      for (const r of list(s.Resource)) {
        const text = JSON.stringify(r);
        if (text.includes('AttachmentsBucket') && MOVED.test(text.replace(/"/g, ''))) offenders.push(`${where}: ${text}`);
      }
      const prefixes = list(s.Condition?.StringLike?.['s3:prefix']).map((p) => JSON.stringify(p));
      if (list(s.Resource).some((r) => JSON.stringify(r).includes('AttachmentsBucket')) && prefixes.some((p) => MOVED.test(p.replace(/"/g, '')))) {
        offenders.push(`${where}: lists ${prefixes.join(', ')} on the attachments bucket`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads profile bodies, packs and templates from the profile bucket, and company context from the company bucket', () => {
    const named = (bucket: string, family: string) => statements().some(({ s }) =>
      list(s.Resource).some((r) => { const t = JSON.stringify(r); return t.includes(bucket) && t.includes(`/${family}/`); }));
    for (const family of ['profiles', 'classification-packs', 'templates', 'golden-uploads']) expect({ family, profile: named('ProfileBucket', family) }).toEqual({ family, profile: true });
    for (const family of ['context', 'platform-knowledge']) expect({ family, company: named('CompanyBucket', family) }).toEqual({ family, company: true });
  });

  it('gives the presigner nothing on the company or profile bucket', () => {
    const conversations = Object.entries(app.templates).find(([name]) => /Conversations$/.test(name));
    expect(conversations).toBeDefined();
    const resources = (conversations![1].Resources ?? {}) as Record<string, Resource>;
    const fnId = Object.keys(resources).find((id) => id.startsWith('PresignedUrlFunction') && resources[id].Type === 'AWS::Lambda::Function');
    expect(fnId).toBeDefined();
    const roleId = (resources[fnId!].Properties?.Role?.['Fn::GetAtt'] as string[])[0];
    const grants = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties?.Roles).includes(roleId))
      .flatMap((r) => list(r.Properties?.PolicyDocument?.Statement));
    expect(grants.length).toBeGreaterThan(0);
    const text = JSON.stringify(grants);
    expect(text).toContain('AttachmentsBucket');
    expect(text).not.toContain('CompanyBucket');
    expect(text).not.toContain('ProfileBucket');
  });
});
