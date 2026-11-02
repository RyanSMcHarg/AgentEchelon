/**
 * AN INVITATION BRINGS ITS PERSON TO THE CONVERSATION, IN THE CHAT APP (SPEC-CONVERSATION-TYPES FR25).
 *
 *  - `invitationLandingFor` is the one place that decides where an invitation's link lands, and it names the chat
 *    app's origin, whether or not the deployment declares a widget;
 *  - the invitations function is handed that origin, so a deployment with no widget issues invitations;
 *  - the link it builds opens the chat app's landing page, with the token in the fragment;
 *  - the chat app's distribution serves that page (`invite.html`) never framed and with no referrer.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { invitationLandingFor } from '../lib/config/app-origins';
import { capabilityDefinition } from '../lib/config/capabilities';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { INVITATION_LANDING_DOCUMENT } from '../lib/stacks/widget-stack';
import { invitationLink, LANDING_PATH } from '../lambda/src/lib/invitations';
import { TEST_ENV } from './helpers/synth';

const APP_URL = 'https://app.example.com';

describe('where an invitation lands', () => {
  it('is the chat app, by its origin, whether or not a widget is declared', () => {
    const plain = new cdk.Stack(new cdk.App({ context: { appUrl: `${APP_URL}/` } }), 'S');
    expect(invitationLandingFor(plain)).toEqual({ client: 'chat', origin: APP_URL });
    const withWidget = new cdk.Stack(new cdk.App({ context: { appUrl: APP_URL, widgetUrl: 'https://widget.example.com' } }), 'S');
    expect(invitationLandingFor(withWidget)).toEqual({ client: 'chat', origin: APP_URL });
  });

  it('opens the chat app\'s landing page, the token in the fragment', () => {
    expect(invitationLink(invitationLandingFor(new cdk.Stack(new cdk.App({ context: { appUrl: APP_URL } }), 'S')).origin, 'tok-en_1'))
      .toBe(`${APP_URL}/invite.html#t=tok-en_1`);
  });
});

describe('a deployment with no widget', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], appUrl: APP_URL } });
  const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn });
  const conversations = new ConversationsStack(app, 'Conversations', {
    env: TEST_ENV,
    appInstanceArn: messaging.appInstanceArn,
    selfPoolId: identity.selfPoolId,
    offboardingRoleArn: identity.offboardingRoleArn,
    credentialExchangeRoleArn: identity.credentialExchangeRoleArn,
    credentialExchangeFunctionArn: identity.credentialExchangeFunction.functionArn,
    invitationLinkReach: identity.invitationLinkReach,
  });

  it('hands the invitations function the chat app\'s origin, so it issues invitations', () => {
    const fns = Object.values(Template.fromStack(conversations).findResources('AWS::Lambda::Function')) as any[];
    const fn = fns.find((f) => f.Properties.Environment?.Variables?.CREDENTIAL_EXCHANGE_FUNCTION);
    expect(fn).toBeDefined();
    expect(fn.Properties.Environment.Variables.INVITATION_LANDING_ORIGIN).toBe(APP_URL);
  });

  it('sends a sign-in invitation\'s holder to the same chat app to sign in', () => {
    const exchange = (Object.values(Template.fromStack(identity).findResources('AWS::Lambda::Function')) as any[])
      .find((f) => f.Properties.Environment?.Variables?.INVITATION_CONFIG);
    expect(JSON.stringify(exchange.Properties.Environment.Variables.INVITATION_CONFIG)).toContain(APP_URL);
  });
});

describe('the chat app serves the landing page', () => {
  const app = new cdk.App();
  const [chat] = capabilityDefinition('chat')!.build!({ app, env: TEST_ENV, prefix: 'Test', settings: {} } as never);
  const t = Template.fromStack(chat);

  it('on its own path, never framed and with no referrer', () => {
    expect(INVITATION_LANDING_DOCUMENT).toBe(LANDING_PATH);
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const behaviors = dist.Properties.DistributionConfig.CacheBehaviors as any[];
    expect(behaviors.map((b) => b.PathPattern)).toEqual(['invite.html']);
    const policy = (t.findResources('AWS::CloudFront::ResponseHeadersPolicy')[behaviors[0].ResponseHeadersPolicyId.Ref] as any).Properties.ResponseHeadersPolicyConfig;
    expect(policy.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('no-referrer');
    expect(policy.SecurityHeadersConfig.FrameOptions.FrameOption).toBe('DENY');
    expect(policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy).toContain("frame-ancestors 'none'");
  });

  it('and the app itself keeps its default behavior', () => {
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    expect(dist.Properties.DistributionConfig.DefaultRootObject).toBe('index.html');
  });
});
