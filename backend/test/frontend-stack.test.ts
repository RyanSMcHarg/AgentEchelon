/**
 * FrontendStack (AgentEchelonFrontend) synthesis tests.
 *
 * The stack hosts the SPA on CloudFront + private S3. It must synthesize with
 * NO dependency on a built frontend (the build is synced out-of-band by
 * scripts/deploy-frontend.mjs), and must apply the SPA-hardening defaults.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/stacks/frontend-stack';

const env = { account: '123456789012', region: 'us-east-1' };

describe('FrontendStack (AgentEchelonFrontend)', () => {
  it('synthesizes a private bucket + CloudFront distribution + managed-rules WAF by default', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontend', { env });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    // Private origin bucket — all public access blocked.
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    // Managed-rules WAF is ON by default: a CLOUDFRONT Web ACL with
    // defaultAction=allow + the AWS managed rule groups + a rate-based rule.
    // No IPSet without an allowlist.
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::WAFv2::IPSet', 0);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: Match.objectLike({
            ManagedRuleGroupStatement: Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
          }),
        }),
        Match.objectLike({
          Statement: Match.objectLike({
            RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }),
          }),
        }),
      ]),
    });
    // The distribution references the Web ACL.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
  });

  it('skips the Web ACL when managed WAF is disabled and no allowlist', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontend', { env, enableManagedWaf: false });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  it('serves the SPA shell on 403/404 and sets index.html as the root', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontend', { env });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
  });

  it('applies SPA security response headers (HSTS, nosniff, frame DENY)', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontend', { env });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ContentTypeOptions: { Override: true },
          StrictTransportSecurity: Match.objectLike({ IncludeSubdomains: true }),
        }),
      }),
    });
  });

  it('emits the bucket / distribution / url outputs the deploy script reads', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontend', { env });
    const template = Template.fromStack(stack);

    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(['DistributionBucketName', 'DistributionId', 'DistributionUrl']),
    );
  });

  it('adds a CLOUDFRONT-scoped WAF allowlist when wafAllowedIps is set', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontend', {
      env,
      wafAllowedIps: ['203.0.113.4/32', '198.51.100.0/24'],
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::WAFv2::IPSet', {
      Scope: 'CLOUDFRONT',
      IPAddressVersion: 'IPV4',
      Addresses: ['203.0.113.4/32', '198.51.100.0/24'],
    });
    // defaultAction stays allow (managed-rules-safe); the allowlist is enforced
    // by a leading rule that BLOCKS any IP NOT in the set.
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'BlockOutsideAllowlist',
          Action: { Block: {} },
          Statement: Match.objectLike({
            NotStatement: Match.objectLike({
              Statement: Match.objectLike({ IPSetReferenceStatement: Match.anyValue() }),
            }),
          }),
        }),
      ]),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
  });
});
