/**
 * WIDGET HOST (`<prefix>WidgetHost`): the sample page that embeds the widget (`examples/widget-host/`),
 * on an origin of its own. TEST-ONLY and OPT-IN, modeled on `TestIssuerStack`: it exists only when the
 * guest issuer lists `"widget-host"` in its `allowedOrigins` (`WIDGET_HOST_ORIGIN`,
 * `lib/config/issuers.ts`), which synth refuses in production and without the `widget` capability.
 *
 * WHY A PAGE OF ITS OWN: the widget is a frame that only the declared hosts may frame (`frame-ancestors`,
 * `lib/stacks/widget-stack.ts`). A host page on the widget's own origin would be framing itself and prove
 * nothing, so the sample page has its own private bucket behind its own CloudFront distribution
 * (`FrontendDistribution`, the construct the consoles and the widget use: origin access control, HTTPS
 * only, the bucket closed to every other reader), and the widget's `frame-ancestors` names this
 * distribution's origin, taken from this stack by reference rather than typed into any configuration.
 *
 * Like the consoles, it provisions an empty origin, and `scripts/deploy-frontend.mjs --widget-host`
 * publishes the page with the widget's origin (read from the Widget stack's `WidgetDistributionUrl`).
 * The page calls no API: the frame it embeds calls `PersonApi` from the widget's own origin, so this origin
 * is not added to `PersonApi`'s CORS.
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FrontendDistribution } from '../constructs/frontend-distribution';

export interface WidgetHostStackProps extends cdk.StackProps {
  enableManagedWaf?: boolean;
  wafRateLimit?: number;
  wafAllowedIps?: string[];
}

export class WidgetHostStack extends cdk.Stack {
  /** The sample page's origin, `https://<distribution domain>`, with no path. */
  public readonly origin: string;

  constructor(scope: Construct, id: string, props: WidgetHostStackProps = {}) {
    super(scope, id, props);

    const host = new FrontendDistribution(this, 'WidgetHost', {
      enableManagedWaf: props.enableManagedWaf,
      wafRateLimit: props.wafRateLimit,
      wafAllowedIps: props.wafAllowedIps,
    });
    this.origin = `https://${host.distributionDomainName}`;

    // `WidgetHost*`, so the publish (`deploy-guards.cjs` `checkWidgetHostStackOutputs`) never takes another
    // distribution's stack for this one.
    new cdk.CfnOutput(this, 'WidgetHostBucketName', {
      value: host.bucketName,
      description: 'S3 bucket the sample host page (examples/widget-host) is synced to',
    });
    new cdk.CfnOutput(this, 'WidgetHostDistributionId', {
      value: host.distributionId,
      description: 'CloudFront distribution ID of the sample host page (for cache invalidation)',
    });
    new cdk.CfnOutput(this, 'WidgetHostUrl', {
      value: this.origin,
      description: 'The sample host page: an origin other than the widget\'s, named by the widget\'s frame-ancestors',
    });
  }
}
