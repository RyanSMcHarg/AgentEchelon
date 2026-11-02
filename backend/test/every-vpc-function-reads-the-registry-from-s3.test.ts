/**
 * EVERY FUNCTION IN THE ANALYTICS VPC READS THE REGISTRY'S S3 COPY, AND THE VPC HAS NO SSM ENDPOINT.
 *
 * The analytics VPC is NAT-free: it reaches S3 and DynamoDB through free gateway endpoints and nothing else of SSM.
 * A function in it that loaded the registry from SSM (`loadProfileRegistry`) would wait on a read that never
 * connects and time out before its first line. So the stack that publishes a row's parameter also writes the same
 * value to the registry bucket (`publishRegistryRow`), and every VPC-attached function is told that copy and may
 * read it (`ProfileRegistryReaders`). Read from C7-custom's synthesized templates in Aurora mode, through the real
 * CDK app:
 *
 *   - every VPC-attached function carries `PROFILE_REGISTRY_S3_ENV` naming the registry prefix, and its role the
 *     stack's S3 read (`s3:ListBucket` on the prefix, `s3:GetObject` on its objects); no other function carries it;
 *   - every published row has its S3 copy, the same value at `registry/classification/<value>`, written and
 *     deleted by its own stack, and `Identity` creates the bucket;
 *   - the archive builds no SSM interface endpoint.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';
import { PROFILE_REGISTRY_S3_ENV, REGISTRY_S3_PREFIX } from '../lib/config/profiles';
import { REGISTRY_S3_READ_POLICY_ID } from '../lib/constructs/profile-registry-readers';

type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
/** A CloudFormation string as text, every token in it written as `<token>`. */
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  const join = (v as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
  if (join) return join[1].map((p) => (typeof p === 'string' ? p : '<token>')).join(join[0]);
  return '<token>';
};

describe('every VPC-attached function reads the registry from S3', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'aurora');
  }, SYNTH_TIMEOUT_MS);

  const stacks = () => Object.entries(app.templates).map(([stack, t]) => ({ stack, resources: (t.Resources ?? {}) as Record<string, Resource> }));
  const functions = () => stacks().flatMap(({ stack, resources }) => Object.entries(resources)
    .filter(([, r]) => r.Type === 'AWS::Lambda::Function')
    .map(([id, r]) => ({ stack, id, r, resources, inVpc: !!r.Properties?.VpcConfig })));

  it('tells every VPC-attached function the S3 copy, and no other function', () => {
    const inVpc = functions().filter((f) => f.inVpc);
    // The archive's handlers, the admin analytics query, and each classification's turn data plane.
    const stackNames = [...new Set(inVpc.map((f) => f.stack))];
    expect(inVpc.length).toBeGreaterThan(10);
    expect(stackNames).toContain('Archive');
    expect(stackNames.some((s) => /^AdminServices/.test(s))).toBe(true);
    expect(stackNames.some((s) => /^Assistants-/.test(s))).toBe(true);
    const missing: string[] = [];
    for (const f of inVpc) {
      const location = text(f.r.Properties?.Environment?.Variables?.[PROFILE_REGISTRY_S3_ENV]);
      if (!new RegExp(`^s3://[^/]*-registry-[^/]+/${REGISTRY_S3_PREFIX}/$`).test(location)) missing.push(`${f.stack}/${f.id}: ${location}`);
    }
    expect(missing).toEqual([]);
    const outside = functions().filter((f) => !f.inVpc && f.r.Properties?.Environment?.Variables?.[PROFILE_REGISTRY_S3_ENV]);
    expect(outside.map((f) => `${f.stack}/${f.id}`)).toEqual([]);
  });

  it('attaches the S3 read to the role of every VPC-attached function', () => {
    const missing: string[] = [];
    for (const f of functions().filter((x) => x.inVpc)) {
      const roleId = (f.r.Properties?.Role?.['Fn::GetAtt'] as string[] | undefined)?.[0];
      const role = roleId ? f.resources[roleId] : undefined;
      const policyId = Object.keys(f.resources).find((id) => id.startsWith(REGISTRY_S3_READ_POLICY_ID) && f.resources[id].Type === 'AWS::IAM::ManagedPolicy');
      if (!role || !policyId || !list(role.Properties?.ManagedPolicyArns).some((a) => JSON.stringify(a).includes(`"${policyId}"`))) {
        missing.push(`${f.stack}/${f.id}`);
      }
      // The copy's read is one more managed policy on the role, inside the IAM limit of ten.
      if (role && list(role.Properties?.ManagedPolicyArns).length > 10) missing.push(`${f.stack}/${f.id}: more than ten managed policies`);
    }
    expect(missing).toEqual([]);
    const { resources } = stacks().find((s) => s.stack === 'Archive')!;
    const policy = Object.entries(resources).find(([id]) => id.startsWith(REGISTRY_S3_READ_POLICY_ID))![1];
    const statements = policy.Properties?.PolicyDocument?.Statement as Array<Record<string, any>>;
    const listing = statements.find((s) => list(s.Action).includes('s3:ListBucket'))!;
    expect(listing.Condition).toEqual({ StringLike: { 's3:prefix': [`${REGISTRY_S3_PREFIX}/*`] } });
    const read = statements.find((s) => list(s.Action).includes('s3:GetObject'))!;
    expect(text(read.Resource)).toMatch(new RegExp(`-registry-.*/${REGISTRY_S3_PREFIX}/\\*$`));
    for (const s of statements) expect(list(s.Action).filter((a) => !/^s3:(ListBucket|GetObject)$/.test(String(a)))).toEqual([]);
  });

  it('writes every published row to S3 with the same value, from the stack that publishes it', () => {
    let rows = 0;
    for (const { stack, resources } of stacks()) {
      const params = Object.values(resources).filter((r) => r.Type === 'AWS::SSM::Parameter'
        && /\/registry\/classification\/[^/]+$/.test(text(r.Properties?.Name)));
      const copies = Object.values(resources).filter((r) => r.Type === 'Custom::AWS' && /"putObject"/.test(text(r.Properties?.Create)));
      for (const p of params) {
        rows++;
        const value = text(p.Properties?.Name).split('/').pop()!;
        const copy = copies.map((c) => ({ create: JSON.parse(text(c.Properties?.Create)), del: JSON.parse(text(c.Properties?.Delete)) }))
          .find((c) => c.create.parameters.Key === `${REGISTRY_S3_PREFIX}/${value}`);
        expect({ stack, value, copied: !!copy }).toEqual({ stack, value, copied: true });
        expect(copy!.create.parameters.Body).toBe(p.Properties?.Value);
        expect(copy!.create.parameters.Bucket).toMatch(/-registry-/);
        expect(copy!.del).toMatchObject({ action: 'deleteObject', parameters: { Key: `${REGISTRY_S3_PREFIX}/${value}` } });
      }
    }
    expect(rows).toBeGreaterThan(2);
    const identity = stacks().find((s) => s.stack === 'Identity')!.resources;
    const buckets = Object.values(identity).filter((r) => r.Type === 'AWS::S3::Bucket' && /-registry-/.test(text(r.Properties?.BucketName)));
    expect(buckets).toHaveLength(1);
  });

  it('builds no SSM interface endpoint in the analytics VPC', () => {
    const endpoints = Object.values(stacks().find((s) => s.stack === 'Archive')!.resources).filter((r) => r.Type === 'AWS::EC2::VPCEndpoint');
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.filter((e) => /\.ssm"?$|\.ssm\b/.test(JSON.stringify(e.Properties?.ServiceName)))).toEqual([]);
  });
});
