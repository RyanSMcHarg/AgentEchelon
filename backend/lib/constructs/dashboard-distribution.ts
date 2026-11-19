/**
 * THE DASHBOARD PAGES' DISTRIBUTION AND LINK (DESIGN-CONVERSATION-DASHBOARDS section 4, `publish_dashboard_page`).
 *
 * A CloudFront distribution of its own, on its own domain, so a dashboard page can never reach the chat app's storage or
 * token. Every request needs a signed URL (a trusted key group), and the distribution may read exactly one object kind
 * from the conversation record's bucket: a dashboard's `page.html`. The `snapshot.json` beside it, and every other key
 * family, stay outside its reach. The key pair is made at deploy, its private half kept in a secret only the link
 * function reads, and the link function signs one URL for one member after checking they are in the conversation.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { DASHBOARD_CSP } from '../../lambda/src/lib/dashboard-render';
import { DASHBOARD_PAGE_OBJECTS } from '../../lambda/src/lib/dashboard-keys';

/**
 * THE BUCKET'S ONE GRANT TO THE PAGE DISTRIBUTION, added by the bucket's own stack when `dashboard-pages` is declared: CloudFront
 * may read a conversation's dashboard page, under any classification, for a distribution of this account, and nothing else
 * in the bucket. The snapshot beside each page, and every other key family, stay outside it.
 */
export function dashboardPagesReadStatement(bucket: s3.IBucket, account: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DashboardPagesToTheirDistribution',
    actions: ['s3:GetObject'],
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    resources: [bucket.arnForObjects(DASHBOARD_PAGE_OBJECTS)],
    conditions: {
      StringEquals: { 'AWS:SourceAccount': account },
      ArnLike: { 'AWS:SourceArn': `arn:aws:cloudfront::${account}:distribution/*` },
    },
  });
}

export class DashboardDistribution extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly linkFunction: lambdaNodeJs.NodejsFunction;

  constructor(scope: Construct, id: string, props: { bucketName: string; bucketRegionalDomainName: string; appInstanceArn: string; allowedOrigin: string }) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // THE SIGNING KEY, MADE ONCE: its private half in this secret, its public half in the key group.
    const secret = new secretsmanager.Secret(this, 'SigningKey', {
      description: 'The private key that signs dashboard page links; read only by the dashboard link function',
    });
    const keyFn = new lambdaNodeJs.NodejsFunction(this, 'SigningKeyFunction', {
      entry: 'lambda/src/dashboard-signing-key.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
    secret.grantRead(keyFn);
    secret.grantWrite(keyFn);
    const keyResource = new cdk.CustomResource(this, 'SigningKeyPair', {
      serviceToken: new cr.Provider(this, 'SigningKeyProvider', { onEventHandler: keyFn }).serviceToken,
      properties: { SecretArn: secret.secretArn },
    });
    const publicKey = new cloudfront.PublicKey(this, 'PublicKey', {
      encodedKey: keyResource.getAttString('PublicKeyPem'),
      comment: 'Verifies dashboard page links',
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'KeyGroup', { items: [publicKey] });

    // THE PAGE CARRIES ITS OWN POLICY, AND THE EDGE REPEATS IT: nothing loads, nothing runs, nothing frames it.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      responseHeadersPolicyName: `${stack.stackName}-DashboardPage`,
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        contentSecurityPolicy: { contentSecurityPolicy: DASHBOARD_CSP, override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
      customHeadersBehavior: { customHeaders: [{ header: 'Cache-Control', value: 'no-store', override: true }] },
    });

    // THE BUCKET IS REFERENCED, NOT HANDED OVER: an origin built on the bucket itself writes a policy reading every key. The
    // bucket's own stack lets CloudFront read dashboard pages, and only pages (`dashboardPagesReadStatement`).
    const referenced = s3.Bucket.fromBucketAttributes(this, 'Bucket', {
      bucketName: props.bucketName,
      bucketRegionalDomainName: props.bucketRegionalDomainName,
    });
    const oac = new cloudfront.S3OriginAccessControl(this, 'OriginAccess', { signing: cloudfront.Signing.SIGV4_ALWAYS });
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${stack.stackName} dashboard pages`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(referenced, { originAccessControl: oac }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: headers,
        trustedKeyGroups: [keyGroup],
        compress: true,
      },
    });

    // THE LINK: a member's check, then one signed URL to one page.
    this.linkFunction = new lambdaNodeJs.NodejsFunction(this, 'LinkFunction', {
      entry: 'lambda/src/dashboard-link.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        ALLOWED_ORIGIN: props.allowedOrigin,
        DASHBOARD_DOMAIN: this.distribution.distributionDomainName,
        DASHBOARD_KEY_PAIR_ID: publicKey.publicKeyId,
        DASHBOARD_SIGNING_SECRET_ARN: secret.secretArn,
      },
    });
    secret.grantRead(this.linkFunction);
    this.linkFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:DescribeChannelMembership'],
      resources: [`${props.appInstanceArn}/channel/*`, `${props.appInstanceArn}/user/*`],
    }));
    this.linkFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['chime:ListTagsForResource'],
      resources: [`${props.appInstanceArn}/channel/*`],
    }));
    new cdk.CfnOutput(this, 'DashboardDomain', { value: this.distribution.distributionDomainName });
  }
}
