/**
 * EVERY ROLE THAT CREATES A CONVERSATION CAN READ WHO SEATS IN IT.
 *
 * Since the service admin creates conversations, the creator adds the assistants itself and reads which
 * assistants those are from the assignment records (`assistant-assignments/{classification}`, enumerated
 * with `GetParametersByPath`). A creator without that read refuses every creation. The conversation split
 * shipped without it, so every accepted split failed on 2026-10-15 and nothing was announced, while the
 * event creator, which carried the same read, worked.
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
  auroraDriftHookup: { rdsProxy: false, liveDrift: true },
};

/** The creators in a classification stack, by the construct id that names their role. */
const CREATORS = ['ConversationSplitRole', 'TypedConversationFromEventRole'];

describe('every conversation creator in a classification stack reads the assignment records', () => {
  const app = new cdk.App();
  const t = Template.fromStack(assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', props));
  const roles = t.findResources('AWS::IAM::Role');
  const policies = Object.values(t.findResources('AWS::IAM::Policy')) as any[];

  it.each(CREATORS)('%s can enumerate this classification\'s assignments', (creator) => {
    const roleId = Object.keys(roles).find((id) => id.startsWith(creator));
    expect(roleId).toBeDefined();
    const statements = policies
      .filter((p) => (p.Properties.Roles ?? []).some((r: { Ref?: string }) => r.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
    const enumerates = statements.some((s) => ([] as string[]).concat(s.Action).includes('ssm:GetParametersByPath')
      && JSON.stringify(s.Resource).includes('/assistant-assignments/premium"'));
    expect(enumerates).toBe(true);
  });
});
