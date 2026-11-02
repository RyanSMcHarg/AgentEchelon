/**
 * AN INVOKE GRANTED BY NAME PATTERN REACHES ONLY THIS INSTANCE'S FUNCTIONS (tenet P4).
 *
 * A stack that deploys before the assistant stacks cannot name their routers or task services by ARN,
 * so it grants `lambda:InvokeFunction` on a pattern (`${STACK_PREFIX}*-AgentHandler*`,
 * `${STACK_PREFIX}*TaskService*`). Two things bound such a pattern, and neither alone is enough:
 *
 *  - THE INSTANCE PREFIX. A pattern that starts with a wildcard reaches every product deployed in the
 *    account and region, so none may.
 *  - THE `Instance` TAG. A prefix also matches every instance whose prefix starts with this one:
 *    `AgentEchelon*TaskService*` names `AgentEchelonTwoAssistants-basic-TaskService...`
 *    too. So every pattern grant is conditioned on the function's `Instance` tag
 *    (`ownInstanceFunctions`, or `ownInstanceFunctionsOnly` for a function of no classification), and
 *    one that reaches an assistant's function on its `classification` tag as well.
 *
 * The functions the grants are meant to reach carry both tags, so the condition narrows the grant
 * without refusing them.
 *
 * Read from the synthesized app with every built capability declared, because the tags are applied at
 * the app root and a stack synthesized on its own does not carry them.
 */
import * as path from 'path';
import { SYNTH_CAPABILITIES, synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';
import { INSTANCE_NAME, STACK_PREFIX } from '../lib/stacks/agent-classification-common';
import { INSTANCE_TAG } from '../lib/tagging';
import { classificationReachOf, reaches } from './helpers/classification-reach';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Statement = { Effect?: string; Action?: unknown; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties?: Record<string, any> };

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Every policy statement in the app, with where it came from. */
function statements(app: SynthesizedApp): Array<{ where: string; s: Statement }> {
  const out: Array<{ where: string; s: Statement }> = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    for (const [id, r] of Object.entries((t.Resources ?? {}) as Record<string, Resource>)) {
      const p = r.Properties ?? {};
      const docs = r.Type === 'AWS::IAM::Role' ? list(p.Policies).map((x: any) => x.PolicyDocument)
        : r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy' ? [p.PolicyDocument] : [];
      for (const d of docs) for (const s of list((d as any)?.Statement) as Statement[]) out.push({ where: `${stack}/${id}`, s });
    }
  }
  return out;
}

/** A resource as a plain string: a literal, or a `Fn::Join` of literals and pseudo-parameter refs. */
function rendered(r: unknown): string {
  if (typeof r === 'string') return r;
  const join = (r as any)?.['Fn::Join'];
  if (join) return (join[1] as unknown[]).map((p) => (typeof p === 'string' ? p : '${token}')).join(join[0]);
  return JSON.stringify(r);
}

/** The function-name part of a Lambda ARN, or undefined for a resource that names no function. */
const functionName = (resource: string): string | undefined => resource.split(':function:')[1];

/** Every invoke granted on a function-name pattern (a wildcard anywhere in the name). */
function patternInvokes(app: SynthesizedApp) {
  return statements(app)
    .filter(({ s }) => s.Effect === 'Allow' && list(s.Action).some((a) => String(a) === 'lambda:InvokeFunction'))
    .flatMap(({ where, s }) => list(s.Resource).map(rendered)
      .filter((r) => functionName(r)?.includes('*'))
      .map((resource) => ({ where, s, resource })));
}

/** The assistant stacks' functions a pattern names: their construct ids. */
const ASSISTANT_FUNCTIONS = /(AgentHandler|TaskService|AssistantVend|ApplyAssistantName|ConversationCreator)/;

const tagsOf = (r: Resource): Record<string, string> =>
  Object.fromEntries(list(r.Properties?.Tags).map((t: any) => [t.Key, t.Value]));

describe('an invoke granted by name pattern reaches only its own instance', () => {
  let app: SynthesizedApp;
  beforeAll(() => {
    app = synthesizeApp(REPO_ROOT, { id: 'aurora+capabilities', context: { analyticsMode: 'aurora', capabilities: [...SYNTH_CAPABILITIES] } });
  }, SYNTH_TIMEOUT_MS);

  it('the router, task service and data-plane pattern grants exist (the checks below are not vacuous)', () => {
    const patterns = patternInvokes(app).map(({ resource }) => functionName(resource));
    expect(patterns).toContain(`${STACK_PREFIX}*-AgentHandler*`);
    expect(patterns).toContain(`${STACK_PREFIX}*TaskService*`);
    expect(patterns).toContain(`${STACK_PREFIX}Assistants-*-ConversationCreator`);
    expect(patterns).toContain(`${STACK_PREFIX}Archive*DataPlaneLambda*`);
  });

  it('no pattern grant starts with a wildcard: each names the instance prefix', () => {
    const unprefixed = patternInvokes(app)
      .filter(({ resource }) => !functionName(resource)!.startsWith(STACK_PREFIX))
      .map(({ where, resource }) => `${where}: ${resource}`);
    expect(unprefixed).toEqual([]);
  });

  it("every pattern grant is conditioned on this instance's tag, so a sibling instance whose prefix starts with this one is out of reach", () => {
    const unscoped = patternInvokes(app)
      .filter(({ s }) => (s.Condition?.StringEquals ?? {})[`aws:ResourceTag/${INSTANCE_TAG}`] !== INSTANCE_NAME)
      .map(({ where, resource }) => `${where}: ${resource}`);
    expect(unscoped).toEqual([]);
  });

  it('a pattern grant on an assistant stack function is also conditioned on a classification', () => {
    const unscoped = patternInvokes(app)
      .filter(({ resource }) => ASSISTANT_FUNCTIONS.test(functionName(resource)!))
      .filter(({ s }) => classificationReachOf(s.Condition) === null)
      .map(({ where, resource }) => `${where}: ${resource}`);
    expect(unscoped).toEqual([]);
  });

  // A role of one classification names that one value wherever it is built; what a shared stack may not hold
  // is a LIST, which changes whenever a classification is declared or removed.
  it('a shared stack\'s pattern grant names no classification list: it reaches any function that carries one', () => {
    const listed = patternInvokes(app)
      .filter(({ where, resource }) => ASSISTANT_FUNCTIONS.test(functionName(resource)!) && !/Assistants-/.test(where))
      .filter(({ s }) => {
        const reach = classificationReachOf(s.Condition);
        return !!reach && !reach.any && reach.values.length > 1;
      })
      .map(({ where, resource }) => `${where}: ${resource}`);
    expect(listed).toEqual([]);
  });

  it('the routers and task services those grants name carry the tags the condition reads', () => {
    const reachesOf = patternInvokes(app).map(({ s }) => classificationReachOf(s.Condition));
    const granted = { has: (value: string): boolean => reachesOf.some((r) => reaches(r, value)) };
    const reached: string[] = [];
    for (const [stack, t] of Object.entries(app.templates)) {
      if (!/Assistants-[a-z0-9-]+$/.test(stack)) continue;
      for (const [id, r] of Object.entries((t.Resources ?? {}) as Record<string, Resource>)) {
        if (r.Type !== 'AWS::Lambda::Function' || !/^(AgentHandler|TaskService|ApplyAssistantNameFunction)[0-9A-F]{8}$/.test(id)) continue;
        const tags = tagsOf(r);
        expect({ fn: `${stack}/${id}`, instance: tags[INSTANCE_TAG] }).toEqual({ fn: `${stack}/${id}`, instance: INSTANCE_NAME });
        expect({ fn: `${stack}/${id}`, granted: granted.has(tags.classification) }).toEqual({ fn: `${stack}/${id}`, granted: true });
        reached.push(id);
      }
    }
    expect(reached.filter((id) => id.startsWith('AgentHandler')).length).toBeGreaterThanOrEqual(3);
    expect(reached.filter((id) => id.startsWith('TaskService')).length).toBeGreaterThanOrEqual(3);
    // No stack builds a name applier: every rename goes through the one runtime applier (ADR-048, amended 2026-10-23).
    expect(reached.filter((id) => id.startsWith('ApplyAssistantName'))).toEqual([]);
  });

  it('the data plane those grants name carries the Instance tag', () => {
    const planes = Object.entries(app.templates)
      .filter(([stack]) => stack.endsWith('Archive'))
      .flatMap(([, t]) => Object.entries((t.Resources ?? {}) as Record<string, Resource>))
      .filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.includes('DataPlaneLambda'));
    expect(planes.length).toBeGreaterThan(0);
    for (const [id, r] of planes) expect({ id, instance: tagsOf(r)[INSTANCE_TAG] }).toEqual({ id, instance: INSTANCE_NAME });
  });
});
