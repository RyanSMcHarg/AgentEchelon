/**
 * THE CORE HOLDS EACH THING ONCE, IN THE STACK THAT OWNS IT, AND DEPLOYS IN ONE ORDER.
 *
 * The required core is `Messaging`, `Identity`, `Conversations` and `Archive`, then the channel flow, the
 * assistant stacks and post-processing. Each holds what it owns and nothing another stack owns:
 *
 *  - the message stream and the app instance's streaming configuration exist once, in `Messaging`, and
 *    the archive and post-processing consume them by reference, in both archive modes;
 *  - there is no Identity Pool anywhere: every credential a person holds is vended by the exchange;
 *  - the platform trail is in `Identity`, beside the roles whose use it records;
 *  - the only SES send grant is in `Notifications`, so a deployment that does not declare email holds
 *    no grant to send it;
 *  - `Archive` is one stack name in either mode and says which mode it is in its `AnalyticsMode` output;
 *  - `Operations` holds a dashboard and nothing else: every stack keeps its own alarms.
 *
 * And the wiring every stack shares is one value read in one place:
 *
 *  - production retains every table (`lib/config/environment.ts`), so a teardown or a replaced stack
 *    never deletes a production table;
 *  - every SSM parameter the deployment writes is under its own root (`SSM_ROOT`), so two instances in
 *    one account never share a parameter.
 *
 * Synthesized through the real CDK app (`synthesizeApp`) with every built capability declared, so the
 * templates are the ones `cdk deploy --all` would create.
 */
import * as path from 'path';
import { synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';
import { CAPABILITIES } from '../lib/config/capabilities';
import { SSM_ROOT } from '../lib/stacks/agent-classification-common';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Resource = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Template = { Resources?: Record<string, Resource>; Outputs?: Record<string, { Value?: unknown }> };

const BUILT = CAPABILITIES.filter((c) => !c.notBuilt).map((c) => c.name);

/** Templates by stack name without the instance prefix (`ImageGuardrail-*` included). */
function byName(app: SynthesizedApp): { templates: Record<string, Template>; dependencies: Record<string, string[]> } {
  const anchor = Object.keys(app.dependencies).find((s) => s.endsWith('PostProcessing'))!;
  const prefix = anchor.slice(0, -'PostProcessing'.length);
  const strip = (s: string): string => (s.startsWith(prefix) ? s.slice(prefix.length) : s);
  const templates: Record<string, Template> = {};
  const dependencies: Record<string, string[]> = {};
  for (const [s, t] of Object.entries(app.templates)) templates[strip(s)] = t as Template;
  for (const [s, d] of Object.entries(app.dependencies)) dependencies[strip(s)] = d.map(strip);
  return { templates, dependencies };
}

/** Every resource of a type, with the stack it is in. */
function resourcesOfType(templates: Record<string, Template>, type: RegExp): Array<{ stack: string; id: string; resource: Resource }> {
  return Object.entries(templates).flatMap(([stack, t]) => Object.entries(t.Resources ?? {})
    .filter(([, r]) => type.test(r.Type))
    .map(([id, resource]) => ({ stack, id, resource })));
}

/** The stacks whose IAM policies grant an action. */
function stacksGranting(templates: Record<string, Template>, action: string): string[] {
  return [...new Set(resourcesOfType(templates, /^AWS::IAM::(Policy|Role|ManagedPolicy)$/)
    .filter(({ resource }) => JSON.stringify(resource.Properties ?? {}).includes(`"${action}"`))
    .map(({ stack }) => stack))].sort();
}

function dependsOnTransitively(dependencies: Record<string, string[]>, stack: string): Set<string> {
  const seen = new Set<string>();
  const walk = (s: string): void => {
    for (const d of dependencies[s] ?? []) if (!seen.has(d)) { seen.add(d); walk(d); }
  };
  walk(stack);
  return seen;
}

describe.each(['athena', 'aurora'] as const)('the core, every built capability declared, in production (%s)', (mode) => {
  let templates: Record<string, Template>;
  let dependencies: Record<string, string[]>;
  beforeAll(() => {
    ({ templates, dependencies } = byName(synthesizeApp(REPO_ROOT, {
      id: `core-${mode}`,
      context: { analyticsMode: mode, capabilities: BUILT, environment: 'production' },
    })));
  }, SYNTH_TIMEOUT_MS);

  it('deploys Messaging, Identity, Conversations and Archive in that order', () => {
    const order = ['Messaging', 'Identity', 'Conversations', 'Archive'];
    for (const s of order) expect(Object.keys(templates)).toContain(s);
    order.forEach((stack, i) => {
      const before = dependsOnTransitively(dependencies, stack);
      for (const earlier of order.slice(0, i)) expect({ stack, after: earlier, ok: before.has(earlier) }).toEqual({ stack, after: earlier, ok: true });
    });
  });

  it('holds the message stream and its streaming configuration once, in Messaging', () => {
    expect(resourcesOfType(templates, /^AWS::Kinesis::Stream$/).map((r) => r.stack)).toEqual(['Messaging']);
    const streaming = Object.entries(templates).filter(([, t]) => JSON.stringify(t.Resources ?? {}).includes('putMessagingStreamingConfigurations'));
    expect(streaming.map(([s]) => s)).toEqual(['Messaging']);
  });

  it('has no Identity Pool anywhere', () => {
    expect(resourcesOfType(templates, /^AWS::Cognito::IdentityPool/)).toEqual([]);
  });

  it('keeps the platform trail in Identity', () => {
    expect(resourcesOfType(templates, /^AWS::CloudTrail::Trail$/).map((r) => r.stack)).toEqual(['Identity']);
  });

  it('grants an SES send in the Notifications stack only', () => {
    expect(stacksGranting(templates, 'ses:SendEmail')).toEqual(['Notifications']);
  });

  it('gives every function that re-checks a team\'s scope the person-to-groups read it resolves ownership by', () => {
    // A team member's groups are read by person: their issuer subjects from Identities, then each one's
    // groups. Without IDENTITIES_TABLE every team member's ownership was "unresolvable", and Profiles
    // refused them their own assistant.
    const scoped = resourcesOfType(templates, /^AWS::Lambda::Function$/)
      .filter(({ id }) => /ManageProfilesFunction|AdminExperimentsFunction/.test(id));
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    for (const { stack, id, resource } of scoped) {
      expect([stack, id, Object.keys(resource.Properties?.Environment?.Variables ?? {}).includes('IDENTITIES_TABLE')]).toEqual([stack, id, true]);
    }
  });

  it('creates every route a stage throttles before the stage, so a fresh deploy finds it', () => {
    // A stage's RouteSettings name routes by key, which CloudFormation does not read as a reference. A fresh
    // PersonApi failed with "Unable to find Route by key GET /turn-state" until the stage depended on them.
    const stages = resourcesOfType(templates, /^AWS::ApiGatewayV2::Stage$/);
    const throttling = stages.filter(({ resource }) => Object.keys(resource.Properties?.RouteSettings ?? {}).length);
    expect(throttling.length).toBeGreaterThan(0);
    for (const { stack, resource } of throttling) {
      const routes = Object.entries(templates[stack].Resources ?? {}).filter(([, r]) => r.Type === 'AWS::ApiGatewayV2::Route');
      const dependsOn = new Set<string>([(resource as { DependsOn?: string | string[] }).DependsOn ?? []].flat());
      for (const key of Object.keys(resource.Properties!.RouteSettings)) {
        const route = routes.find(([, r]) => r.Properties?.RouteKey === key);
        expect([stack, key, route ? 'found' : 'missing']).toEqual([stack, key, 'found']);
        expect([stack, key, dependsOn.has(route![0])]).toEqual([stack, key, true]);
      }
    }
  });

  it('lets the invitation and claim functions hand their email to Notifications, by a grant Notifications attaches', () => {
    const handOff = resourcesOfType(templates, /^AWS::IAM::Policy$/)
      .filter(({ resource }) => JSON.stringify(resource.Properties ?? {}).includes('TransactionalMailFunction') && JSON.stringify(resource.Properties ?? {}).includes('"lambda:InvokeFunction"'));
    expect(handOff.map(({ stack }) => stack)).toEqual(['Notifications']);
    expect(JSON.stringify(handOff[0].resource.Properties?.Roles)).toMatch(/Invitations|GuestUpgrade/);
  });

  it('names its archive mode in the Archive stack output', () => {
    expect(templates.Archive.Outputs?.AnalyticsMode?.Value).toBe(mode);
  });

  it('holds a dashboard in Operations and nothing else', () => {
    const types = [...new Set(Object.values(templates.Operations.Resources ?? {}).map((r) => r.Type))].filter((t) => t !== 'AWS::CDK::Metadata');
    expect(types).toEqual(['AWS::CloudWatch::Dashboard']);
  });

  it('retains every table in production', () => {
    const tables = resourcesOfType(templates, /^AWS::DynamoDB::(Table|GlobalTable)$/);
    // Non-vacuity: the core and the capabilities hold tables in several stacks.
    expect(new Set(tables.map((t) => t.stack)).size).toBeGreaterThan(4);
    expect(tables.filter(({ resource }) => resource.DeletionPolicy !== 'Retain').map(({ stack, id }) => `${stack}/${id}`)).toEqual([]);
  });

  it('writes every SSM parameter under this deployment\'s own root', () => {
    const params = resourcesOfType(templates, /^AWS::SSM::Parameter$/);
    expect(params.length).toBeGreaterThan(10);
    const outside = params
      .map(({ stack, id, resource }) => ({ at: `${stack}/${id}`, name: resource.Properties?.Name }))
      // CDK's own cross-region references (the image guardrails) are written under `/cdk/` by CDK.
      .filter(({ name }) => !(typeof name === 'string' && (name.startsWith(`${SSM_ROOT}/`) || name.startsWith('/cdk/'))));
    expect(outside).toEqual([]);
  });
});

describe('outside production (athena)', () => {
  it('destroys the conversation tables with their stack, so a teardown leaves nothing to block a fresh deploy', () => {
    const { templates } = byName(synthesizeApp(REPO_ROOT, { id: 'core-dev', context: { analyticsMode: 'athena', capabilities: [] } }));
    const tables = resourcesOfType(templates, /^AWS::DynamoDB::Table$/).filter((t) => t.stack === 'Conversations');
    expect(tables.length).toBeGreaterThan(5);
    expect(tables.filter(({ resource }) => resource.DeletionPolicy !== 'Delete').map(({ id }) => id)).toEqual([]);
  }, SYNTH_TIMEOUT_MS);
});
