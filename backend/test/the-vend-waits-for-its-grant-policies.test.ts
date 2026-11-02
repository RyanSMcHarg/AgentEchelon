/**
 * THE VEND WAITS FOR EVERY GRANT POLICY IT CAN NAME.
 *
 * The vend narrows each session by passing `AssistantGrant-*` managed policies to AssumeRole, named by a
 * literal ARN prefix plus an edge. A literal gives CloudFormation no reference to order on, so a deploy
 * that adds an edge could update the vend before the new policy exists, and AssumeRole would fail closed
 * for every turn until it did. The vend's `DependsOn` names every grant policy, so it cannot.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';

const env = { account: '123456789012', region: 'us-east-1' };
const props = {
  env,
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
};

describe.each([
  ['basic', assistantsOf('basic'), 'AgentEchelonAssistants-basic'],
  ['premium', assistantsOf('premium'), 'AgentEchelonAssistants-premium'],
] as const)('%s', (_name, Stack, id) => {
  it('the vend depends on every AssistantGrant policy', () => {
    const t = Template.fromStack(Stack(new cdk.App(), id, props));
    const grants = Object.keys(t.findResources('AWS::IAM::ManagedPolicy')).filter((k) => k.startsWith('AssistantGrant'));
    expect(grants.length).toBeGreaterThan(0);
    const [vend] = Object.entries(t.findResources('AWS::Lambda::Function')).filter(([k]) => k.startsWith('AssistantVend'));
    expect(vend).toBeDefined();
    const dependsOn = ([] as string[]).concat((vend[1] as { DependsOn?: string[] }).DependsOn ?? []);
    expect(grants.filter((g) => !dependsOn.includes(g))).toEqual([]);
  });
});
