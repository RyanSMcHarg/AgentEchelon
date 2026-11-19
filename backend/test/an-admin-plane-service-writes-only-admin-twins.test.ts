/**
 * AN ADMIN-PLANE SERVICE WRITES ONLY ADMIN TWINS, BY IAM AND NOT ONLY BY CODE (tenet D3).
 *
 * The admin credential exchange creates, renames, tags and elevates the admin-plane twin `<personId>-admin`
 * (`adminTwinIdFor`, person-arn.ts), and the admin-conversation sync deletes an orphaned twin. Each write is held to
 * `user/*-admin` by IAM as well as by the code, so a bad id or a misfire cannot make a person's own chat identity an
 * AppInstanceAdmin, rename, retag or delete it; reads stay on every identity. An action names the bare app instance
 * only where it authorizes against it, a tag write carries only the keys its handler writes, and the service admin,
 * whose id also ends in the twin suffix, is refused to every one of these writes.
 */
import { adminServicesOnLiteralsTemplate, TEST_APP_INSTANCE_ARN } from './helpers/synth';
import { ADMIN_TWIN_OWNER_TAG } from '../lambda/src/lib/person-arn';
import { serviceAdminArnOf } from '../lib/stacks/agent-classification-common';

type Statement = {
  Sid?: string; Effect?: string; Action: string | string[]; Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

const statementsOf = (t: ReturnType<typeof adminServicesOnLiteralsTemplate>, role: RegExp): Statement[] => [
  ...(Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>)
    .filter(([id]) => role.test(id))
    .flatMap(([, r]) => (r.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement)),
  ...(Object.values(t.findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => role.test(JSON.stringify(p.Properties.Roles)))
    .flatMap((p) => p.Properties.PolicyDocument.Statement),
];
const allowsOf = (t: ReturnType<typeof adminServicesOnLiteralsTemplate>, role: RegExp) =>
  statementsOf(t, role).filter((s) => s.Effect !== 'Deny');
const deniesOf = (t: ReturnType<typeof adminServicesOnLiteralsTemplate>, role: RegExp) =>
  statementsOf(t, role).filter((s) => s.Effect === 'Deny');
const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement) => JSON.stringify(s.Resource);
const resourceList = (s: Statement): string[] => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map((r) => JSON.stringify(r));
const BARE_APP_INSTANCE = JSON.stringify(TEST_APP_INSTANCE_ARN);
const TWINS = JSON.stringify(`${TEST_APP_INSTANCE_ARN}/user/*-admin`);
const SERVICE_ADMIN = JSON.stringify(serviceAdminArnOf(TEST_APP_INSTANCE_ARN));

/** Every one of `actions` is refused on the service admin by an explicit Deny on `role`. */
const refusesTheServiceAdmin = (t: ReturnType<typeof adminServicesOnLiteralsTemplate>, role: RegExp, actions: string[]) => {
  const denies = deniesOf(t, role).filter((s) => resourceList(s).includes(SERVICE_ADMIN));
  for (const a of actions) expect([a, denies.some((s) => actionsOf(s).includes(a))]).toEqual([a, true]);
};

describe('admin-plane services write only admin twins', () => {
  const t = adminServicesOnLiteralsTemplate({});
  const WRITES = ['chime:CreateAppInstanceUser', 'chime:UpdateAppInstanceUser', 'chime:CreateAppInstanceAdmin', 'chime:TagResource', 'chime:DeleteAppInstanceUser'];
  const EXCHANGE = /AdminCredentialExchangeRole/;

  it('the admin exchange writes identities only under the twin suffix, and reads any', () => {
    const statements = allowsOf(t, EXCHANGE);
    const writing = statements.filter((s) => actionsOf(s).some((a) => WRITES.includes(a)));
    expect(writing.length).toBeGreaterThan(0);
    for (const s of writing) {
      expect(resourcesOf(s)).toContain('/user/*-admin');
      expect(resourcesOf(s)).not.toMatch(/\/user\/\*"/);
    }
    expect(statements.some((s) => s.Sid === 'ReadsAnIdentity' && actionsOf(s).includes('chime:DescribeAppInstanceUser'))).toBe(true);
  });

  // The Service Authorization Reference lists the AppInstanceUser alone for a rename and a retag, so neither
  // reaches the bare app instance; the elevation and the create name the app instance they act in.
  const NEEDS_THE_APP_INSTANCE = ['chime:CreateAppInstanceAdmin', 'chime:CreateAppInstanceUser'];

  it('the admin exchange names the bare app instance only for an action that authorizes against it', () => {
    const statements = allowsOf(t, EXCHANGE);
    for (const s of statements.filter((x) => actionsOf(x).some((a) => WRITES.includes(a)))) {
      if (!resourceList(s).includes(BARE_APP_INSTANCE)) continue;
      for (const a of actionsOf(s)) expect(NEEDS_THE_APP_INSTANCE).toContain(a);
    }
    for (const action of ['chime:UpdateAppInstanceUser', 'chime:TagResource']) {
      const granting = statements.filter((s) => actionsOf(s).includes(action));
      expect(granting.length).toBeGreaterThan(0);
      for (const s of granting) expect(resourceList(s)).toEqual([TWINS]);
    }
  });

  it('the admin exchange elevates only a twin: the elevation names the twin suffix beside the app instance', () => {
    const elevating = allowsOf(t, EXCHANGE).filter((s) => actionsOf(s).includes('chime:CreateAppInstanceAdmin'));
    expect(elevating.length).toBeGreaterThan(0);
    for (const s of elevating) expect(resourceList(s).sort()).toEqual([BARE_APP_INSTANCE, TWINS].sort());
  });

  it('the admin exchange tags a twin with its classification and owner, and no other key', () => {
    const tagging = allowsOf(t, EXCHANGE).filter((s) => actionsOf(s).includes('chime:TagResource'));
    expect(tagging).toHaveLength(1);
    expect(tagging[0].Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys']).toEqual(['classification', ADMIN_TWIN_OWNER_TAG]);
  });

  it('the admin exchange never writes the service admin, whose id also ends in the twin suffix', () => {
    refusesTheServiceAdmin(t, EXCHANGE, ['chime:CreateAppInstanceUser', 'chime:UpdateAppInstanceUser', 'chime:CreateAppInstanceAdmin', 'chime:TagResource']);
  });

  it('user management re-stamps only the classification key, and only on an identity', () => {
    const tagging = allowsOf(t, /UserManagementFunction/).filter((s) => actionsOf(s).includes('chime:TagResource'));
    expect(tagging.length).toBeGreaterThan(0);
    for (const s of tagging) {
      expect(actionsOf(s)).toEqual(['chime:TagResource']);
      expect(resourceList(s)).toEqual([JSON.stringify(`${TEST_APP_INSTANCE_ARN}/user/*`)]);
      expect(s.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys']).toEqual(['classification']);
    }
  });

  it('the admin-conversation sync deletes only a twin, may drop any elevation, and keeps the service admin', () => {
    const statements = allowsOf(t, /AdminConversationSync/);
    const deleting = statements.filter((s) => actionsOf(s).includes('chime:DeleteAppInstanceUser'));
    expect(deleting).toHaveLength(1);
    expect(resourcesOf(deleting[0])).toContain('/user/*-admin');
    expect(resourcesOf(deleting[0])).not.toMatch(/\/user\/\*"/);
    expect(statements.some((s) => s.Sid === 'DropsAnElevation' && actionsOf(s).includes('chime:DeleteAppInstanceAdmin'))).toBe(true);
    refusesTheServiceAdmin(t, /AdminConversationSync/, ['chime:DeleteAppInstanceUser', 'chime:DeleteAppInstanceAdmin']);
  });
});
