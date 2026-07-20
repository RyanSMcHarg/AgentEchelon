import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FrontendDistribution } from '../constructs/frontend-distribution';

export interface FrontendStackProps extends cdk.StackProps {
  /**
   * Managed-rules WAF protection, on by default (AWS Managed Rules + rate limit).
   * Set false (CDK context `frontendWaf=false`) to skip the Web ACL.
   */
  enableManagedWaf?: boolean;
  /** Per-IP rate limit / 5-min window for the WAF rate rule. Default 3000. */
  wafRateLimit?: number;
  /**
   * Optional IPv4 CIDR allowlist — locks the distribution to these ranges (in
   * addition to the managed-rules WAF). Wired from the `wafAllowedIps` CDK
   * context in bin/backend.ts. Empty/undefined → no IP lock.
   */
  wafAllowedIps?: string[];
  /**
   * Root/SPA-fallback document. Default `index.html` (chat SPA); the admin app
   * passes `admin.html` (its own Vite entry / `dist-admin/admin.html`).
   */
  rootDocument?: string;
  /**
   * Prefix for this stack's CloudFormation output keys. Default '' →
   * `DistributionBucketName` / `DistributionId` / `DistributionUrl`. The admin
   * stack passes 'Admin' → `AdminDistributionBucketName` / `AdminDistributionId`
   * / `AdminDistributionUrl`, so its outputs don't collide with the chat stack's
   * when both are merged (gen-frontend-env keys outputs by name).
   */
  outputPrefix?: string;
}

/**
 * AgentEchelonFrontend — hosts the AgentEchelon SPA on CloudFront + private S3.
 *
 * This is the DEFAULT production frontend path (`cdk deploy --all` includes
 * it). It provisions an empty origin bucket + distribution only; the build is
 * uploaded out-of-band after the rest of the app deploys, because the Vite
 * bundle bakes in this app's CDK outputs. See FrontendDistribution and
 * `backend/scripts/deploy-frontend.mjs`.
 *
 * Deploy flow:
 *   1. cdk deploy --all                 (creates this bucket + distribution)
 *   2. populate frontend/.env from CDK outputs
 *   3. set --context appUrl=https://<DistributionUrl> and redeploy so backend
 *      CORS allows the app origin (or use a custom domain known up front)
 *   4. node backend/scripts/deploy-frontend.mjs   (build + sync + invalidate)
 */
export class FrontendStack extends cdk.Stack {
  public readonly distributionBucketName: string;
  public readonly distributionId: string;
  /** Full https:// URL of the deployed app. */
  public readonly distributionUrl: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps = {}) {
    super(scope, id, props);

    const frontend = new FrontendDistribution(this, 'Frontend', {
      enableManagedWaf: props.enableManagedWaf,
      wafRateLimit: props.wafRateLimit,
      wafAllowedIps: props.wafAllowedIps,
      rootDocument: props.rootDocument,
    });

    this.distributionBucketName = frontend.bucketName;
    this.distributionId = frontend.distributionId;
    this.distributionUrl = `https://${frontend.distributionDomainName}`;

    const p = props.outputPrefix ?? '';
    const isAdmin = p !== '';

    // Outputs consumed by backend/scripts/deploy-frontend.mjs (build → sync →
    // invalidate) and by the deployer wiring frontend/.env + the CORS context.
    // The admin stack prefixes them ('Admin*') so the two frontend stacks' outputs
    // don't collide when merged by name.
    new cdk.CfnOutput(this, `${p}DistributionBucketName`, {
      value: this.distributionBucketName,
      description: 'S3 bucket the frontend build is synced to',
    });
    new cdk.CfnOutput(this, `${p}DistributionId`, {
      value: this.distributionId,
      description: 'CloudFront distribution ID (for cache invalidation)',
    });
    new cdk.CfnOutput(this, `${p}DistributionUrl`, {
      value: this.distributionUrl,
      description: isAdmin
        ? 'Admin console URL — set this as --context adminAppUrl for backend CORS'
        : 'Public app URL — set this as --context appUrl for backend CORS',
    });
  }
}
