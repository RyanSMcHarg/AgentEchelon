/**
 * DECLARING `connectors` ADDS ITS OWN STACKS AND CHANGES NOTHING ELSE BUT ITS ATTACH POINTS (C6, K5).
 *
 * The deploy matrix's C6 (`test/deploy-matrix/c6-connectors.test.ts`) checks C6 against C5 as a whole,
 * the widget included. This suite isolates `connectors` itself: it runs the same four checks on what C6 adds, through the real CDK app in both analytics modes: C5's built
 * capabilities, then the same plus `connectors` with C6's one vendor (PagerDuty, subscribing to incident
 * events through its EventBridge partner event source), and again with a connector that takes per-person
 * grants.
 *
 *  - the stack set is the base plus `Connectors`, and nothing else: a subscribing connector adds a rule
 *    on its partner event bus, never an API (`IngressApi` is NOT BUILT);
 *  - the component rule holds;
 *  - against the base, every earlier stack is still there and changes only where it is an attach point
 *    (`PersonApi` gains the grant routes; `Identity` gains the revoker's name on offboarding, add-only);
 *  - every SSM parameter a stack resolves at deploy is published by a stack it deploys after.
 */
import * as path from 'path';
import { synthesizeApp } from '../lib/docs/api-contract';
import { PAGERDUTY_CONNECTOR, type AnalyticsMode } from './deploy-matrix/configurations';
import {
  additivityViolations, assistantParameterViolations, componentRuleViolations, ssmEdgeViolations, stackSet, type Synthesized,
} from './deploy-matrix/matrix';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;
const BASE = ['chat', 'admin', 'operations', 'notifications'];
const GRANTS_CONNECTOR = { id: 'crm', vendor: 'salesforce', grants: { redirectUris: ['https://app.example.com/connectors/callback'] } };

function synth(mode: AnalyticsMode, capabilities: string[], connectors?: unknown[]): Synthesized {
  const app = synthesizeApp(REPO_ROOT, {
    id: `connectors-${mode}-${capabilities.length}-${connectors?.length ?? 0}`,
    context: { analyticsMode: mode, capabilities, ...(connectors ? { connectors } : {}) },
  });
  const prefix = Object.keys(app.dependencies).find((s) => s.endsWith('PostProcessing'))!.slice(0, -'PostProcessing'.length);
  const strip = (s: string) => (s.startsWith(prefix) ? s.slice(prefix.length) : s);
  const out: Synthesized = { templates: {}, dependencies: {} };
  for (const [s, t] of Object.entries(app.templates)) out.templates[strip(s)] = t as Synthesized['templates'][string];
  for (const [s, d] of Object.entries(app.dependencies)) out.dependencies[strip(s)] = d.map(strip);
  return out;
}

describe.each(['athena', 'aurora'] as const)('connectors on C5\'s built capabilities (%s)', (mode) => {
  let base: Synthesized;
  let c6: Synthesized;
  let withGrants: Synthesized;
  beforeAll(() => {
    base = synth(mode, BASE);
    c6 = synth(mode, [...BASE, 'connectors'], [PAGERDUTY_CONNECTOR]);
    withGrants = synth(mode, [...BASE, 'connectors'], [PAGERDUTY_CONNECTOR, GRANTS_CONNECTOR]);
  }, SYNTH_TIMEOUT_MS);

  it('adds Connectors, and nothing else', () => {
    expect(stackSet(c6)).toEqual([...stackSet(base), 'Connectors'].sort());
    expect(stackSet(withGrants)).toEqual(stackSet(c6));
  });

  it('receives the subscribing connector\'s events through a rule on its partner event bus, and serves it no route', () => {
    const rules = Object.values(c6.templates.Connectors.Resources ?? {}).filter((r) => r.Type === 'AWS::Events::Rule' && (r.Properties as Record<string, unknown>)?.EventPattern);
    expect(rules.map((r) => (r.Properties as Record<string, unknown>).EventBusName)).toEqual([PAGERDUTY_CONNECTOR.eventSource]);
    expect(JSON.stringify(c6.templates.PersonApi)).not.toContain('/webhooks/');
    expect(JSON.stringify(c6.templates.Connectors)).not.toContain('AWS::ApiGatewayV2');
  });

  it('keeps the component rule', () => {
    expect(componentRuleViolations(c6)).toEqual([]);
    expect(componentRuleViolations(withGrants)).toEqual([]);
  });

  it('changes nothing of the base outside its attach points', () => {
    expect(additivityViolations(base, c6)).toEqual([]);
    expect(additivityViolations(base, withGrants)).toEqual([]);
  });

  it('leaves Identity and PersonApi untouched when no connector takes grants', () => {
    expect(JSON.stringify(c6.templates.Identity)).not.toContain('CONNECTOR_GRANTS_FUNCTION');
    expect(JSON.stringify(withGrants.templates.Identity)).toContain('CONNECTOR_GRANTS_FUNCTION');
    expect(JSON.stringify(c6.templates.PersonApi)).not.toContain('/connectors/{connectorId}/grant');
    expect(JSON.stringify(withGrants.templates.PersonApi)).toContain('/connectors/{connectorId}/grant');
  });

  it('deploys every SSM reader after its writer', () => {
    expect(ssmEdgeViolations(withGrants)).toEqual([]);
    expect(assistantParameterViolations(withGrants)).toEqual([]);
  });

  it('builds no receiver and no rule when no connector subscribes', () => {
    const quiet = synth(mode, [...BASE, 'connectors'], [GRANTS_CONNECTOR]);
    expect(stackSet(quiet)).toEqual([...stackSet(base), 'Connectors'].sort());
    expect(JSON.stringify(quiet.templates.Connectors)).not.toContain('ConnectorEventReceiver');
    expect(additivityViolations(base, quiet)).toEqual([]);
  }, SYNTH_TIMEOUT_MS);
});
