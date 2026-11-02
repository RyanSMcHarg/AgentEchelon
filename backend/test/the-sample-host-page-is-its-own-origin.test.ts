/**
 * THE SAMPLE HOST PAGE IS AN ORIGIN OF ITS OWN, AND THE WIDGET NAMES IT FROM ITS STACK (examples/widget-host).
 *
 *  - The `WidgetHost` stack is a private bucket behind its own CloudFront distribution: public access
 *    blocked, TLS required on the bucket, the bucket read only through origin access control, and the
 *    viewer redirected to HTTPS.
 *  - A guest issuer listing `"widget-host"` gets that distribution's origin in the widget's
 *    `frame-ancestors`, as a reference to the stack, never as a typed domain; without the stack the value
 *    names nothing. `PersonApi`'s CORS never carries it: the page calls no API.
 *  - The value is the guest issuer's alone, and production refuses it.
 *  - `deploy.mjs` publishes the page exactly when the value is declared.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WidgetHostStack } from '../lib/stacks/widget-host-stack';
import { WidgetStack, widgetHosts } from '../lib/stacks/widget-stack';
import { personApiOrigins } from '../lib/stacks/person-api-stack';
import { WIDGET_HOST_ORIGIN, declaresWidgetHost, issuerErrors } from '../lib/config/issuers';
import { defaultProfileRegistry } from '../lib/profile-registry';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { declaredWidgetHost, contextFlagsFromConfig, DEPLOY_STEPS, WIDGET_HOST_ORIGIN: SCRIPT_VALUE } = require('../scripts/lib/deploy-guards.cjs');

const env = { account: '111122223333', region: 'us-east-1' };
const SITE = 'https://www.example.com';
const ALL = ['basic', 'standard', 'premium', 'admin'];
const DEPLOYMENT = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true };
const GUEST = { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, allowedOrigins: [SITE, WIDGET_HOST_ORIGIN] };

function frameAncestors(template: Template): string {
  const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
  const config = (Object.values(policies)[0] as any).Properties.ResponseHeadersPolicyConfig;
  return JSON.stringify(config.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);
}

describe('the WidgetHost stack', () => {
  const t = Template.fromStack(new WidgetHostStack(new cdk.App(), 'TestWidgetHost', { env, enableManagedWaf: false }));

  it('is a private bucket, readable only by its own distribution through origin access control', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
      }),
    });
    // TLS on the bucket, and the one grant is the distribution's.
    const policy = JSON.stringify(t.findResources('AWS::S3::BucketPolicy'));
    expect(policy).toContain('aws:SecureTransport');
    expect(policy).toContain('cloudfront.amazonaws.com');
    expect(policy).not.toMatch(/"Principal":"\*","Action":"s3:GetObject"/);
  });

  it('outputs what the publish reads, under its own names', () => {
    for (const key of ['WidgetHostBucketName', 'WidgetHostDistributionId', 'WidgetHostUrl']) t.hasOutput(key, {});
  });
});

describe('the widget names the sample host page from its stack', () => {
  it('puts the stack\'s origin in frame-ancestors by reference, beside the typed hosts', () => {
    const app = new cdk.App({ context: { issuers: [DEPLOYMENT, GUEST] } });
    const host = new WidgetHostStack(app, 'TestWidgetHost', { env, enableManagedWaf: false });
    const widget = new WidgetStack(app, 'TestWidget', { env, enableManagedWaf: false, widgetHostOrigin: host.origin });
    const ancestors = frameAncestors(Template.fromStack(widget));
    expect(ancestors).toContain(SITE);
    expect(ancestors).toContain('Fn::ImportValue');
    expect(ancestors).not.toContain(WIDGET_HOST_ORIGIN);
    expect(widget.dependencies.map((s) => s.stackName)).toContain(host.stackName);
  });

  it('names nothing for the value when there is no stack', () => {
    const scope = new cdk.Stack(new cdk.App({ context: { issuers: [DEPLOYMENT, GUEST] } }), 'S', { env });
    expect(widgetHosts(scope)).toEqual([SITE]);
  });

  it('is never a PersonApi origin', () => {
    const origins = personApiOrigins(new cdk.Stack(new cdk.App({ context: { issuers: [DEPLOYMENT, GUEST], appUrl: 'https://chat.example.com' } }), 'S', { env }));
    expect(origins).toContain(SITE);
    expect(origins).not.toContain(WIDGET_HOST_ORIGIN);
  });
});

describe('who may declare it', () => {
  const errors = (entries: unknown[], environment = 'dev') => issuerErrors(entries, defaultProfileRegistry, { environment }).join('\n');

  it('is the guest issuer\'s, outside production', () => {
    expect(errors([DEPLOYMENT, GUEST])).not.toMatch(/widget-host/);
    expect(declaresWidgetHost([DEPLOYMENT, GUEST])).toBe(true);
    expect(declaresWidgetHost([DEPLOYMENT, { ...GUEST, allowedOrigins: [SITE] }])).toBe(false);
  });

  it('is refused in production and on any other kind', () => {
    expect(errors([DEPLOYMENT, GUEST], 'production')).toMatch(/"widget-host" is a sample page for testing the widget, refused in production/);
    const host = { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', audience: 'host-client', allowedOrigins: [WIDGET_HOST_ORIGIN], clearance: { oneChannel: 'basic', classifications: ['basic'] } };
    expect(errors([DEPLOYMENT, host])).toMatch(/"widget-host" is the sample host page a guest issuer's visitors arrive from/);
  });

  it('is still refused as any other bare word', () => {
    expect(errors([DEPLOYMENT, { ...GUEST, allowedOrigins: ['widget-host-2'] }])).toMatch(/allowedOrigins lists https origins/);
  });
});

describe('the deploy publishes the page exactly when it is declared', () => {
  it('reads the declaration from the forwarded registry, as deploy.config.json forwards it', () => {
    expect(SCRIPT_VALUE).toBe(WIDGET_HOST_ORIGIN);
    expect(declaredWidgetHost(contextFlagsFromConfig({ issuers: [DEPLOYMENT, GUEST] }))).toBe(true);
    expect(declaredWidgetHost(contextFlagsFromConfig({ issuers: [DEPLOYMENT, { ...GUEST, allowedOrigins: [SITE] }] }))).toBe(false);
    expect(declaredWidgetHost([])).toBe(false);
  });

  it('publishes it after the widget, whose origin it names', () => {
    expect(DEPLOY_STEPS.indexOf('publishWidgetHost')).toBe(DEPLOY_STEPS.indexOf('publishWidget') + 1);
  });
});
