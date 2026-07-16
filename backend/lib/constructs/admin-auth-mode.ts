/**
 * Admin-plane auth mode — the CDK half of "bring your own admin console + auth"
 * (see docs/ADMIN-INTEGRATION-GUIDE.md). Lets a deployer choose, per
 * deployment, how the admin/analytics APIs authenticate operators WITHOUT
 * forking the stacks:
 *
 *   -c adminAuthMode=ae-cognito   (default) Cognito authorizer on AE's own
 *                                  user pool — the standalone behavior.
 *   -c adminAuthMode=federated    Cognito authorizer on the HOST's admin pool
 *                                  (-c hostAdminPoolId=<userPoolId>). The host
 *                                  owns admin auth; AE trusts its tokens and
 *                                  gates on the claim named by ADMIN_GROUP_NAMES.
 *   -c adminAuthMode=service      IAM (SigV4) authorization — no Cognito
 *                                  authorizer. Only AWS principals granted
 *                                  execute-api:Invoke (your backend proxy's
 *                                  role) can call; the handler trusts the signed
 *                                  caller (see callerIsAdmin in lambda auth.ts).
 *
 * Pair this with the Lambda env var so the handlers honor the same mode:
 *   environment: { ADMIN_AUTH_MODE: getAdminAuthMode(this), ADMIN_GROUP_NAMES: ... }
 *
 * In `ae-cognito` mode the produced CloudFormation is identical to a plain
 * hand-written Cognito authorizer, so existing deployments see no destructive diff.
 */

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export type AdminAuthMode = 'ae-cognito' | 'federated' | 'service';

/** Resolve the deployment's admin auth mode from CDK context (default ae-cognito). */
export function getAdminAuthMode(scope: Construct): AdminAuthMode {
  const raw = (scope.node.tryGetContext('adminAuthMode') as string | undefined) ?? 'ae-cognito';
  if (raw === 'ae-cognito' || raw === 'federated' || raw === 'service') return raw;
  throw new Error(
    `Invalid -c adminAuthMode="${raw}" — expected one of: ae-cognito | federated | service`,
  );
}

/**
 * Env vars to attach to every admin/analytics Lambda so its handler honors the
 * same mode the gateway authorizer was built with. Spread into `environment`:
 *   environment: { ...adminAuthEnv(this), ATHENA_WORKGROUP: ... }
 *
 * - `ADMIN_AUTH_MODE` lets the handler treat IAM-signed service calls as admin
 *   in `service` mode (see callerIsAdmin in lambda auth.ts).
 * - `ADMIN_GROUP_NAMES` (only when `-c adminGroupNames=` is set) tells the
 *   handler which `cognito:groups` value denotes admin — needed in `federated`
 *   mode when the host emits a group other than `admins`.
 */
export function adminAuthEnv(scope: Construct): Record<string, string> {
  const env: Record<string, string> = { ADMIN_AUTH_MODE: getAdminAuthMode(scope) };
  const groups = scope.node.tryGetContext('adminGroupNames') as string | undefined;
  if (groups) env.ADMIN_GROUP_NAMES = groups;
  return env;
}

/**
 * Build the API Gateway MethodOptions for ONE admin/analytics API, honoring
 * `adminAuthMode`. Call once per API and reuse the returned options across all
 * of that API's methods — a single shared authorizer is created per call.
 *
 * `aePool` supplies AgentEchelon's own user pool for `ae-cognito` mode, either
 * as an already-imported `userPool` or a `userPoolId` to import. If neither is
 * given in `ae-cognito` mode the endpoint is left unauthenticated (matching
 * the behavior of the optional-userPool analytics endpoint).
 */
export function adminApiMethodOptions(
  scope: Construct,
  authorizerId: string,
  aePool: { userPool?: cognito.IUserPool; userPoolId?: string },
): apigateway.MethodOptions {
  const mode = getAdminAuthMode(scope);

  if (mode === 'service') {
    // Host owns auth; only IAM-signed (SigV4) service calls are accepted.
    return { authorizationType: apigateway.AuthorizationType.IAM };
  }

  let pool: cognito.IUserPool | undefined;
  if (mode === 'federated') {
    const hostAdminPoolId = scope.node.tryGetContext('hostAdminPoolId') as string | undefined;
    if (!hostAdminPoolId) {
      throw new Error(
        'adminAuthMode=federated requires -c hostAdminPoolId=<userPoolId> (your admin pool)',
      );
    }
    pool = cognito.UserPool.fromUserPoolId(scope, `${authorizerId}HostPool`, hostAdminPoolId);
  } else {
    // ae-cognito (default)
    pool =
      aePool.userPool ??
      (aePool.userPoolId
        ? cognito.UserPool.fromUserPoolId(scope, `${authorizerId}AePool`, aePool.userPoolId)
        : undefined);
    // Fail closed: returning `{}` here would emit an admin method with
    // AuthorizationType.NONE — a fully open admin endpoint. A missing pool in
    // ae-cognito mode is a misconfiguration; surface it at synth.
    if (!pool) {
      throw new Error(
        `adminAuthMode=ae-cognito requires a user pool for authorizer "${authorizerId}" ` +
          '(pass aePool.userPool or aePool.userPoolId); refusing to emit an unauthenticated admin method.',
      );
    }
  }

  const authorizer = new apigateway.CognitoUserPoolsAuthorizer(scope, authorizerId, {
    cognitoUserPools: [pool],
  });
  return {
    authorizer,
    authorizationType: apigateway.AuthorizationType.COGNITO,
  };
}
