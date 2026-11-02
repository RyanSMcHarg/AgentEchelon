/**
 * A CLASSIFICATION HOLDS TEMPLATES ONLY FOR THE WORKFLOWS IT SERVES, READS ONLY ITS OWN, AND ONLY ITS OWN
 * DEPLOY WRITES THEM (SPEC-DOCUMENT-TEMPLATES FR2; tenets D13, D15, P4).
 *
 * Template bodies live at `templates/<classification>/<name>/<sha256>.md` in the attachments bucket and
 * their active-version pointers at `<ssmRoot>/assistant/<classification>/templates/<name>`. The
 * classification is the second segment of both, so IAM scopes a read to it. These read the synthesized
 * TEMPLATE, because a grant that is too wide fails nobody in a unit test.
 *
 * WHO RECEIVES A DOCUMENT TEMPLATE is derived, never listed (`templatesDeclaredFor`): the platform
 * `report_generation` machine declares `report` on its delivering states, so a classification that serves that
 * workflow and produces documents receives the shipped `report` template and its deploy-time writer. One that
 * produces no document gets no writer, which is proven by absence. A pack counts by what it declares: one
 * without a report intent removes the writer, and one that redeclares the machine with a choice keeps the
 * shipped template it names.
 *
 * EVERY CLASSIFICATION READS ITS OWN TEMPLATES (ADR-062 decision 2): its turns say message templates, so its
 * router, its acting role and the boundary read `templates/<classification>/` and its pointers whatever its
 * workflows declare. Read-only, and its own prefix alone.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { defaultProfileRegistry } from '../lib/profile-registry';
import { shippedTemplates, templatesDeclaredFor } from '../lib/config/default-templates';
import { DEFAULT_TASK_STATE_MACHINES, REPORT_TEMPLATE } from '../lambda/src/lib/task-state-machines';
import { templateKey, parseTemplatePointer } from '../lambda/src/lib/template-store';

type Resource = { Type: string; Properties?: Record<string, any>; DependsOn?: string[] };

function synth(classification: string, context: Record<string, unknown> = {}): Record<string, Resource> {
  const app = new cdk.App({ context });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
}

interface Stmt { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; owner: string }

function statements(resources: Record<string, Resource>): Stmt[] {
  const out: Stmt[] = [];
  const take = (owner: string, doc: any) => {
    for (const s of doc?.Statement ?? []) out.push({ ...s, owner });
  };
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') take(id, r.Properties?.PolicyDocument);
    if (r.Type === 'AWS::IAM::Role') for (const p of r.Properties?.Policies ?? []) take(id, p.PolicyDocument);
  }
  return out;
}

const actionsOf = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const bodyPrefixes = (s: Stmt): string[] => [...(JSON.stringify(s.Resource ?? []).match(/(?<!assistant\/[a-z]+\/)(?<![a-z])templates\/[^"]*/g) ?? [])];
const pointerPaths = (s: Stmt): string[] => [...(JSON.stringify(s.Resource ?? []).match(/assistant\/[^"/]+\/templates\/[^"]*/g) ?? [])];

/** The roles a policy statement is attached to, by logical id. */
function rolesOf(resources: Record<string, Resource>, owner: string): string {
  const r = resources[owner];
  if (r.Type === 'AWS::IAM::Role') return owner;
  return JSON.stringify(r.Properties?.Roles ?? []);
}

/** The deploy-time custom resources that write a template body or pointer. */
const templateWriters = (resources: Record<string, Resource>) => Object.entries(resources)
  .filter(([, r]) => r.Type === 'Custom::AWS' && /templates/.test(JSON.stringify(r.Properties ?? {})));

/** The `Create` call a custom resource makes, parsed. */
const createCall = (r: Resource) => JSON.parse(typeof r.Properties!.Create === 'string' ? r.Properties!.Create : JSON.stringify(r.Properties!.Create));

const REPORT = shippedTemplates().get(REPORT_TEMPLATE)!;

describe('the platform ships a report template, and report_generation declares it', () => {
  it('the shipped report template parses, and both delivering states declare it', () => {
    expect(REPORT).toBeDefined();
    const states = DEFAULT_TASK_STATE_MACHINES.report_generation.states;
    expect(states.generating.template).toBe(REPORT_TEMPLATE);
    expect(states.revising.template).toBe(REPORT_TEMPLATE);
  });

  it('a classification that produces documents serves it from the platform pack; one that produces none does not', () => {
    expect(templatesDeclaredFor(undefined, true)).toEqual([REPORT_TEMPLATE]);
    expect(templatesDeclaredFor(undefined, false)).toEqual([]);
  });
});

// The sample's classifications, chosen by the registry fact the derivation reads.
const SAMPLE = ['basic', 'standard', 'premium'];
const withoutDocuments = SAMPLE.find((c) => !defaultProfileRegistry.produces(c, 'document'))!;
const withDocuments = SAMPLE.filter((c) => defaultProfileRegistry.produces(c, 'document'));

/** Every template grant a synthesized stack holds is a read of its own classification's prefix or pointers. */
function onlyReadsItsOwn(resources: Record<string, Resource>, classification: string): void {
  const granted = statements(resources).filter((s) => s.Effect === 'Allow' && [...bodyPrefixes(s), ...pointerPaths(s)].length);
  expect(granted.length).toBeGreaterThan(0);
  for (const s of granted) {
    for (const a of actionsOf(s)) expect(['s3:GetObject', 'ssm:GetParameter']).toContain(a);
    expect(bodyPrefixes(s).every((r) => r === `templates/${classification}/*`)).toBe(true);
    expect(pointerPaths(s).every((r) => r === `assistant/${classification}/templates/*`)).toBe(true);
  }
}

describe('a classification with no templated workflow writes no template, and reads its own', () => {
  const resources = synth(withoutDocuments);
  const all = statements(resources).filter((s) => s.Effect === 'Allow');

  it(`REFUSES by absence: ${withoutDocuments} has no template writer`, () => {
    expect(withoutDocuments).toBeDefined();
    expect(templateWriters(resources)).toEqual([]);
  });

  it('its router, its acting role and the boundary read its own message templates, and nothing wider', () => {
    onlyReadsItsOwn(resources, withoutDocuments);
    const router = all.filter((s) => s.owner.startsWith('RouterMessageTemplatesRead'));
    expect(router.flatMap(bodyPrefixes)).toEqual([`templates/${withoutDocuments}/*`]);
    expect(router.flatMap(pointerPaths)).toEqual([`assistant/${withoutDocuments}/templates/*`]);
    expect(all.some((s) => s.owner.startsWith('AssistantTurnContextS3ReadManaged') && bodyPrefixes(s).includes(`templates/${withoutDocuments}/*`))).toBe(true);
    expect(bodyPrefixes(all.find((s) => s.Sid === 'BoundaryItsOwnTemplates')!)).toEqual([`templates/${withoutDocuments}/*`]);
  });

  it('lists which templates a family holds under its own template prefix and no other (ADR-062 slice 2)', () => {
    const listings = all.filter((s) => actionsOf(s).includes('s3:ListBucket') && /templates\//.test(JSON.stringify((s as any).Condition ?? {})));
    // The router, the acting role and the boundary each list it.
    expect(listings.length).toBeGreaterThanOrEqual(3);
    for (const s of listings) {
      const prefixes = JSON.stringify((s as any).Condition).match(/templates\/[^"]*/g) ?? [];
      expect(prefixes).toEqual([`templates/${withoutDocuments}/*`]);
    }
  });

  it('a pack that declares the report workflow does not give it a writer, because it produces no document', () => {
    const pack = JSON.stringify({ extends: 'default', intents: [{ key: 'find_recipe', description: 'Find a recipe', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' }] });
    const r = synth(withoutDocuments, { assistantIntentPack: pack });
    expect(templateWriters(r)).toEqual([]);
    onlyReadsItsOwn(r, withoutDocuments);
  });
});

describe.each(withDocuments)('%s serves the report workflow, so it holds the report template', (classification) => {
  const resources = synth(classification);
  const all = statements(resources).filter((s) => s.Effect === 'Allow');
  const own = `templates/${classification}/*`;
  const ownPointers = `assistant/${classification}/templates/*`;

  it('the acting role reads its own template bodies, on its managed context-read policy', () => {
    const reads = all.filter((s) => actionsOf(s).includes('s3:GetObject') && bodyPrefixes(s).includes(own));
    expect(reads.some((s) => s.owner.startsWith('AssistantTurnContextS3ReadManaged'))).toBe(true);
  });

  it('the acting role reads its own pointers, and only its own', () => {
    const reads = all.filter((s) => actionsOf(s).includes('ssm:GetParameter') && pointerPaths(s).length);
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(pointerPaths(s)).toEqual([ownPointers]);
  });

  it('the boundary admits its own templates to read, and nothing wider', () => {
    const boundary = all.find((s) => s.Sid === 'BoundaryItsOwnTemplates');
    expect(boundary).toBeDefined();
    expect(actionsOf(boundary!)).toEqual(['s3:GetObject']);
    expect(bodyPrefixes(boundary!)).toEqual([own]);
  });

  it('the deploy writes the shipped body create-only, then the pointer only where none is active', () => {
    const writers = templateWriters(resources);
    const [bodyId, body] = writers.find(([, r]) => createCall(r).action === 'putObject')!;
    const put = createCall(body);
    expect(put.parameters.Key).toBe(templateKey(classification, REPORT_TEMPLATE, REPORT.contentHash));
    expect(put.parameters.Body).toBe(REPORT.source);
    expect(put.parameters.IfNoneMatch).toBe('*');
    expect(put.ignoreErrorCodesMatching).toBe('PreconditionFailed');

    const [, pointer] = writers.find(([, r]) => createCall(r).action === 'putParameter')!;
    const call = createCall(pointer);
    expect(call.parameters.Name).toMatch(new RegExp(`/assistant/${classification}/templates/${REPORT_TEMPLATE}$`));
    expect(call.parameters.Overwrite).toBe(false);
    expect(call.ignoreErrorCodesMatching).toBe('ParameterAlreadyExists');
    expect(parseTemplatePointer(call.parameters.Value)).toEqual({ active: REPORT.contentHash, history: [] });
    expect(JSON.stringify(pointer.DependsOn ?? [])).toContain(bodyId);
  });

  it('only the deploy-time writer writes, and only its own prefix and its own pointer', () => {
    const bodyWrites = all.filter((s) => actionsOf(s).some((a) => a === 's3:PutObject' || a === 's3:*') && bodyPrefixes(s).length);
    expect(bodyWrites.length).toBeGreaterThan(0);
    for (const s of bodyWrites) {
      // The writer reaches its own template's key family, never the classification's whole prefix (ADR-062).
      expect(bodyPrefixes(s)).toEqual([`templates/${classification}/${REPORT_TEMPLATE}/*`]);
      expect(JSON.stringify(s.Resource)).not.toMatch(/_assistants|_shipped/);
      const roles = rolesOf(resources, s.owner);
      expect(roles).not.toMatch(/AgentHandlerRole|TaskService|Acting/);
      expect(roles).toContain('AWS679f53fac002430cb0da5b7982bd2287');
    }
    const pointerWrites = all.filter((s) => actionsOf(s).some((a) => a === 'ssm:PutParameter' || a === 'ssm:*') && pointerPaths(s).length);
    expect(pointerWrites.length).toBeGreaterThan(0);
    for (const s of pointerWrites) {
      expect(pointerPaths(s)).toEqual([`assistant/${classification}/templates/${REPORT_TEMPLATE}`]);
      expect(rolesOf(resources, s.owner)).toContain('AWS679f53fac002430cb0da5b7982bd2287');
    }
  });

  it('names no other classification\'s templates, and never the family as a whole', () => {
    const named = all.flatMap((s) => [...bodyPrefixes(s), ...pointerPaths(s)]);
    expect(named.length).toBeGreaterThan(0);
    for (const r of named) expect(r.startsWith(`templates/${classification}/`) || r.startsWith(`assistant/${classification}/templates/`)).toBe(true);
  });
});

describe('a pack counts by what it declares', () => {
  const classification = withDocuments[0];

  it('a pack with no report intent leaves the classification with no document template, reading only its own', () => {
    const pack = JSON.stringify({ intents: [{ key: 'find_recipe', description: 'Find a recipe', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' }] });
    expect(templatesDeclaredFor(pack, true)).toEqual([]);
    const r = synth(classification, { assistantIntentPack: pack });
    expect(templateWriters(r)).toEqual([]);
    onlyReadsItsOwn(r, classification);
  });

  it('a pack that redeclares the machine with a choice keeps the shipped template it names, and writes no other', () => {
    const machine = structuredClone(DEFAULT_TASK_STATE_MACHINES.report_generation);
    for (const s of ['generating', 'revising']) {
      delete machine.states[s].template;
      machine.states[s].templates = [REPORT_TEMPLATE, 'board-pack'];
      machine.states[s].defaultTemplate = REPORT_TEMPLATE;
    }
    const pack = JSON.stringify({
      extends: 'default',
      intents: [{ key: 'find_recipe', description: 'Find a recipe', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' }],
      machines: { report_generation: machine },
    });
    expect(templatesDeclaredFor(pack, true)).toEqual(['board-pack', REPORT_TEMPLATE]);
    const r = synth(classification, { assistantIntentPack: pack });
    const keys = templateWriters(r).map(([, w]) => createCall(w).parameters.Key ?? createCall(w).parameters.Name);
    expect(keys.some((k: string) => k.includes('board-pack'))).toBe(false);
    expect(keys.some((k: string) => k.includes(`/${REPORT_TEMPLATE}`))).toBe(true);
    expect(statements(r).some((s) => s.Sid === 'BoundaryItsOwnTemplates')).toBe(true);
  });
});
