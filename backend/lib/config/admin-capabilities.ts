/**
 * The admin capability catalog (SPEC-ADMIN-CONSOLE "Role-based capability matrix",
 * DESIGN-ADMIN-CONSOLE section 5.1).
 *
 * The single source of truth mapping each admin function to the API Gateway resource(s) it
 * authorizes, how it is enforced, and which admin role holds it. The CDK builds each role's IAM
 * policy from this list and the credential exchange vends against the same keys, so the published
 * matrix, the gateway and the exchange cannot disagree. `backend/test/admin-role-matrix-is-published`
 * fails the build when the spec's table and this catalog differ.
 *
 * ONE GRANT PER FUNCTION. Every entry owns resources no other entry names, because the handlers
 * trust an IAM-signed caller (`isAdminIamEnforcedCall`) only on the grounds that the resource it
 * reached authorizes one capability. A capability granted together with a function of a different
 * weight - reading quality data and spending model calls on a classifier replay, viewing a profile
 * and activating it - is not a capability, and the trust would be unsound.
 *
 * TWO ROLES. `admins` hold every capability, across every classification and every assistant.
 * `team-members` hold a scoped set, reaching only the assistants their `team-<name>` group owns
 * (SPEC FR47). A team-member capability is DECLARED here as the target and GRANTED only once its
 * scoped resources exist (`teamScope` + `teamScoped`), because granting the unscoped route would
 * hand a team every assistant's data.
 */

export type AdminCapabilityEnforcement = 'signOnRole' | 'exchangeVend';

/** The admin roles a deployment ships. A role is a Cognito group and the IAM role it maps to. */
export type AdminRole = 'admins' | 'team-members';
export const ADMIN_ROLES: AdminRole[] = ['admins', 'team-members'];

/** The Cognito group each role maps to. */
export const ADMIN_ROLE_GROUP: Record<AdminRole, string> = {
  admins: 'admins',
  'team-members': 'team-members',
};

export interface AdminApiResource {
  /** Which surface of `AdminApi` the resource lives on. */
  api: 'admin-conversations' | 'analytics' | 'assistant-admin' | 'user-management' | 'admin-exchange' | 'feedback';
  method: string;
  /** Path under the surface's mount, e.g. `admin/conversations/identities` (no leading slash). */
  path: string;
}

/**
 * WHERE EACH SURFACE IS MOUNTED ON `AdminApi`, the one admin HTTP API. Every surface's paths are already
 * distinct from the API root except the analytics query's, whose capability paths (`events-log`,
 * `triage`, its root `POST`) are short names, so it is mounted below `/query` in both archive modes. The
 * admin console composes the same paths (`frontend/packages/shared/src/platform/config.ts`), and
 * `the-route-table-is-every-url-a-client-calls.test.ts` holds the two to one table.
 */
export const ADMIN_API_MOUNTS: Readonly<Record<AdminApiResource['api'], string>> = {
  'admin-conversations': '',
  analytics: '/query',
  'assistant-admin': '',
  'user-management': '',
  'admin-exchange': '',
  feedback: '',
};

/** How a team member's reach is narrowed for this capability (DESIGN-ADMIN-CONSOLE 5.2). */
export type TeamScope =
  /** The assistants the team owns. */
  | 'assistant'
  /** Conversations an owned assistant is a member of, for the period it was. */
  | 'conversation'
  /**
   * The person's own teams: a route under `.../teams/{team}/...` for work on behalf of a team rather than
   * an assistant it already owns (creating an assistant the team will own). The credential exchange names
   * each of the person's `team-<name>` groups in their session, and the handler re-reads the groups.
   */
  | 'team';

export interface AdminCapability {
  key: string;
  enforcement: AdminCapabilityEnforcement;
  resources: AdminApiResource[];
  /** The roles that hold this capability (the target matrix, not only what is granted today). */
  roles: AdminRole[];
  /** For a capability `team-members` hold: what narrows it. */
  teamScope?: TeamScope;
  /** Whether the scoped resources a team member needs exist, so the team grant is live. */
  teamScoped?: boolean;
  /**
   * The routes a team member holds this capability on: the same work under
   * `.../assistants/{assistant}/...`, so the credential exchange can name exactly the owned assistants
   * in their session (DESIGN-ADMIN-CONSOLE 5.2). Granted to the `team-members` boundary with
   * `{assistant}` as a wildcard; the session policy narrows it to the owned names.
   */
  teamResources?: AdminApiResource[];
  /** Whether the CDK wiring (route + authorizer + grant) is live. */
  wired: boolean;
  /**
   * For an `exchangeVend` capability: the exchange capabilities one request for it vends.
   * The request itself is an IAM-authorized route on the exchange (`exchange-credentials/admin/<key>`),
   * so who may obtain the credential is an IAM decision rather than a group lookup (SPEC FR45).
   */
  vends?: string[];
}

/** The exchange route a person requests an `exchangeVend` capability on. */
export const vendRoutePath = (key: string): string => `exchange-credentials/admin/${key}`;

const ADMINS: AdminRole[] = ['admins'];
const BOTH: AdminRole[] = ['admins', 'team-members'];

export const ADMIN_CAPABILITIES: Record<string, AdminCapability> = {
  // ── admin-conversations API (AdminServices stack) ────────────────────────
  'view-conversations': {
    key: 'view-conversations',
    enforcement: 'signOnRole',
    resources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations' },
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations/membership-history' },
    ],
    roles: BOTH,
    teamScope: 'conversation',
    teamResources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/assistants/{assistant}/conversations' },
    ],
    teamScoped: true,
    wired: true,
  },
  // A conversation's invitations (M-10): their status, and revoking one, which removes the invitee's
  // membership. Two capabilities, because seeing who was invited and taking someone out are different weights.
  'view-invitations': {
    key: 'view-invitations',
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-conversations', method: 'GET', path: 'admin/conversations/*/invitations' }],
    roles: ADMINS,
    wired: true,
  },
  'revoke-invitations': {
    key: 'revoke-invitations',
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-conversations', method: 'POST', path: 'admin/conversations/*/invitations/*/revoke' }],
    roles: ADMINS,
    wired: true,
  },
  'find-conversation': {
    key: 'find-conversation',
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-conversations', method: 'GET', path: 'admin/conversations/find' }],
    roles: BOTH,
    teamScope: 'conversation',
    teamResources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/assistants/{assistant}/conversations/find' },
    ],
    teamScoped: true,
    wired: true,
  },
  'see-user-identity': {
    key: 'see-user-identity',
    // Its own route rather than a field on the conversation reads: a field decision has no resource
    // for the gateway to refuse, so it could never be IAM-enforced (SPEC FR41). The conversation reads
    // return participant ARNs to anyone holding `view-conversations`; resolving them to names is this.
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-conversations', method: 'GET', path: 'admin/conversations/identities' }],
    roles: ADMINS,
    wired: true,
  },
  'view-messages': {
    key: 'view-messages',
    // The conversation id is a PATH segment, so the role boundary wildcards it and the
    // exchange-vended session policy narrows to the one conversation.
    enforcement: 'exchangeVend',
    vends: ['view-messages'],
    resources: [
      // The read itself, which is never a standing grant: only a session vended for one conversation
      // reaches it.
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations/*/messages' },
      { api: 'admin-exchange', method: 'POST', path: vendRoutePath('view-messages') },
    ],
    roles: BOTH,
    teamScope: 'conversation',
    // A team member reads on its assistant's route instead, with a stated reason; the handler bounds the
    // read to the periods that assistant was a member of the conversation (membership-period.ts).
    teamResources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/assistants/{assistant}/conversations/*/messages' },
    ],
    teamScoped: true,
    wired: true,
  },
  // ── the administration identity's per-conversation vends (Amazon Chime SDK plane) ──
  // Vended by the credential exchange on the `${personId}-admin` AppInstanceAdmin bearer, narrowed to one
  // conversation. They carry no API Gateway resource; the vend IS the grant.
  'view-live-members': { key: 'view-live-members', enforcement: 'exchangeVend', vends: ['view'], resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('view-live-members') }], roles: ADMINS, wired: true },
  'redact': { key: 'redact', enforcement: 'exchangeVend', vends: ['redact'], resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('redact') }], roles: ADMINS, wired: true },
  'delete': { key: 'delete', enforcement: 'exchangeVend', vends: ['delete'], resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('delete') }], roles: ADMINS, wired: true },
  'manage-membership': { key: 'manage-membership', enforcement: 'exchangeVend', vends: ['manage-membership'], resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('manage-membership') }], roles: ADMINS, wired: true },
  'archive-conversation': {
    key: 'archive-conversation',
    // A server-side sequence (notice, `archived` tag, metadata mirror, moderators removed), so it is a
    // route the role holds rather than a credential the console acts with; it requires a stated reason.
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-conversations', method: 'POST', path: 'admin/conversations/*/archive' }],
    roles: ADMINS,
    wired: true,
  },
  'delete-conversation': { key: 'delete-conversation', enforcement: 'exchangeVend', vends: ['manage-channel'], resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('delete-conversation') }], roles: ADMINS, wired: true },
  'attachment-read': {
    key: 'attachment-read', enforcement: 'exchangeVend', vends: ['attachment-read'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('attachment-read') }],
    roles: BOTH, teamScope: 'conversation',
    // A team member asks on its assistant's route; the exchange vends only for a conversation one of the
    // assistant's identities is a member of, on a role whose boundary is deliverables alone.
    teamResources: [{ api: 'admin-exchange', method: 'POST', path: 'exchange-credentials/admin/assistants/{assistant}/attachment-read' }],
    teamScoped: true,
    wired: true,
  },
  // THE DE-IDENTIFIED COPY (FR54): what was said, without who said it. Its own resource, so the grant
  // that admits the copy can never admit the raw conversation, and the raw read can never be reached
  // through it. A team reads its assistants' conversations, within their membership periods.
  'view-clean-conversations': {
    key: 'view-clean-conversations',
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-conversations', method: 'GET', path: 'admin/conversations/*/clean' }],
    roles: BOTH,
    teamScope: 'conversation',
    teamResources: [{ api: 'admin-conversations', method: 'GET', path: 'admin/assistants/{assistant}/conversations/*/clean' }],
    teamScoped: true,
    wired: true,
  },
  'attachment-read-uploads': {
    key: 'attachment-read-uploads', enforcement: 'exchangeVend', vends: ['attachment-read-uploads'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('attachment-read-uploads') }],
    roles: ADMINS, wired: true,
  },
  // OPERATOR TASK ACCESS (ADR-033, DESIGN-TASK-ACCESS). Reading what work is open in a conversation and
  // cancelling or reassigning somebody's work are different clearances, and a cross-conversation read by
  // owner or assignee is narrowed to that one principal rather than to a conversation.
  'tasks-read': {
    key: 'tasks-read', enforcement: 'exchangeVend', vends: ['tasks-read'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('tasks-read') }],
    roles: ADMINS, wired: true,
  },
  'tasks-manage': {
    key: 'tasks-manage', enforcement: 'exchangeVend', vends: ['tasks-manage'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('tasks-manage') }],
    roles: ADMINS, wired: true,
  },
  'tasks-read-owned-by': {
    key: 'tasks-read-owned-by', enforcement: 'exchangeVend', vends: ['tasks-read-owned-by'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('tasks-read-owned-by') }],
    roles: ADMINS, wired: true,
  },
  'tasks-read-assignee': {
    key: 'tasks-read-assignee', enforcement: 'exchangeVend', vends: ['tasks-read-assignee'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('tasks-read-assignee') }],
    roles: ADMINS, wired: true,
  },
  'tasks-reassign-owner': {
    key: 'tasks-reassign-owner', enforcement: 'exchangeVend', vends: ['tasks-reassign-owner'],
    resources: [{ api: 'admin-exchange', method: 'POST', path: vendRoutePath('tasks-reassign-owner') }],
    roles: ADMINS, wired: true,
  },

  // ── analytics API (Analytics{,Aurora} stack) ──────────────────────────────
  'view-events': {
    key: 'view-events',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'events-log' }],
    roles: ADMINS,
    wired: true,
  },
  'view-user-activity': {
    key: 'view-user-activity',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'user-activity' }],
    roles: ADMINS,
    wired: true,
  },
  'view-moderation-audit': {
    key: 'view-moderation-audit',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'moderation-audit' }],
    roles: ADMINS,
    wired: true,
  },
  'record-moderation': {
    key: 'record-moderation',
    // The audit WRITE, apart from the audit read: a role that may read who moderated what is not
    // thereby allowed to add rows to that record.
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'moderation-record' }],
    roles: ADMINS,
    wired: true,
  },
  'view-analytics': {
    key: 'view-analytics',
    enforcement: 'signOnRole',
    resources: [
      { api: 'analytics', method: 'POST', path: '' },
      // The native GET reads the console makes alongside the query POST. Each is listed so the grant
      // a role receives is exactly this capability, rather than the whole API.
      { api: 'analytics', method: 'GET', path: 'analytics/queue-health' },
      { api: 'analytics', method: 'GET', path: 'analytics/evaluation' },
      { api: 'analytics', method: 'GET', path: 'analytics/evaluation/exchanges' },
      { api: 'analytics', method: 'GET', path: 'analytics/evaluation/flows' },
      { api: 'analytics', method: 'GET', path: 'analytics/conversations' },
      { api: 'analytics', method: 'GET', path: 'analytics/drift' },
      { api: 'analytics', method: 'GET', path: 'analytics/context' },
      { api: 'analytics', method: 'GET', path: 'analytics/model-effectiveness' },
      // The thumbs-up/down summary the Models tab shows, on the admin feedback API (AdminServices stack).
      // It counts every assistant together, per model and intent, so it has no team route: a team
      // member is granted only `teamResources`, and is refused on this one at the gateway.
      { api: 'feedback', method: 'GET', path: 'feedback' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'analytics', method: 'POST', path: 'analytics/assistants/{assistant}/query' },
    ],
    teamScoped: true,
    wired: true,
  },
  'triage-responses': {
    key: 'triage-responses',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'triage' }],
    roles: BOTH,
    teamScope: 'assistant',
    // A team flags, unflags and reviews only its assistant's turns; the handler checks the turn
    // (`turnIsTheAssistants`). The flagged list is read on the team's query route with a stated reason.
    teamResources: [{ api: 'analytics', method: 'POST', path: 'analytics/assistants/{assistant}/triage' }],
    teamScoped: true,
    wired: true,
  },
  'label-ground-truth': {
    key: 'label-ground-truth',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'ground-truth' }],
    roles: BOTH,
    teamScope: 'assistant',
    // A team labels only its assistant's turns, and never adjudicates a classifier, which serves a whole
    // classification: the handler refuses `classifier_replay_adjudicate` on a team route.
    teamResources: [{ api: 'analytics', method: 'POST', path: 'analytics/assistants/{assistant}/ground-truth' }],
    teamScoped: true,
    wired: true,
  },
  'run-classifier-replay': {
    key: 'run-classifier-replay',
    // Starting a replay spends real model calls, so it is its own grant rather than riding the
    // read bundle it reports into. Its own non-VPC function answers it (archive-stack-aurora.ts).
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'classifier-replay-start' }],
    roles: ADMINS,
    wired: true,
  },
  'view-access-log': {
    key: 'view-access-log',
    // WHO WAS GIVEN ACCESS TO WHICH CONVERSATION, WHEN, AND WHY (ADR-052, SPEC-ADMIN-CONSOLE FR30). The
    // exchange writes a record for every vend before the credential is returned; this reads them back.
    // Admins only: the log names every operator's reads, and reading it is itself recorded.
    enforcement: 'signOnRole',
    resources: [{ api: 'admin-exchange', method: 'GET', path: 'admin/access-log' }],
    roles: ADMINS,
    wired: true,
  },
  'view-security': {
    key: 'view-security',
    enforcement: 'signOnRole',
    resources: [
      { api: 'analytics', method: 'GET', path: 'membership-audit/findings' },
      { api: 'analytics', method: 'GET', path: 'membership-audit/enforce' },
    ],
    roles: ADMINS,
    wired: true,
  },
  'enforce-membership-audit': {
    key: 'enforce-membership-audit',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'membership-audit/enforce' }],
    roles: ADMINS,
    wired: true,
  },
  'revoke-membership': {
    key: 'revoke-membership',
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'membership-audit/revoke' }],
    roles: ADMINS,
    wired: true,
  },
  'manage-deployment': {
    key: 'manage-deployment',
    enforcement: 'signOnRole',
    resources: [
      { api: 'analytics', method: 'POST', path: 'deployment/sleep' },
      { api: 'analytics', method: 'POST', path: 'deployment/wake' },
    ],
    roles: ADMINS,
    wired: true,
  },

  // ── experiments API (Experiments stack): assistant profiles ───────────────
  'view-profiles': {
    key: 'view-profiles',
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'GET', path: 'admin/profiles' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/export' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/validate' },
      // Preview run: one draft workflow walked with sample values, writing nothing (ADR-061 decision 7).
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/preview-run' },
      // The draft's latest run against the golden set, which Activate reads too (ADR-065).
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-gate' },
      // How an upload or a generation ended, read when the console is told it ended (ADR-065 decisions 7, 8).
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-set-batch' },
      // An assistant's message templates beside the classification's and the shipped ones (ADR-062).
      { api: 'assistant-admin', method: 'GET', path: 'admin/templates' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'GET', path: 'admin/assistants/{assistant}/profiles' },
      { api: 'assistant-admin', method: 'GET', path: 'admin/assistants/{assistant}/templates' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/export' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/validate' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/preview-run' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-gate' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-set-batch' },
    ],
    teamScoped: true,
    wired: true,
  },
  'edit-profiles': {
    key: 'edit-profiles',
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/version' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/draft' },
      // Throwing a draft away is an edit of the draft, so it is this capability's (SPEC-PORTABLE-PROFILES FR18).
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/discard' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/import' },
      // A battle variant's unlabelled candidate version is a profile write like any other.
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/variant-version' },
      // Running a draft against the golden set spends model calls on the draft, so it is the draft's editors' (ADR-065).
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-run' },
      // Writing golden entries from the draft's intent pack spends a model call per intent (ADR-065 decision 8); whoever may
      // generate a batch may retire it.
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-set-generate' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-set-retire-generation' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-run' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-set-generate' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-set-retire-generation' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/version' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/draft' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/discard' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/import' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/variant-version' },
    ],
    teamScoped: true,
    wired: true,
  },
  // A DEPLOYMENT'S OWN GOLDEN ENTRIES (ADR-065 decision 7). Its own capability rather than part of editing, because what
  // it writes is the set every draft is measured against, so a deployment can define a role that edits drafts and does
  // not add cases. Both shipped roles hold it; a team member uploads only for the assistant in the route's path.
  'import-golden-set': {
    key: 'import-golden-set',
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-set-import' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/golden-set-retire-upload' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-set-import' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/golden-set-retire-upload' },
    ],
    teamScoped: true,
    wired: true,
  },
  'activate-profiles': {
    key: 'activate-profiles',
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/activate' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/profiles/rollback' },
      // PROMOTING AN EXPERIMENT'S CANDIDATE ACTIVATES A VERSION OF THE LIVE ASSISTANT (DESIGN-EXPERIMENTS-
      // BATTLE-DECISION-LOOP §3.6), so it is this capability's, not the experiment capabilities': a role that
      // may run experiments but not activate profiles is refused it at the gateway.
      { api: 'assistant-admin', method: 'POST', path: 'admin/experiments/*/promote' },
      // SAVING AN ASSISTANT'S MESSAGE TEMPLATE MAKES IT THE ONE IN USE, with no draft (ADR-062), so it is an
      // activation like a version's; rolling it back is too.
      { api: 'assistant-admin', method: 'POST', path: 'admin/templates/save' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/templates/rollback' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/activate' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/profiles/rollback' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/templates/save' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/templates/rollback' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/experiments/{experimentId}/promote' },
    ],
    teamScoped: true,
    wired: true,
  },
  // ACTIVATING A DRAFT THE GOLDEN GATE REFUSES (ADR-065 decision 5). Its own capability rather than a flag on Activate, so
  // whether a role may pass the gate is an IAM decision: the admin role alone holds it, and with no team route no team
  // member's session can name it. The handler checks the caller's groups again, and the version records the reason.
  'activate-past-golden-gate': {
    key: 'activate-past-golden-gate',
    enforcement: 'signOnRole',
    resources: [{ api: 'assistant-admin', method: 'POST', path: 'admin/profiles/activate-past-golden-gate' }],
    roles: ADMINS,
    wired: true,
  },
  'manage-ownership': {
    key: 'manage-ownership',
    // The only principal permitted to write an `AppInstanceBot`'s `owner-team` tag (SPEC FR47).
    enforcement: 'signOnRole',
    // GET lists who owns what and which teams exist; POST assigns or clears a team, with a reason.
    resources: [
      { api: 'assistant-admin', method: 'GET', path: 'admin/ownership' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/ownership' },
    ],
    roles: BOTH,
    // A TEAM ASSIGNS ONLY WHAT IT OWNS, AND ONLY TO ITS OWN TEAMS. The session names the owned
    // assistants, and the handler refuses a team the caller does not hold and a cleared owner (an
    // assistant no team owns is an admin's decision). Only admins list every owner and assign any team.
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/ownership' },
    ],
    teamScoped: true,
    wired: true,
  },
  'manage-assistants': {
    key: 'manage-assistants',
    // Creates and retires an assistant at runtime (ADR-048): an identity, its Amazon Lex bot and its
    // assignment record. The roster is listed by `GET admin/profiles`.
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/roster' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/roster/*/retire' },
      // A console-created assistant's turns per hour (the router reads it from the assignment record).
      { api: 'assistant-admin', method: 'POST', path: 'admin/roster/*/limits' },
    ],
    roles: BOTH,
    // A TEAM CREATES ONLY FOR ITSELF. The team route names the team, the session names only the
    // person's own teams, and the handler re-reads their groups, makes the new assistant's owner that
    // team and refuses a classification their clearance does not reach. Retiring stays an admin's: it
    // has no team route.
    teamScope: 'team',
    teamResources: [
      { api: 'assistant-admin', method: 'GET', path: 'admin/teams/{team}/roster' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/teams/{team}/roster' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/teams/{team}/roster/*/limits' },
    ],
    teamScoped: true,
    wired: true,
  },

  // ── experiments API: experiments and battles ──────────────────────────────
  'view-experiments': {
    key: 'view-experiments',
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'GET', path: 'admin/experiments' },
      { api: 'assistant-admin', method: 'GET', path: 'admin/experiments/battle-settings' },
      { api: 'assistant-admin', method: 'GET', path: 'admin/experiments/challengers' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'GET', path: 'admin/assistants/{assistant}/experiments' },
    ],
    teamScoped: true,
    wired: true,
  },
  'manage-experiments': {
    key: 'manage-experiments',
    enforcement: 'signOnRole',
    resources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/experiments' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/experiments/*/status' },
      { api: 'assistant-admin', method: 'DELETE', path: 'admin/experiments/*' },
    ],
    roles: BOTH,
    teamScope: 'assistant',
    teamResources: [
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/experiments' },
      { api: 'assistant-admin', method: 'POST', path: 'admin/assistants/{assistant}/experiments/{experimentId}/status' },
      { api: 'assistant-admin', method: 'DELETE', path: 'admin/assistants/{assistant}/experiments/{experimentId}' },
    ],
    teamScoped: true,
    wired: true,
  },
  'manage-battle-settings': {
    key: 'manage-battle-settings',
    // Battle settings govern a whole classification, so they are never a team's to change.
    enforcement: 'signOnRole',
    resources: [{ api: 'assistant-admin', method: 'POST', path: 'admin/experiments/battle-settings' }],
    roles: ADMINS,
    wired: true,
  },

  // ── user-management API (AdminServices stack) ───────────────────────────────
  'view-users': {
    key: 'view-users',
    enforcement: 'signOnRole',
    resources: [{ api: 'user-management', method: 'GET', path: 'users' }],
    roles: ADMINS,
    wired: true,
  },
  'manage-users': {
    key: 'manage-users',
    // Clearance, membership groups and console teams (`team`, owner decision 2026-10-24: a team is a `team-<name>`
    // group, and joining one keeps the `team-members` role in step). `admins` is assigned in the identity provider.
    enforcement: 'signOnRole',
    // `readmit` lets an offboarded subject sign in again, which is a decision about the account, like approval;
    // `provision` pre-assigns a provisioned-only issuer's subject to a person (P-13), the same kind of decision.
    resources: ['approve', 'reject', 'enable', 'tier', 'group', 'team', 'readmit', 'provision'].map((a) => (
      { api: 'user-management' as const, method: 'POST', path: `users/${a}` }
    )),
    roles: ADMINS,
    wired: true,
  },
  'delete-users': {
    key: 'delete-users',
    enforcement: 'signOnRole',
    resources: [{ api: 'user-management', method: 'POST', path: 'users/delete' }],
    roles: ADMINS,
    wired: true,
  },

  // EXPORT BY APPINSTANCEUSER (B13, GDPR Articles 15 and 20): one archive of everything kept about a person.
  // Its own capability, apart from viewing the list and from deleting: reading somebody's whole record out is
  // a weight of its own.
  'export-users': {
    key: 'export-users',
    enforcement: 'signOnRole',
    resources: [{ api: 'user-management', method: 'POST', path: 'users/export' }],
    roles: ADMINS,
    wired: true,
  },
  // THE GUEST PANEL (E6, L16): the guest issuer's kill switch and who changed it. Reading only.
  'view-guest-sessions': {
    key: 'view-guest-sessions',
    enforcement: 'signOnRole',
    resources: [{ api: 'user-management', method: 'GET', path: 'users/guest' }],
    roles: ADMINS,
    wired: true,
  },
  // A VISITOR'S REGISTRATION, APPROVED (B6, P-12): on a guest issuer that declares
  // `guest.registration.approval: 'admin'`, the registrations waiting and approving one, which sends its
  // sign-in link. Its own capability, apart from the Guest panel: the list carries what each visitor
  // registered and the address the link goes to, and approving is a decision about an account.
  'approve-registrations': {
    key: 'approve-registrations',
    enforcement: 'signOnRole',
    resources: [
      { api: 'user-management', method: 'GET', path: 'users/guest/registrations' },
      { api: 'user-management', method: 'POST', path: 'users/guest/registrations/*/approve' },
    ],
    roles: ADMINS,
    wired: true,
  },

  // Deployment configuration (classifications, connectors) is deploy-time with no runtime admin API
  // to gate; listed for traceability against the matrix, unwired by design.
  'view-config': { key: 'view-config', enforcement: 'signOnRole', resources: [], roles: ADMINS, wired: false },
};

/** The exchange capabilities that act in the Amazon Chime SDK, and so run as the administration identity. */
const ADMINISTRATION_IDENTITY_VENDS = new Set(['view', 'redact', 'delete', 'manage-membership', 'manage-channel']);

/** Whether a capability needs the person's `${personId}-admin` AppInstanceAdmin identity to act. */
export function needsAdministrationIdentity(cap: AdminCapability): boolean {
  return (cap.vends ?? []).some((v) => ADMINISTRATION_IDENTITY_VENDS.has(v));
}

/**
 * The roles whose people hold the administration identity: those granted a capability that needs it.
 * The identity is provisioned for, and reconciled against, exactly these - decided by the capability,
 * never by a group name - so a deployment that grants redact to another role gets the identity
 * provisioned and removed for that role's people too.
 */
export function rolesNeedingAdministrationIdentity(): AdminRole[] {
  return ADMIN_ROLES.filter((r) => capabilitiesForRole(r).some(needsAdministrationIdentity));
}

/** Whether a role is GRANTED a capability today: declared for it, wired, and, for a team, scoped. */
export function roleIsGranted(role: AdminRole, cap: AdminCapability): boolean {
  if (!cap.wired || !cap.roles.includes(role)) return false;
  if (role === 'team-members') return cap.teamScoped === true;
  return true;
}

/** The wired capabilities a role is granted (drives its IAM grants). */
export function capabilitiesForRole(role: AdminRole): AdminCapability[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => roleIsGranted(role, c));
}

/**
 * The `execute-api` resources a role is granted ON a given API, for the CDK to attach to the role.
 * A `signOnRole` capability's routes are standing grants; an `exchangeVend` capability contributes only
 * its request route on the exchange, and its credential is vended per use. Each entry is `{ method, path }` with a leading-slash path ready for `arnForExecuteApi`.
 */
export function roleExecuteApiResources(
  role: AdminRole,
  api: AdminApiResource['api'],
): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const cap of capabilitiesForRole(role)) {
    // A team member holds a capability on its team routes only, with every path parameter a wildcard
    // here; the console session the exchange issues names the owned assistants.
    if (role === 'team-members') {
      for (const r of cap.teamResources ?? []) {
        if (r.api !== api) continue;
        out.push({ method: r.method, path: `/${r.path}`.replace(/\{[^}]+\}/g, '*') });
      }
      continue;
    }
    for (const r of cap.resources) {
      if (r.api !== api) continue;
      // An exchangeVend capability's own resource (the message read) is reached only by a session the
      // exchange vends for one conversation; what a role holds standing is the right to REQUEST it.
      if (cap.enforcement === 'exchangeVend' && r.api !== 'admin-exchange') continue;
      out.push({ method: r.method, path: `/${r.path}`.replace(/\/$/, '') || '/' });
    }
  }
  return out;
}

/** Every resource declared on an API, whoever holds it: what the stack must IAM-authorize. */
export function declaredExecuteApiResources(api: AdminApiResource['api']): Array<{ method: string; path: string; key: string }> {
  const out: Array<{ method: string; path: string; key: string }> = [];
  for (const cap of Object.values(ADMIN_CAPABILITIES)) {
    for (const r of [...cap.resources, ...(cap.teamResources ?? [])]) {
      if (r.api === api) out.push({ method: r.method, path: `/${r.path}`.replace(/\/$/, '') || '/', key: cap.key });
    }
  }
  return out;
}
