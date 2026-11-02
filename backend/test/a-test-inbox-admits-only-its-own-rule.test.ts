/**
 * THE TEST INBOX STORES ONE DOMAIN'S MAIL, AND ONLY ITS OWN RECEIPT RULE CAN WRITE IT.
 *
 * The opt-in TestInbox stack is what lets a notification e2e assert an email ARRIVED. It receives mail
 * through an SES receipt rule into S3. Two things here are easy to get wrong and invisible once deployed:
 * the bucket policy (the stock SES S3 action admits any receipt rule in the account) and the rule set
 * (SES allows one ACTIVE set per region, so an account that already receives mail must add to its set
 * rather than gain a new one).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { TestInboxStack, TEST_INBOX_SSM, TEST_INBOX_PREFIX, testInboxStackProps } from '../lib/stacks/test-inbox-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const synth = (props: Partial<ConstructorParameters<typeof TestInboxStack>[2]> = {}) =>
  Template.fromStack(new TestInboxStack(new cdk.App(), 'TestInbox', { env, domain: 'Inbox.Example.com', ...props }));

describe('the test inbox', () => {
  it('stores mail for its domain, raw, under its prefix', () => {
    synth().hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: Match.objectLike({
        Recipients: ['inbox.example.com'],
        Enabled: true,
        Actions: [{ S3Action: Match.objectLike({ ObjectKeyPrefix: TEST_INBOX_PREFIX }) }],
      }),
    });
  });

  it('admits SES to write only for THIS receipt rule, not any rule in the account', () => {
    const t = synth();
    const statements = Object.values(t.findResources('AWS::S3::BucketPolicy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((st: any) => st.Principal?.Service === 'ses.amazonaws.com');
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('s3:PutObject');
    expect(statements[0].Condition.StringEquals['aws:SourceAccount']).toBe('123456789012');
    expect(JSON.stringify(statements[0].Condition.ArnLike['aws:SourceArn'])).toMatch(/receipt-rule\/agent-echelon-test-inbox/);
  });

  it('creates its own rule set, left inactive, when the account names none', () => {
    const t = synth();
    t.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    t.hasOutput('ActivateRuleSet', Match.anyValue());
  });

  it('adds its rule to the account\'s ACTIVE rule set when one is named, and creates no second set', () => {
    const t = synth({ existingRuleSetName: 'company-inbound' });
    t.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    t.hasResourceProperties('AWS::SES::ReceiptRule', { RuleSetName: 'company-inbound' });
    expect(Object.keys(t.findOutputs('ActivateRuleSet'))).toHaveLength(0);
  });

  it('verifies the domain unless it is already verified, because SES receives only for a verified domain', () => {
    synth().resourceCountIs('AWS::SES::EmailIdentity', 1);
    synth({ domainVerified: true }).resourceCountIs('AWS::SES::EmailIdentity', 0);
  });

  it('writes the MX record only when it is given the hosted zone, and otherwise says what to add', () => {
    const zoned = synth({ hostedZoneId: 'Z123', hostedZoneName: 'example.com' });
    zoned.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'MX', ResourceRecords: ['10 inbound-smtp.us-east-1.amazonaws.com'] });
    synth().hasOutput('MxRecord', Match.anyValue());
  });

  it('publishes where it is, for provisioning to write into the test secret', () => {
    const t = synth();
    for (const name of Object.values(TEST_INBOX_SSM)) t.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
  });
});

describe('whether a deployment creates its own test inbox (testInboxStackProps, read by bin/backend.ts)', () => {
  it('creates one for testInboxDomain alone, with the stack options the context carries', () => {
    expect(testInboxStackProps({
      testInboxDomain: ' inbox.example.com ', testInboxRuleSet: 'company-inbound', testInboxDomainVerified: 'true',
    })).toEqual({
      domain: 'inbox.example.com',
      existingRuleSetName: 'company-inbound',
      domainVerified: true,
      hostedZoneId: undefined,
      hostedZoneName: undefined,
    });
  });

  it('creates NONE when testInboxBucket declares an existing inbox: the domain\'s receipt rule is not this deployment\'s', () => {
    expect(testInboxStackProps({
      testInboxDomain: 'dev.example.com', testInboxBucket: 'another-projects-mail', testInboxPrefix: 'test-emails/app/',
    })).toBeNull();
  });

  it('creates none when no domain is set, and treats empty strings as unset', () => {
    expect(testInboxStackProps({})).toBeNull();
    expect(testInboxStackProps({ testInboxDomain: '', testInboxBucket: '', testInboxPrefix: '' })).toBeNull();
  });

  it('refuses a declaration that names no mailbox: a bucket with no domain, or a prefix with no bucket', () => {
    expect(() => testInboxStackProps({ testInboxBucket: 'b' })).toThrow(/testInboxBucket.*testInboxDomain/);
    expect(() => testInboxStackProps({ testInboxDomain: 'inbox.example.com', testInboxPrefix: 'p/' })).toThrow(/testInboxPrefix.*testInboxBucket/);
  });

  it('is what bin/backend.ts reads the context through, so the app and this test cannot disagree', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'backend.ts'), 'utf8');
    expect(src).toMatch(/const testInbox = testInboxStackProps\(/);
    expect(src).toMatch(/if \(testInbox\) \{\s*new TestInboxStack\(/);
    for (const k of ['testInboxDomain', 'testInboxBucket', 'testInboxPrefix']) expect(src).toContain(`tryGetContext('${k}')`);
  });
});
