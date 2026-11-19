/**
 * DashboardPagesStack (`<prefix>DashboardPages`): the `dashboard-pages` capability (DESIGN-CONVERSATION-DASHBOARDS section 4).
 *
 * A conversation dashboard published as a page (`publish_dashboard_page`), opened outside the chat app on a five-minute
 * signed link issued to members only: the page distribution on its own domain, its signing key, and the `/dashboard-link`
 * route that checks the caller is in the conversation before it signs. A deployment that does not declare it stands up
 * none of this, and the page tool is not offered there; the in-app dashboard (`publish_dashboard`) needs no capability.
 *
 * ITS ONE REACH INTO THE CORE is the conversation record's bucket letting CloudFront read dashboard pages, and only pages,
 * which the Conversations stack adds when the capability is declared (`capabilities.ts`, its attach point).
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DashboardDistribution } from '../constructs/dashboard-distribution';
import { grantIssuerRegistry } from '../constructs/trusted-issuers';
import { grantLiveClearance } from '../constructs/directory-access';
import type { RouteSource, RouteSpec } from '../constructs/http-api';

export interface DashboardPagesStackProps extends cdk.StackProps {
  appInstanceArn: string;
  selfPoolId: string;
  /** The conversation record's bucket, by name, whose dashboard pages the distribution serves. */
  attachmentsBucketName: string;
  attachmentsBucketRegionalDomainName: string;
  appUrl?: string;
}

export class DashboardPagesStack extends cdk.Stack implements RouteSource {
  public readonly routes: RouteSpec[] = [];

  constructor(scope: Construct, id: string, props: DashboardPagesStackProps) {
    super(scope, id, props);
    const pages = new DashboardDistribution(this, 'DashboardPages', {
      bucketName: props.attachmentsBucketName,
      bucketRegionalDomainName: props.attachmentsBucketRegionalDomainName,
      appInstanceArn: props.appInstanceArn,
      allowedOrigin: this.node.tryGetContext('appUrl') || props.appUrl || 'http://localhost:5173',
    });
    grantIssuerRegistry(pages.linkFunction, props.selfPoolId);
    grantLiveClearance(pages.linkFunction, { appInstanceArn: props.appInstanceArn, userPoolId: props.selfPoolId });
    this.routes.push({
      api: 'person', method: 'POST', path: '/dashboard-link', handler: pages.linkFunction, capability: 'dashboard-pages',
      throttle: { rate: 10, burst: 20 },
    });
  }
}
