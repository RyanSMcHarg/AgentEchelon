/**
 * THE WIDGET IS FRAMED ONLY BY THE DECLARED HOSTS, AND PERSONAPI ADMITS ITS FRAME (L9, E12).
 *
 * `frame-ancestors` on the Widget distribution is generated from every `allowedOrigins` the
 * trusted-issuer registry declares, never typed and never `*`; with none declared it is `'none'`. The
 * frame's own origin (`widgetUrl`) joins `PersonApi`'s CORS with the `widget` capability, beside the
 * declared hosts, which are already there.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WidgetStack, widgetContentSecurityPolicy } from '../lib/stacks/widget-stack';
import { personApiOrigins } from '../lib/stacks/person-api-stack';
import { capabilityDefinition } from '../lib/config/capabilities';

const env = { account: '111122223333', region: 'us-east-1' };
const SITE = 'https://www.example.com';
const ORG = 'https://acme.lightning.force.com';
const ALL = ['basic', 'standard', 'premium', 'admin'];
const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, allowedOrigins: [SITE] },
  { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', audience: 'host-client', allowedOrigins: [ORG, SITE], clearance: { oneChannel: 'basic', classifications: ['basic'] } },
];

function policyOf(template: Template): { csp: string; config: Record<string, any> } {
  const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
  const config = (Object.values(policies)[0] as any).Properties.ResponseHeadersPolicyConfig;
  return { csp: config.SecurityHeadersConfig.ContentSecurityPolicy?.ContentSecurityPolicy, config };
}

function widget(context: Record<string, unknown>): Template {
  const app = new cdk.App({ context });
  return Template.fromStack(new WidgetStack(app, 'TestWidget', { env, enableManagedWaf: false }));
}

describe('the Widget stack', () => {
  it('is a built capability that stands up exactly the Widget stack', () => {
    const def = capabilityDefinition('widget')!;
    expect(def.notBuilt).toBeUndefined();
    expect(def.stacks).toEqual(['Widget']);
    expect(typeof def.build).toBe('function');
  });

  it('sends frame-ancestors with every declared host, once each, and nothing else', () => {
    const { csp } = policyOf(widget({ issuers: ISSUERS }));
    const ancestors = csp.split('; ').find((d) => d.startsWith('frame-ancestors '))!;
    expect(ancestors.split(' ').slice(1).sort()).toEqual([ORG, SITE].sort());
    expect(ancestors).not.toContain('*');
  });

  it('may not be framed anywhere when no issuer declares a host', () => {
    const { csp } = policyOf(widget({}));
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sends no X-Frame-Options, which would refuse every host, and denies every powerful feature', () => {
    const { config } = policyOf(widget({ issuers: ISSUERS }));
    expect(config.SecurityHeadersConfig.FrameOptions).toBeUndefined();
    const permissions = config.CustomHeadersConfig.Items.find((h: { Header: string }) => h.Header === 'Permissions-Policy').Value;
    expect(permissions).toContain('camera=()');
    expect(permissions).toContain('microphone=()');
  });

  it('limits what the frame loads: its own scripts and the captcha vendor, images from no arbitrary host', () => {
    const csp = widgetContentSecurityPolicy([SITE]);
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: https://*.amazonaws.com");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/img-src[^;]* https:(;|$| )/);
  });

  it('publishes the Widget* outputs the publish reads', () => {
    const outputs = Object.keys(widget({ issuers: ISSUERS }).toJSON().Outputs ?? {});
    expect(outputs).toEqual(expect.arrayContaining(['WidgetDistributionBucketName', 'WidgetDistributionId', 'WidgetDistributionUrl', 'WidgetHosts']));
  });

  it('is a private bucket behind CloudFront', () => {
    const t = widget({ issuers: ISSUERS });
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });
});

describe('PersonApi CORS', () => {
  const originsWith = (context: Record<string, unknown>) => personApiOrigins(new cdk.Stack(new cdk.App({ context }), 'S', { env }));

  it('admits every declared host and, with the widget capability, the widget frame\'s own origin', () => {
    const origins = originsWith({ issuers: ISSUERS, appUrl: 'https://chat.example.com', capabilities: ['widget'], widgetUrl: 'https://widget.example.com/' });
    expect(origins.sort()).toEqual(['https://chat.example.com', 'https://widget.example.com', ORG, SITE].sort());
  });

  it('does not admit a widget origin without the widget capability', () => {
    const origins = originsWith({ issuers: ISSUERS, appUrl: 'https://chat.example.com', capabilities: ['chat'], widgetUrl: 'https://widget.example.com' });
    expect(origins).not.toContain('https://widget.example.com');
  });
});
