/**
 * A CLASSIFICATION READS ONLY ITS OWN INTENT PACK, AND ONLY ITS OWN DEPLOY WRITES IT (tenets D13, D15, P4).
 *
 * The pack's body lives at `classification-packs/{classification}/{sha256}/intentPack` in the attachments
 * bucket and the classification's parameter holds a pointer. The prefix names the classification so IAM
 * can scope both verbs to it, which is only worth anything if the synthesized grants actually do. These
 * read the TEMPLATE, because a grant that is too wide does not fail a unit test: it fails nobody.
 *
 * The isolation is proven by absence (no statement in the basic stack reaches another classification's
 * prefix or the family as a whole), and by a second classification whose grants name its own prefix and
 * not basic's. The reader's own key check (`getClassificationPack`) is the second layer, pinned in
 * `lib/a-classification-pack-is-a-body.test.ts`.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { classificationPackKey, contentIdOf } from '../lambda/src/lib/profile-bodies';
import { packPointerOf, MAX_INTENT_PACK_BYTES } from '../lambda/src/lib/intent-pack';

const PACK = JSON.stringify({
  intents: [{ key: 'find_recipe', description: 'Find a recipe', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' }],
});
const BUCKET = 'arn:aws:s3:::test-bucket';

type Resource = { Type: string; Properties?: Record<string, any>; DependsOn?: string[] };

function synth(classification: string, context: Record<string, unknown> = { assistantIntentPack: PACK }): Record<string, Resource> {
  const app = new cdk.App({ context });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
}

interface Stmt { Sid?: string; Action: string | string[]; Resource: unknown; owner: string }

/** Every Allow statement in the template, with the logical id of the policy or role that carries it. */
function statements(resources: Record<string, Resource>): Stmt[] {
  const out: Stmt[] = [];
  const take = (owner: string, doc: any) => {
    for (const s of doc?.Statement ?? []) if (s.Effect === 'Allow') out.push({ ...s, owner });
  };
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') take(id, r.Properties?.PolicyDocument);
    if (r.Type === 'AWS::IAM::Role') for (const p of r.Properties?.Policies ?? []) take(id, p.PolicyDocument);
  }
  return out;
}

const actionsOf = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const packResources = (s: Stmt) => JSON.stringify(s.Resource ?? []).match(/classification-packs\/[^"]*/g) ?? [];

/** The roles a policy statement is attached to, by logical id. */
function rolesOf(resources: Record<string, Resource>, owner: string): string {
  const r = resources[owner];
  if (r.Type === 'AWS::IAM::Role') return owner;
  return JSON.stringify(r.Properties?.Roles ?? []);
}

describe('a classification reads only its own intent pack', () => {
  const basic = synth('basic');
  const all = statements(basic);

  it('writes the body to its own prefix and the pointer to its parameter, body first', () => {
    const key = classificationPackKey('basic', contentIdOf(PACK));
    const writer = Object.entries(basic).find(([, r]) => r.Type === 'Custom::AWS' && JSON.stringify(r.Properties).includes(key));
    expect(writer).toBeDefined();
    expect(JSON.stringify(writer![1].Properties)).toContain('putObject');

    const [paramId, param] = Object.entries(basic).find(([, r]) => r.Type === 'AWS::SSM::Parameter'
      && JSON.stringify(r.Properties?.Name ?? '').endsWith('/basic/assistant-intent-pack"'))!;
    expect(paramId).toBeDefined();
    expect(packPointerOf(param.Properties!.Value)).toEqual({ key, configId: contentIdOf(PACK) });
    expect(param.DependsOn ?? []).toContain(writer![0]);
  });

  it('grants every reader its own prefix and nothing wider', () => {
    // Every statement in the stack that names the pack family names exactly basic's prefix.
    const named = all.flatMap(packResources);
    expect(named.length).toBeGreaterThan(0);
    for (const r of named) expect(r).toBe('classification-packs/basic/*');
  });

  it('the router, the task service and the processor can each read it', () => {
    const reads = all.filter((s) => actionsOf(s).includes('s3:GetObject') && packResources(s).length);
    const holders = reads.map((s) => rolesOf(basic, s.owner)).join(' ');
    expect(holders).toContain('AgentHandlerRole');
    expect(holders).toContain('TaskService');
    // The processor's acting role takes it on its managed context-read policy.
    expect(reads.some((s) => s.owner.startsWith('AssistantTurnContextS3ReadManaged'))).toBe(true);
  });

  it('REFUSES by absence: no turn role may write the pack, only the deploy-time writer', () => {
    const writes = all.filter((s) => actionsOf(s).includes('s3:PutObject') && packResources(s).length
      && s.Sid !== 'BoundaryObjectsATurnUses');
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) {
      const roles = rolesOf(basic, s.owner);
      expect(roles).not.toMatch(/AgentHandlerRole|TaskService|Acting/);
      // The AwsCustomResource provider's singleton role.
      expect(roles).toContain('AWS679f53fac002430cb0da5b7982bd2287');
    }
  });

  it('FAILS the way it is meant to: another classification names its own prefix, never basic\'s', () => {
    const standard = statements(synth('standard')).flatMap(packResources);
    expect(standard.length).toBeGreaterThan(0);
    for (const r of standard) expect(r).toBe('classification-packs/standard/*');
    expect(standard).not.toContain('classification-packs/basic/*');
  });

  it('refuses an oversize pack at synth with the measurement named', () => {
    const big = JSON.stringify({ intents: [{ key: 'k', description: 'x'.repeat(MAX_INTENT_PACK_BYTES) }] });
    expect(() => synth('basic', { assistantIntentPack: big })).toThrow(new RegExp(`over the ${MAX_INTENT_PACK_BYTES}-byte`));
  });

  it('accepts a pack past the 8 KB parameter limit', () => {
    const large = JSON.stringify({ intents: [{ key: 'k', description: 'x'.repeat(12 * 1024) }] });
    expect(() => synth('basic', { assistantIntentPack: large })).not.toThrow();
  });

  it('names the pack prefix as an object ARN in the deployment bucket', () => {
    expect(JSON.stringify(all)).toContain(`${BUCKET}/classification-packs/basic/*`);
  });
});
