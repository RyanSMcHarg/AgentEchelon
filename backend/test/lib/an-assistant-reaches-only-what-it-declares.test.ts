/**
 * AN ASSISTANT REACHES ONLY WHAT ITS DEFINITION DECLARES, INSIDE ITS CLASSIFICATION (tenet P4;
 * `lambda/src/lib/assistant-grant.ts`).
 *
 * The rule the vend applies when it chooses session policies. Pinned here as a pure function so the
 * budget and the "declares nothing selects everything" cases are read the same way everywhere.
 */
import { grantEdgesFor, MAX_SESSION_POLICIES, variantGrantOf, type GrantCatalog } from '../../lambda/src/lib/assistant-grant';

const catalog: GrantCatalog = {
  edges: new Set(['base', 'context', 'platform', 'telemetry', 'models-all', 'models-haiku', 'models-sonnet',
    'models-opus', 'models-titan', 'models-gpt_oss_20b', 'models-gpt_oss_120b', 'models-deepseek_v3',
    'image-stability_image_core']),
  alwaysModelKeys: ['haiku'],
  defaultImageModelKey: 'stability_image_core',
};

describe('which session policies a definition selects', () => {
  it('always includes base', () => {
    expect(grantEdgesFor({ tools: [], models: { default: 'haiku' } }, undefined, catalog)).toContain('base');
  });

  it('selects company context through the context source or the tool, and nothing else does', () => {
    expect(grantEdgesFor({ tools: [], contextSources: ['company-docs'] }, undefined, catalog)).toContain('context');
    expect(grantEdgesFor({ tools: ['load_company_context'], contextSources: [] }, undefined, catalog)).toContain('context');
    expect(grantEdgesFor({ tools: ['load_platform_info'], contextSources: ['user-profile'] }, undefined, catalog)).not.toContain('context');
  });

  it('selects telemetry only through read_deployment_health', () => {
    expect(grantEdgesFor({ tools: ['read_deployment_health'], contextSources: [] }, undefined, catalog)).toContain('telemetry');
    expect(grantEdgesFor({ tools: ['load_company_context'], contextSources: [] }, undefined, catalog)).not.toContain('telemetry');
  });

  it('a definition that declares nothing selects everything', () => {
    expect(grantEdgesFor(null, undefined, catalog)).toEqual(expect.arrayContaining(['context', 'platform', 'telemetry', 'models-all']));
  });

  it('falls back to the classification\'s whole model set rather than pass IAM\'s session-policy limit', () => {
    const def = { tools: ['load_company_context', 'load_platform_info', 'read_deployment_health'], contextSources: [],
      models: { default: 'sonnet', image: 'stability_image_core', byIntent: { report_generation: { primary: 'opus', fallback: 'titan' }, code_generation: { primary: 'gpt_oss_120b', fallback: 'gpt_oss_20b' } } } };
    const edges = grantEdgesFor(def, undefined, catalog);
    expect(edges.length).toBeLessThanOrEqual(MAX_SESSION_POLICIES);
    expect(edges).toContain('models-all');
  });

  it('never names an edge the classification does not have', () => {
    const edges = grantEdgesFor({ tools: [], models: { default: 'not-a-model' } }, { modelKeys: ['nope'], imageModelKey: 'nope' }, catalog);
    for (const e of edges) expect(catalog.edges.has(e) || e === 'base').toBe(true);
  });

  it('a profileRef variant replaces the assistant\'s definition', () => {
    const v = variantGrantOf({ profile: { tools: ['read_deployment_health'], contextSources: [] } });
    expect(grantEdgesFor({ tools: ['load_company_context'], contextSources: [] }, v, catalog)).toEqual(expect.arrayContaining(['telemetry']));
    expect(grantEdgesFor({ tools: ['load_company_context'], contextSources: [] }, v, catalog)).not.toContain('context');
  });
});

/**
 * IAM ACCEPTS AT MOST TEN SESSION POLICIES PER AssumeRole, and the edges a session gets are computed from
 * the catalog each classification actually deploys. So the worst case is checked against the SYNTHESIZED
 * catalogs (the vend's own environment), not a hand-built one: every tool, every model a definition can
 * name, a variant adding its own model and image, and the context-routing edge where it exists.
 */
describe('no definition can pass IAM\'s session-policy limit on any deployed catalog', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cdk = require('aws-cdk-lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Template } = require('aws-cdk-lib/assertions');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assistantClassifications } = require('../../lib/config/profiles');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assistantsOf, assistantsStackId } = require('../helpers/assistants');
  const stacks: Array<[string]> = (assistantClassifications() as string[]).map((c) => [c]);
  const props = {
    env: { account: '123456789012', region: 'us-east-1' },
    appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
    attachmentsBucketName: 'agent-echelon-attachments-test',
    attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
  };

  it.each(stacks)('%s', (name) => {
    const app = new cdk.App();
    const t = Template.fromStack(assistantsOf(name)(app, assistantsStackId(name), props));
    const [, vend] = Object.entries(t.findResources('AWS::Lambda::Function')).find(([k]) => k.startsWith('AssistantVend')) as [string, any];
    const envVars = vend.Properties.Environment.Variables;
    const deployed: GrantCatalog = {
      edges: new Set(JSON.parse(envVars.GRANT_EDGES)),
      alwaysModelKeys: JSON.parse(envVars.GRANT_ROUTED_MODELS),
      defaultImageModelKey: envVars.GRANT_DEFAULT_IMAGE_MODEL,
    };
    const models = [...deployed.edges].filter((e) => e.startsWith('models-') && e !== 'models-all' && e !== 'models-cn').map((e) => e.slice(7));
    const images = [...deployed.edges].filter((e) => e.startsWith('image-')).map((e) => e.slice(6));
    const worst = {
      tools: ['load_company_context', 'load_platform_info', 'read_deployment_health'],
      contextSources: ['company-docs'],
      models: {
        default: models[0], classifier: models[1] ?? models[0], image: images[0],
        byIntent: Object.fromEntries(models.map((m, i) => [`intent_${i}`, { primary: m, fallback: models[(i + 1) % models.length] }])),
      },
    };
    const variant = { modelKeys: models.slice(-1), imageModelKey: images[images.length - 1] };
    for (const def of [worst, { ...worst, models: { ...worst.models, byIntent: {} } }, null]) {
      for (const v of [undefined, variant]) {
        const edges = grantEdgesFor(def, v, deployed);
        expect(edges.length).toBeLessThanOrEqual(MAX_SESSION_POLICIES);
        // Every edge the vend would pass exists as a deployed grant policy.
        for (const e of edges) expect(deployed.edges.has(e)).toBe(true);
      }
    }
  });
});
