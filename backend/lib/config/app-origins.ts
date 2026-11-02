import type { Construct } from 'constructs';

/**
 * Frontend origins for CORS wiring, after the admin console split
 * (DESIGN-SEPARATE-ADMIN-APP.md). Two independently-deployed interface origins:
 *
 *   - chat SPA        -> CDK context `appUrl`      (AgentEchelonChatApp)
 *   - admin console   -> CDK context `adminAppUrl` (AgentEchelonAdminApp)
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
 * `adminAppUrl` is only known after AgentEchelonAdminApp deploys, so it
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

/**
 * The embeddable widget's own origin (`<prefix>Widget`, CDK context `widgetUrl`), or undefined until the
 * deploy passes it (`deploy.mjs` reads the `Widget` stack's output, as it does the chat app's for `appUrl`). The widget is a frame on that origin, so its calls to `PersonApi` come from it, not
 * from the host page that frames it. Known only after the Widget stack deploys, the same two-phase
 * bootstrap as `appUrl`.
 */
export function widgetOrigin(scope: Construct): string | undefined {
  const raw = String(scope.node.tryGetContext('widgetUrl') || '').trim().replace(/\/$/, '');
  return raw || undefined;
}

/** A client an invitation's link can open: each serves the landing page (`invite.html`) on its own origin. */
export type InvitationClient = 'chat' | 'widget';

/** Where an invitation's link lands: the client, and the origin its landing page is served from. */
export interface InvitationLanding {
  client: InvitationClient;
  origin: string;
}

/**
 * WHERE AN INVITATION BRINGS ITS PERSON: the one place that decides it. Every invitation lands in the chat app,
 * which serves the landing page on its own origin (`frontend/packages/chat/invite.html`), signs a `sign-in`
 * invitee in or up, and hosts a `link` invitee's session for the one conversation. The widget serves the same
 * page on its origin, so a client chosen per recipient is a branch here and nothing else.
 */
export function invitationLandingFor(scope: Construct): InvitationLanding {
  return { client: 'chat', origin: chatOrigin(scope).replace(/\/$/, '') };
}
