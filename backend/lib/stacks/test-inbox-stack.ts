import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { SSM_ROOT, RES_PREFIX } from './agent-classification-common';

/** Where the inbox is published. `provision-test-users` reads these and writes them into the test secret. */
export const TEST_INBOX_SSM = {
  domain: `${SSM_ROOT}/test-inbox/domain`,
  bucket: `${SSM_ROOT}/test-inbox/bucket`,
  prefix: `${SSM_ROOT}/test-inbox/prefix`,
} as const;

/** The key prefix received mail is written under. */
export const TEST_INBOX_PREFIX = 'inbox/';

export interface TestInboxStackProps extends cdk.StackProps {
  /**
   * The domain test users' addresses are on. Every message to ANY address on it is stored, so use a
   * domain (or subdomain) that exists only for tests: `inbox.example.com`, not your company domain.
   */
  domain: string;
  /**
   * An ACTIVE receipt rule set to add the rule to. SES allows ONE active rule set per region, so an
   * account that already receives mail must name its set here; activating a new one would silently
   * stop the mail the existing set handles. Omitted, this stack creates a set and leaves it INACTIVE
   * for the deployer to activate (the stack output prints the command).
   */
  existingRuleSetName?: string;
  /**
   * Set when `domain` is already a verified SES identity. SES receives only for a verified domain, and
   * CloudFormation cannot create an identity that already exists.
   */
  domainVerified?: boolean;
  /**
   * A Route 53 public hosted zone for `domain`. With it the stack writes the DKIM records that verify
   * the domain and the MX record that routes its mail to SES. Without it the deployer adds both.
   */
  hostedZoneId?: string;
  hostedZoneName?: string;
}

/**
 * WHETHER THIS DEPLOYMENT CREATES ITS OWN TEST INBOX, from its context. Pure, so the decision is tested
 * without a synth (`test/a-test-inbox-admits-only-its-own-rule.test.ts`).
 *
 * `testInboxDomain` alone creates the TestInbox stack. `testInboxDomain` with `testInboxBucket` declares an
 * EXISTING inbox: the domain's receipt rule and bucket belong to someone else (another project's rule in
 * the same account, say), so this deployment creates nothing and provisioning reads the declared bucket
 * (`scripts/lib/test-inbox-config.cjs`). A second receipt rule for that domain would compete with the
 * owner's. Neither key creates nothing.
 *
 * A declaration that cannot name a mailbox is refused rather than ignored: a bucket with no domain (whose
 * mail lands there is unknown) and a prefix with no bucket (a place in nothing).
 */
export interface TestInboxContext {
  testInboxDomain?: unknown;
  testInboxBucket?: unknown;
  testInboxPrefix?: unknown;
  testInboxRuleSet?: unknown;
  testInboxDomainVerified?: unknown;
  testInboxHostedZoneId?: unknown;
  testInboxHostedZoneName?: unknown;
}

export function testInboxStackProps(c: TestInboxContext): Omit<TestInboxStackProps, keyof cdk.StackProps> | null {
  const get = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim() || undefined;
  const domain = get(c.testInboxDomain);
  const bucket = get(c.testInboxBucket);
  if (bucket && !domain) {
    throw new Error('testInboxBucket is set without testInboxDomain: name the domain whose mail that bucket receives');
  }
  if (get(c.testInboxPrefix) && !bucket) {
    throw new Error('testInboxPrefix is set without testInboxBucket: a prefix names where mail lands in an existing bucket. '
      + 'The TestInbox stack writes under its own prefix, so leave testInboxPrefix empty for it');
  }
  if (!domain || bucket) return null;
  return {
    domain,
    existingRuleSetName: get(c.testInboxRuleSet),
    domainVerified: get(c.testInboxDomainVerified) === 'true',
    hostedZoneId: get(c.testInboxHostedZoneId),
    hostedZoneName: get(c.testInboxHostedZoneName),
  };
}

/**
 * A MAILBOX THE E2E SUITE CAN READ, so a test can assert an email was delivered rather than that a send
 * was attempted (SPEC-NOTIFICATION-BRIDGE). OPT-IN, created only when `testInboxDomain` is set and
 * `testInboxBucket` is not (`testInboxStackProps`).
 *
 * SES receives mail for the domain and writes each message, raw, to S3. The suite polls the bucket for
 * a message to a test user (`tests/e2e/helpers/test-inbox.ts`).
 *
 * A deployer who already receives mail somewhere skips this stack and declares that bucket instead:
 * `testInboxBucket` and `testInboxPrefix` beside `testInboxDomain` in `deploy.config.json`, or
 * `TEST_EMAIL_DOMAIN`, `TEST_INBOX_BUCKET` and `TEST_INBOX_PREFIX` at provisioning.
 */
export class TestInboxStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TestInboxStackProps) {
    super(scope, id, props);
    const domain = props.domain.trim().toLowerCase();

    // Test mail only: short-lived, never public, removed with the stack.
    const bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ prefix: TEST_INBOX_PREFIX, expiration: cdk.Duration.days(3) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const zone = props.hostedZoneId && props.hostedZoneName
      ? route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.hostedZoneId, zoneName: props.hostedZoneName,
      })
      : undefined;

    if (!props.domainVerified) {
      new ses.EmailIdentity(this, 'DomainIdentity', {
        identity: zone ? ses.Identity.publicHostedZone(zone) : ses.Identity.domain(domain),
      });
    }
    if (zone) {
      new route53.MxRecord(this, 'Mx', {
        zone,
        recordName: domain,
        values: [{ priority: 10, hostName: `inbound-smtp.${this.region}.amazonaws.com` }],
      });
    }

    const ruleSet = props.existingRuleSetName
      ? ses.ReceiptRuleSet.fromReceiptRuleSetName(this, 'RuleSet', props.existingRuleSetName)
      : new ses.ReceiptRuleSet(this, 'RuleSet', { receiptRuleSetName: `${RES_PREFIX}-test-inbox` });

    const ruleName = `${RES_PREFIX}-test-inbox`;
    // The S3 action is written here rather than with `aws-ses-actions` S3, whose bucket policy admits SES
    // on the account alone: any receipt rule in the account could then write into this bucket. This one
    // admits this rule only.
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects(`${TEST_INBOX_PREFIX}*`)],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:ses:${this.region}:${this.account}:receipt-rule-set/${ruleSet.receiptRuleSetName}:receipt-rule/${ruleName}` },
      },
    }));
    const storeInBucket: ses.IReceiptRuleAction = {
      bind: () => ({ s3Action: { bucketName: bucket.bucketName, objectKeyPrefix: TEST_INBOX_PREFIX } }),
    };
    const rule = new ses.ReceiptRule(this, 'Rule', {
      ruleSet,
      receiptRuleName: ruleName,
      recipients: [domain],
      scanEnabled: true,
      actions: [storeInBucket],
    });
    // SES checks it can write to the bucket when the rule is created, so the policy must exist first.
    rule.node.addDependency(bucket.policy!);

    new ssm.StringParameter(this, 'DomainParam', { parameterName: TEST_INBOX_SSM.domain, stringValue: domain });
    new ssm.StringParameter(this, 'BucketParam', { parameterName: TEST_INBOX_SSM.bucket, stringValue: bucket.bucketName });
    new ssm.StringParameter(this, 'PrefixParam', { parameterName: TEST_INBOX_SSM.prefix, stringValue: TEST_INBOX_PREFIX });

    new cdk.CfnOutput(this, 'TestInboxBucket', { value: bucket.bucketName });
    if (!props.existingRuleSetName) {
      new cdk.CfnOutput(this, 'ActivateRuleSet', {
        description: 'SES receives nothing until the rule set is active. Activating REPLACES any other active set in this region.',
        value: `aws ses set-active-receipt-rule-set --rule-set-name ${RES_PREFIX}-test-inbox --region ${this.region}`,
      });
    }
    if (!zone) {
      new cdk.CfnOutput(this, 'MxRecord', {
        description: `Add this MX record for ${domain} so its mail reaches SES`,
        value: `${domain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
      });
    }
  }
}
