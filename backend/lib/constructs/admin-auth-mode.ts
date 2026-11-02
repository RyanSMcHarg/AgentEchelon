/**
 * Admin-plane auth mode: the handler-side half of "bring your own admin console + auth"
 * (see docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md).
 *
 * Every admin route, `GET /feedback` included, is AWS_IAM in every deployment
 * (`ADMIN_IAM_METHOD_OPTIONS` in admin-role-grants.ts); this setting selects no authorizer. It is
 * read only to set `ADMIN_AUTH_MODE` on the admin handlers:
 *
 *   -c adminAuthMode=ae-cognito   (default) AE's own pool and console.
 *   -c adminAuthMode=service      A trusted backend principal granted `execute-api:Invoke` calls the
 *                                  admin APIs; the handler trusts any IAM-signed caller as admin
 *                                  (`isServiceAdminCall` in lambda auth.ts).
 *
 * `federated` is retired and refused at synth: every admin route is AWS_IAM, so a mode that names a
 * host's admin sign-in would select nothing, and a deployer passing it would believe it did.
 *
 * Spread the env into each admin Lambda's environment:
 *   environment: { ...adminAuthEnv(this), ATHENA_WORKGROUP: ... }
 */

import type { Construct } from 'constructs';
import { issuersOf } from './trusted-issuers';

export type AdminAuthMode = 'ae-cognito' | 'service';

/** The refusal for the retired `federated` value, naming what reaches the console instead. */
export const FEDERATED_ADMIN_MODE_RETIRED =
  'adminAuthMode=federated is retired. Every admin route is AWS_IAM-authorized, so it would select nothing; '
  + "a host identity provider reaches the admin console by federating into the deployment's own pool "
  + '(ADMIN-INTEGRATION-GUIDE, Approach 1). Remove adminAuthMode or set it to ae-cognito.';

/** Resolve the deployment's admin auth mode from CDK context (default ae-cognito). */
export function getAdminAuthMode(scope: Construct): AdminAuthMode {
  const raw = (scope.node.tryGetContext('adminAuthMode') as string | undefined) ?? 'ae-cognito';
  if (raw === 'ae-cognito' || raw === 'service') return raw;
  if (raw === 'federated') throw new Error(FEDERATED_ADMIN_MODE_RETIRED);
  throw new Error(
    `Invalid -c adminAuthMode="${raw}" — expected one of: ae-cognito | service`,
  );
}

/**
 * Env vars to attach to every admin/analytics Lambda. Spread into `environment`:
 *   environment: { ...adminAuthEnv(this), ATHENA_WORKGROUP: ... }
 *
 * - `ADMIN_AUTH_MODE` lets the handler treat IAM-signed service calls as admin
 *   in `service` mode (see callerIsAdmin in lambda auth.ts).
 * - `ADMIN_GROUP_NAMES` (only when the trusted-issuer registry's `deployment` entry declares
 *   `adminGroups`) tells the
 *   handler which group value denotes admin: the groups it names on a trusted
 *   IAM-signed call, and the `cognito:groups` value its claim check accepts.
 */
export function adminAuthEnv(scope: Construct): Record<string, string> {
  const env: Record<string, string> = { ADMIN_AUTH_MODE: getAdminAuthMode(scope) };
  const groups = issuersOf(scope).deploymentAdminGroups();
  if (groups) env.ADMIN_GROUP_NAMES = groups.join(',');
  return env;
}
