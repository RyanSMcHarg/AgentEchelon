/**
 * ADMIN API (`<prefix>AdminApi`): every admin route, on one HTTP API behind IAM. Part of the `admin`
 * capability, with `AdminServices` (whose handlers it serves) and `AdminApp` (the console that calls it).
 *
 * IAM-AUTHORIZED, ROUTE BY ROUTE. The console signs every admin call with a short-lived console session,
 * and each console role is granted `execute-api:Invoke` on exactly the routes its capabilities name in the
 * catalog (`lib/config/admin-capabilities.ts`), so a role without a capability is refused at the gateway
 * before a handler runs. The grants are made here, beside the API, on the roles `AdminServices` creates.
 *
 * ONE ROUTE TAKES A TOKEN: the console session, which is how the console obtains the credentials it signs
 * with. It is behind this API's own edge authorizer on the admin plane, which admits only a token whose
 * issuer declares `admin: true`, uncached; the admin exchange refuses again on the registry entry (tenet D3).
 *
 * CORS: the admin console's origin.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { adminOrigin } from '../config/app-origins';
import type { AdminRole } from '../config/admin-capabilities';
import { grantAdminRolesOnApi } from '../constructs/admin-role-grants';
import { EdgeAuthorizer } from '../constructs/edge-authorizer';
import { RouteTableApi, type RouteSpec } from '../constructs/http-api';
import { INSTANCE_NAME } from './agent-classification-common';

export interface AdminApiStackProps extends cdk.StackProps {
  /** Every admin route, from `AdminServices` and its nested stacks. */
  routes: readonly RouteSpec[];
  /** The console roles (`AdminServices`), granted here on the routes their capabilities name. */
  consoleRoles: Record<AdminRole, iam.IRole>;
  appInstanceArn: string;
  /** This deployment's own pool, or `''` when the registry declares none. */
  selfPoolId: string;
  /** The pool's app clients: the audience its tokens carry. */
  selfClientIds: string[];
  /** `Identities` (Identity): the admin edge reads it, and never writes it. */
  identities: dynamodb.ITable;
}

export class AdminApiStack extends cdk.Stack {
  readonly api: RouteTableApi;
  readonly edge: EdgeAuthorizer;

  constructor(scope: Construct, id: string, props: AdminApiStackProps) {
    super(scope, id, props);
    if (props.routes.some((r) => r.api !== 'admin')) throw new Error('AdminApi serves admin routes only');

    this.edge = new EdgeAuthorizer(this, 'AdminEdgeAuthorizer', {
      appInstanceArn: props.appInstanceArn,
      selfPoolId: props.selfPoolId,
      selfClientIds: props.selfClientIds,
      identities: { tableName: props.identities.tableName, tableArn: props.identities.tableArn },
      plane: 'admin',
    });
    this.api = new RouteTableApi(this, 'AdminApi', {
      apiName: `${INSTANCE_NAME}-admin-api`,
      description: 'Every admin route, behind IAM; the console session behind the admin edge authorizer',
      routes: props.routes,
      allowedOrigins: [adminOrigin(this)],
      edge: this.edge,
    });
    grantAdminRolesOnApi(this, this.api, props.consoleRoles);

    new cdk.CfnOutput(this, 'AdminApiUrl', {
      value: this.api.url,
      description: 'The admin API base URL - VITE_ADMIN_API_URL (admin package only)',
    });
    new cdk.CfnOutput(this, 'AdminApiCapabilities', {
      value: [...new Set(props.routes.map((r) => r.capability))].sort().join(','),
      description: 'The capabilities whose admin routes this API serves - VITE_ADMIN_API_CAPABILITIES',
    });

    cdk.Tags.of(this).add('Component', 'AdminApi');
  }
}
