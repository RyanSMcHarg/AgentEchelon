/**
 * ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT (ADR-048, amended 2026-10-24), across the whole synthesized app.
 *
 * Every assistant's identity and Amazon Lex bot are built and removed by the provisioner, on a session of one role
 * (`RuntimeAssistantProvisionerRole`, in `Messaging`). What is pinned, over every template of the app (nested stacks
 * included), with and without `admin`:
 *   - exactly one role holds an identity or Amazon Lex build or delete action, and it is that one;
 *   - every seed's role (each `Assistants-<classification>`'s, and the admin assistant's) holds `lambda:InvokeFunction`
 *     on the provisioner, a claim write under its own classification's path, and its own stack's status, and
 *     nothing else of its own (the app-wide registry read and write denial excepted);
 *   - each claim path is writable by one role: a classification's by its seed, the console's by `manage-assistants`,
 *     and no role holds a parameter write broad enough to reach every claim;
 *   - the roles that may invoke the provisioner are the seeds' and `manage-assistants`', and no other;
 *   - the provisioner exists before any stack that asks it: every stack holding a seed deploys after `Messaging`.
 */
import * as path from 'path';
import { synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';
import { ASSISTANT_PROVISIONER_FUNCTION_NAME, SSM_ROOT } from '../lib/stacks/agent-classification-common';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource?: unknown };
type Resource = { Type: string; Properties?: Record<string, any> };
type Template = { Resources?: Record<string, Resource> };

const BUILD_ACTIONS = [
  'chime:CreateAppInstanceBot', 'chime:DeleteAppInstanceBot',
  'lex:CreateBot', 'lex:DeleteBot', 'lex:CreateBotLocale', 'lex:BuildBotLocale', 'lex:UpdateBotAlias', 'lex:CreateResourcePolicy',
];
const PROVISIONER_ARN = `arn:aws:lambda:us-east-1:123456789012:function:${ASSISTANT_PROVISIONER_FUNCTION_NAME}`;
/** Parameter grants broad enough to reach every claim path: every parameter, the deployment's root, the claims' root. */
const OVER_EVERY_CLAIM = ['*', ':parameter/*', `:parameter${SSM_ROOT}/*`, `:parameter${SSM_ROOT}/provisioner-claims/*`];

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** An IAM action or resource pattern, as a regular expression. */
const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
/** A resource as text a pattern is matched against: a token's parts joined, so a `Fn::Join` of the name reads as the name. */
const flat = (r: unknown): string => {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && Array.isArray((r as { 'Fn::Join'?: unknown[] })['Fn::Join'])) {
    const [, parts] = (r as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
    return parts.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'Ref' in (x as object) ? ((x as { Ref: string }).Ref === 'AWS::Partition' ? 'aws' : (x as { Ref: string }).Ref === 'AWS::Region' ? 'us-east-1' : (x as { Ref: string }).Ref === 'AWS::AccountId' ? '123456789012' : '#token#') : '#token#')).join('');
  }
  // Any other token names a resource of the app that is not a pattern: it matches nothing by itself.
  return '#token#';
};

/** Every role of every template, as `<stack>/<logical id>`, with the statements it holds (never its boundary). */
function rolesOf(app: SynthesizedApp): Map<string, Statement[]> {
  const out = new Map<string, Statement[]>();
  for (const [stack, raw] of Object.entries(app.templates)) {
    const resources = Object.entries((raw as Template).Resources ?? {});
    for (const [id, r] of resources) {
      if (r.Type !== 'AWS::IAM::Role') continue;
      const inline = list(r.Properties?.Policies).flatMap((p: any) => list(p.PolicyDocument?.Statement) as Statement[]);
      const attached = resources
        .filter(([, x]) => (x.Type === 'AWS::IAM::Policy' || x.Type === 'AWS::IAM::ManagedPolicy') && JSON.stringify(x.Properties?.Roles ?? []).includes(`"${id}"`))
        .flatMap(([, x]) => list(x.Properties!.PolicyDocument?.Statement) as Statement[]);
      const managed = list(r.Properties?.ManagedPolicyArns)
        .map((m: any) => (m && typeof m === 'object' && typeof m.Ref === 'string' ? resources.find(([pid]) => pid === m.Ref)?.[1] : undefined))
        .filter((x): x is Resource => !!x && x.Type === 'AWS::IAM::ManagedPolicy')
        .flatMap((x) => list(x.Properties!.PolicyDocument?.Statement) as Statement[]);
      out.set(`${stack}/${id}`, [...inline, ...attached, ...managed]);
    }
  }
  return out;
}

const names = (s: Statement, action: string) => list(s.Action).some((a) => glob(a).test(action));
const allows = (s: Statement, action: string) => s.Effect !== 'Deny' && names(s, action);
/** Whether a role may take an action at all: an allow for it, and no deny of it on every resource. */
const mayTake = (ss: Statement[], action: string) => ss.some((s) => allows(s, action))
  && !ss.some((s) => s.Effect === 'Deny' && names(s, action) && list(s.Resource).includes('*'));
const reaches = (s: Statement, arn: string) => list(s.Resource).some((r) => glob(flat(r)).test(arn));
/** The registry read and write denial every role carries (`profile-registry-readers.ts`), and nothing of its own. */
const appWide = (s: Statement) => s.Effect === 'Deny' || /^ReadTheProfileRegistry/.test(s.Sid ?? '');

const memo = new Map<string, SynthesizedApp>();
function synth(capabilities: string[]): SynthesizedApp {
  const key = capabilities.join(',');
  if (!memo.has(key)) memo.set(key, synthesizeApp(REPO_ROOT, { id: `one-principal-${key || 'core'}`, context: { analyticsMode: 'athena', capabilities } }));
  return memo.get(key)!;
}

describe.each([
  ['with admin', ['chat', 'admin', 'experiments', 'battle']],
  ['without admin', ['chat']],
])('a deployment %s', (_label, capabilities) => {
  let app: SynthesizedApp;
  let roles: Map<string, Statement[]>;
  beforeAll(() => { app = synth(capabilities); roles = rolesOf(app); }, SYNTH_TIMEOUT_MS);

  it('has exactly one role that can build or remove an identity or an Amazon Lex bot: the provisioner session', () => {
    const builders = [...roles].filter(([, ss]) => BUILD_ACTIONS.some((a) => mayTake(ss, a))).map(([r]) => r);
    expect(builders).toHaveLength(1);
    expect(builders[0]).toMatch(/Messaging\/RuntimeAssistantProvisionerRole[0-9A-F]{8}$/);
  });

  it("every seed role holds its own grants alone: invoking the provisioner, its own classification's claim path, its own stack's status", () => {
    const seeds = [...roles].filter(([r]) => /\/(DeclaredAssistantsRole|AdminAgentSeedRole)[0-9A-F]{8}$/.test(r));
    // Each classification's, and the admin assistant's where admin is declared.
    expect(seeds.length).toBeGreaterThanOrEqual(capabilities.includes('admin') ? 2 : 1);
    expect(seeds.some(([r]) => /AdminAgentSeedRole/.test(r))).toBe(capabilities.includes('admin'));
    for (const [r, ss] of seeds) {
      const own = ss.filter((s) => !appWide(s));
      expect({ r, own: own.map((s) => ({ actions: list(s.Action).sort(), invokesTheProvisioner: reaches(s, PROVISIONER_ARN) })) }).toEqual({ r, own: [
        { actions: ['lambda:InvokeFunction'], invokesTheProvisioner: true },
        { actions: ['ssm:DeleteParameter', 'ssm:PutParameter'], invokesTheProvisioner: false },
        { actions: ['cloudformation:DescribeStacks'], invokesTheProvisioner: false },
      ] });
      // ONE classification's claim path, never a wildcard over them.
      const claimPaths = own.filter((s) => names(s, 'ssm:PutParameter')).flatMap((s) => list(s.Resource).map(flat));
      expect({ r, claimPaths }).toEqual({ r, claimPaths: [expect.stringMatching(/\/provisioner-claims\/seed\/[a-z0-9-]+\/\*$/)] });
    }
  });

  it("no two roles may write one claim path: each classification's is its seed's alone, and the console's is manage-assistants' alone", () => {
    const claimWriters = new Map<string, string[]>();
    for (const [r, ss] of roles) {
      for (const s of ss.filter((x) => allows(x, 'ssm:PutParameter'))) {
        for (const res of list(s.Resource).map(flat)) {
          const m = /\/provisioner-claims\/(.*)$/.exec(res);
          if (m) claimWriters.set(m[1], [...(claimWriters.get(m[1]) ?? []), r]);
          // A grant over every parameter, or over the deployment's root, would reach every claim.
          else expect({ r, res, reachesEveryClaim: OVER_EVERY_CLAIM.some((p) => (p === '*' ? res === '*' : res.endsWith(p))) }).toEqual({ r, res, reachesEveryClaim: false });
        }
      }
    }
    for (const [p, writers] of claimWriters) {
      expect({ p, writers }).toEqual({ p, writers: [expect.stringMatching(p === 'console/*' ? /ManageAssistantsRole/ : /(DeclaredAssistantsRole|AdminAgentSeedRole)/)] });
      expect(p).toMatch(/^(console|seed\/[a-z0-9-]+)\/\*$/);
    }
    expect([...claimWriters.keys()].some((p) => p === 'console/*')).toBe(capabilities.includes('admin'));
  });

  it('only the seeds and manage-assistants may invoke the provisioner', () => {
    const invokers = [...roles].filter(([, ss]) => ss.some((s) => allows(s, 'lambda:InvokeFunction') && reaches(s, PROVISIONER_ARN))).map(([r]) => r);
    const allowed = /\/(DeclaredAssistantsRole|AdminAgentSeedRole|ManageAssistantsRole)[0-9A-F]{8}$/;
    expect(invokers.filter((r) => !allowed.test(r))).toEqual([]);
    expect(invokers.some((r) => /ManageAssistantsRole/.test(r))).toBe(capabilities.includes('admin'));
  });

  it('the provisioner is in Messaging, and every stack holding a seed deploys after it', () => {
    const fns = Object.entries(app.templates).flatMap(([stack, t]) => Object.entries((t as Template).Resources ?? {})
      .filter(([, r]) => r.Type === 'AWS::Lambda::Function' && r.Properties?.FunctionName === ASSISTANT_PROVISIONER_FUNCTION_NAME)
      .map(([id]) => `${stack}/${id}`));
    expect(fns).toEqual([expect.stringMatching(/Messaging\/AssistantProvisionerFunction/)]);
    const messaging = Object.keys(app.dependencies).find((s) => /Messaging$/.test(s))!;
    const after = (stack: string, seen = new Set<string>()): boolean => (app.dependencies[stack] ?? [])
      .some((d) => d === messaging || (!seen.has(d) && (seen.add(d), after(d, seen))));
    const seeded = Object.entries(app.templates)
      .filter(([, t]) => Object.values((t as Template).Resources ?? {}).some((r) => r.Type === 'Custom::DeclaredAssistants'))
      .map(([s]) => s.split('.')[0]);
    expect(seeded.length).toBeGreaterThan(0);
    for (const s of seeded) expect({ s, afterMessaging: after(s) }).toEqual({ s, afterMessaging: true });
  });
});
