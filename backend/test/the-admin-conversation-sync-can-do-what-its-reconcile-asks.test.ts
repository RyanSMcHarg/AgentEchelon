/**
 * THE ADMIN-CONVERSATION SYNC HOLDS EVERY PERMISSION ITS RECONCILE USES, AND RUNS ON THE DIRECTORY'S EVENT.
 *
 * The sync shares lib/membership-reconcile.ts, which reads the moderator list before it changes anything
 * and grants and revokes moderation alongside membership. The role was written before that, with the
 * membership actions only, so every run that reached an admin conversation would fail AccessDenied on its
 * first call. Unit tests mock the client and cannot see a missing grant; this reads the synthesized role.
 *
 * And the rule: a user deleted, disabled or re-enabled changes who counts as an admin without any group
 * call, so those events invoke the sync too (tenet D6), with the daily schedule as the backstop.
 */
import { Template, Match } from 'aws-cdk-lib/assertions';
import { TEST_APP_INSTANCE_ARN, adminServicesOnLiteralsTemplate } from './helpers/synth';

const APP = TEST_APP_INSTANCE_ARN;
const ADMIN_CONVERSATION = `${APP}/channel/admins`;

/** The sync is the admin backend's (AdminServices). */
function template(adminConversationArns: string | undefined = ADMIN_CONVERSATION): Template {
  return adminServicesOnLiteralsTemplate(adminConversationArns ? { adminConversationArns } : {});
}

/** Every Allow statement on the sync's role. */
function statementsOfSync(t: Template): Array<{ Action: string | string[]; Resource: unknown }> {
  const fns = t.findResources('AWS::Lambda::Function');
  const fnId = Object.keys(fns).find((id) => id.startsWith('AdminConversationSyncFunction'))!;
  const roleRef = (fns[fnId].Properties.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
  return (Object.values(t.findResources('AWS::IAM::Policy')) as Array<{
    Properties: { Roles: Array<{ Ref: string }>; PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } };
  }>).filter((p) => p.Properties.Roles.some((r) => r.Ref === roleRef)).flatMap((p) => p.Properties.PolicyDocument.Statement);
}

/** Every action granted by any policy attached to the role of the function whose logical id starts with `prefix`. */
function actionsOfFunctionRole(t: Template, prefix: string): string[] {
  const fns = t.findResources('AWS::Lambda::Function');
  const fnId = Object.keys(fns).find((id) => id.startsWith(prefix));
  if (!fnId) throw new Error(`no function ${prefix}`);
  const roleRef = (fns[fnId].Properties.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
  const policies = Object.values(t.findResources('AWS::IAM::Policy')) as Array<{
    Properties: { Roles: Array<{ Ref: string }>; PolicyDocument: { Statement: Array<{ Action: string | string[] }> } };
  }>;
  return policies
    .filter((p) => p.Properties.Roles.some((r) => r.Ref === roleRef))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

describe('the admin-conversation sync', () => {
  const t = template();

  it('holds the moderator actions the shared reconcile calls, not only the membership ones', () => {
    const actions = actionsOfFunctionRole(t, 'AdminConversationSyncFunction');
    expect(actions).toEqual(expect.arrayContaining([
      'chime:ListChannelMemberships', 'chime:CreateChannelMembership', 'chime:DeleteChannelMembership',
      'chime:ListChannelModerators', 'chime:CreateChannelModerator', 'chime:DeleteChannelModerator',
    ]));
  });

  /** The membership grant's statements, by the resources each names. */
  function membershipStatements(tpl: Template): Array<{ Resource: unknown; Condition?: Record<string, Record<string, unknown>> }> {
    return statementsOfSync(tpl).filter((s) => ([] as string[]).concat(s.Action).includes('chime:CreateChannelMembership')) as any;
  }
  const resourcesOf = (tpl: Template) =>
    membershipStatements(tpl).flatMap((s) => ([] as unknown[]).concat(s.Resource)).map((r) => String(r)).sort();

  it('holds them on the configured admin conversations, the admin plane\'s channels by their tag, and the service admin alone', () => {
    expect(resourcesOf(t)).toEqual(
      [ADMIN_CONVERSATION, `${APP}/channel/*`, `${APP}/user/agent-echelon-admin`].sort());
  });

  it('reaches the admin plane\'s channels, which take in the notification channel, only through their classification tag', () => {
    const wide = membershipStatements(template('')).filter((s) => ([] as unknown[]).concat(s.Resource).includes(`${APP}/channel/*`));
    expect(wide.length).toBeGreaterThan(0);
    for (const s of wide) {
      expect(JSON.stringify(s.Condition ?? {})).toContain('aws:ResourceTag/classification');
      expect(JSON.stringify(s.Condition ?? {})).toContain('admin');
    }
  });

  it('runs on a group change and on a user deleted, disabled or re-enabled, with a daily backstop', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.cognito-idp'],
        detail: Match.objectLike({
          eventName: ['AdminAddUserToGroup', 'AdminRemoveUserFromGroup', 'AdminDeleteUser', 'AdminDisableUser', 'AdminEnableUser'],
        }),
      }),
    });
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 day)' });
  });
});
