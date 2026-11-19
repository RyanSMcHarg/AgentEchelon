/**
 * EVERY CONVERSATION ROUTE RECHECKS CLEARANCE LIVE (DESIGN-REVOCATION-WINDOWS R4).
 *
 * The shared conversation check reads the person's current clearance only on a function wired for it: the flag and
 * the directory read `grantLiveClearance` adds. A route left unwired is held to the token, which a downgrade reaches
 * at renewal, so every function that runs the check is named here and must carry both. Read from C7-custom's
 * synthesized templates.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';

type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/**
 * The functions that run `callerReachesConversation` or `callerStillCleared` (the create and claim routes), by construct id, in the
 * stacks C7-custom deploys. The share is in Notifications, which C7-custom does not deploy, and is pinned in
 * `the-email-bridge-is-in-notifications.test.ts`.
 */
const ROUTES = [
  'PresignedUrlFunction', 'UserTasksApiFunction', 'TurnStateApiFunction', 'InvitationsFunction', 'ProposalsFunction',
  'ConversationManagementFunction', 'UserFeedbackFunction', 'ChannelBattleFunction', 'BattleOutcomeFunction',
  'CreateConversationFunction', 'GuestUpgradeFunction',
];

describe('every conversation route rechecks clearance live', () => {
  let app: Synthesized;
  beforeAll(() => {
    app = synthesize(configuration('C7-custom'), 'athena');
  }, SYNTH_TIMEOUT_MS);

  it('carries the flag and the read of the person\'s current groups', () => {
    const found: string[] = [];
    const missing: string[] = [];
    for (const [stack, t] of Object.entries(app.templates)) {
      const resources = (t.Resources ?? {}) as Record<string, Resource>;
      for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::Lambda::Function') continue;
        const route = ROUTES.find((name) => id.startsWith(name));
        if (!route) continue;
        found.push(route);
        const env = r.Properties?.Environment?.Variables ?? {};
        const roleId = (r.Properties?.Role?.['Fn::GetAtt'] as string[] | undefined)?.[0];
        const statements = Object.values(resources)
          .filter((p) => p.Type === 'AWS::IAM::Policy' && JSON.stringify(p.Properties?.Roles).includes(`"${roleId}"`))
          .flatMap((p: any) => list(p.Properties.PolicyDocument.Statement)) as Array<{ Action: unknown }>;
        const readsGroups = statements.some((s) => list(s.Action).includes('cognito-idp:AdminListGroupsForUser'));
        if (env.LIVE_CLEARANCE !== 'directory' || !env.IDENTITIES_TABLE || !readsGroups) missing.push(`${stack}/${id}`);
      }
    }
    expect(missing).toEqual([]);
    expect([...new Set(found)].sort()).toEqual([...ROUTES].sort());
  });
});
