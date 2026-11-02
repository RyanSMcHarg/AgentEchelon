/**
 * THE FIRST-TURN TITLE RUNS ON THE PLATFORM'S UTILITY MODEL, WHATEVER THE CLASSIFICATION SELECTS.
 *
 * `channel-title.ts` names a new conversation with `UTILITY_MODEL_ID`, on the assistant's session. The session is
 * the acting role narrowed by the vend's edges, and both carry only the classification's selection, so a
 * classification that does not select Claude Haiku had its title call denied (and swallowed, since a title is
 * best-effort). The acting role holds the utility model beside the selection, scoped exactly like the router's
 * grant of it (`utilityModelArns`), and the vend adds the `utility` edge to every session.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cdk = require('aws-cdk-lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Template } = require('aws-cdk-lib/assertions');
import { DEFAULT_PROFILES_CONFIG, type ProfilesConfig } from '../lib/config/profiles';
import { useDeploymentProfiles } from '../lib/profile-registry';
import { UTILITY_MODEL_ID, utilityModelArns } from '../lib/config/model-strategy';
import { grantEdgesFor } from '../lambda/src/lib/assistant-grant';
import { assistantsOf, assistantsStackId } from './helpers/assistants';

const PROPS = {
  env: { account: '123456789012', region: 'us-east-1' },
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
};

/** The shipped set, with `premium` selecting no Claude Haiku. */
const WITHOUT_HAIKU: ProfilesConfig = {
  ...DEFAULT_PROFILES_CONFIG,
  classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'premium'
    ? { ...c, models: { selected: c.models!.selected.filter((k) => k !== 'haiku'), default: c.models!.default } }
    : c)),
};

const statementsOf = (doc: any): any[] => doc?.Statement ?? [];
const actionsOf = (s: any): string[] => ([] as string[]).concat(s.Action ?? []);
const resourcesOf = (s: any): string[] => ([] as unknown[]).concat(s.Resource ?? []).map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));

describe('the first-turn title runs on the utility model whatever the classification selects', () => {
  let t: InstanceType<typeof Template>;
  beforeAll(() => {
    useDeploymentProfiles(WITHOUT_HAIKU);
    const app = new cdk.App();
    t = Template.fromStack(assistantsOf('premium')(app, assistantsStackId('premium'), PROPS));
  });
  afterAll(() => useDeploymentProfiles(DEFAULT_PROFILES_CONFIG));

  it('grants the acting role the utility model beside a selection that does not include it', () => {
    const turnBedrock = Object.entries(t.findResources('AWS::IAM::ManagedPolicy'))
      .find(([k]) => k.startsWith('AssistantTurnBedrockPolicyManaged')) as [string, any];
    expect(turnBedrock).toBeDefined();
    const utility = statementsOf(turnBedrock[1].Properties.PolicyDocument).find((s) => s.Sid === 'PlatformUtilityModel');
    expect(actionsOf(utility)).toEqual(['bedrock:InvokeModel']);
    expect(resourcesOf(utility).sort()).toEqual(utilityModelArns('us-east-1', '123456789012').sort());
    expect(resourcesOf(utility)).toContain(`arn:aws:bedrock:us-east-1:123456789012:inference-profile/${UTILITY_MODEL_ID}`);
  });

  it('gives the vend a utility edge scoped exactly like the router\'s grant, and no Haiku edge', () => {
    const [, vend] = Object.entries(t.findResources('AWS::Lambda::Function')).find(([k]) => k.startsWith('AssistantVend')) as [string, any];
    const edges: string[] = JSON.parse(vend.Properties.Environment.Variables.GRANT_EDGES);
    expect(edges).toContain('utility');
    expect(edges).not.toContain('models-haiku');
    const [, edge] = Object.entries(t.findResources('AWS::IAM::ManagedPolicy'))
      .find(([, r]: [string, any]) => /AssistantGrant-premium-utility/.test(JSON.stringify(r.Properties.ManagedPolicyName))) as [string, any];
    const [only] = statementsOf(edge.Properties.PolicyDocument);
    expect(statementsOf(edge.Properties.PolicyDocument)).toHaveLength(1);
    expect(actionsOf(only)).toEqual(['bedrock:InvokeModel']);
    expect(resourcesOf(only).sort()).toEqual(utilityModelArns('us-east-1', '123456789012').sort());
  });

  it('narrows every session to include the utility edge, however narrow the definition', () => {
    const catalog = { edges: new Set(['base', 'utility', 'models-all', 'models-opus', 'models-sonnet']), alwaysModelKeys: [], defaultImageModelKey: '' };
    const edges = grantEdgesFor({ modelKey: 'opus', models: { default: 'opus' }, tools: [] }, undefined, catalog);
    expect(edges).toEqual(expect.arrayContaining(['base', 'utility', 'models-opus']));
    expect(edges).not.toContain('models-all');
  });
});
