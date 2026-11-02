/**
 * A FUNCTION GIVEN A TEMPLATE READ IS TOLD THE ROOT THE READ NAMES (ADR-062 decision 2, `template-store.ts`).
 *
 * A template's active-version pointer lives at `<ssmRoot>/assistant/<classification>/templates/<name>`, and the store
 * reads `SSM_ROOT` from the environment, falling back to `/agent-echelon`. The grant names the instance's own root
 * (`/${INSTANCE_NAME}`). So a function that holds the grant without the variable reads the fallback root: on the default
 * instance the two agree by coincidence, and on any other instance every pointer read is refused and every template
 * silently reads as the shipped one. The typed creator was the function that showed it.
 *
 * Read from the synthesized templates: every Lambda function whose role may read a template pointer carries `SSM_ROOT`,
 * and it is the root that grant names.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS, adminServicesTemplate } from './helpers/synth';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { assistantClassifications } from '../lib/config/profiles';
import { SSM_ROOT } from '../lib/stacks/agent-classification-common';

type Resource = { Type: string; Properties?: Record<string, any> };
type Resources = Record<string, Resource>;

const refOf = (role: unknown): string | undefined => {
  const r = role as { 'Fn::GetAtt'?: [string, string]; Ref?: string } | undefined;
  return r?.['Fn::GetAtt']?.[0] ?? r?.Ref;
};

/** Every statement attached to a role, inline or by policy resource, by the role's logical id. */
function statementsByRole(resources: Resources): Map<string, any[]> {
  const out = new Map<string, any[]>();
  const add = (role: string | undefined, doc: any) => {
    if (!role) return;
    out.set(role, [...(out.get(role) ?? []), ...(doc?.Statement ?? [])]);
  };
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Role') for (const p of r.Properties?.Policies ?? []) add(id, p.PolicyDocument);
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
      for (const role of r.Properties?.Roles ?? []) add(refOf(role), r.Properties?.PolicyDocument);
    }
  }
  return out;
}

/** A pointer read: `ssm:GetParameter` on a `<root>/assistant/<classification>/templates/...` parameter. */
const pointerRead = (s: any): boolean => s.Effect === 'Allow'
  && [s.Action].flat().includes('ssm:GetParameter')
  && /assistant\/[^"/]+\/templates/.test(JSON.stringify(s.Resource ?? ''));

/** The functions whose roles may read a template pointer, with the environment each is given. */
function templateReaders(resources: Resources): Array<{ id: string; env: Record<string, unknown>; grants: string }> {
  const byRole = statementsByRole(resources);
  return Object.entries(resources)
    .filter(([, r]) => r.Type === 'AWS::Lambda::Function')
    .map(([id, r]) => ({ id, role: refOf(r.Properties?.Role), env: r.Properties?.Environment?.Variables ?? {} }))
    .map((f) => ({ ...f, reads: (byRole.get(f.role ?? '') ?? []).filter(pointerRead) }))
    .filter((f) => f.reads.length > 0)
    .map((f) => ({ id: f.id, env: f.env, grants: JSON.stringify(f.reads.map((s) => s.Resource)) }));
}

function assistants(classification: string): Resources {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Resources }).Resources;
}

function notifications(): Resources {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111122223333', region: 'us-east-1' };
  const host = new cdk.Stack(app, 'Host', { env });
  return Template.fromStack(new NotificationStack(app, 'N', {
    env, appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i', userPoolId: 'us-east-1_PRIMARY',
    classifications: assistantClassifications(), senderEmail: 'assistant@example.com', appUrl: 'https://app.example.com', notifyBridge: true,
    messageStream: kinesis.Stream.fromStreamArn(host, 'S', 'arn:aws:kinesis:us-east-1:111122223333:stream/s'),
    tokens: dynamodb.Table.fromTableArn(host, 'T', 'arn:aws:dynamodb:us-east-1:111122223333:table/tokens'),
    templateBucket: { bucketName: 'attachments', bucketArn: 'arn:aws:s3:::attachments' },
  })).toJSON().Resources as Resources;
}

function expectEveryReaderKnowsItsRoot(resources: Resources, atLeast: string[]): void {
  const readers = templateReaders(resources);
  for (const name of atLeast) expect(readers.map((r) => r.id).join(' ')).toContain(name);
  for (const reader of readers) {
    expect({ fn: reader.id, SSM_ROOT: reader.env.SSM_ROOT }).toEqual({ fn: reader.id, SSM_ROOT });
    expect(reader.grants).toContain(`parameter${SSM_ROOT}/assistant/`);
  }
}

describe('a function given a template read is told the root that read names', () => {
  it('every function of a classification that reads templates: its router and its conversation creator', () => {
    expectEveryReaderKnowsItsRoot(assistants('basic'), ['ConversationCreator', 'AgentHandler']);
  });

  it('and the typed creator, where the classification opens rooms for events', () => {
    expectEveryReaderKnowsItsRoot(assistants('premium'), ['TypedConversationFromEvent', 'ConversationCreator', 'AgentHandler']);
  });

  it('the proactive briefing and the email senders', () => {
    expectEveryReaderKnowsItsRoot(notifications(), ['ProactiveBriefingFunction']);
  });

  it('the admin notification channel and the admin alert poster', () => {
    const resources = adminServicesTemplate().toJSON().Resources as Resources;
    expectEveryReaderKnowsItsRoot(resources, ['ProvisionFn', 'AdminAlertPoster']);
  });
});
