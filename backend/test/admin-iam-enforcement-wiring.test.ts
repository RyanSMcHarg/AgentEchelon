/**
 * Every Lambda behind an AWS_IAM-authorized admin route must be TOLD the deployment enforces IAM.
 *
 * `requireAdmin` trusts a gateway-vetted signed principal only when `ADMIN_IAM_ENFORCEMENT=true` is
 * in its environment. Without that variable it falls through to Cognito authorizer claims — which an
 * IAM-authorized request does not carry — and refuses every single call with a 401.
 *
 * This guard exists because that is exactly what shipped: `ClassifierReplayStartFn` deployed
 * cleanly, its route answered, its IAM grant was correct, and the first real request was refused.
 * Nothing in the unit tests could see it (the handler is right; the environment was incomplete) and
 * nothing in the template review could either, because a missing variable looks like every other
 * variable that is deliberately absent.
 *
 * Asserted from the TEMPLATES rather than as a list of expected functions, so a new IAM-authorized
 * admin route is covered the day it is added instead of the day someone remembers this file. A route is
 * on `AdminApi` and its handler in the stack that owns it, so the route's integration names the handler's
 * construct (`RouteTableApi` writes it as the integration's description), and the function is found by
 * that construct id in whichever template holds it.
 */
import { auroraAppTemplates } from './helpers/synth';

/** A function's logical id is its construct id and CDK's eight-hex uniqueness suffix. */
const isConstruct = (logicalId: string, constructId: string): boolean => new RegExp(`^${constructId}[0-9A-F]{8}$`).test(logicalId);

/**
 * THE HANDLERS THAT NEVER ASK `requireAdmin`, each with the reason. They read the person from the console
 * session the gateway authenticated (`consoleSessionOf`, `callerPersonId`) and decide from that, so the
 * setting this guard checks is not one they read.
 */
const READS_THE_SESSION_ITSELF: Array<{ id: RegExp; why: string }> = [
  { id: /^AdminCredentialExchangeFunction/, why: 'the admin credential exchange: it names the console sessions it reads (consoleSessionCaller)' },
  { id: /^AssistantOwnershipFunction/, why: 'ownership: the actor is the signed console session (callerPersonId), and IAM refuses a role without the route' },
  { id: /^ConversationManagementFunction/, why: 'the console archive: it accepts the route only from an admin console session (isAdminConsoleSession), and the same function serves the person routes' },
];

describe('an IAM-authorized admin route always tells its Lambda that IAM is enforced', () => {
  it('every function behind an AWS_IAM route, in every template of the app, carries ADMIN_IAM_ENFORCEMENT', () => {
    // Every admin route is on AdminApi, read on the Aurora archive with sleep mode on, which is where the
    // most admin routes are.
    const templates = auroraAppTemplates();
    const functions = Object.entries(templates).flatMap(([stack, t]) =>
      Object.entries(t.findResources('AWS::Lambda::Function')).map(([id, fn]) => ({ stack, id, fn })));
    const iamAuthed: Array<{ stack: string; id: string; vars?: Record<string, unknown>; api: string }> = [];
    for (const [api, template] of Object.entries(templates)) {
      const routes = template.findResources('AWS::ApiGatewayV2::Route');
      const integrations = template.findResources('AWS::ApiGatewayV2::Integration');
      for (const route of Object.values(routes)) {
        const props = route.Properties as Record<string, any>;
        if (props?.AuthorizationType !== 'AWS_IAM') continue;
        const integrationId = /"Ref":"([A-Za-z0-9]+)"/.exec(JSON.stringify(props.Target))?.[1];
        const handler = integrationId ? (integrations[integrationId]?.Properties as Record<string, any> | undefined)?.Description : undefined;
        for (const f of functions.filter((x) => handler && isConstruct(x.id, handler))) {
          const vars = ((f.fn.Properties as Record<string, unknown>)?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables;
          iamAuthed.push({ stack: f.stack, id: f.id, vars, api });
        }
      }
    }

    // If this is empty the test is vacuous: it would pass while asserting nothing at all. The analytics
    // query, the replay starter and the membership-audit review are among them.
    expect(iamAuthed.length).toBeGreaterThan(10);
    expect(iamAuthed.some((f) => f.id.startsWith('ClassifierReplayStartFn'))).toBe(true);
    // Every IAM-authorized route is on the admin API: the person API holds none.
    expect([...new Set(iamAuthed.map((f) => f.api))]).toEqual(['AdminApi']);
    const missing = iamAuthed
      .filter((f) => !READS_THE_SESSION_ITSELF.some((e) => e.id.test(f.id)))
      .filter((f) => f.vars?.ADMIN_IAM_ENFORCEMENT !== 'true');
    expect([...new Set(missing.map((f) => `${f.stack}/${f.id}`))]).toEqual([]);
    // And every exemption still names a function behind an IAM route, so the list stays the inventory.
    for (const e of READS_THE_SESSION_ITSELF) expect([String(e.id), iamAuthed.some((f) => e.id.test(f.id))]).toEqual([String(e.id), true]);
  }, 600_000);
});
