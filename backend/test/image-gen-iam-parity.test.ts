/**
 * ONE RULE FOR EVERY MODEL, HELD BY THE SYNTHESIZED STACKS (ADR-054, `lib/config/model-availability.ts`).
 *
 * A classification may use a model exactly when it selects it from the instance's catalog (`models` on its
 * registry entry; the platform allows, the classification selects, the profile uses), text and image alike,
 * and everything that grants or wires a model derives from that selection: the acting role's text
 * and image `InvokeModel` grants, the vend's per-model session-policy edges, the image guardrail, the
 * seed's preselected image model, and the refusal's `produces: image`. Each classification's stack is
 * synthesized once and every one of those is compared with its selection, table-driven, so a model a
 * classification selects cannot be left half-wired, and one it does not select is not granted. Its external
 * model's key secret is created and read exactly where it selects that model.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cdk = require('aws-cdk-lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Template } = require('aws-cdk-lib/assertions');
import { getModelCatalog, UTILITY_MODEL_ID, type Classification } from '../lib/config/model-strategy';
import { IMAGE_MODEL_KEYS, imageModelsAllowedFor } from '../lib/config/model-availability';
import { IMAGE_GEN_MODELS } from '../lambda/src/lib/image-gen-models';
import { defaultProfileRegistry } from '../lib/profile-registry';
import { assistantClassifications } from '../lib/config/profiles';
import { assistantsOf, assistantsStackId } from './helpers/assistants';

const STACKS = assistantClassifications().map((c) => [c as Classification]);
const PROPS = {
  env: { account: '123456789012', region: 'us-east-1' },
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
};

/** Every resource string an `InvokeModel` statement names, across every policy in the template. */
function invokeResources(t: InstanceType<typeof Template>): string[] {
  const out: string[] = [];
  const docs = [
    ...Object.values(t.findResources('AWS::IAM::Policy')).map((r: any) => r.Properties.PolicyDocument),
    ...Object.values(t.findResources('AWS::IAM::ManagedPolicy')).map((r: any) => r.Properties.PolicyDocument),
    ...Object.values(t.findResources('AWS::IAM::Role')).flatMap((r: any) => (r.Properties.Policies ?? []).map((p: any) => p.PolicyDocument)),
  ];
  for (const doc of docs) {
    for (const s of doc?.Statement ?? []) {
      const actions = ([] as string[]).concat(s.Action ?? []);
      if (!actions.includes('bedrock:InvokeModel')) continue;
      for (const r of ([] as unknown[]).concat(s.Resource ?? [])) out.push(typeof r === 'string' ? r : JSON.stringify(r));
    }
  }
  return out;
}

const IMAGE_KEYS_SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:image-gen-keys-AbCdEf';

describe('every model grant matches the classification\'s selection, text and image alike', () => {
  const text = getModelCatalog('us-east-1', '123456789012');

  it.each(STACKS)('%s', (classification) => {
    const app = new cdk.App({ context: { imageGenKeysSecretArn: IMAGE_KEYS_SECRET } });
    const t = Template.fromStack(assistantsOf(classification)(app, assistantsStackId(classification), PROPS));
    const granted = invokeResources(t);

    // IMAGE: granted exactly the Bedrock image models the catalog allows this classification.
    const imageAllowed = imageModelsAllowedFor(classification);
    for (const m of Object.values(IMAGE_GEN_MODELS).filter((x) => x.hosting === 'aws-bedrock')) {
      const arn = `arn:aws:bedrock:*::foundation-model/${m.bedrockModelId}`;
      expect({ classification, model: m.key, granted: granted.includes(arn) })
        .toEqual({ classification, model: m.key, granted: imageAllowed.includes(m.key) });
    }

    // TEXT: no foundation model the classification does not select is granted.
    const selects = (key: string) => defaultProfileRegistry.selectsModel(classification, key);
    for (const m of Object.values(text)) {
      if (selects(m.key)) continue;
      const ownArns = new Set(m.foundationModelArns.filter((a) => !Object.values(text).some(
        (o) => o.key !== m.key && selects(o.key) && o.foundationModelArns.includes(a),
      )));
      for (const arn of ownArns) {
        expect({ classification, model: m.key, arn, granted: granted.includes(arn) })
          .toEqual({ classification, model: m.key, arn, granted: false });
      }
    }

    // THE VEND'S EDGES: one per allowed text model and one per allowed Bedrock image model, nothing else.
    const [, vend] = Object.entries(t.findResources('AWS::Lambda::Function')).find(([k]) => k.startsWith('AssistantVend')) as [string, any];
    const env = vend.Properties.Environment.Variables;
    const edges: string[] = JSON.parse(env.GRANT_EDGES);
    expect(edges.filter((e) => e.startsWith('image-')).map((e) => e.slice(6)).sort())
      .toEqual(imageAllowed.filter((k) => IMAGE_GEN_MODELS[k].hosting === 'aws-bedrock').sort());
    const textEdges = edges.filter((e) => e.startsWith('models-') && e !== 'models-all' && e !== 'models-cn').map((e) => e.slice(7));
    expect(textEdges.sort()).toEqual(Object.values(text)
      .filter((m) => selects(m.key) && (m.foundationModelArns.length || m.inferenceProfileArns?.length))
      .map((m) => m.key).sort());

    // THE SEED'S PRESELECTED IMAGE MODEL, granted to a seed-served session only where it is allowed.
    expect(env.GRANT_DEFAULT_IMAGE_MODEL === '').toBe(imageAllowed.length === 0);

    // THE IMAGE GUARDRAIL is wired exactly where an image model is allowed.
    const guardrails = Object.values(t.findResources('AWS::Bedrock::Guardrail')) as any[];
    const imageGuardrail = guardrails.some((g) => /battle-image-guardrail/.test(JSON.stringify(g.Properties.Name)));
    expect(imageGuardrail).toBe(imageAllowed.length > 0);

    // THE REFUSAL'S `produces: image` IS DERIVED FROM THE SAME LIST, so the two cannot disagree.
    expect(defaultProfileRegistry.produces(classification, 'image')).toBe(imageAllowed.length > 0);

    // THE EXTERNAL ADAPTER'S KEY: its secret and the processor's environment exist exactly where it is selected.
    const secrets = Object.keys(t.findResources('AWS::SecretsManager::Secret')).filter((k) => k.startsWith('DeepseekApiKey'));
    expect({ classification, secret: secrets.length > 0 }).toEqual({ classification, secret: selects('deepseek_api') });
    const envs = Object.values(t.findResources('AWS::Lambda::Function'))
      .map((f: any) => (f.Properties.Environment?.Variables ?? {}) as Record<string, unknown>);
    // THE IMAGE PROVIDERS' KEYS reach the processor exactly where the classification selects an image model hosted
    // outside AWS, not wherever it selects any image model.
    const externalImage = imageAllowed.some((k) => IMAGE_GEN_MODELS[k].hosting === 'external-http');
    expect({ classification, imageKeys: envs.some((v) => v.IMAGE_GEN_KEYS_SECRET_ARN === IMAGE_KEYS_SECRET) })
      .toEqual({ classification, imageKeys: externalImage });
    expect({ classification, external: envs.some((v) => 'DEEPSEEK_BASE_URL' in v) })
      .toEqual({ classification, external: selects('deepseek_api') });
    // THE INTENT CLASSIFIER runs on the platform's utility model whatever the classification selects, so its
    // router is granted that model beside the selection.
    const [, handlerRole] = Object.entries(t.findResources('AWS::IAM::Role')).find(([k]) => k.startsWith('AgentHandlerRole')) as [string, any];
    const handlerBedrock = JSON.stringify(handlerRole.Properties.Policies.find((p: any) => p.PolicyName === 'BedrockPolicy'));
    expect(handlerBedrock).toContain(`inference-profile/${UTILITY_MODEL_ID}`);
    expect(envs.some((v) => v.CLASSIFIER_MODEL_ID === UTILITY_MODEL_ID)).toBe(true);
    // THE IN-AWS CHINESE PATH (rule 2a) is wired exactly where the classification routes by context and selects
    // DeepSeek on Bedrock; without it a Chinese turn takes the external adapter it selects (rule 2b).
    const routesByContext = !!defaultProfileRegistry.requireTopology(classification).contextRouting;
    expect({ classification, cnBedrock: envs.some((v) => !!v.CN_BEDROCK_CHAT_MODEL) })
      .toEqual({ classification, cnBedrock: routesByContext && selects('deepseek_v3') });
  });

  it('the catalog names every image model and its purpose, and no classification on any model', () => {
    expect([...IMAGE_MODEL_KEYS].sort()).toEqual(Object.keys(IMAGE_GEN_MODELS).sort());
    for (const m of Object.values(IMAGE_GEN_MODELS)) {
      expect(m.output).toBe('image');
      expect(Object.keys(m)).not.toContain('allowedClassifications');
    }
    for (const m of Object.values(text)) {
      expect(m.output).toBe('text');
      expect(Object.keys(m)).not.toContain('allowedClassifications');
    }
  });
});

/**
 * ADR-064 SECURITY POSTURE: a step override and a route's `image` part are walked by the vend's narrowing like every
 * other model a definition names, and narrowing grants only edges the classification's stack created. So a step or image
 * model the classification does not select opens no edge, and one it selects is granted.
 */
describe('a step override and an image part reach no model outside the classification (vend narrowing)', () => {
  const { grantEdgesFor } = jest.requireActual('../lambda/src/lib/assistant-grant') as typeof import('../lambda/src/lib/assistant-grant');
  const catalog = {
    edges: new Set(['base', 'models-haiku', 'models-sonnet', 'models-titan', 'models-all', 'image-stability_image_core']),
    alwaysModelKeys: ['haiku'],
    defaultImageModelKey: '',
  } as never;

  it('grants a step override and an image part the classification selects', () => {
    const edges = grantEdgesFor({
      models: { default: 'haiku', byIntent: { image_generation: { primary: 'haiku', image: { primary: 'stability_image_core' }, steps: { confirm: { primary: 'sonnet' } } } } },
    } as never, undefined, catalog);
    expect(edges).toEqual(expect.arrayContaining(['models-sonnet', 'image-stability_image_core']));
  });

  it('refuses a step override and an image part naming models the classification does not select', () => {
    const edges = grantEdgesFor({
      models: { default: 'haiku', byIntent: { image_generation: { primary: 'haiku', image: { primary: 'stability_image_ultra' }, steps: { confirm: { primary: 'opus' }, generate: { primary: 'nova_canvas' } } } } },
    } as never, undefined, catalog);
    expect(edges).not.toContain('models-opus');
    expect(edges).not.toContain('image-stability_image_ultra');
    expect(edges).not.toContain('image-nova_canvas');
    expect(edges).not.toContain('models-all');
  });
});
