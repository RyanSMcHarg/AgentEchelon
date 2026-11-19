/**
 * THE ROLES THE TEST INSTANCE MINTS ADMIN SESSIONS ON, FOR EVERY SUITE.
 *
 * Every admin handler is told, by the stack, the names of this instance's admin console, team console and
 * admin plane roles (`adminSessionRoleEnv`, lib/constructs/admin-role-grants.ts), and admits an IAM-signed
 * console or admin-plane session only on those (`trustedIamAdminPrincipal`, lambda/src/lib/auth.ts). Here they
 * are the default instance's names, the ones `adminSessionRoleEnv` produces with no `AE_INSTANCE_NAME`, so a
 * suite signs as `agent-echelon-admin-console` exactly as a deployment's console does.
 *
 * A suite about another instance's session signs with a role of another prefix; a suite about a handler that
 * was told nothing deletes these.
 */
process.env.ADMIN_CONSOLE_ROLE_NAME ??= 'agent-echelon-admin-console';
process.env.TEAM_CONSOLE_ROLE_NAME ??= 'agent-echelon-team-console';
process.env.ADMIN_PLANE_ROLE_NAME ??= 'agent-echelon-admin-plane';
