/**
 * WIDGET (`<prefix>Widget`, the `widget` capability): the embeddable assistant widget's hosting.
 *
 * A private S3 bucket and a CloudFront distribution (`FrontendDistribution`, the construct the two
 * consoles use), serving `frontend/packages/widget`'s build: the frame document a host page frames, and
 * `embed.js`, the loader the host page includes. Like the consoles, the stack provisions an empty origin
 * and `backend/scripts/deploy-frontend.mjs --widget` publishes the bundle; cdk never uploads it.
 *
 * WHO MAY FRAME IT IS GENERATED, NEVER TYPED (L9). The distribution's Content-Security-Policy carries
 * `frame-ancestors` built from every `allowedOrigins` the trusted-issuer registry declares (the hosts
 * that embed the widget, a guest issuer's public site and a `host-assertion` issuer's org alike), the
 * same list `PersonApi`'s CORS is built from. A deployment that declares no host gets
 * `frame-ancestors 'none'`: the widget then cannot be framed anywhere, and synth says so. The frame's own
 * origin is this distribution's, which `PersonApi` admits once `npm run deploy` passes it as `widgetUrl`
 * (`lib/config/app-origins.ts`), the same two-phase bootstrap as `appUrl`.
 *
 * The rest of the policy is what the frame needs and nothing more: its own scripts and styles, the
 * captcha vendor's script and frame (`challenges.cloudflare.com`, guest start), the person API and the
 * Amazon Chime SDK (`*.amazonaws.com`, `*.chime.aws`), images from its own origin, `data:` and
 * `*.amazonaws.com` only (so a message cannot load an image from an arbitrary host), and fonts from its
 * own origin or `data:`.
 *
 * THE INVITATION LANDING PAGE IS HERE TOO (`invite.html`, M-5), as an alternative client: every invitation lands in
 * the chat app today, which serves the same page under the same policy (`invitationLandingFor`, `lib/config/app-origins.ts`).
 * It is the page an invitation's link opens, which
 * reads its token from the URL fragment, shows the conversation and a Join button, and redeems by POST. It
 * is a top-level page and never a frame, so its path is served with its own policy (`frame-ancestors
 * 'none'`, `X-Frame-Options: DENY`) and `Referrer-Policy: no-referrer` (`tokenDocuments`).
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FrontendDistribution } from '../constructs/frontend-distribution';
import { issuersOf } from '../constructs/trusted-issuers';
import { WIDGET_HOST_ORIGIN } from '../config/issuers';
import { LANDING_PATH } from '../../lambda/src/lib/invitations';

export interface WidgetStackProps extends cdk.StackProps {
  enableManagedWaf?: boolean;
  wafRateLimit?: number;
  wafAllowedIps?: string[];
  /**
   * The sample host page's origin (`WidgetHostStack.origin`), when the guest issuer lists
   * `"widget-host"` (`WIDGET_HOST_ORIGIN`): it stands in for that value in `frame-ancestors`.
   */
  widgetHostOrigin?: string;
}

/** The captcha vendor guest start verifies (`lib/constructs/guest-issuer.ts`): its script and its frame. */
export const CAPTCHA_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Every origin the registry declares as embedding the widget, deduplicated and sorted. `"widget-host"`
 * (`WIDGET_HOST_ORIGIN`) is the sample host page's origin, `widgetHostOrigin`, read from its stack; with
 * no such stack it names nothing.
 */
export function widgetHosts(scope: Construct, widgetHostOrigin?: string): string[] {
  const declared = [...new Set(issuersOf(scope).entries.flatMap((e) => e.allowedOrigins ?? []))];
  const literal = declared.filter((o) => o !== WIDGET_HOST_ORIGIN).sort();
  return declared.includes(WIDGET_HOST_ORIGIN) && widgetHostOrigin ? [...literal, widgetHostOrigin] : literal;
}

/** The frame's Content-Security-Policy, with `frame-ancestors` from the declared hosts. */
export function widgetContentSecurityPolicy(hosts: readonly string[]): string {
  const ancestors = hosts.length ? hosts.join(' ') : "'none'";
  return [
    "default-src 'self'",
    `script-src 'self' ${CAPTCHA_ORIGIN}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' https://*.amazonaws.com https://*.chime.aws wss://*.chime.aws ${CAPTCHA_ORIGIN}`,
    "img-src 'self' data: https://*.amazonaws.com",
    "font-src 'self' data:",
    `frame-src ${CAPTCHA_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

/** The landing page an invitation's link opens: the one path the invitation email names. */
export const INVITATION_LANDING_DOCUMENT = LANDING_PATH;

/** The landing page's policy: the frame's, framed by nobody. */
export function invitationLandingPolicy(): string {
  return widgetContentSecurityPolicy([]);
}

export class WidgetStack extends cdk.Stack {
  public readonly distributionUrl: string;
  /** The origins that may frame the widget, as synthesized. */
  public readonly hosts: readonly string[];

  constructor(scope: Construct, id: string, props: WidgetStackProps = {}) {
    super(scope, id, props);
    this.hosts = widgetHosts(this, props.widgetHostOrigin);
    if (!this.hosts.length) {
      cdk.Annotations.of(this).addWarningV2('ae:widget-no-hosts',
        'no issuer declares allowedOrigins, so the widget is served with frame-ancestors \'none\' and no page can embed it');
    }

    const frontend = new FrontendDistribution(this, 'Widget', {
      enableManagedWaf: props.enableManagedWaf,
      wafRateLimit: props.wafRateLimit,
      wafAllowedIps: props.wafAllowedIps,
      framedDocumentPolicy: widgetContentSecurityPolicy(this.hosts),
      tokenDocuments: [{ path: INVITATION_LANDING_DOCUMENT, contentSecurityPolicy: invitationLandingPolicy() }],
    });
    this.distributionUrl = `https://${frontend.distributionDomainName}`;

    // `Widget*`, so the publish (`deploy-guards.cjs` `checkWidgetStackOutputs`) never takes a console's
    // stack for this one.
    new cdk.CfnOutput(this, 'WidgetDistributionBucketName', {
      value: frontend.bucketName,
      description: 'S3 bucket the widget build is synced to',
    });
    new cdk.CfnOutput(this, 'WidgetDistributionId', {
      value: frontend.distributionId,
      description: 'CloudFront distribution ID (for cache invalidation)',
    });
    new cdk.CfnOutput(this, 'WidgetDistributionUrl', {
      value: this.distributionUrl,
      description: 'The widget origin: hosts load <url>/embed.js; npm run deploy passes it to PersonApi CORS as widgetUrl',
    });
    new cdk.CfnOutput(this, 'WidgetHosts', {
      value: this.hosts.join(',') || 'none',
      description: 'The origins frame-ancestors admits, from the trusted-issuer registry allowedOrigins',
    });
  }
}
