/**
 * A DEPLOYMENT WITHOUT `admin` HOLDS NO ADMIN HANDLER, ROUTE, ROLE OR TABLE ANYWHERE (D7, E6).
 *
 * The admin backend is omitted as one unit: every admin handler, the admin credential exchange and its
 * roles, the console roles and the admin notification channel are the `AdminServices` stack's, and every
 * admin route and the console roles' grants on them are `AdminApi`'s. So a synthesis of the core alone
 * carries none of it, in either archive mode, and a synthesis with `admin` carries all of it inside
 * `AdminServices` (and its nested stacks) and `AdminApi`, with one exception the capability registry
 * declares as its attach point: the admin console's app client is on this deployment's own pool, in
 * `Identity`, because its tokens are an audience both APIs' edge authorizers check.
 *
 * What is recognized as admin, read from the templates rather than from a list of stacks:
 *  - a handler told it sits behind an admin route (`ADMIN_IAM_ENFORCEMENT`, `ADMIN_AUTH_MODE`);
 *  - an IAM-authorized route (every admin route but the console session is one, and no person route is);
 *  - a console role (named `<instance>-admin-console` / `<instance>-team-console`), the admin-plane exchange
 *    role, the team attachment role, the admin app client and the team-members group;
 *  - a construct of the admin backend by its logical id.
 *
 * THE ACCESS LOG IS NOT AN ADMIN TABLE. It is the record of identity facts the core writes (each person the
 * exchange mints, each `Identities` change offboarding makes), kept in `Identity` beside those writers; the
 * admin backend adds its own records to it and reads it by reference.
 */
import * as path from 'path';
import { synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';
import { ADMIN_CONSOLE_ROLE_NAME } from '../lib/constructs/admin-role-grants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = { Resources?: Record<string, Resource> };

/** The logical ids of the admin backend's own constructs. */
const ADMIN_CONSTRUCTS = /^(ExchangeRoleAdminPlane|TeamAttachmentRole|AdminConsoleRole|TeamConsoleRole|AdminCredentialExchange|AccessLogReader|UserManagement|AdminConversation|AdminTasks|ManageProfiles|AdminExperiments|AssistantOwnership|ManageAssistants|AnalyticsQuery|QueueHealth|ClassifierReplayStart|MembershipAuditAdmin|AdminAgent|AdminNotificationChannel|AdminAlert|FeedbackSummary|AdminFeedback|AdminWebClient|TeamMembersGroup)/;

/** Every admin thing in one template, as `<resource id>: why`. */
function adminThings(t: Template): string[] {
  const out: string[] = [];
  for (const [id, r] of Object.entries(t.Resources ?? {})) {
    const vars = r.Properties?.Environment?.Variables ?? {};
    if (r.Type === 'AWS::Lambda::Function' && (vars.ADMIN_IAM_ENFORCEMENT !== undefined || vars.ADMIN_AUTH_MODE !== undefined)) out.push(`${id}: an admin handler`);
    if (r.Type === 'AWS::ApiGatewayV2::Route' && r.Properties?.AuthorizationType === 'AWS_IAM') out.push(`${id}: an IAM-authorized route`);
    if (r.Type === 'AWS::ApiGatewayV2::Api' && /admin-api$/.test(String(r.Properties?.Name))) out.push(`${id}: the admin API`);
    if (r.Type === 'AWS::IAM::Role' && Object.values(ADMIN_CONSOLE_ROLE_NAME).includes(r.Properties?.RoleName)) out.push(`${id}: a console role`);
    if (r.Type === 'AWS::Cognito::UserPoolClient' && r.Properties?.ClientName === 'admin-client') out.push(`${id}: the admin app client`);
    if (r.Type === 'AWS::Cognito::UserPoolGroup' && r.Properties?.GroupName === 'team-members') out.push(`${id}: the team-members group`);
    if (r.Type === 'AWS::Events::Rule' && JSON.stringify(r.Properties?.EventPattern?.source ?? []).includes('ae.alert')) out.push(`${id}: the ae.alert rule`);
    if (r.Type !== 'AWS::CDK::Metadata' && ADMIN_CONSTRUCTS.test(id)) out.push(`${id}: an admin construct (${r.Type})`);
  }
  return out;
}

const memo = new Map<string, SynthesizedApp>();
function synth(mode: 'athena' | 'aurora', capabilities: string[]): SynthesizedApp {
  const key = `${mode}|${capabilities.join(',')}`;
  if (!memo.has(key)) memo.set(key, synthesizeApp(REPO_ROOT, { id: `no-admin-${key}`, context: { analyticsMode: mode, capabilities } }));
  return memo.get(key)!;
}

describe.each(['athena', 'aurora'] as const)('a deployment without admin (%s)', (mode) => {
  let app: SynthesizedApp;
  beforeAll(() => { app = synth(mode, ['chat', 'notifications', 'operations', 'experiments', 'battle']); }, SYNTH_TIMEOUT_MS);

  it('stands up neither AdminServices, AdminApi nor AdminApp', () => {
    expect(Object.keys(app.dependencies).filter((s) => /AdminServices|AdminApi|AdminApp|AdminPlane|AdminNotification/.test(s))).toEqual([]);
  });

  it('holds no admin handler, route, role, client, group or alert rule in any stack', () => {
    const found = Object.entries(app.templates).flatMap(([stack, t]) => adminThings(t as Template).map((x) => `${stack}/${x}`));
    expect(found).toEqual([]);
  });

  it('still keeps the access log, the identity record the core writes', () => {
    const identity = Object.entries(app.templates).find(([s]) => s.endsWith('Identity'))![1] as Template;
    expect(Object.keys(identity.Resources ?? {}).some((id) => id.startsWith('AccessLogTable'))).toBe(true);
  });
});

describe('a deployment with admin', () => {
  let app: SynthesizedApp;
  beforeAll(() => { app = synth('athena', ['chat', 'admin', 'experiments']); }, SYNTH_TIMEOUT_MS);

  it('holds every admin thing in AdminServices, its nested stacks and AdminApi, and none in any other stack', () => {
    const byStack = Object.entries(app.templates).map(([stack, t]) => [stack, adminThings(t as Template)] as const);
    // The admin console's app client is the one declared attach point on the core (`attaches` of `admin`).
    const declared = (stack: string, thing: string) => /Identity$/.test(stack) && (thing.endsWith('the admin app client') || /^AdminWebClient/.test(thing));
    const outside = byStack
      .map(([stack, things]) => [stack, things.filter((x) => !declared(stack, x))] as const)
      .filter(([stack, things]) => things.length && !/AdminServices|AdminApi/.test(stack));
    expect(outside.map(([stack, things]) => `${stack}: ${things.join('; ')}`)).toEqual([]);
    // Non-vacuity: the recognizer finds the admin backend where it is.
    const inside = byStack.filter(([stack]) => /AdminServices|AdminApi/.test(stack)).flatMap(([, things]) => things);
    for (const kind of ['an admin handler', 'an IAM-authorized route', 'the admin API', 'a console role', 'the team-members group', 'the ae.alert rule']) {
      expect([kind, inside.some((x) => x.endsWith(kind))]).toEqual([kind, true]);
    }
    const identity = byStack.find(([stack]) => /Identity$/.test(stack))![1];
    expect(identity.some((x) => x.endsWith('the admin app client'))).toBe(true);
  });

  it('carries the admin console app client only where admin is declared', () => {
    const without = synth('athena', ['chat']);
    const identity = Object.entries(without.templates).find(([s]) => s.endsWith('Identity'))![1] as Template;
    expect(adminThings(identity)).toEqual([]);
  }, SYNTH_TIMEOUT_MS);
});
