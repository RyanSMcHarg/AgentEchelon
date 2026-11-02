/**
 * A CLASSIFICATION'S TURN ROLE IS REFUSED A CONTEXT SOURCE ONLY ANOTHER CLASSIFICATION PUBLISHES (ADR-060 decision 1,
 * decision 3; tenets P4, D3, D12).
 *
 * A `ctx:` variable is a field of a context source its classification publishes, and a source is read under that
 * classification's acting role. So a source only classification B publishes is refused to classification A twice: A's
 * validation refuses a variable, a condition or a template binding naming it, because A's published catalog does not
 * hold it, and A's synthesized roles hold no grant on its resource, so the read itself would be refused by IAM.
 *
 * The catalog is the deployment's data (`loadContextSourceCatalog`), so the test gives premium one source of its own,
 * `x-deal-desk`, on a parameter no other classification names, and synthesizes premium and standard from it. Each
 * assertion is made on what synth emits: the statements every role and boundary holds, and the catalog parameter's
 * published value, which is the value validation reads at runtime (`contextSourceCatalogFor` in `manage-profiles.ts`).
 * The deployed half is `tests/e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts`, which asks
 * IAM's simulator about the deployed acting roles.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as contextSources from '../lib/config/context-sources';
import type { ContextSourceEntry } from '../lib/config/context-sources';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import {
  buildSourceTable,
  catalogEntryForVariables,
  sourceLookup,
  whenErrors,
  type VariableCatalogEntry,
} from '../lambda/src/lib/variables';
import { versionConditionErrors } from '../lambda/src/lib/profile-lifecycle';

type Resource = { Type: string; Properties?: Record<string, any> };

const OWNER = 'premium';
const OTHER = 'standard';
const DEAL_DESK_ARN = 'arn:aws:ssm:us-east-1:123456789012:parameter/deal-desk/premium-only';

const DEAL_DESK: ContextSourceEntry = {
  key: 'x-deal-desk',
  title: 'Deal desk',
  description: 'The open deal the room is about',
  useWhen: 'Answering about the deal under review',
  type: 'ssm-parameter',
  arn: DEAL_DESK_ARN,
  locator: '/deal-desk/premium-only',
  trust: 'operator',
  availability: 'always',
  describesPerson: false,
  maxBytes: 1024,
  fields: { stage: { type: 'string', description: 'The deal stage' } },
};

const real = contextSources.loadContextSourceCatalog;
let spy: jest.SpyInstance;

function synth(classification: string): Record<string, Resource> {
  const app = new cdk.App({ context: {} });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
}

/** Every Allow statement in a template, with the resource that holds it. */
function allows(resources: Record<string, Resource>): Array<{ owner: string; resource: string }> {
  const out: Array<{ owner: string; resource: string }> = [];
  for (const [id, r] of Object.entries(resources)) {
    const docs = r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy'
      ? [r.Properties?.PolicyDocument]
      : r.Type === 'AWS::IAM::Role' ? (r.Properties?.Policies ?? []).map((p: any) => p.PolicyDocument) : [];
    for (const doc of docs) for (const s of doc?.Statement ?? []) if (s.Effect === 'Allow') out.push({ owner: id, resource: JSON.stringify(s.Resource ?? '') });
  }
  return out;
}

/** The catalog a classification's stack publishes, as validation reads it back. */
function publishedCatalog(resources: Record<string, Resource>): VariableCatalogEntry[] {
  const param = Object.values(resources).find((r) => r.Type === 'AWS::SSM::Parameter' && /context-sources$/.test(String(r.Properties?.Name)));
  // A value carrying a deploy-time token is an `Fn::Join`; its literal parts are the published JSON around the token.
  const value = param!.Properties!.Value;
  const text = typeof value === 'string' ? value
    : (value['Fn::Join'][1] as unknown[]).map((part) => (typeof part === 'string' ? part : 'TOKEN')).join(value['Fn::Join'][0]);
  return JSON.parse(text);
}

let owner: Record<string, Resource>;
let other: Record<string, Resource>;

beforeAll(() => {
  spy = jest.spyOn(contextSources, 'loadContextSourceCatalog').mockImplementation((ctx, modules) => {
    const loaded = real(ctx, modules);
    return ctx.classification === OWNER ? { ...loaded, entries: [...loaded.entries, DEAL_DESK] } : loaded;
  });
  owner = synth(OWNER);
  other = synth(OTHER);
});
afterAll(() => spy.mockRestore());

describe(`a source only ${OWNER} publishes`, () => {
  it(`is granted to ${OWNER}'s acting role and published in ${OWNER}'s catalog (the positive control)`, () => {
    const grants = allows(owner).filter((s) => s.resource.includes(DEAL_DESK_ARN));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => /Acting/.test(g.owner))).toBe(true);
    expect(publishedCatalog(owner).map((e) => e.key)).toContain('x-deal-desk');
  });

  it(`REFUSED: no role, policy or boundary ${OTHER} synthesizes names its resource`, () => {
    expect(spy.mock.calls.some(([ctx]) => ctx.classification === OTHER)).toBe(true);
    expect(allows(other).filter((s) => s.resource.includes(DEAL_DESK_ARN))).toEqual([]);
    expect(JSON.stringify(other)).not.toContain(DEAL_DESK_ARN);
  });

  it(`REFUSED: ${OTHER}'s published catalog does not hold it, so a condition or a variable naming it is refused there`, async () => {
    const otherCatalog = publishedCatalog(other);
    expect(otherCatalog.map((e) => e.key)).not.toContain('x-deal-desk');
    const lookupIn = (c: VariableCatalogEntry[]) => sourceLookup(buildSourceTable({ catalog: c.map(catalogEntryForVariables) }));
    expect(whenErrors({ 'ctx:x-deal-desk.stage': 'won' }, lookupIn(otherCatalog)).join()).toMatch(/not a source this classification publishes/);
    expect(whenErrors({ 'ctx:x-deal-desk.stage': 'won' }, lookupIn(publishedCatalog(owner)))).toEqual([]);

    const rule = { models: { routing: [{ when: { 'ctx:x-deal-desk.stage': 'won' }, model: 'claude_sonnet' }] } } as never;
    expect(await versionConditionErrors(rule, 'p', async () => otherCatalog)).toEqual([expect.stringMatching(/x-deal-desk.*not a source this classification publishes/)]);
    expect(await versionConditionErrors(rule, 'p', async () => publishedCatalog(owner))).toEqual([]);
  });
});
