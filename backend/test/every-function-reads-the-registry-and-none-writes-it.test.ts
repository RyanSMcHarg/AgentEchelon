/**
 * EVERY FUNCTION READS THE RUNTIME REGISTRY, AND NO ROLE THE APP BUILDS WRITES IT (the classification-independence
 * plan, step 5).
 *
 * Read from C7-custom's synthesized templates (Battle Mode, experiments, a guest issuer, a host's one-conversation
 * issuer, and the admin backend), through the real CDK app:
 *
 *   - every Lambda function is told the registry's path (`PROFILE_REGISTRY_PATH_ENV`), and its role carries the
 *     stack's registry read (`ssm:GetParametersByPath` on the path, `ssm:GetParameter` on its rows), so the read a
 *     handler makes at cold start is allowed; a permissions boundary on that role allows the same read;
 *   - every role the app builds carries the stack's denial of every write on the path, so only the deploy that
 *     publishes a row changes it;
 *   - no Lambda environment names the deployment's set, and no grant names the registry path for anything but that
 *     read: IAM never reads the registry.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';
import { PROFILE_REGISTRY_PATH_ENV } from '../lib/config/profiles';
import { REGISTRY_READ_POLICY_ID, REGISTRY_WRITE_DENIAL_POLICY_ID, REGISTRY_WRITE_ACTIONS } from '../lib/constructs/profile-registry-readers';

type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

describe('every function reads the registry and no role writes it', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'athena');
  }, SYNTH_TIMEOUT_MS);

  /** Each template's resources, with the logical ids of its two registry policies. */
  const perStack = () => Object.entries(app.templates).map(([stack, t]) => {
    const resources = (t.Resources ?? {}) as Record<string, Resource>;
    const policyId = (prefix: string) => Object.keys(resources).find((id) => id.startsWith(prefix) && resources[id].Type === 'AWS::IAM::ManagedPolicy');
    return { stack, resources, read: policyId(REGISTRY_READ_POLICY_ID), deny: policyId(REGISTRY_WRITE_DENIAL_POLICY_ID) };
  });
  const attached = (role: Resource, policyId: string | undefined): boolean =>
    !!policyId && list(role.Properties?.ManagedPolicyArns).some((a) => JSON.stringify(a).includes(`"${policyId}"`));
  /**
   * A function the app builds, not one CDK builds for itself: a custom resource provider's handler (bucket
   * auto-delete, the messaging resources) or the log-retention function, raw resources no handler code runs in.
   */
  const built = ([id, r]: [string, Resource]): boolean => r.Type === 'AWS::Lambda::Function'
    && !/CustomResourceProviderHandler|^LogRetention[0-9a-f]{32}|^BucketNotificationsHandler/.test(id);
  const roleIdOf = (fn: Resource): string | undefined => {
    const r = fn.Properties?.Role;
    return (r?.['Fn::GetAtt'] as string[] | undefined)?.[0];
  };

  it('tells every function the same path, and names the deployment\'s set in none', () => {
    const paths = new Set<string>();
    let functions = 0;
    for (const { resources } of perStack()) {
      for (const [, r] of Object.entries(resources).filter(built)) {
        functions++;
        const env = (r.Properties?.Environment?.Variables ?? {}) as Record<string, unknown>;
        paths.add(String(env[PROFILE_REGISTRY_PATH_ENV]));
        expect(Object.keys(env).filter((k) => /AE_PROFILES_CONFIG|CLASSIFICATION_ADMISSION_JSON/.test(k))).toEqual([]);
      }
    }
    expect(functions).toBeGreaterThan(50);
    expect([...paths]).toEqual([expect.stringMatching(/\/registry\/classification$/)]);
  });

  it('attaches the read to the role of every function whose role the stack builds, and the denial to every role', () => {
    const missingRead: string[] = [];
    const missingDeny: string[] = [];
    for (const { stack, resources, read, deny } of perStack()) {
      for (const [id, r] of Object.entries(resources)) {
        // A custom resource provider's role runs during a deploy, never at runtime, and holds no SSM write (below).
        if (r.Type === 'AWS::IAM::Role' && !/CustomResourceProviderRole/.test(id) && !attached(r, deny)) missingDeny.push(`${stack}/${id}`);
        if (!built([id, r])) continue;
        const roleId = roleIdOf(r);
        if (!roleId || !resources[roleId]) continue; // a role another stack builds is checked there
        if (!attached(resources[roleId], read)) missingRead.push(`${stack}/${id} (${roleId})`);
      }
    }
    expect(missingRead).toEqual([]);
    expect(missingDeny).toEqual([]);
  });

  it('reads the path and its rows, and denies every write on both', () => {
    const { resources, read, deny } = perStack().find((s) => s.read && s.deny)!;
    const readDoc = JSON.stringify(resources[read!].Properties?.PolicyDocument);
    expect(readDoc).toContain('ssm:GetParametersByPath');
    expect(readDoc).toMatch(/parameter\/[^"]*\/registry\/classification"/);
    expect(readDoc).toMatch(/registry\/classification\/\*/);
    expect(readDoc).not.toContain('ssm:PutParameter');
    const denial = (resources[deny!].Properties?.PolicyDocument?.Statement ?? []) as Array<{ Effect: string; Action: unknown }>;
    expect(denial.map((s) => s.Effect)).toEqual(['Deny', 'Deny']);
    for (const d of denial) expect(list(d.Action).sort()).toEqual([...REGISTRY_WRITE_ACTIONS].sort());
  });

  it('denies every write on the call-time routing keys to every role, the manage-profiles assistant/* write included', () => {
    let checked = 0;
    for (const { resources, deny } of perStack()) {
      const managers = Object.entries(resources).filter(([id, r]) => r.Type === 'AWS::IAM::Role' && /ManageProfilesRole/.test(id));
      if (!managers.length) continue;
      const denial = (resources[deny!].Properties?.PolicyDocument?.Statement ?? []) as Array<{ Sid?: string; Resource: unknown }>;
      const routing = denial.find((d) => d.Sid === 'NeverWriteACallTimeRoutingKey');
      expect(JSON.stringify(routing?.Resource)).toContain('/assistant/*/*-arn"');
      for (const [, role] of managers) {
        expect(JSON.stringify(role.Properties?.Policies)).toMatch(/ssm:PutParameter/);
        expect(attached(role, deny)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(1);
  });

  it('allows the read inside a boundary that a function role carries', () => {
    let bounded = 0;
    for (const { resources } of perStack()) {
      for (const [, r] of Object.entries(resources).filter(built)) {
        const role = resources[roleIdOf(r) ?? ''];
        const boundaryId = role?.Properties?.PermissionsBoundary?.Ref as string | undefined;
        if (!boundaryId || !resources[boundaryId]) continue;
        bounded++;
        expect(JSON.stringify(resources[boundaryId].Properties?.PolicyDocument)).toContain('ssm:GetParametersByPath');
      }
    }
    expect(bounded).toBeGreaterThan(0);
  });

  it('grants no write on the registry path anywhere, so only a deploy publishes a row', () => {
    const writers: string[] = [];
    for (const { stack, resources } of perStack()) {
      for (const [id, r] of Object.entries(resources)) {
        const docs = r.Type === 'AWS::IAM::Role' ? list(r.Properties?.Policies).map((p: any) => p.PolicyDocument)
          : (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') ? [r.Properties?.PolicyDocument] : [];
        for (const doc of docs) {
          for (const s of list((doc as any)?.Statement) as Array<{ Effect?: string; Action?: unknown; Resource?: unknown }>) {
            if (s.Effect === 'Deny') continue;
            const writes = list(s.Action).map(String).filter((a) => REGISTRY_WRITE_ACTIONS.includes(a) || a === 'ssm:*');
            if (writes.length && /registry|parameter\/\*|parameter\$|:\*"/.test(JSON.stringify(s.Resource))) writers.push(`${stack}/${id}`);
          }
        }
      }
    }
    expect(writers).toEqual([]);
  });
});
