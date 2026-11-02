/**
 * THE SEAMS PER ISSUER, AS SYNTHESIZED (C5, C6).
 *
 *  - An issuer declaring `directory: 'claims'` adds the contact copies' customer managed key and the
 *    user-profile table's TTL; the credential exchange is granted the copies' write and the encrypt, and
 *    finds the table and key at run time; a function that reaches people is granted the read and the
 *    decrypt. A deployment that declares no such issuer has none of it.
 *  - A `userProfileService` ARN beside the registry sets `USER_PROFILE_SERVICE_ARN` on the router and
 *    grants it the invoke (C6); absent, neither is there.
 */
import * as cdk from 'aws-cdk-lib';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { conversationsStacks, basicClassificationTemplate } from './helpers/synth';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { assistantClassifications } from '../lib/config/profiles';
import { SHARED_SSM } from '../lib/stacks/agent-classification-common';

/** A direct OIDC entry is a multi-tenant Entra one: a generic `oidc` entry is refused (it federates into the pool). */
const ENTRA_TENANTS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000'];
const ENTRA_DISCOVERY = 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration';

const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  {
    id: 'partner', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY,
    audience: 'ae', clearance: { fixed: ['basic'], classifications: ['basic'] }, directory: 'claims',
  },
];
const PROFILE_SERVICE = 'arn:aws:lambda:us-east-1:111122223333:function:profiles';

const statementsOf = (t: Template): any[] => (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
  .flatMap((p) => p.Properties.PolicyDocument.Statement);
const actionsOf = (s: any): string[] => [].concat(s.Action);

describe('an issuer with the claims directory', () => {
  const { conversations, identity } = conversationsStacks({ issuers: ISSUERS });
  const conv = Template.fromStack(conversations);
  const id = Template.fromStack(identity);

  it('keys the copies with a rotating customer managed key, published for the readers', () => {
    conv.resourceCountIs('AWS::KMS::Key', 1);
    conv.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    conv.hasResourceProperties('AWS::SSM::Parameter', { Name: SHARED_SSM.contactCopyKeyArn });
  });

  it('expires a copy through the table TTL', () => {
    conv.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'personId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('grants the exchange the write of the copy keys alone, and the encrypt', () => {
    const write = statementsOf(conv).find((s) => actionsOf(s).includes('dynamodb:PutItem') && JSON.stringify(s.Condition || {}).includes('#contact#'));
    expect(write).toBeDefined();
    expect(write.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*#contact#*'] } });
    expect(statementsOf(conv).some((s) => actionsOf(s).includes('kms:Encrypt'))).toBe(true);
    // Nothing in this stack decrypts: only a function that reaches people does.
    expect(statementsOf(conv).some((s) => actionsOf(s).includes('kms:Decrypt'))).toBe(false);
  });

  it('the exchange finds the table and key at run time', () => {
    id.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ CONTACT_COPY_TABLE_PARAM: SHARED_SSM.userProfileName, CONTACT_COPY_KEY_PARAM: SHARED_SSM.contactCopyKeyArn }) },
    });
  });

  it('a function that reaches people reads the copies and decrypts them', () => {
    const app = new cdk.App({ context: { issuers: ISSUERS } });
    const env = { account: '123456789012', region: 'us-east-1' };
    const messageStream = kinesis.Stream.fromStreamArn(new cdk.Stack(app, 'StreamHost', { env }), 'S', 'arn:aws:kinesis:us-east-1:123456789012:stream/s');
    const t = Template.fromStack(new NotificationStack(app, 'N', {
      env, appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test', userPoolId: 'us-east-1_PRIMARY',
      classifications: assistantClassifications(), senderEmail: 'assistant@example.com', appUrl: 'https://app.example.com', messageStream, notifyBridge: true,
      tokens: dynamodb.Table.fromTableArn(new cdk.Stack(app, 'TokensHost', { env }), 'Tokens', 'arn:aws:dynamodb:us-east-1:123456789012:table/tokens'),
    }));
    const read = statementsOf(t).filter((s) => actionsOf(s).includes('dynamodb:GetItem') && JSON.stringify(s.Condition || {}).includes('#contact#'));
    expect(read.length).toBeGreaterThan(0);
    expect(statementsOf(t).some((s) => actionsOf(s).includes('kms:Decrypt'))).toBe(true);
    expect(statementsOf(t).some((s) => actionsOf(s).includes('kms:Encrypt'))).toBe(false);
  });
});

describe('a deployment with no claims directory', () => {
  it('has no key, no TTL and no copy grant', () => {
    const conv = Template.fromStack(conversationsStacks({}).conversations);
    conv.resourceCountIs('AWS::KMS::Key', 0);
    expect(JSON.stringify(conv.toJSON())).not.toContain('#contact#');
    expect(JSON.stringify(Template.fromStack(conversationsStacks({}).identity).toJSON())).not.toContain('CONTACT_COPY');
  });
});

describe('the profile store beside the registry (C6)', () => {
  it('sets USER_PROFILE_SERVICE_ARN on the router and grants it the invoke', () => {
    const t = basicClassificationTemplate({ userProfileService: PROFILE_SERVICE });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ USER_PROFILE_SERVICE_ARN: PROFILE_SERVICE }) },
    });
    expect(statementsOf(t).some((s) => actionsOf(s).includes('lambda:InvokeFunction') && JSON.stringify(s.Resource) === JSON.stringify(PROFILE_SERVICE))).toBe(true);
  });

  it('leaves both out when none is declared', () => {
    const t = basicClassificationTemplate();
    expect(JSON.stringify(t.toJSON())).not.toContain('USER_PROFILE_SERVICE_ARN');
  });

  it('refuses a value that is not a Lambda function ARN', () => {
    expect(() => basicClassificationTemplate({ userProfileService: 'not-an-arn' })).toThrow(/is not a Lambda function ARN/);
  });
});
