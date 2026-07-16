import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface FrontendDistributionProps {
  /**
   * Managed-rules WAF protection, **on by default**. Attaches a CLOUDFRONT-scoped
   * WAF Web ACL with AWS Managed Rules (Common + Known-Bad-Inputs +
   * Amazon-IP-reputation) and a per-IP rate-limit rule, with `defaultAction:
   * allow` (public-safe — managed rules block malicious traffic, legitimate
   * traffic passes). Set `false` to skip the managed Web ACL (e.g. to avoid the
   * ~$5/mo Web ACL + per-rule cost on a throwaway deployment). Independent of
   * `wafAllowedIps`.
   */
  enableManagedWaf?: boolean;
  /**
   * Per-IP rate limit (requests per 5-minute window) for the rate-based rule.
   * Default 3000. Counts viewer requests (incl. cache hits) per source IP, so
   * keep it generous enough for shared/NAT'd office IPs serving a multi-asset
   * SPA. Only used when `enableManagedWaf` is true.
   */
  wafRateLimit?: number;
  /**
   * Optional IPv4 CIDR allowlist. When non-empty, an additional WAF rule blocks
   * any source IP **not** in these ranges (evaluated before the managed rules) —
   * locks a not-yet-public deployment to office / VPN IPs. Empty (default) =
   * no IP lock; the managed-rules WAF (if enabled) still protects the public
   * distribution. Setting this also forces a Web ACL even if
   * `enableManagedWaf` is false.
   */
  wafAllowedIps?: string[];
}

/**
 * S3 (private) + CloudFront for hosting the AgentEchelon **single-page app**.
 *
 * Hardening highlights:
 *   - Modern Origin Access Control (OAC) instead of the legacy Origin Access
 *     Identity (OAI) — AWS-recommended, SigV4, no canonical-user grant.
 *   - SPA error mapping (403/404 → /index.html 200) so client-side routes and
 *     deep links resolve on refresh.
 *   - Standalone-app security headers: `X-Frame-Options: DENY` (anti
 *     clickjacking — the widget deliberately allowed framing; the app must
 *     not), HSTS, nosniff, strict referrer. No permissive `Access-Control-
 *     Allow-Origin: *` (the SPA serves its own assets same-origin).
 *
 * Deliberately does NOT upload the build. The Vite bundle bakes in CDK
 * outputs (`VITE_USER_POOL_ID`, `VITE_APP_INSTANCE_ARN`, the API URLs) that
 * only exist *after* this stack deploys — a circular dependency if the upload
 * lived here. The flow is therefore two-phase: deploy
 * this (empty) bucket + distribution, populate `frontend/.env` from the stack
 * outputs, `npm run build`, then `backend/scripts/deploy-frontend.mjs` syncs
 * `frontend/dist` and invalidates the distribution.
 */
export class FrontendDistribution extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly bucketName: string;
  public readonly distributionId: string;
  /** CloudFront domain WITHOUT scheme, e.g. d111.cloudfront.net */
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: FrontendDistributionProps = {}) {
    super(scope, id);

    // Private origin bucket. The build is fully rebuildable from source, so —
    // unlike the attachments bucket (RETAIN) — destroy it with the stack and
    // auto-empty it so teardown is clean.
    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.bucketName = this.bucket.bucketName;

    // Security + caching response headers for a standalone SPA.
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SpaHeaders', {
      responseHeadersPolicyName: `${cdk.Stack.of(this).stackName}-SpaHeaders`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true }, // X-Content-Type-Options: nosniff
        frameOptions: {
          // Standalone app must not be framed (clickjacking). The app is
          // a document and should deny framing outright.
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            // Chime SDK voice/video (roadmap) needs camera + microphone from the
            // app's own origin; deny every other powerful feature by default.
            // A Content-Security-Policy is intentionally NOT set here — a strict
            // CSP must enumerate the deployer's Cognito / Chime / API-Gateway
            // connect-src origins, so it is left as a deployer hardening step
            // rather than a default that could brick the SPA on first load.
            header: 'Permissions-Policy',
            value:
              'accelerometer=(), camera=(self), display-capture=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=()',
            override: true,
          },
        ],
      },
    });

    // WAF (CLOUDFRONT scope → the Web ACL is created in us-east-1, which is
    // where this app deploys). Two independent layers, combined into one Web ACL:
    //   • Managed-rules protection (on by default): AWS Managed Common +
    //     Known-Bad-Inputs + Amazon-IP-reputation + a per-IP rate limit, with
    //     defaultAction=allow so the PUBLIC distribution is protected without
    //     blocking legitimate traffic.
    //   • Optional IP allowlist (private mode): a leading rule that blocks any
    //     source IP not in `wafAllowedIps`. Evaluated FIRST, so non-listed IPs
    //     are blocked outright; listed IPs still pass through the managed rules.
    const stackName = cdk.Stack.of(this).stackName;
    const wafAllowedIps = props.wafAllowedIps ?? [];
    const enableManagedWaf = props.enableManagedWaf ?? true;
    const wafRateLimit = props.wafRateLimit ?? 3000;
    let webAclArn: string | undefined;

    if (enableManagedWaf || wafAllowedIps.length > 0) {
      const rules: wafv2.CfnWebACL.RuleProperty[] = [];
      let priority = 0;
      const vis = (metric: string) => ({
        cloudWatchMetricsEnabled: true,
        metricName: metric,
        sampledRequestsEnabled: true,
      });

      // Private-mode IP lock: block everything NOT in the allowlist, first.
      if (wafAllowedIps.length > 0) {
        const ipSet = new wafv2.CfnIPSet(this, 'AllowedIpSet', {
          name: `${stackName}-AllowedIps`,
          scope: 'CLOUDFRONT',
          ipAddressVersion: 'IPV4',
          addresses: wafAllowedIps,
          description: 'IPs allowed to reach the AgentEchelon frontend',
        });
        rules.push({
          name: 'BlockOutsideAllowlist',
          priority: priority++,
          statement: {
            notStatement: {
              statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
            },
          },
          action: { block: {} },
          visibilityConfig: vis(`${stackName}-BlockOutsideAllowlist`),
        });
      }

      if (enableManagedWaf) {
        // AWS Managed Rule groups. `overrideAction: none` lets each group apply
        // its own block actions. Safe for a GET/HEAD/OPTIONS-only static SPA
        // (no large request bodies through CloudFront to trip body-size rules).
        for (const name of [
          'AWSManagedRulesCommonRuleSet',
          'AWSManagedRulesKnownBadInputsRuleSet',
          'AWSManagedRulesAmazonIpReputationList',
        ]) {
          rules.push({
            name,
            priority: priority++,
            statement: {
              managedRuleGroupStatement: { vendorName: 'AWS', name },
            },
            overrideAction: { none: {} },
            visibilityConfig: vis(`${stackName}-${name}`),
          });
        }
        // Per-IP flood protection.
        rules.push({
          name: 'RateLimitPerIp',
          priority: priority++,
          statement: {
            rateBasedStatement: { limit: wafRateLimit, aggregateKeyType: 'IP' },
          },
          action: { block: {} },
          visibilityConfig: vis(`${stackName}-RateLimitPerIp`),
        });
      }

      const webAcl = new wafv2.CfnWebACL(this, 'WebACL', {
        name: `${stackName}-WebACL`,
        scope: 'CLOUDFRONT',
        // Public-safe default: legitimate traffic is allowed; the rules above do
        // the blocking (managed-rule matches, rate excess, or non-allowlisted IP).
        defaultAction: { allow: {} },
        visibilityConfig: vis(`${stackName}-WebACL`),
        rules,
      });
      webAclArn = webAcl.attrArn;
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${cdk.Stack.of(this).stackName} frontend`,
      defaultBehavior: {
        // OAC: CloudFront signs origin requests with SigV4; the bucket policy
        // grants only this distribution. CDK wires the bucket policy for us.
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
      },
      defaultRootObject: 'index.html',
      // SPA routing: client-side routes (and refreshes / email deep links) hit
      // S3 keys that don't exist → S3 returns 403 (OAC) / 404. Serve the app
      // shell with a 200 so the router can resolve the path.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      webAclId: webAclArn,
    });
    this.distributionId = this.distribution.distributionId;
    this.distributionDomainName = this.distribution.distributionDomainName;
  }
}
