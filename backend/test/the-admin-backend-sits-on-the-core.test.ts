/**
 * THE ADMIN BACKEND SITS ON THE CORE, AND THE CORE KNOWS NOTHING OF IT (D7, L2, L3).
 *
 *  - C2 without `experiments` synthesizes: profile administration, ownership and the roster are admin
 *    handlers, so a deployment with `admin` and no `experiments` manages its assistants and runs no
 *    experiment. The experiment routes join `AdminServices` only when `experiments` is declared.
 *  - No core stack reads an admin-channel ARN: a core alert is an `ae.alert` event on the default bus, and
 *    the rule that posts it into the admin channel exists only in `AdminServices`.
 *  - The admin credential exchange's token route is the admin backend's own, so the core's exchange
 *    carries no admin route.
 */
import * as path from 'path';
import { synthesizeApp, SYNTH_CAPABILITIES, type SynthesizedApp } from '../lib/docs/api-contract';
import { componentRuleViolations, ssmEdgeViolations, assistantParameterViolations, type Synthesized } from './deploy-matrix/matrix';
import { isCoreStack } from './deploy-matrix/configurations';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = { Resources?: Record<string, Resource>; Parameters?: Record<string, unknown> };

/** The app with the instance prefix stripped from every stack name, nested templates included. */
function stripped(app: SynthesizedApp): Synthesized & { templates: Record<string, Template> } {
  const prefix = Object.keys(app.dependencies).find((s) => s.endsWith('PostProcessing'))!.slice(0, -'PostProcessing'.length);
  const strip = (s: string) => (s.startsWith(prefix) ? s.slice(prefix.length) : s);
  return {
    templates: Object.fromEntries(Object.entries(app.templates).map(([s, t]) => [strip(s), t as Template])),
    dependencies: Object.fromEntries(Object.entries(app.dependencies).map(([s, d]) => [strip(s), d.map(strip)])),
  } as never;
}

/** The routes an HTTP API in a template serves, as `METHOD /path`. */
function routes(t: Template | undefined): string[] {
  return Object.values(t?.Resources ?? {}).filter((r) => r.Type === 'AWS::ApiGatewayV2::Route').map((r) => String(r.Properties?.RouteKey));
}

describe.each(['athena', 'aurora'] as const)('C2 without experiments (%s)', (mode) => {
  let app: ReturnType<typeof stripped>;
  beforeAll(() => {
    app = stripped(synthesizeApp(REPO_ROOT, { id: `c2-no-experiments-${mode}`, context: { analyticsMode: mode, capabilities: ['chat', 'admin', 'operations'] } }));
  }, SYNTH_TIMEOUT_MS);

  it('synthesizes, with the admin backend and no Experiments stack', () => {
    const stacks = Object.keys(app.dependencies);
    expect(stacks).toEqual(expect.arrayContaining(['AdminServices', 'AdminApp']));
    expect(stacks).not.toContain('Experiments');
  });

  it('keeps the component rule and deploys every SSM reader after its writer', () => {
    expect(componentRuleViolations(app)).toEqual([]);
    expect(ssmEdgeViolations(app)).toEqual([]);
    expect(assistantParameterViolations(app)).toEqual([]);
  });

  it('administers profiles, ownership and the roster, and routes no experiment', () => {
    const all = routes(app.templates.AdminApi);
    for (const r of ['GET /admin/profiles', 'POST /admin/profiles/activate', 'POST /admin/profiles/rollback', 'GET /admin/ownership', 'POST /admin/roster']) {
      expect([r, all.includes(r)]).toEqual([r, true]);
    }
    expect(all.filter((r) => /\/experiments|variant-version/.test(r))).toEqual([]);
  });
});

describe('every built capability (athena)', () => {
  let app: ReturnType<typeof stripped>;
  beforeAll(() => {
    app = stripped(synthesizeApp(REPO_ROOT, { id: 'admin-on-the-core', context: { analyticsMode: 'athena', capabilities: [...SYNTH_CAPABILITIES] } }));
  }, SYNTH_TIMEOUT_MS);

  it('routes the experiments through AdminApi once experiments is declared', () => {
    const all = routes(app.templates.AdminApi);
    expect(all).toEqual(expect.arrayContaining(['GET /admin/experiments', 'POST /admin/profiles/variant-version']));
    // And the Experiments stack holds the table and its contract, and no route.
    expect(routes(app.templates.Experiments)).toEqual([]);
  });

  it('has the ae.alert rule in AdminServices and nowhere else', () => {
    const rules = Object.entries(app.templates).flatMap(([stack, t]) => Object.values(t.Resources ?? {})
      .filter((r) => r.Type === 'AWS::Events::Rule' && JSON.stringify(r.Properties?.EventPattern?.source ?? []).includes('ae.alert'))
      .map(() => stack));
    expect(rules).toEqual(['AdminServices']);
  });

  it('reads no admin-channel ARN, agent or parameter in any core stack', () => {
    const core = Object.entries(app.templates).filter(([s]) => isCoreStack(s));
    expect(core.length).toBeGreaterThan(5);
    const offenders = core.filter(([, t]) => /admin-notification\/channel-arn|assistant\/admin-agent\/bot-arn|ADMIN_ALERT_CHANNEL|ADMIN_ALERT_BEARER|aeChannelKind/.test(JSON.stringify(t)))
      .map(([s]) => s);
    expect(offenders).toEqual([]);
  });

  it('raises a core alert as an event: the core alert posters hold events:PutEvents for ae.alert', () => {
    const core = Object.entries(app.templates).filter(([s]) => isCoreStack(s));
    const puts = core.flatMap(([stack, t]) => Object.values(t.Resources ?? {})
      .filter((r) => r.Type === 'AWS::IAM::Policy')
      .flatMap((p) => p.Properties!.PolicyDocument.Statement as Array<{ Action: unknown; Condition?: any }>)
      .filter((st) => ([] as unknown[]).concat(st.Action).includes('events:PutEvents'))
      .map((st) => [stack, st.Condition?.StringEquals?.['events:source']] as const));
    // The assistant stacks (processor, router, context-source alarm) and the archive (membership audit).
    expect(new Set(puts.map(([s]) => s.replace(/-.*$/, '')))).toEqual(new Set(['Assistants', 'Archive']));
    for (const [, source] of puts) expect(source).toEqual(['ae.alert']);
  });

  it('carries no admin route on the person API, whose one exchange route is the person exchange', () => {
    const person = routes(app.templates.PersonApi);
    expect(person.filter((r) => r.includes('/exchange-credentials'))).toEqual(['POST /exchange-credentials']);
    expect(person.filter((r) => /\/(admin|users|query)(\/|$)/.test(r))).toEqual([]);
    // The core stacks hold handlers and no API: every route is on one of the two HTTP APIs.
    for (const s of ['Identity', 'Conversations', 'Archive', 'AdminServices']) expect([s, routes(app.templates[s])]).toEqual([s, []]);
  });
});
