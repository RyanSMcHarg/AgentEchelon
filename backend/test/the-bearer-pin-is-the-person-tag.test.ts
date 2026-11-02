/**
 * THE BEARER PIN IS THE `person` SESSION TAG.
 *
 * Every person credential the exchanges vend carries `person=<AppInstanceUser id>` on the STS session,
 * and every person role pins the Amazon Chime SDK bearer to `${appInstanceArn}/user/${aws:PrincipalTag/person}`
 * (the admin-plane role to `${aws:PrincipalTag/person}-admin`). The tag key and the policy variable
 * must name the same key: a role reading one key while the exchange writes another resolves the
 * variable to nothing, and every vend reaches nothing.
 *
 * Read from the synthesized Identity template, where the pinned roles live, and from the source,
 * so a `sub` tag or a `PrincipalTag/sub` variable cannot return in a stack, a handler or a script.
 * The live proof is `backend/scripts/deny-test-bearer-pin.mjs`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './helpers/strip-comments';
import { adminServicesTemplate, basicClassificationTemplate, identityTemplate } from './helpers/synth';

const BACKEND = path.resolve(__dirname, '..');

interface Statement { Action?: string | string[]; Resource?: unknown; Condition?: unknown }

const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : []);

describe('the bearer pin is the person tag', () => {
  // The person exchange's roles (Identity's two, and a classification's own in its stack) and the admin plane's
  // (AdminServices), read together.
  type Json = { Resources: Record<string, { Type: string; Properties?: any }> };
  const json: Json = { Resources: {
    ...(identityTemplate().toJSON() as Json).Resources,
    ...(basicClassificationTemplate().toJSON() as Json).Resources,
    ...(adminServicesTemplate().toJSON() as Json).Resources,
  } };

  /** Every identity-policy statement attached to the role with this logical id, inline or attached. */
  const statementsOf = (roleId: string): Statement[] => {
    const out: Statement[] = [];
    for (const r of Object.values(json.Resources)) {
      if (r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`)) {
        out.push(...(r.Properties?.PolicyDocument?.Statement ?? []));
      }
    }
    for (const p of json.Resources[roleId]?.Properties?.Policies ?? []) out.push(...(p.PolicyDocument?.Statement ?? []));
    return out;
  };

  const exchangeRoleIds = Object.entries(json.Resources)
    .filter(([id, r]) => r.Type === 'AWS::IAM::Role' && /^ExchangeRole/.test(id))
    .map(([id]) => id);
  const personRoleIds = exchangeRoleIds.filter((id) => !id.startsWith('ExchangeRoleAdminPlane'));
  const adminPlaneIds = exchangeRoleIds.filter((id) => id.startsWith('ExchangeRoleAdminPlane'));

  it('finds the person roles and the admin-plane role, so the checks below are not vacuous', () => {
    expect(personRoleIds.length).toBeGreaterThanOrEqual(3);
    expect(adminPlaneIds).toHaveLength(1);
  });

  it('pins chime:Connect on every person role to the person tag, and on the admin plane to its -admin twin', () => {
    for (const id of personRoleIds) {
      const connect = statementsOf(id).filter((s) => actionsOf(s).includes('chime:Connect'));
      expect({ id, count: connect.length }).toEqual({ id, count: 1 });
      const resource = JSON.stringify(connect[0].Resource);
      expect({ id, pinned: resource.includes('/user/${aws:PrincipalTag/person}') }).toEqual({ id, pinned: true });
      expect({ id, admin: resource.includes('${aws:PrincipalTag/person}-admin') }).toEqual({ id, admin: false });
    }
    const admin = JSON.stringify(statementsOf(adminPlaneIds[0]));
    expect(admin).toContain('/user/${aws:PrincipalTag/person}-admin');
  });

  it('requires the person tag on every exchange role trust, and names no sub tag anywhere', () => {
    for (const id of exchangeRoleIds) {
      const trust = JSON.stringify(json.Resources[id].Properties?.AssumeRolePolicyDocument ?? {});
      expect({ id, person: trust.includes('"aws:RequestTag/person":"*"') }).toEqual({ id, person: true });
    }
    const blob = JSON.stringify(json);
    expect(blob).not.toContain('PrincipalTag/sub');
    expect(blob).not.toContain('RequestTag/sub');
  });

  it('leaves no sub session tag or PrincipalTag/sub in the stacks, the handlers or the scripts', () => {
    const roots = ['lib', 'bin', 'lambda/src', 'lambda/share-conversation', 'lambda/presigned-url', 'scripts'];
    const exts = new Set(['.ts', '.js', '.mjs', '.cjs']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'cdk.out') walk(full); continue; }
        if (!exts.has(path.extname(e.name)) || e.name.endsWith('.d.ts')) continue;
        // A `.js` beside its `.ts` is the compiler's output.
        if (e.name.endsWith('.js') && fs.existsSync(full.slice(0, -3) + '.ts')) continue;
        const src = fs.readFileSync(full, 'utf8');
        // The policy variable is refused in comments too: a comment that names the old key is how a
        // reader writes a new policy against it.
        if (/PrincipalTag\/sub\b|RequestTag\/sub\b/.test(src)) offenders.push(`${path.relative(BACKEND, full)}: PrincipalTag/sub`);
        if (/\{\s*Key:\s*['"`]sub['"`]/.test(stripComments(src))) offenders.push(`${path.relative(BACKEND, full)}: a session tag keyed sub`);
      }
    };
    for (const r of roots) walk(path.join(BACKEND, r));
    expect(offenders).toEqual([]);
  });
});
