import { identityTemplate, basicClassificationTemplate } from './helpers/synth';
import { MEMBERSHIP_GROUP_PRECEDENCE_BASE } from '../lib/config/profiles';
/**
 * NO GROUP CARRIES A ROLE, AND A MEMBERSHIP GROUP SITS AFTER EVERY CLEARANCE GROUP.
 *
 * Every credential a person holds is vended by the credential exchange, which reads the groups as
 * clearance through the trusted-issuer registry; there is no Identity Pool for a group's role to be
 * assumed through, so a group that names a role is a grant nothing should hold. `ops` is a membership
 * group: its members must already be cleared for premium, and it grants nothing, so it sits after every
 * clearance group in the precedence order, from a fixed base. A classification's clearance groups are built by
 * its own stack, at the precedence it declares, so the admin plane's are Identity's and `basic`'s are
 * `Assistants-basic`'s. This reads the synthesized groups.
 */


it('creates no group with a role, ops after every clearance group, and no two groups sharing a precedence', () => {
  const groupsOf = (t: ReturnType<typeof identityTemplate>) => (Object.values(t.findResources('AWS::Cognito::UserPoolGroup')) as Array<{
    Properties: { GroupName: string; Precedence: number; RoleArn?: unknown };
  }>).map((g) => g.Properties);
  const identityGroups = groupsOf(identityTemplate());
  const basicGroups = groupsOf(basicClassificationTemplate());
  // Identity holds the admin plane's group and the membership groups; a classification's are its own stack's.
  expect(identityGroups.map((g) => g.GroupName).sort()).toEqual(['admins', 'ops']);
  expect(basicGroups.map((g) => g.GroupName)).toEqual(['basic']);
  expect(basicGroups[0].Precedence).toBe(5);
  const groups = [...identityGroups, ...basicGroups];

  const ops = groups.find((g) => g.GroupName === 'ops');
  expect(ops).toBeDefined();
  expect(ops!.Precedence).toBe(MEMBERSHIP_GROUP_PRECEDENCE_BASE);
  expect(groups.filter((g) => g.RoleArn !== undefined).map((g) => g.GroupName)).toEqual([]);
  const clearance = groups.filter((g) => g.GroupName !== 'ops' && g.GroupName !== 'team-members');
  expect(ops!.Precedence).toBeGreaterThan(Math.max(...clearance.map((g) => g.Precedence)));
  expect(new Set(groups.map((g) => g.Precedence)).size).toBe(groups.length);
});
