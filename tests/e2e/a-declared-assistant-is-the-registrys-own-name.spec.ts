/**
 * A DECLARED ASSISTANT IS THE REGISTRY'S OWN NAME, AND IT RESOLVES THE WAY A CONSOLE-CREATED ONE DOES (ADR-048).
 *
 * Against a deployment, the way a deploy does it: the premium stack's seed function (`DeclaredAssistantsFunction`,
 * the handler CloudFormation invokes for `Custom::DeclaredAssistants`) is invoked with a CloudFormation event whose
 * declaration names a throwaway assistant in premium's primary role.
 *
 *   1. The provisioner refuses it: a seed declares only the registry's own name for its classification, role and
 *      occupancy (ADR-048, "A `seed-declared` request is then refused ..."), so a name the registry does not hold
 *      builds nothing. No directory entry, no record and no identity exists for it afterwards.
 *   2. A declared assistant and a console-created one expose the same infrastructure links: the listing resolves
 *      both through one path (record and directory paths, identity, Lex bot and alias). The spec creates its own
 *      console assistant through the admin route the console uses (`POST /admin/roster`), so the comparison runs on a
 *      fresh deployment, and retires it afterwards.
 *
 * That a console retire sticks across the next seed is proven by unit test
 * (`backend/test/a-deploy-seeds-its-declared-assistants-once.test.ts`, "does NOT recreate one retired in the
 * console"): the seed builds only the registry's own names, so the deployed proof would retire an assistant that serves.
 *
 * The refused seed spends its claim and builds nothing. The console assistant is retired in `afterAll`, which deletes its
 * identity and its Lex bot; its directory entry stays as the retired tombstone that keeps the name from being reused.
 */
import { test, expect, noteProgress } from './helpers/fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, signedCall } from './helpers/admin-api';
import { idTokenFor } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws, awsOrNull } from './helpers/aws';
import { INSTANCE, physicalIdsIn, stackName } from './helpers/stack-prefix';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardBackendErrors('a-declared-assistant-is-the-registrys-own-name');

const ROOT = `/${INSTANCE}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assistantId = `e2e-decl-${Date.now().toString(36)}`;
/** The console assistant this spec creates to compare against, in the shape the console's create sends. */
const consoleAssistantId = `e2e-links-${Date.now().toString(36)}`;
const consoleCreate = {
  assistantId: consoleAssistantId,
  classification: 'premium',
  role: 'primary',
  displayName: `E2E links ${consoleAssistantId.slice(-6)}`,
  descriptor: { modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 120 },
};
const declaration = {
  classification: 'premium',
  roles: ['primary'],
  assistants: [{ assistantId, role: 'primary', occupancy: 'live', displayName: `E2E decl ${assistantId.slice(-6)}`, welcome: true }],
};

/** Invoke the premium seed the way CloudFormation's provider does, and read its answer. */
function seed(): { PhysicalResourceId?: string; Data?: { Summary?: string } } {
  const [fn] = physicalIdsIn([stackName('Assistants-premium')], { type: 'AWS::Lambda::Function', logicalId: /^DeclaredAssistantsFunction/ });
  if (!fn) throw new Error(`no DeclaredAssistantsFunction in ${stackName('Assistants-premium')}; deploy the premium stack`);
  const props = { ServiceToken: 'e2e', declaration: JSON.stringify(declaration) };
  const event = {
    RequestType: 'Create',
    ResourceType: 'Custom::DeclaredAssistants',
    LogicalResourceId: 'E2EDeclaredAssistants',
    ResourceProperties: props,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const inFile = path.join(dir, 'in.json');
  const outFile = path.join(dir, 'out.json');
  fs.writeFileSync(inFile, JSON.stringify(event));
  const meta = aws(`lambda invoke --function-name ${fn} --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload fileb://${inFile} ${outFile}`, { timeoutMs: 900_000 });
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (meta?.FunctionError) throw new Error(`the seed failed: ${JSON.stringify(out).slice(0, 400)}`);
  return out;
}

const param = (name: string) => {
  const v = awsOrNull(`ssm get-parameter --name ${name} --query Parameter.Value`);
  return typeof v === 'string' ? JSON.parse(v) : null;
};

test.describe.serial("a declared assistant is the registry's own name", () => {
  let adminSession: any;

  test.beforeAll(async () => {
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is not set');
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(admin.email, admin.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, `console session: ${JSON.stringify(session.body).slice(0, 300)}`).toBe(200);
    adminSession = session.body.credentials;
  });

  let consoleCreated = false;
  test.afterAll(async () => {
    // The deployment is left as found: the console assistant this spec created is retired, whatever the test did.
    if (consoleCreated && adminSession) {
      const res = await signedCall(adminUrl('assistant-admin', `/admin/roster/${consoleAssistantId}/retire`), adminSession, 'POST', { reason: 'e2e cleanup' });
      expect(res.status, `retire ${consoleAssistantId}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
  });

  test("the seed refuses an assistant the registry does not name, and builds nothing", async () => {
    test.setTimeout(300_000);
    let refusal = '';
    try {
      seed();
    } catch (err) {
      refusal = String((err as Error).message);
    }
    expect(refusal, 'the seed built an assistant the registry does not name').toMatch(
      new RegExp(`'${assistantId}' is not the registry's assistant for premium/primary`),
    );
    // Nothing was built: no entry, no record, and no identity under its name.
    expect(param(`${ROOT}/assistant-directory/${assistantId}`)).toBeNull();
    expect(param(`${ROOT}/assistant-assignments/premium/primary/assistants/${assistantId}`)).toBeNull();
    const primary = param(`${ROOT}/assistant-assignments/premium/primary/assistants/${refusal.match(/it names '([^']+)'/)?.[1] ?? ''}`);
    expect(primary?.botArn, "the registry's own premium primary is recorded").toBeTruthy();
    const appInstance = String(primary.botArn).split('/bot/')[0];
    const bots = (aws(`chime-sdk-identity list-app-instance-bots --app-instance-arn ${appInstance}`).AppInstanceBots ?? []) as Array<{ Name?: string }>;
    expect(bots.map((b) => b.Name ?? '')).not.toContain(declaration.assistants[0].displayName);
  });

  test.describe('beside a console-created assistant', () => {
    // The build is the provisioner's, asynchronous and raising no event the runner can subscribe to, so the roster is
    // read on an interval and a step of it may pass in silence.
    test.use({ stallWindowMs: 9 * 60_000 });

    test('a declared assistant and a console-created one expose the same infrastructure links', async () => {
      test.setTimeout(600_000);
      const res = await signedCall(adminUrl('assistant-admin', '/admin/roster'), adminSession, 'POST', consoleCreate);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(202);
      consoleCreated = true;

      // The roster says when the build is done; the listing then resolves the new assistant beside the declared ones.
      let listing: { status: number; body: any } = { status: 0, body: {} };
      let status = '';
      for (const deadline = Date.now() + 480_000; Date.now() < deadline; await sleep(15_000)) {
        listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), adminSession);
        const entry = ((listing.body?.runtimeAssistants ?? []) as Array<{ assistant: string; status: string }>).find((a) => a.assistant === consoleAssistantId);
        if (entry?.status && entry.status !== status) noteProgress('harness', `${consoleAssistantId} is ${entry.status}`);
        status = entry?.status ?? '';
        if (status && status !== 'provisioning') break;
      }
      expect(status, `the console assistant's build ended ${status || 'unlisted'}`).toBe('active');
      expect(listing.status).toBe(200);
      const profiles = listing.body.profiles as Array<{ profileName: string; origin?: string; resolved?: Record<string, unknown> }>;
      const declared = profiles.find((p) => p.origin === 'deployed' && p.resolved?.directoryParam);
      const created = profiles.find((p) => p.profileName === consoleAssistantId);
      expect(declared, 'a declared assistant is listed with its directory entry').toBeTruthy();
      expect(created?.origin, `${consoleAssistantId} is listed as console-created`).toBe('console');
      const own = ['botArn', 'lexBotId', 'lexBotAliasId', 'definitionParam', 'assignmentParam', 'directoryParam', 'profileBodies'];
      for (const p of [declared!, created!]) {
        const r = p.resolved as Record<string, any>;
        expect(own.filter((k) => r[k] !== undefined), `${p.profileName} resolves every link of its own`).toEqual(own);
        expect(r.assignmentParam).toMatch(new RegExp(`/assistant-assignments/[^/]+/[^/]+/assistants/${p.profileName}$`));
        expect(r.directoryParam).toBe(`${ROOT}/assistant-directory/${p.profileName}`);
        for (const k of own) expect(r.scopes?.[k], `${p.profileName} ${k} is its own`).toBe('assistant');
      }
    });
  });
});
