/**
 * THE PRESIGNER HOLDS ONLY THE KEY FAMILIES IT SIGNS (tenet D15).
 *
 * A presigned URL carries the signer's permissions, so the role behind `/presigned-url` is the boundary on
 * every URL it hands out. From the synthesized template: it may write `attachments/` and read
 * `attachments/`, `generated-docs/` and `battle-images/`, and nothing else in the bucket; its own check
 * before signing (`lib/conversation-access.ts`) reads membership, the classification tag and, for the live
 * clearance check, the signer's AppInstanceUser, and nothing else.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { TEST_ENV } from './helpers/synth';

/** The Conversations stack, with the `meetings` capability declared or not. */
function conversationsTemplate(meetings: boolean): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], appUrl: 'https://app.example.com' } });
  const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn });
  return Template.fromStack(new ConversationsStack(app, 'Conversations', {
    env: TEST_ENV,
    appInstanceArn: messaging.appInstanceArn,
    selfPoolId: identity.selfPoolId,
    offboardingRoleArn: identity.offboardingRoleArn,
    credentialExchangeRoleArn: identity.credentialExchangeRoleArn,
    credentialExchangeFunctionArn: identity.credentialExchangeFunction.functionArn,
    invitationLinkReach: identity.invitationLinkReach,
    meetings,
  }));
}
const template = conversationsTemplate(true);

/** Every statement on the presigner's role, with its resources flattened to strings. */
function presignerStatements(t: Template = template): Array<{ actions: string[]; resources: string[] }> {
  const template = t;
  const fns = template.findResources('AWS::Lambda::Function');
  const [fnId] = Object.keys(fns).filter((id) => id.startsWith('PresignedUrlFunction'));
  const roleRef = JSON.stringify(fns[fnId].Properties.Role);
  const policies = Object.values(template.findResources('AWS::IAM::Policy')) as Array<{ Properties: { Roles: unknown[]; PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } }>;
  return policies
    .filter((p) => p.Properties.Roles.some((r) => roleRef.includes(JSON.stringify(r).replace(/[{}"]/g, '').replace('Ref:', ''))))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .map((s) => ({
      actions: ([] as string[]).concat(s.Action),
      resources: ([] as unknown[]).concat(s.Resource).map((r) => JSON.stringify(r)),
    }));
}

describe('the presigner holds only the key families it signs', () => {
  const statements = presignerStatements();
  const s3 = statements.filter((s) => s.actions.some((a) => a.startsWith('s3:')));

  it('writes attachments/ only', () => {
    const writes = s3.filter((s) => s.actions.some((a) => /^s3:(Put|Delete|Abort)/.test(a)));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.actions).toEqual(['s3:PutObject']);
      expect(w.resources.every((r) => r.includes('/attachments/*'))).toBe(true);
    }
  });

  it('reads the five key families it serves, a meeting transcript only as its Markdown and a recording only as its composited file, and no whole-bucket grant', () => {
    const reads = s3.filter((s) => s.actions.includes('s3:GetObject'));
    const families = reads.flatMap((s) => s.resources)
      .map((r) => /\/(attachments|generated-docs|battle-images)\/\*/.exec(r)?.[1] ?? (/\/transcripts\/\*\/\*\.md/.test(r) ? 'transcripts'
        : /\/recordings\/\*\/media\/composited-video\/\*\.mp4/.test(r) ? 'recordings' : r));
    expect(new Set(families)).toEqual(new Set(['attachments', 'generated-docs', 'battle-images', 'transcripts', 'recordings']));
    for (const s of s3) {
      expect(s.resources.some((r) => /\/\*"?\]?\}?$/.test(r) && !/(attachments|generated-docs|battle-images)\/\*/.test(r))).toBe(false);
      expect(s.actions.some((a) => a === 's3:*' || a.startsWith('s3:List') || a.startsWith('s3:Delete'))).toBe(false);
    }
  });

  it('reads membership, moderation, the classification tag and who the signer is, and sends nothing to a conversation', () => {
    const chime = statements.flatMap((s) => s.actions).filter((a) => a.startsWith('chime:'));
    // DescribeAppInstanceUser is the live clearance read (R4, `grantLiveClearance`): the directory reaches
    // the signer's issuer subject through their AppInstanceUser before it asks the issuer's pool.
    // DescribeChannelModerator answers whether the caller moderates a meeting's parent conversation, which hosts a meeting
    // whose record names no host (`hostedMeetingLive`); it is a read, asked as the caller.
    expect(new Set(chime)).toEqual(new Set(['chime:DescribeChannelMembership', 'chime:DescribeChannelModerator', 'chime:ListTagsForResource', 'chime:DescribeAppInstanceUser']));
  });

  it('reads moderation only of this instance\'s conversations and people, and writes nothing with it', () => {
    const moderation = statements.filter((s) => s.actions.includes('chime:DescribeChannelModerator'));
    expect(moderation.length).toBeGreaterThan(0);
    for (const s of moderation) {
      expect(s.actions.every((a) => a.startsWith('chime:Describe') || a.startsWith('chime:List'))).toBe(true);
      // The resources are the app instance's own ARN (a CDK token) joined with `/channel/*` or `/user/*`, nothing wider.
      for (const r of s.resources) {
        expect(r).toContain('appInstanceArn');
        expect(r).toMatch(/"\/(channel|user)\/\*"\]\]\}$/);
      }
    }
  });

  // ABSENT MEANS OFF: what only meetings need is built only where the `meetings` capability is declared.
  it('DENY: without meetings, the conversation store sends no object events, keeps no meeting expiry, and no role reads a meeting\'s families or moderation for one', () => {
    const plain = conversationsTemplate(false);
    const bucket = JSON.stringify(plain.findResources('AWS::S3::Bucket'));
    expect(bucket).not.toContain('EventBridgeConfiguration');
    expect(bucket).not.toContain('DeleteOldTranscripts');
    expect(bucket).not.toContain('DeleteOldRecordings');
    const reads = presignerStatements(plain).flatMap((s) => s.resources).join('\n');
    expect(reads).not.toMatch(/transcripts|recordings/);
    expect(presignerStatements(plain).flatMap((s) => s.actions)).not.toContain('chime:DescribeChannelModerator');
    expect(JSON.stringify(plain.findResources('AWS::IAM::Policy'))).not.toContain('ReadAMeetingConversationsRecord');
    expect(JSON.stringify(plain.findResources('AWS::IAM::Policy'))).not.toContain('MeetingDecidersModeration');
    // With meetings, each is there.
    expect(JSON.stringify(template.findResources('AWS::S3::Bucket'))).toContain('EventBridgeConfiguration');
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).toContain('ReadAMeetingConversationsRecord');
  });

  it('describes users of this instance only', () => {
    const describes = statements.filter((s) => s.actions.includes('chime:DescribeAppInstanceUser'));
    expect(describes.length).toBeGreaterThan(0);
    for (const d of describes) {
      expect(d.actions).toEqual(['chime:DescribeAppInstanceUser']);
      expect(d.resources.every((r) => r.includes('/user/*'))).toBe(true);
    }
  });
});
