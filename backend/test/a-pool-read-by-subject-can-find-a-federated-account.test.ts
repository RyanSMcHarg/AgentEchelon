/**
 * EVERY ROLE THAT READS ONE POOL ACCOUNT BY SUBJECT CAN ALSO FIND A FEDERATED ONE (SPEC-CREDENTIAL-EXCHANGE §4b).
 *
 * Cognito accepts a `sub` as `Username` for a local user only, so a person who signed in through a
 * provider on the pool is found by `ListUsers` on the `sub` attribute and then addressed by their pool
 * username (`bySubjectOrUsername`, lambda/src/lib/cognito-pool-directory.ts). A role granted
 * `AdminGetUser` or `AdminListGroupsForUser` without `ListUsers` reads a local account and gets
 * AccessDenied for a federated one, or for any account that no longer exists: the offboarding sweep would
 * throw where it should erase. So the whole app, every capability declared, is read for the pairing.
 */
import { auroraAppTemplates } from './helpers/synth';

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown };
const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : []);
const ONE_ACCOUNT = ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'];

/** Every policy's statements by the role it attaches to, across every template. */
function statementsByRole(): Map<string, Statement[]> {
  const byRole = new Map<string, Statement[]>();
  for (const [stack, t] of Object.entries(auroraAppTemplates())) {
    const resources = t.toJSON().Resources as Record<string, { Type: string; Properties: any }>;
    for (const [id, r] of Object.entries(resources)) {
      const add = (role: string, statements: Statement[]) => byRole.set(role, [...(byRole.get(role) ?? []), ...statements]);
      if (r.Type === 'AWS::IAM::Role') {
        for (const p of r.Properties.Policies ?? []) add(`${stack}/${id}`, p.PolicyDocument?.Statement ?? []);
      }
      if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
        const roles = (r.Properties.Roles ?? []).map((x: any) => `${stack}/${x?.Ref ?? JSON.stringify(x)}`);
        for (const role of roles.length ? roles : [`${stack}/${id}`]) add(role, r.Properties.PolicyDocument?.Statement ?? []);
      }
    }
  }
  return byRole;
}

describe('a pool read by subject can find a federated account', () => {
  it('pairs every AdminGetUser or AdminListGroupsForUser grant with ListUsers on the same role', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [role, statements] of statementsByRole()) {
      const allowed = statements.filter((s) => s.Effect !== 'Deny').flatMap(actionsOf);
      if (!allowed.some((a) => ONE_ACCOUNT.includes(a))) continue;
      checked++;
      if (!allowed.includes('cognito-idp:ListUsers') && !allowed.includes('cognito-idp:*')) missing.push(role);
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
