/**
 * WHAT A HANDLER NEEDS TO RE-CHECK A TEAM-SCOPED ROUTE (DESIGN-ADMIN-CONSOLE 5.2).
 *
 * `lambda/src/lib/assistant-scope.ts` reads the caller's groups and the assistant's ownership tag to
 * refuse a team member an assistant their team does not own. This grants exactly those reads - listing
 * the app instance's bots, reading their tags, listing one user's groups - and sets the two values the
 * check resolves them against. Read-only: nothing here can change ownership or membership.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantDirectoryRead } from './directory-access';

/**
 * `identities` is the Identity stack's table, BY REFERENCE where the caller holds it: read from its SSM
 * contract instead, a nested stack resolves a parameter with no dependency edge on the stack publishing it.
 */
export function grantAssistantScopeCheck(
  fn: lambda.Function,
  appInstanceArn: string,
  userPoolId: string,
  identities?: { tableName: string; tableArn: string },
): void {
  // ListAppInstanceBots is authorized against the bots, not the app instance (measured).
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['chime:ListAppInstanceBots'], resources: [appInstanceArn, `${appInstanceArn}/bot/*`] }));
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['chime:ListTagsForResource'], resources: [`${appInstanceArn}/bot/*`] }));
  // A CALLER'S TEAM GROUPS ARE READ BY PERSON: their issuer subjects from `Identities`, then each subject's
  // groups from its issuer (`groupsFor`). The pool read alone left `IDENTITIES_TABLE` unset, so every team
  // member's ownership was "unresolvable" and Profiles refused them their own assistant (2026-10-21).
  // ListUsers resolves a federated person's `sub` to their pool username (`bySubjectOrUsername`).
  grantDirectoryRead(fn, { appInstanceArn, userPoolId, identities, poolReads: ['cognito-idp:AdminListGroupsForUser', 'cognito-idp:ListUsers'] });
}
