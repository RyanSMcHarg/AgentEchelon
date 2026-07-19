import type { Construct } from 'constructs';

/**
 * Frontend origins for CORS wiring, after the admin console split
 * (SPEC-SEPARATE-ADMIN-APP.md). Two independently-deployed interface origins:
 *
 *   - chat SPA        -> CDK context `appUrl`      (AgentEchelonFrontend)
 *   - admin console   -> CDK context `adminAppUrl` (AgentEchelonAdminFrontend)
 *
 * Each admin/analytics API sets its `ALLOWED_ORIGIN(S)` to the origin(s) that
 * legitimately call it:
 *   - admin-only surfaces (analytics query, user-management, admin-conversations,
 *     membership-audit) -> `adminOrigin` only.
 *   - surfaces the chat client also consumes (feedback, experiments,
 *     credential-exchange) -> `sharedOrigins` (both).
 *   - chat-only surfaces (client-events, deployment-state, messaging, etc.)
 *     keep `appUrl` and do not use this module.
 *
 * `adminAppUrl` is only known after AgentEchelonAdminFrontend deploys, so it
 * falls back to the chat origin until the deployer wires it in with
 * `--context adminAppUrl=<AdminDistributionUrl>` — the same two-phase bootstrap
 * the chat origin already uses for `appUrl`.
 */

const DEV_ORIGIN = 'http://localhost:5173';

/** The user-facing chat SPA origin. */
export function chatOrigin(scope: Construct): string {
  return (scope.node.tryGetContext('appUrl') as string) || process.env.APP_URL || DEV_ORIGIN;
}

/** The standalone admin console origin (falls back to the chat origin until the
 *  admin frontend is deployed and `-c adminAppUrl=` is provided). */
export function adminOrigin(scope: Construct): string {
  return (scope.node.tryGetContext('adminAppUrl') as string) || chatOrigin(scope);
}

/** Deduped [chat, admin] origins for a surface both interfaces consume. */
export function sharedOrigins(scope: Construct): string[] {
  const chat = chatOrigin(scope);
  const admin = adminOrigin(scope);
  return admin === chat ? [chat] : [chat, admin];
}

/** `sharedOrigins` as the comma-joined value the multi-origin echo handlers
 *  (credential-exchange, user-feedback, admin-experiments) split on. */
export function sharedOriginsEnv(scope: Construct): string {
  return sharedOrigins(scope).join(',');
}
