/**
 * Shared constants + thin helpers for the per-classification assistant stacks (`AssistantsStack`, one
 * `Assistants-<classification>` stack per classification the profile registry declares).
 *
 * **Intentionally thin.** The per-classification ownership model (ADR-011) targets
 * independently-owned *code* per classification — a basic-team change must not
 * review-couple the standard or premium classifications. So this file holds only what
 * the classifications MUST agree on (the SSM contract keys, the shared bot key, and a
 * couple of pure helpers) and deliberately stops short of building any classification
 * stack's resources. Each classification's stack owns its own IAM, Lambda, Lex bot, and
 * AppInstanceBot wiring even when those happen to look similar — that is
 * what "per-classification ownership" means.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { utilityModelArns, type BackendModelDefinition, type BackendModelKey, type Classification } from '../config/model-strategy';
import { STACK_NAMES } from '../config/stack-names';
import { CAPABILITIES, capabilityDefinition } from '../config/capabilities';
import { alarmNamesPathOf } from '../constructs/alarm-names';
import { SESSION_TAG, CHANNEL_SID, BEARER_SID } from '../../lambda/src/lib/assistant-acting-policy';
import { SPEAK_EDGE, SPEAK_ACTIONS, SPEAK_ROUTE_PREFIX } from '../../lambda/src/lib/assistant-grant';
import { defaultProfileRegistry as profiles } from '../profile-registry';
import { INSTANCE_TAG } from '../tagging';
import { AUDIENCE_TAG } from '../../lambda/src/lib/channel-classification';
import { classificationPackPrefix } from '../../lambda/src/lib/profile-bodies';
import { templatePrefix, templatePointerPath } from '../../lambda/src/lib/template-store';

// RE-EXPORTED, NOT RESTATED. This was a second literal copy of the union, which is two places to edit
// and one of them to forget: a classification declared in the registry and in `model-strategy` but not
// here would typecheck at every call site that imports it from this file while meaning something
// narrower. The union has one definition and this file passes it through.
export type { Classification };
export type ClassificationModelCatalog = Record<BackendModelKey, BackendModelDefinition>;

/** Classification ordering, lowest → highest. */

/**
 * Chime actions whose IAM resource is purely a CHANNEL (so it carries the
 * `classification` tag) and that must be classification-gated.
 *
 * EXCLUDES:
 * - app/user-scoped actions (CreateChannel, ListChannels, Connect,
 *   GetMessagingSessionEndpoint, ListChannelMembershipsForAppInstanceUser) — no
 *   channel tag; granted unconditionally.
 * - PER-MEMBER membership changes (CreateChannelMembership / DeleteChannelMembership).
 *   They ARE authorized against the channel and the bearer, both of which can be
 *   conditioned, and a service that changes membership bearing an assistant is held to a
 *   declared classification on both by `membershipAsAssistantStatements` (step 24), and one
 *   bearing the service admin by `membershipAsServiceAdminStatements` (step 31). They are
 *   not in this list because the member being added or removed, `MemberArn`, is a request
 *   parameter IAM never evaluates (measured by `scripts/deny-test-assistant-membership.mjs`,
 *   which found a Deny on the member's ARN never consulted). So WHO is added is governed by
 *   Chime's moderator model, the app-layer share/create gates and the membership audit.
 *   (ListChannelMemberships is channel-scoped and reads only, so it stays here.)
 */
/**
 * WHAT AN ASSISTANT NEEDS TO ANSWER A TURN, and nothing else.
 *
 * Distinct from `CLASSIFICATION_GATED_CHANNEL_ACTIONS` below, which is the set the classification
 * boundary GATES and therefore includes the moderation verbs (`RedactChannelMessage`,
 * `UpdateChannel`, `DeleteChannel`). Those belong to a moderator, not to an assistant taking a turn,
 * and an acting role that holds them is wider than the boundary it is supposed to narrow.
 */
// RE-EXPORTED, NOT REDECLARED. The list lives in `assistant-acting-policy.ts` because Lambdas need it
// too, and a Lambda cannot import this module, which pulls in `aws-cdk-lib`.
export { ASSISTANT_TURN_CHANNEL_ACTIONS } from '../../lambda/src/lib/assistant-acting-policy';

export const CLASSIFICATION_GATED_CHANNEL_ACTIONS = [
  'chime:SendChannelMessage',
  'chime:UpdateChannelMessage',
  'chime:RedactChannelMessage',
  'chime:GetChannelMessage',
  'chime:ListChannelMessages',
  'chime:DescribeChannel',
  'chime:UpdateChannel',
  'chime:DeleteChannel',
  'chime:UpdateChannelReadMarker',
  'chime:ListChannelMemberships',
];

/** The classification tag values a principal at this classification may act on: its declared `grants`
 *  set. Config-driven via the profile registry (SPEC-CAPABILITY-PROFILES) — the same set the runtime
 *  uses for RAG scope, so the IAM boundary and retrieval scope can never drift. Not "itself and every
 *  one below": there is no below, only the declared set (ADR-046). */
export function classificationsAllowedFor(classification: Classification): string[] {
  // A HOLDER question, not an order question. This is the set a principal at this classification may
  // reach, which a type like admin may declare directly - see ProfileRegistry.grantsFor. The IAM
  // condition it feeds is already set membership (StringEquals over a list is an OR), so widening
  // from a rank prefix to a declared set changes what is matched and nothing about how.
  return profiles.grantsFor(classification);
}

/** The classification tag values an ASSISTANT of this classification may act on: its own, and no
 *  other. An assistant is not a principal on a ladder - every classification has its own assistant
 *  and a channel carries only its matched one - so this is a point where `classificationsAllowedFor`
 *  is a range. Derived from the same resolver so the two cannot drift; see
 *  `ProfileRegistry.channelsActableBy` and ADR-042 for why they were ever one. */
export function channelsAnAssistantMayActIn(classification: Classification): string[] {
  return profiles.channelsActableBy(classification);
}

/** The `context/{classification}/` S3 prefixes a classification may read — the ONE resolver the IAM
 *  statement generator (assistant-profile-stack) and the retrieval walk (company-context) both consume,
 *  so the boundary and the walk derive the identical prefix set from the classification config. Append
 *  `*` for an IAM resource/prefix. */
export function contextPrefixesAllowedFor(classification: Classification): string[] {
  return profiles.contextPrefixesGranted(classification);
}

/** One ROLE's own `context/{c}/` prefixes (`roleContext` in profiles.ts): what its assistant may read, and the
 *  prefixes a turn as that assistant reads. Never wider than `contextPrefixesAllowedFor`, which caps it. */
export function contextPrefixesForRole(classification: Classification, role: string): string[] {
  return profiles.contextPrefixesForRole(classification, role);
}

/**
 * COMPANY CONTEXT, READ PER ASSISTANT ROLE, ON THE ONE ACTING ROLE.
 *
 * Every assistant of a classification acts through the same IAM role, so a role's own context cannot
 * be a grant on a role of its own. It is one statement per `context/{c}/` prefix the classification
 * grants, conditioned on the session's `role` tag being one of the assistant roles whose `roleContext`
 * includes that prefix (`profiles.ts`). Classifications and role names are both bounded, so the set of
 * statements is finite however many assistants there are.
 *
 * ALLOW ONLY. A session without a `role` tag matches none of these and reads no context, which is the
 * fail-closed direction; a Deny conditioned the same way would not match it either.
 */
export function roleContextStatements(classification: string, roles: string[], bucketArn: string): iam.PolicyStatement[] {
  // ONE PAIR PER READER GROUP, NOT PER PREFIX. Prefixes read by the same set of roles share one list and
  // one read statement naming all of them, so the role's policy grows with the number of distinct reader
  // groups (two on premium with an ops role) rather than with the size of the declared set. The key still
  // carries the classification, so each prefix is named in the resource and IAM refuses the rest (tenet D13).
  const groups = new Map<string, { readers: string[]; prefixes: string[] }>();
  for (const prefix of contextPrefixesAllowedFor(classification as Classification)) {
    const readers = roles.filter((r) => contextPrefixesForRole(classification as Classification, r).includes(prefix));
    if (!readers.length) continue;
    const key = readers.join('|');
    const group = groups.get(key) ?? { readers, prefixes: [] };
    group.prefixes.push(prefix);
    groups.set(key, group);
  }
  const statements: iam.PolicyStatement[] = [];
  for (const { readers, prefixes } of groups.values()) {
    const slug = prefixes.map((p) => p.replace(/^context\//, '').replace(/\/$/, '').replace(/[^A-Za-z0-9]/g, '')).join('');
    statements.push(
      new iam.PolicyStatement({
        sid: `RoleContextList${slug}`,
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [bucketArn],
        conditions: {
          StringLike: { 's3:prefix': prefixes.map((p) => `${p}*`) },
          StringEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: readers },
        },
      }),
      new iam.PolicyStatement({
        sid: `RoleContextRead${slug}`,
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: prefixes.map((p) => `${bucketArn}/${p}*`),
        conditions: { StringEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: readers } },
      }),
    );
  }
  return statements;
}

/**
 * SPEC-CONVERSATION-SECURITY Layer 1 — the channel-join boundary, **fail-closed**.
 *
 * Returns an IAM **Allow** that grants the channel-scoped Chime actions ONLY on
 * channels tagged `classification ∈ {this classification and every classification below}` (the
 * immutable tag create-conversation stamps). This is the FAIL-CLOSED inverse of a
 * deny-on-higher: an **untagged** channel, or one with an unexpected tag value,
 * carries no matching `aws:ResourceTag/classification`, so the condition is false,
 * no Allow applies, and the action is implicitly DENIED. (A deny-on-higher would
 * instead fail OPEN on untagged channels — a hole for any channel created before
 * tagging shipped.) Pure-IAM: evaluated before any app logic, so even a routing
 * bug can't make a basic identity act on a premium channel.
 *
 * Condition key is the GLOBAL `aws:ResourceTag/<key>`, NOT `chime:ResourceTag`:
 * Amazon Chime exposes **no service-specific condition keys** (AWS Service
 * Authorization Reference), so `chime:ResourceTag/...` never exists in the request
 * context — verified the hard way by a live deny-test (the `chime:` form let a
 * basic member send into a premium channel; the `aws:` form returns AccessDenied).
 *
 * Used for BOTH the per-classification assistant roles and the per-classification Cognito user roles,
 * one definition and TWO boundaries, which `actor` selects. It used to be one boundary for both, and
 * that was an inheritance rather than a decision: the declared grant set is right for a person and
 * wrong for an assistant, because every classification has its own assistant and a channel carries only its
 * matched one. ADR-042 is the record. Because it's fail-closed, every legitimate channel MUST be
 * tagged; new channels are tagged at creation and existing ones are covered by
 * `scripts/backfill-channel-classification-tags.mjs`.
 */
export function classificationChannelScopedAllow(
  classification: Classification,
  appInstanceArn: string,
  actions: string[] = CLASSIFICATION_GATED_CHANNEL_ACTIONS,
  opts: {
    /**
     * WHICH KIND OF PRINCIPAL this boundary is being built for, and it decides the classification set.
     *
     * `'person'` reaches its own classification and every one below, which is what a premium user
     * speaking in a basic room needs. `'assistant'` reaches its own and no other.
     *
     * REQUIRED, deliberately, and it is the reason `opts` is no longer optional. A default would be
     * wrong in one direction or the other: defaulting to `'person'` leaves a forgotten assistant
     * caller silently wide, which is the state ADR-042 describes, and defaulting to `'assistant'`
     * breaks a forgotten user caller. Making it required moves the question to compile time, where a
     * new call site cannot be added without answering it.
     */
    actor: 'person' | 'assistant';
    /**
     * Override the BEARER resources (statement 2). Default is the unconditioned
     * `…/user/*` + `…/bot/*`. The credential-exchange USER roles
     * pass `[`${appInstanceArn}/user/${'${aws:PrincipalTag/person}'}`]` to pin the
     * bearer to the caller's OWN AppInstanceUser — closing the impersonation
     * vector (docs/SPEC-CREDENTIAL-EXCHANGE.md §5).
     * Assistant/handler roles keep the default (they legitimately bear a bot).
     */
    bearerResources?: string[];
  },
): iam.PolicyStatement[] {
  const bearerResources = opts.bearerResources ?? [
    `${appInstanceArn}/user/*`,
    `${appInstanceArn}/bot/*`,
  ];
  // Chime channel-message actions authorize against BOTH the channel resource
  // AND the caller's bearer identity resource (the AWS messaging IAM example
  // policy lists `.../user/<id>` AND `.../channel/*`). So we need two grants:
  //
  // (1) CHANNEL resource — tag-gated. THIS is the classification boundary: the channel
  //     is only granted when its `classification` tag ∈ the set this role is generated for.
  //     An untagged channel, or one of a classification outside that set → no grant → implicit deny (fail-closed).
  // (2) BEARER resource — THE IMPERSONATION BOUNDARY, and nothing sits behind it.
  //
  //     AMAZON CHIME SDK DOES NOT BIND THE BEARER TO THE CALLER. AWS is explicit that this is IAM's
  //     job: "The IAM permissions for Amazon Chime SDK messaging APIs require an
  //     `app-instance-user-arn` that matches the `chime-bearer` parameter", and widening that resource
  //     to `/user/*` is the DOCUMENTED way to let a back-end service act as anybody
  //     (dg/call-from-backend.html). What the service enforces on its own is ROLE and channel
  //     MEMBERSHIP. So this statement is the whole of the impersonation control, and a wildcard here
  //     is an open door rather than a formality.
  //
  //     A PERSON'S BEARER IS PINNED BY THE CALLER (`…/user/${aws:PrincipalTag/person}`, the credential
  //     exchange), which is strictly stronger than the tag condition below and is deny-tested live by
  //     `backend/scripts/deny-test-credential-exchange.mjs`. That path is left exactly as it is.
  //
  //     AN ASSISTANT'S BEARER IS `/bot/*` BECAUSE ONE PRINCIPAL CARRIES TWO IDENTITIES, WHICH IS THE
  //     THING TO FIX RATHER THAN THE THING TO PRESERVE. A processor answers as its own assistant and,
  //     during a duel, as the single alt of its (classification, role) - so the one role it
  //     runs on needs both bots today. Both are created at deploy and both carry a `classification`
  //     tag, so the condition below permits exactly that pair and denies every other classification's
  //     bots. Verified against the deployment: all eight bots carry the tag, and the alt's tag
  //     matches its assignment record.
  //
  //     A PRIMARY SHOULD NEVER BEAR THE ALT, AND THE MECHANISM FOR IT NOT TO IS ALREADY PROVISIONED.
  //     `assistantActingRole` creates an acting role per (role, occupancy) - `live` AND `alt`, six
  //     deployed today - so the correct shape is that a duel side ASSUMES the alt's acting role, whose own
  //     inline policy names the one bot it may bear, and this statement narrows to the live bot alone.
  //     Nothing assumes those roles yet (Phase 1b), which is the only reason one principal still holds
  //     both. Read the wildcard as owed work, not as a property of the design.
  //
  //     WHY A TAG AND NOT A LITERAL ARN LIST. An assistant is meant to be creatable and assignable at
  //     runtime; a hardcoded list would need a deploy every time one is created, which defeats that.
  //     A newly provisioned bot tagged with its classification is permitted with no IAM change. The
  //     tag is also cross-stack-free: the alt bots are created in `battle-stack`, which does not
  //     receive these roles, so naming their ARNs here would need a dependency that does not exist.
  //
  //     WHAT THIS DOES NOT CLOSE: two assistants INSIDE one classification bearing each other. That
  //     needs the per-assistant pin (an `assistant` session tag on an assumed acting role), which is Phase 1b
  //     and arrives with the second assistant that creates the need.
  const statements = [
    new iam.PolicyStatement({
      // NAMED FOR THE SET, NOT FOR A RANK RELATIONSHIP.
      //
      // This was `AllowOwnAndLowerClassificationChannelActions`, which was accurate while the
      // permitted list was `scopeAtOrBelow` - a rank prefix. It is now `grantsFor`, a declared grant
      // set that need not be a prefix: a deployment declaring `premium: ['basic','premium']` gets a
      // statement that excludes `standard`, and "own and lower" would be a false description of the
      // policy a reader is looking at. A Sid is the label an operator reads in the console when they
      // are working out why something was denied.
      sid: 'AllowGrantedClassificationChannelActions',
      effect: iam.Effect.ALLOW,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/classification': opts.actor === 'assistant'
            ? channelsAnAssistantMayActIn(classification)
            : classificationsAllowedFor(classification),
        },
      },
    }),
    new iam.PolicyStatement({
      sid: 'AllowChannelActionsAsBearerIdentity',
      effect: iam.Effect.ALLOW,
      actions,
      resources: bearerResources,
      // Applied to the ASSISTANT path only. A person's bearer is already pinned to their own
      // identity by the caller, which this could only weaken by widening to a whole classification;
      // and a person's identity carries the tag too, so adding it there would turn an untagged or
      // mistagged user into an outage for no gain.
      ...(opts.actor === 'assistant' && {
        conditions: {
          StringEquals: { 'aws:ResourceTag/classification': classification },
        },
      }),
    }),
  ];
  // SPEC-CONVERSATION-ARCHIVE (ADR-017): if this grant includes a message
  // write, layer the archived-channel read-only Deny on top. A Deny overrides
  // the Allow above, so once a channel is tagged `archived=true` neither the
  // per-classification assistant nor a classification user can send/edit — the channel is read-only
  // by IAM. Callers that grant only reads (e.g. DescribeChannel) get no Deny.
  if (actions.some((a) => ARCHIVE_DENIED_ACTIONS.has(a))) {
    statements.push(archivedChannelReadOnlyDeny(appInstanceArn));
  }
  return statements;
}

/** The membership changes a service makes bearing an assistant. */
export const MEMBERSHIP_CHANGE_ACTIONS = ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership'];

/**
 * EVERY CLASSIFICATION, WITHOUT A LIST. A shared role (one principal serving every conversation: the channel
 * flow, post-processing, battle, the share, the admin plane) passes this where a per-classification role
 * passes its own value. Its grants are then written as "the resource carries a `classification` tag" rather
 * than "the tag is one of the declared set", so declaring or removing a classification changes no shared
 * stack, and an untagged resource still matches nothing (tenet D12: a shared role carrying the classification
 * tag, which fails closed on an untagged resource, is not a violation; the boundary is the principal).
 */
export const EVERY_CLASSIFICATION = 'every-classification' as const;
/** The classifications a grant reaches: one role's own list, or every classification without naming one. */
export type ClassificationScope = readonly string[] | typeof EVERY_CLASSIFICATION;

const CLASSIFICATION_TAG = 'aws:ResourceTag/classification';

/** The resource carries a `classification` tag, whatever its value. An untagged resource matches nothing. */
export function anyClassificationTagged(): Record<string, Record<string, string>> {
  return { Null: { [CLASSIFICATION_TAG]: 'false' } };
}

/**
 * The resource carries a conversation's classification: a `classification` tag that is not the admin plane's.
 * The admin plane is part of every deployment rather than a classification a builder declares, so naming it
 * here does not change when a classification is added or removed.
 */
export function anyConversationTagged(): Record<string, Record<string, string | string[]>> {
  const adminPlane = profiles.adminPlaneValues();
  return {
    Null: { [CLASSIFICATION_TAG]: 'false' },
    ...(adminPlane.length ? { StringNotEquals: { [CLASSIFICATION_TAG]: adminPlane } } : {}),
  };
}

const AUDIENCE_RESOURCE_TAG = `aws:ResourceTag/${AUDIENCE_TAG}`;
const AUDIENCE_REQUEST_TAG = `aws:RequestTag/${AUDIENCE_TAG}`;

/**
 * WHO A CLASSIFICATION'S RESOURCE IS FOR: its `audience` tag, `members` or `outside`, as the conversation creator's
 * function carries it. A shared caller bounds an invoke or a read by this tag rather than by a list of
 * classifications, so its grant does not change when a classification is added or removed.
 */
export function tagAudience(resource: Construct, classification: string): void {
  cdk.Tags.of(resource).add(AUDIENCE_TAG, profiles.audienceOf(classification));
}

/**
 * THIS INSTANCE'S FUNCTIONS OF THE DEPLOYMENT'S OWN PEOPLE'S CONVERSATIONS: the `Instance` tag, the `audience` tag
 * `members` (`tagAudience`), and a `classification` tag that is not the admin plane's (`anyConversationTagged`).
 * A guest's function carries `outside` and an untagged one no audience, so neither matches; the grant names no list.
 */
export function ownInstanceMemberConversationFunctions(): Record<string, unknown> {
  return {
    ...anyConversationTagged(),
    StringEquals: { [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME, [AUDIENCE_RESOURCE_TAG]: 'members' },
  };
}

/**
 * INVOKE THE ROUTER OF ANY MEMBER CONVERSATION'S CLASSIFICATION, FOUND BY NAME AT CALL TIME: the router's construct
 * id bounded by `ownInstanceMemberConversationFunctions`, and the `router-arn` parameters under this instance's
 * path whose `audience` tag is `members` and whose classification is not the admin plane's. Never a guest's router
 * or its parameter, never another instance's, and nothing that names a classification, so adding one changes
 * neither statement.
 */
export function memberRoutersByNameStatements(stack: cdk.Stack, sid = 'InvokeTheRouter'): iam.PolicyStatement[] {
  const adminPlane = profiles.adminPlaneValues();
  return [
    new iam.PolicyStatement({
      sid,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}*-AgentHandler*`],
      conditions: ownInstanceMemberConversationFunctions(),
    }),
    new iam.PolicyStatement({
      sid: 'ReadTheRouterByName',
      actions: ['ssm:GetParameter'],
      resources: [cdk.Arn.format(
        { service: 'ssm', resource: 'parameter', resourceName: routerArnKey('*').replace(/^\//, '') },
        stack,
      )],
      conditions: {
        StringEquals: { [`ssm:resourceTag/${AUDIENCE_TAG}`]: 'members' },
        Null: { 'ssm:resourceTag/classification': 'false' },
        ...(adminPlane.length ? { StringNotEquals: { 'ssm:resourceTag/classification': adminPlane } } : {}),
      },
    }),
  ];
}

/**
 * NEVER AN OUTSIDE CONVERSATION, AS A SECOND LAYER (tenet D3). A role that serves the deployment's own people in
 * every conversation (the share, Battle Mode, invitations) reaches a channel by its `classification` tag
 * being present, so no list keeps it off an outside classification's conversations. The channel's own
 * immutable `audience` tag does, which its creator stamps from the classification's declared audience
 * (`createOwnClassificationOnly`): `actions` are denied on a channel whose audience is `outside`, and on a
 * channel that carries no audience at all, so an unstamped channel fails closed rather than open. The
 * handler's own refusal (an outside conversation's type turns sharing, battle and invitations off, and no
 * member's clearance reaches it) is the first layer.
 *
 * Not on the admin plane: admins are across everything, outside classifications included,
 * so `adminPlaneMembershipStatements` carries no audience condition.
 */
export function neverAnOutsideConversation(sid: string, appInstanceArn: string, actions: string[]): iam.PolicyStatement[] {
  if (!actions.length) throw new Error(`neverAnOutsideConversation(${sid}): no action to deny`);
  return [
    new iam.PolicyStatement({
      sid: `${sid}NeverAnOutsideConversation`,
      effect: iam.Effect.DENY,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: { StringEquals: { [AUDIENCE_RESOURCE_TAG]: 'outside' } },
    }),
    new iam.PolicyStatement({
      sid: `${sid}NeverAConversationWithNoAudience`,
      effect: iam.Effect.DENY,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: { Null: { [AUDIENCE_RESOURCE_TAG]: 'true' } },
    }),
  ];
}

/** The condition on a channel or a bot for `scope`: the values a role's own list names, or any conversation's. */
function conversationScopeCondition(at: string, scope: ClassificationScope, valuesOf: (c: string) => string[]): Record<string, unknown> {
  if (scope === EVERY_CLASSIFICATION) return anyConversationTagged();
  const values = [...new Set(scope.flatMap(valuesOf))];
  if (!values.length) throw new Error(`${at}: no classification to condition on`);
  return { StringEquals: { [CLASSIFICATION_TAG]: values } };
}

/** Every classification a conversation can carry: the declared set less the admin plane, which has none. */
export function conversationalClassifications(): string[] {
  return profiles.classificationValues().filter((c) => profiles.isConversational(c));
}

/**
 * A MEMBERSHIP CHANGE BEARING AN ASSISTANT, CONDITIONED ON THE CONVERSATION'S CLASSIFICATION
 *. The same two legs as `classificationChannelScopedAllow`, for a service
 * that serves a set of classifications rather than one.
 *
 * WHAT IAM CAN AND CANNOT SEE HERE (ACCESS-CONTROL-BY-EXAMPLE, ADR-042). The MEMBER cannot be
 * tag-gated: `MemberArn` is a request parameter, not a resource, so nothing conditions who is
 * added or removed (measured by `scripts/deny-test-assistant-membership.mjs`, which found the
 * authorization is on the channel). The other two resources the call is authorized against can be,
 * which is what this conditions:
 *
 * - the CHANNEL, which carries the immutable `classification` tag, so the change is allowed only in a
 *   conversation of a declared classification and never in an untagged or admin-plane channel;
 * - the BEARER, pinned to `/bot/*` and to a bot carrying a declared classification, so the role cannot
 *   make the change as a person or as an assistant outside the set.
 *
 * The legs are evaluated independently, so for a role serving several classifications IAM does not pair
 * them: a basic bot bearing a change in a premium conversation passes both. Pairing is the handler's
 * (each resolves the bot from the channel's own tag) and Amazon Chime SDK's own role model, under which
 * only a moderator of a `RESTRICTED` channel or an app instance admin may add or remove a member
 * (ADR-042). A single-classification role passes one value and is paired. The membership audit remains
 * the detection for the member itself.
 */
export function membershipAsAssistantStatements(
  sid: string,
  appInstanceArn: string,
  classifications: ClassificationScope,
  actions: string[] = MEMBERSHIP_CHANGE_ACTIONS,
): iam.PolicyStatement[] {
  const at = `membershipAsAssistantStatements(${sid})`;
  return [
    new iam.PolicyStatement({
      sid: `${sid}InDeclaredClassifications`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: conversationScopeCondition(at, classifications, (c) => channelsAnAssistantMayActIn(c as Classification)),
    }),
    new iam.PolicyStatement({
      sid: `${sid}AsADeclaredAssistant`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [`${appInstanceArn}/bot/*`],
      conditions: conversationScopeCondition(at, classifications, (c) => [c]),
    }),
    // A role serving every conversation is one of the deployment's own people's tools, and never reaches an
    // outside conversation (`neverAnOutsideConversation`). A role of one classification names its own value.
    ...(classifications === EVERY_CLASSIFICATION ? neverAnOutsideConversation(sid, appInstanceArn, actions) : []),
  ];
}

/**
 * The membership changes a creator makes bearing the service admin: it adds the assistants and people,
 * makes the assistant and the opener moderators, and then drops its own moderator record and leaves.
 */
export const CREATOR_MEMBERSHIP_ACTIONS = [
  'chime:CreateChannelMembership',
  'chime:CreateChannelModerator',
  'chime:DeleteChannelMembership',
  'chime:DeleteChannelModerator',
];

/**
 * A MEMBERSHIP CHANGE BEARING THE SERVICE ADMIN, CONDITIONED ON THE CONVERSATION'S CLASSIFICATION
 *. The creators (the router's drift split, the conversation split, the
 * typed-conversation creator and the conversation creation function) create as the service admin, an
 * AppInstanceUser, so the bot leg of `membershipAsAssistantStatements` cannot match them. The same two
 * legs, with the bearer named:
 *
 * - the CHANNEL, which carries the immutable `classification` tag from `CreateChannel` (every creator
 *   tags in that call), so the change is allowed only in a conversation of the role's own
 *   classifications and never in another classification's, an untagged or an admin-plane channel;
 * - the BEARER, the service admin's exact ARN with no tag condition, because the admin carries
 *   `classification=admin`, which matches no creator's classification. Never `/user/*`, which would let the role act as any person.
 *
 * The added or removed member (`MemberArn`, `ChannelModeratorArn`) is a request parameter, not a
 * resource, and stays outside IAM's view (`scripts/deny-test-assistant-membership.mjs`); the membership
 * audit is the detection for it.
 */
export function membershipAsServiceAdminStatements(
  sid: string,
  appInstanceArn: string,
  classifications: ClassificationScope,
  serviceAdminArn: string,
  actions: string[] = CREATOR_MEMBERSHIP_ACTIONS,
): iam.PolicyStatement[] {
  const channels = conversationScopeCondition(`membershipAsServiceAdminStatements(${sid})`, classifications, (c) => channelsAnAssistantMayActIn(c as Classification));
  if (!serviceAdminArn || serviceAdminArn.includes('*')) {
    throw new Error(`membershipAsServiceAdminStatements(${sid}): the service admin must be named exactly`);
  }
  return [
    new iam.PolicyStatement({
      sid: `${sid}InDeclaredClassifications`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: channels,
    }),
    new iam.PolicyStatement({
      sid: `${sid}AsTheServiceAdmin`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [serviceAdminArn],
    }),
    // The same second layer as `membershipAsAssistantStatements`: a role serving every conversation (the
    // invitations function) never changes an outside conversation's membership.
    ...(classifications === EVERY_CLASSIFICATION ? neverAnOutsideConversation(sid, appInstanceArn, actions) : []),
  ];
}

/**
 * THE SERVICE APP-INSTANCE ADMIN, by its exact ARN. `messaging-stack.ts` creates it as
 * `${RES_PREFIX}-admin` and publishes the same ARN at `INSTANCE_SSM.appInstanceAdminArn`, which the
 * handlers read at runtime; a stack that only needs it as a policy resource derives it here instead of
 * importing it, so the deploy order stays free.
 */
export function serviceAdminArnOf(appInstanceArn: string): string {
  return `${appInstanceArn}/user/${RES_PREFIX}-admin`;
}

/**
 * A MEMBERSHIP CHANGE ON THE ADMIN PLANE.
 *
 * The admin-plane roles (user deletion, archive and removal, the admin conversations, the admin
 * notification channel, the membership audit) act across classifications by definition: admins are across
 * everything, and administering a subset of the classifications is a separate instance with its own
 * admins. So their channel leg is a channel that carries a classification, whatever its value, and names
 * no list. What they never need is a person's or an assistant's bearer, or a channel that carries no
 * classification. So the same two legs as the creators:
 *
 * - the CHANNEL: `channel/*` carrying a `classification` tag (`EVERY_CLASSIFICATION`), or the admin plane's
 *   own value for a role that acts in admin-plane channels alone, or the exact channel ARNs where the role
 *   acts in named channels only;
 * - the BEARER: the exact identities the handler bears (the service admin, by its ARN), never
 *   `/user/*` or the app instance.
 *
 * The member added or removed is a request parameter and stays outside IAM's view; the handler's own
 * authorization (a channel's live moderator list, the admins group, the audit's clearance check) is
 * what decides it.
 */
export function adminPlaneMembershipStatements(
  sid: string,
  appInstanceArn: string,
  opts: {
    /** The exact bearer ARNs. A wildcard is refused at synth. */
    bearerArns: string[];
    /**
     * The classifications whose channels the role acts in: `EVERY_CLASSIFICATION` for a role that acts across
     * the deployment (admins are across everything, outside classifications included), or the admin plane's
     * own values for a role that acts in admin-plane channels alone. Never a list of declared classifications:
     * administering a subset of them is a separate instance with its own admins.
     */
    channelClassifications?: ClassificationScope;
    /** Or the exact channels it acts in. */
    channelArns?: string[];
    actions: string[];
  },
): iam.PolicyStatement[] {
  const { bearerArns, channelArns = [], actions } = opts;
  const scope = opts.channelClassifications ?? [];
  const reachesChannels = scope === EVERY_CLASSIFICATION || scope.length > 0;
  if (scope !== EVERY_CLASSIFICATION) {
    const listed = scope.filter((c) => !profiles.adminPlaneValues().includes(c));
    if (listed.length) {
      throw new Error(`adminPlaneMembershipStatements(${sid}): names ${listed.join(', ')}; the admin plane acts in every classification (EVERY_CLASSIFICATION) or in its own channels, never in a listed set`);
    }
  }
  if (!bearerArns.length || bearerArns.some((b) => !b || b.includes('*'))) {
    throw new Error(`adminPlaneMembershipStatements(${sid}): every bearer must be named exactly`);
  }
  if (channelArns.some((c) => !c || c.includes('*'))) {
    throw new Error(`adminPlaneMembershipStatements(${sid}): a named channel must be named exactly`);
  }
  if (!reachesChannels && !channelArns.length) return [];
  return [
    ...(reachesChannels ? [new iam.PolicyStatement({
      sid: `${sid}InItsClassifications`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: scope === EVERY_CLASSIFICATION
        ? anyClassificationTagged()
        : { StringEquals: { [CLASSIFICATION_TAG]: [...new Set(scope)] } },
    })] : []),
    ...(channelArns.length ? [new iam.PolicyStatement({
      sid: `${sid}InItsChannels`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [...new Set(channelArns)],
    })] : []),
    new iam.PolicyStatement({
      sid: `${sid}AsItsBearer`,
      effect: iam.Effect.ALLOW,
      actions,
      resources: [...new Set(bearerArns)],
    }),
  ];
}

/** The tag keys an assistant identity (an AppInstanceBot) carries: which classification, which assistant, which role. */
export const ASSISTANT_IDENTITY_TAG_KEYS = ['classification', 'assistant', 'role'] as const;

/** The tag a runtime provisioner stamps on what it creates, and the value it stamps. */
export const RUNTIME_PROVISIONER_TAG = { key: 'provisioner', value: 'runtime' } as const;
/** The tag keys a runtime-created assistant's identity and Lex bot carry: the identity tags plus `provisioner`. */
export const RUNTIME_ASSISTANT_TAG_KEYS = [...ASSISTANT_IDENTITY_TAG_KEYS, RUNTIME_PROVISIONER_TAG.key] as const;

/**
 * THE PROVISIONER'S GRANT (ADR-048, amended 2026-10-24), REACHING ONLY WHAT A PROVISIONER CREATED.
 *
 * Every assistant identity and its Amazon Lex bot are the provisioner's, and ONE ROLE holds this grant:
 * `RuntimeAssistantProvisionerRole` (`lib/constructs/assistant-provisioner.ts`), assumed by the provisioner function
 * alone, which builds and retires every assistant, declared or created in the console. A stack's seed and
 * `manage-assistants` ask that function; neither holds this. Every action is conditioned on the classification and
 * on `provisioner = runtime`, requested on create and required on the resource for everything after, so an identity
 * nothing provisioned is unreachable, and a session of one classification reaches no other's.
 *
 * WHY STRICT `StringEquals` ON THE RESOURCE TAG. `StringEqualsIfExists` is TRUE when the key is absent from
 * the request context, so a service that did not populate `aws:ResourceTag/classification` would leave an
 * `IfExists` statement unconditioned in effect. A strict condition on an absent key DENIES, so whichever way
 * the service behaves, it fails closed. And the resource half of a tag statement pins the TARGET, not only the
 * value written, so no holder can relabel another classification's assistant.
 *
 * Amazon Lex V2 supports `aws:RequestTag` on `CreateBot` and `aws:ResourceTag` on the bot and bot-alias
 * resources (AWS service reference, read 2026-10-12). It does not on bot versions, which is why the
 * runtime build creates none. The test alias is tagged at create (`testBotAliasTags`), so alias actions
 * are reachable under the same condition.
 *
 * NOT HERE, deliberately: any `iam:*` beyond passing the one Lex bot role to Amazon Lex, and any write under
 * `/assistant/*` (profiles are `manage-profiles`' alone). `UpdateAppInstanceBot` is here for one use, a declared
 * display name reaching an identity it built (`renameIdentity`), which re-sends the configuration the identity
 * already has; a profile version's rename stays the name applier's job.
 *
 * EVERY CONDITION IS THE SESSION'S OWN `classification` TAG (`${aws:PrincipalTag/classification}`) rather than a
 * value: the role is assumed once per classification, tagged with it, so one role reaches whichever classification
 * the work is for, names none, and still pairs the requested classification with the one a bot already carries.
 * `classifications` takes only {@link SESSION_CLASSIFICATION}: a grant written for named classifications would be a
 * second principal that builds assistants.
 */
export const SESSION_CLASSIFICATION = 'session-classification' as const;
export function runtimeAssistantProvisioningAllow(args: {
  classifications: typeof SESSION_CLASSIFICATION;
  appInstanceArn: string;
  region: string;
  account: string;
  lexBotRoleArn: string;
}): iam.PolicyStatement[] {
  if (args.classifications !== SESSION_CLASSIFICATION) {
    throw new Error('runtimeAssistantProvisioningAllow: the grant is written for the session\'s classification only; one role holds it');
  }
  // The session's classification, as a policy variable: emitted literally, so concatenated.
  const own = ['$' + '{aws:PrincipalTag/classification}'];
  const sidOf = (_c: string) => 'OfTheSession';
  const { key: P, value: RUNTIME } = RUNTIME_PROVISIONER_TAG;
  const tagKeys = { 'ForAllValues:StringEquals': { 'aws:TagKeys': [...RUNTIME_ASSISTANT_TAG_KEYS] } };
  const requested = { 'aws:RequestTag/classification': own, [`aws:RequestTag/${P}`]: RUNTIME };
  const onResource = { 'aws:ResourceTag/classification': own, [`aws:ResourceTag/${P}`]: RUNTIME };
  // `bot-alias/*`, not `bot-alias/*/*`: `CreateBot` authorizes its test alias against the literal
  // resource `bot-alias/*` (measured 2026-10-13: AccessDenied on `bot-alias/*` under the two-segment
  // pattern), and an IAM wildcard also matches the `{botId}/{aliasId}` of an existing alias.
  const lexBots = [
    `arn:aws:lex:${args.region}:${args.account}:bot/*`,
    `arn:aws:lex:${args.region}:${args.account}:bot-alias/*`,
  ];
  return [
    new iam.PolicyStatement({
      sid: 'CreateRuntimeAssistantIdentity',
      actions: ['chime:CreateAppInstanceBot'],
      // Authorized against the bot path as well as the app instance (measured 2026-09-24; see above).
      resources: [args.appInstanceArn, `${args.appInstanceArn}/bot/*`],
      conditions: { StringEquals: requested, ...tagKeys },
    }),
    // A create that passes `Tags` also authorizes `chime:TagResource` (measured for channels). ONE
    // STATEMENT PER CLASSIFICATION, so the requested classification must equal the one the bot already
    // carries: with the set on both sides, this role could relabel a premium runtime assistant as basic.
    ...own.map((c) => new iam.PolicyStatement({
      sid: `TagRuntimeAssistantIdentityAtCreate${sidOf(c)}`,
      actions: ['chime:TagResource'],
      resources: [args.appInstanceArn, `${args.appInstanceArn}/bot/*`],
      conditions: {
        StringEquals: {
          'aws:RequestTag/classification': c, 'aws:ResourceTag/classification': c,
          [`aws:RequestTag/${P}`]: RUNTIME, [`aws:ResourceTag/${P}`]: RUNTIME,
        },
        ...tagKeys,
      },
    })),
    // Whether a retired identity is gone: a deleted bot carries no tags, so Describe answers with a denial
    // (`ForbiddenException`, or the IAM layer's `AccessDeniedException` under the tag condition below), and
    // retire settles it by listing. Read only, and it names nothing it could change.
    new iam.PolicyStatement({
      sid: 'ListAssistantIdentities',
      actions: ['chime:ListAppInstanceBots'],
      resources: [args.appInstanceArn, `${args.appInstanceArn}/bot/*`],
    }),
    new iam.PolicyStatement({
      sid: 'RetireRuntimeAssistantIdentityOnly',
      actions: ['chime:DescribeAppInstanceBot', 'chime:DeleteAppInstanceBot'],
      resources: [`${args.appInstanceArn}/bot/*`],
      conditions: { StringEquals: onResource },
    }),
    // A declaration's new display name reaches its identity's Name (`renameIdentity`), under the same condition as
    // retire. The call re-sends the configuration the identity already has, so the Lex wiring stays the build's.
    new iam.PolicyStatement({
      sid: 'RenameRuntimeAssistantIdentityOnly',
      actions: ['chime:UpdateAppInstanceBot'],
      resources: [`${args.appInstanceArn}/bot/*`],
      conditions: { StringEquals: onResource },
    }),
    new iam.PolicyStatement({
      sid: 'CreateRuntimeAssistantLexBot',
      actions: ['lex:CreateBot'],
      resources: lexBots,
      conditions: { StringEquals: requested, ...tagKeys },
    }),
    // Tagging is pinned on the RESOURCE as well as the request, per classification, for the same reason
    // as the identity: a request-only condition would let this role stamp `provisioner=runtime` onto a
    // deploy-time Lex bot and so bring it within the delete grant below.
    ...own.map((c) => new iam.PolicyStatement({
      sid: `TagRuntimeAssistantLexBotAtCreate${sidOf(c)}`,
      actions: ['lex:TagResource'],
      resources: lexBots,
      conditions: {
        StringEquals: {
          'aws:RequestTag/classification': c, 'aws:ResourceTag/classification': c,
          [`aws:RequestTag/${P}`]: RUNTIME, [`aws:ResourceTag/${P}`]: RUNTIME,
        },
        ...tagKeys,
      },
    })),
    new iam.PolicyStatement({
      sid: 'BuildAndRetireRuntimeAssistantLexBotOnly',
      actions: [
        'lex:DescribeBot', 'lex:CreateBotLocale', 'lex:DescribeBotLocale', 'lex:CreateIntent', 'lex:ListIntents',
        'lex:UpdateIntent', 'lex:BuildBotLocale', 'lex:ListBotAliases', 'lex:UpdateBotAlias',
        'lex:CreateResourcePolicy', 'lex:UpdateResourcePolicy', 'lex:DeleteBot',
        // `DeleteBot` cascades, and authorizes each child it deletes (measured 2026-10-13: refused on
        // `lex:DeleteBotLocale` without these), under the same resource-tag condition.
        'lex:DeleteBotLocale', 'lex:DeleteIntent', 'lex:DeleteBotAlias', 'lex:DeleteResourcePolicy',
        'lex:DeleteBotChannel', 'lex:DeleteSlot', 'lex:DeleteSlotType', 'lex:DeleteBotVersion',
      ],
      resources: lexBots,
      conditions: { StringEquals: onResource },
    }),
    // Whether a retired Amazon Lex bot is gone: a deleted bot carries no tags, so `DeleteBot` answers with an
    // access denial rather than NotFound, and retire settles it by listing. `ListBots` takes no resource, so
    // it is granted on `*`; it is read only, and it names nothing it could change.
    new iam.PolicyStatement({
      sid: 'ListAssistantLexBots',
      actions: ['lex:ListBots'],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'PassTheRuntimeLexBotRoleToLexOnly',
      actions: ['iam:PassRole'],
      resources: [args.lexBotRoleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'lexv2.amazonaws.com' } },
    }),
  ];
}

/**
 * THE ASSISTANT ROLE EVERY CLASSIFICATION DECLARES. A role is a job (`primary`, `ops`) from a platform
 * registry, and any number of assistants may hold it. A classification's own list comes from
 * `assistantRolesFor`, which always includes this one.
 */
export const ASSISTANT_ROLES = ['primary'];

/** The roles one classification instantiates, from its own declaration. `primary` is always present. */
export function assistantRolesFor(classification: string): string[] {
  return profiles.rolesFor(classification);
}

/**
 * THE ATTACHMENTS BUCKET'S UNCLASSIFIED KEY FAMILIES A TURN READS OR WRITES (tenet D15): a member's upload, an
 * assistant's deliverable, a duel's images and the content-addressed profile bodies. Each is narrowed further
 * by the acting role's own grants and by code; the boundary admits the family and nothing classified.
 */
export const TURN_OBJECT_FAMILIES = ['attachments/', 'generated-docs/', 'battle-images/', 'profiles/'] as const;

/** The classified prefixes one classification's assistants may read: its granted `context/` and `platform-knowledge/`. */
function classifiedPrefixesOf(classification: string): string[] {
  return [
    ...contextPrefixesAllowedFor(classification as Classification),
    ...profiles.grantsFor(classification).map((c) => `platform-knowledge/${c}/`),
  ];
}

/** The S3 an acting role's boundary allows (`assistantActingRole`): none without a bucket. */
function boundaryS3Statements(classification: string, bucketArn: string | undefined, readsTemplates: boolean): iam.PolicyStatement[] {
  if (!bucketArn) return [];
  const classified = classifiedPrefixesOf(classification);
  return [
    new iam.PolicyStatement({
      sid: 'BoundaryObjectsATurnUses',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject'],
      // The classification's OWN intent-pack bodies (`classification-packs/{classification}/`) and no other's.
      resources: [...TURN_OBJECT_FAMILIES, ...classified, classificationPackPrefix(classification)].map((p) => `${bucketArn}/${p}*`),
    }),
    // The classification's OWN document templates (`templates/{classification}/`), and only to read: a
    // turn never writes a template, so the boundary does not admit the write a mistaken grant would ask for.
    // Present for every classification's acting role, whose turns say message templates (ADR-062).
    ...(readsTemplates ? [new iam.PolicyStatement({
      sid: 'BoundaryItsOwnTemplates',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${bucketArn}/${templatePrefix(classification)}*`],
    })] : []),
    new iam.PolicyStatement({
      sid: 'BoundaryListingItsOwnPrefixes',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [bucketArn],
      // Its own template prefix too, where it reads templates: a turn lists which templates a family holds.
      conditions: { StringLike: { 's3:prefix': [...classified, ...(readsTemplates ? [templatePrefix(classification)] : [])].map((p) => `${p}*`) } },
    }),
  ];
}

/**
 * A CONTEXT SOURCE'S OBJECTS, INSIDE THE BOUNDARY. A classification's context-source catalog may name an
 * `s3-prefix` outside the attachments bucket; the stack that grants it adds the same object resources here,
 * so the boundary admits what the catalog declares for this classification and nothing else.
 */
export function allowContextSourceObjects(boundary: iam.ManagedPolicy, objectArns: string[]): void {
  if (!objectArns.length) return;
  boundary.addStatements(new iam.PolicyStatement({
    sid: 'BoundaryContextSourceObjects',
    effect: iam.Effect.ALLOW,
    actions: ['s3:GetObject'],
    resources: [...new Set(objectArns)],
  }));
}

/** Every assistant acting role lives under this IAM path, which separates it from platform roles. */
export function assistantRolePath(): string {
  return `/${INSTANCE_NAME}/assistant/`;
}

/** The read actions an assistant role may be given on this deployment's own telemetry. */
// METRICS AND ALARMS ONLY. Log reads were here too and nothing on a session ever made one (no CloudWatch Logs
// client exists under `lambda/src`), while the grant reached every log group in the account: other
// instances' and this instance's admin plane. An observability tool that needs logs adds
// the read with the log groups it names.
const METRIC_READ_ACTIONS = [
  'cloudwatch:GetMetricData',
  'cloudwatch:GetMetricStatistics',
  'cloudwatch:ListMetrics',
];
/**
 * ALARM READS, SCOPED TO THIS DEPLOYMENT'S ALARMS. `DescribeAlarms` accepts the `alarm` resource type
 * (Service Authorization Reference), so unlike the metric reads it is granted on alarm ARNs rather than
 * `*`: an ops session reads this instance's alarms and no other application's in the same account.
 *
 * CloudWatch authorizes a call that NAMES its alarms (`AlarmNames`) against each alarm's own ARN, and a
 * listing call (by prefix, by state, or unfiltered) against `alarm:*`, so under this scope the tool asks by
 * name, and the names come from the deployment (`publishAlarmNames`, `lib/constructs/alarm-names.ts`). A
 * narrower scope also cannot return composite alarms (CloudWatch permissions reference); the platform
 * declares none, and the tool asks for metric alarms only.
 */
const ALARM_READ_ACTIONS = ['cloudwatch:DescribeAlarms'];
const OBSERVABILITY_READ_ACTIONS = [...METRIC_READ_ACTIONS, ...ALARM_READ_ACTIONS];

/**
 * THE NAME PREFIXES EVERY ALARM OF THIS DEPLOYMENT CARRIES, which the alarm-read grant's resources name.
 *
 * An alarm is named after its stack (`${stackName}-...`, or the name CloudFormation generates, which also
 * begins with the stack name) or after the instance (`${STACK_PREFIX}-...`). Each stack name is the
 * instance prefix followed by a name from `stack-names.json`, so the list names every stack this instance
 * can create and no look-alike instance's: `AgentEchelonArchive-` belongs to this instance, while
 * `AgentEchelonTwoArchive-` does not, though both begin with `AgentEchelon`.
 * `alarm-names-carry-the-deployment-prefix.test.ts` keeps every alarm the stacks declare inside it.
 *
 * The core's prefixes, and those of the stacks each capability in `declared` stands up (every capability by
 * default): an optional capability's alarms are read only in a deployment that declares it.
 */
export function deploymentAlarmNamePrefixes(declared: readonly string[] = CAPABILITIES.map((c) => c.name)): string[] {
  return [...coreAlarmNamePrefixes(), ...declared.flatMap((name) => capabilityAlarmNamePrefixes(name))];
}

/** The stacks a capability stands up, by name: an optional capability's alarms are read only where it is declared. */
const CAPABILITY_STACKS = new Set(CAPABILITIES.flatMap((c) => c.stacks));

/** The name prefixes of the core's alarms: the instance, every stack no capability owns, each classification and region. */
export function coreAlarmNamePrefixes(): string[] {
  return [
    `${STACK_PREFIX}-`,
    ...STACK_NAMES.current.filter((n) => !CAPABILITY_STACKS.has(n)).map((n) => `${STACK_PREFIX}${n}-`),
    `${STACK_PREFIX}${STACK_NAMES.perClassification}`,
    `${STACK_PREFIX}${STACK_NAMES.perRegion}`,
  ];
}

/** The name prefixes of one capability's alarms: one per stack its registry entry stands up. */
export function capabilityAlarmNamePrefixes(capability: string): string[] {
  return (capabilityDefinition(capability)?.stacks ?? []).map((n) => `${STACK_PREFIX}${n}-`);
}

/** Alarm ARNs, as IAM resources: one wildcard per name prefix. */
function alarmArns(scope: Construct, prefixes: readonly string[]): string[] {
  const stack = cdk.Stack.of(scope);
  return prefixes.map((p) => `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:${p}*`);
}

/**
 * THIS INSTANCE'S ALARMS, AS ONE SESSION-POLICY RESOURCE. A session policy only narrows the acting role, whose
 * grant names each declared stack's alarms (`assistantActingRole`), so the session edge names the instance's
 * stack-name family and stays the same whichever capabilities a deployment declares.
 */
function instanceAlarmArns(scope: Construct): string[] {
  return alarmArns(scope, [STACK_PREFIX]);
}

/** Which of a classification's assistant roles may read this deployment's own telemetry. */
export function observabilityRoles(roles: string[]): string[] {
  return roles.filter((r) => r === 'ops');
}

/**
 * THE ROLE ONE CLASSIFICATION'S ASSISTANTS ACT THROUGH (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * ONE ROLE, ANY NUMBER OF ASSISTANTS. Nothing about a particular assistant is written into IAM. The
 * vend (`assistant-vend.ts`) assumes this role per turn and tags the session with the assistant, its
 * assistant role and its bot, copied from the routing record the router wrote for that turn; every
 * statement here compares those tags. Adding an assistant is therefore data (an identity, a routing
 * record entry), never a deploy, and no runtime principal holds any IAM write.
 *
 * WHO MAY MINT A SESSION. The trust policy names the vend and nothing else, and pins the
 * `classification` request tag to this role's own value and the `role` tag to the assistant roles this
 * classification declares. The processor, the handler and the task service cannot assume it at all;
 * they ask the vend, and the vend reads the routing record only the router writes. What IAM cannot
 * check is whether the router chose the right assistant inside this classification - that decision is
 * code, as it is for a person at the credential exchange.
 *
 * THE BEARER IS AN ARN VARIABLE, `.../bot/${aws:PrincipalTag/bot}`, the same construction a person's
 * credential uses with `.../user/${aws:PrincipalTag/person}`. A session can act as exactly the bot it
 * was minted for and no other, and the bot's own `classification` tag must also match, which is the
 * second layer.
 *
 * THE BOUNDARY IS WHAT THE CLASSIFICATION ALLOWS, as Denies. It allows the services a turn uses and
 * denies, whatever the identity policies grow to hold: editing IAM or chaining into another role;
 * acting in a channel, or as a bot, not tagged with this classification; and reading telemetry from a
 * session whose role is not an observability role. A Deny keyed on a negated condition also denies
 * when the key is absent, so an untagged channel or session is refused rather than let through.
 */
export function assistantActingRole(
  scope: Construct,
  opts: {
    classification: string;
    appInstanceArn: string;
    /** The vend's role: the only principal that may mint a session. */
    vendRole: iam.IRole;
    /** The assistant roles this classification declares. */
    roles: string[];
    /** What a session may do in a conversation; narrower than the gated set. */
    sessionChannelActions: string[];
    /** The bucket holding `context/`. */
    contextBucketArn?: string;
    /** Whether a workflow this classification serves declares a document template, so a turn reads its own. */
    readsTemplates?: boolean;
    /** The capabilities this deployment declares: an observability role reads their stacks' alarms beside the core's. */
    capabilities?: readonly string[];
  },
): { role: iam.Role; boundary: iam.ManagedPolicy } {
  const own = opts.classification;
  const channelValues = channelsAnAssistantMayActIn(own as Classification);
  const observers = observabilityRoles(opts.roles);

  const boundary = new iam.ManagedPolicy(scope, 'AssistantBoundary', {
    managedPolicyName: `${STACK_PREFIX}AssistantActingBoundary-${own}`,
    // FROZEN TEXT. A managed policy's Description is replace-only in CloudFormation, and this policy
    // has a fixed name, so an edit to the description alone makes the replacement collide with the
    // policy it replaces and the deploy fails. Changing both together is a clean replacement: the new
    // name is created, the acting role moves to it, and the old one is deleted.
    description:
      `The boundary for every assistant of the ${own} classification. A session narrowed at `
      + 'runtime cannot exceed it, and widening it is a deploy.',
    statements: [
      new iam.PolicyStatement({
        sid: 'BoundaryTheServicesATurnUses',
        effect: iam.Effect.ALLOW,
        // NO S3 HERE: S3 is allowed below on the objects a turn uses and this classification's own context
        // alone, so another classification's prefix is outside the boundary without being named.
        actions: [
          'chime:*', 'bedrock:*', 'dynamodb:*', 'ssm:GetParameter', 'ssm:GetParameters',
          'ssm:GetParametersByPath', 'ssm:GetParameterHistory',
          // NO ssm:PutParameter: tripping the cost circuit is the processor's own record, on its own role.
          'lambda:InvokeFunction', 'kinesis:PutRecord',
          'kinesis:PutRecords', 'firehose:PutRecord', 'firehose:PutRecordBatch', 'secretsmanager:GetSecretValue',
          'kms:Decrypt', 'kms:GenerateDataKey', 'cloudwatch:PutMetricData', ...OBSERVABILITY_READ_ACTIONS,
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'AnAssistantNeverEditsIdentityOrChains',
        effect: iam.Effect.DENY,
        actions: ['iam:*', 'sts:AssumeRole', 'sts:TagSession', 'chime:TagResource', 'chime:UntagResource'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'BoundaryNoChannelOutsideThisClassification',
        effect: iam.Effect.DENY,
        actions: CLASSIFICATION_GATED_CHANNEL_ACTIONS,
        resources: [`${opts.appInstanceArn}/channel/*`],
        conditions: { StringNotEquals: { 'aws:ResourceTag/classification': channelValues } },
      }),
      new iam.PolicyStatement({
        sid: 'BoundaryNoBotOutsideThisClassification',
        effect: iam.Effect.DENY,
        actions: CLASSIFICATION_GATED_CHANNEL_ACTIONS,
        resources: [`${opts.appInstanceArn}/bot/*`],
        conditions: { StringNotEquals: { 'aws:ResourceTag/classification': own } },
      }),
      // S3 ONLY WHERE A TURN USES IT, AND NO OTHER CLASSIFICATION'S COMPANY CONTEXT, whatever the identity
      // policies grow to hold. The boundary allows the bucket's unclassified key families a turn reads or
      // writes (`TURN_OBJECT_FAMILIES`), and of the classified ones (`context/`, `platform-knowledge/`) only
      // the prefixes this classification grants, objects and listing alike. Every other prefix, another
      // classification's, one declared after this stack was deployed, or an undeclared one, is outside it
      // without being named, so a mistaken S3 grant on the acting role still cannot read it, and declaring a
      // classification changes no other classification's boundary. A context source in another bucket is
      // added by the stack that grants it (`allowContextSourceObjects`).
      ...boundaryS3Statements(own, opts.contextBucketArn, opts.readsTemplates === true),
      new iam.PolicyStatement({
        sid: 'BoundaryTelemetryOnlyForObservabilityRoles',
        effect: iam.Effect.DENY,
        actions: OBSERVABILITY_READ_ACTIONS,
        resources: ['*'],
        // An empty list would serialize to a condition matching every value, which would deny the
        // statement to nobody; with no observability role the Deny is unconditioned instead.
        ...(observers.length
          ? { conditions: { StringNotEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: observers } } }
          : {}),
      }),
      // AN ARCHIVED CONVERSATION IS READ-ONLY, ENFORCED AT THE BOUNDARY. A Deny in the boundary covers every
      // grant the acting role holds now or is given later, which the same Deny on the role's identity
      // policy only does by being remembered next to each new send. Every other role keeps the Deny on its
      // identity policy through `classificationChannelScopedAllow`; this role moves it here (tenet D9, recorded).
      archivedChannelReadOnlyDeny(opts.appInstanceArn),
    ],
  });

  const tagPin = {
    StringLike: {
      [`aws:RequestTag/${SESSION_TAG.assistant}`]: '*',
      [`aws:RequestTag/${SESSION_TAG.bot}`]: '*',
    },
    StringEquals: {
      [`aws:RequestTag/${SESSION_TAG.classification}`]: own,
      [`aws:RequestTag/${SESSION_TAG.role}`]: opts.roles,
    },
  };
  const vend = new iam.ArnPrincipal(opts.vendRole.roleArn);
  // THE CONDITIONS GO ON THE ASSUME ITSELF, not only on `sts:TagSession`: conditioning the tag call
  // alone would let the vend assume WITHOUT tags and skip every pin. `PrincipalWithConditions` puts
  // them on `sts:AssumeRole`, so an untagged assume is refused.
  const role = new iam.Role(scope, 'AssistantActingRole', {
    assumedBy: new iam.PrincipalWithConditions(vend, tagPin),
    permissionsBoundary: boundary,
    path: assistantRolePath(),
    maxSessionDuration: cdk.Duration.hours(1),
    description: `What every ${own} assistant acts through, one tagged session per turn.`,
  });
  role.assumeRolePolicy?.addStatements(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [vend],
      actions: ['sts:TagSession'],
      conditions: tagPin,
    }),
    // The session's source identity is the assistant, so CloudTrail names it on every call the turn
    // makes and a downstream call cannot rewrite it.
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [vend],
      actions: ['sts:SetSourceIdentity'],
    }),
  );

  // ── IN A CONVERSATION: ITS OWN CLASSIFICATION'S CHANNELS, AS ITS OWN BOT ───────────────────────
  role.addToPolicy(new iam.PolicyStatement({
    sid: CHANNEL_SID,
    effect: iam.Effect.ALLOW,
    actions: [...opts.sessionChannelActions],
    resources: [`${opts.appInstanceArn}/channel/*`],
    conditions: { StringEquals: { 'aws:ResourceTag/classification': channelValues } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: BEARER_SID,
    effect: iam.Effect.ALLOW,
    actions: [...opts.sessionChannelActions],
    resources: [`${opts.appInstanceArn}/bot/\${aws:PrincipalTag/${SESSION_TAG.bot}}`],
    conditions: { StringEquals: { 'aws:ResourceTag/classification': own } },
  }));
  // NO ARCHIVED-CHANNEL DENY HERE: the boundary carries it (`AssistantBoundary` above), which covers
  // every grant this role holds rather than the sends it was written next to.

  // ── WHAT AN ASSISTANT ROLE READS ────────────────────────────────────────────────────────────────
  if (opts.contextBucketArn) {
    for (const statement of roleContextStatements(own, opts.roles, opts.contextBucketArn)) role.addToPolicy(statement);
  }
  if (observers.length) {
    // THE CORE'S OBSERVABILITY READS ARE ONE MANAGED POLICY, NOT INLINE. They are the same in every deployment,
    // and keeping them off the role's inline budget leaves room for each declared capability's alarm read below,
    // so a deployment that declares every capability stays inside IAM's 10,240-byte inline limit.
    const here = cdk.Stack.of(scope);
    const observability = new iam.ManagedPolicy(scope, 'AssistantObservabilityRead', { roles: [role] });
    observability.addStatements(new iam.PolicyStatement({
      sid: 'RoleObservabilityRead',
      effect: iam.Effect.ALLOW,
      actions: METRIC_READ_ACTIONS,
      // THE METRIC READS ACCEPT ONLY `*` (they name no resource type), so what narrows them is the role
      // condition and the boundary's matching Deny, and the tool filters to this deployment's functions.
      resources: ['*'],
      conditions: { StringEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: observers } },
    }));
    observability.addStatements(new iam.PolicyStatement({
      sid: 'RoleObservabilityAlarmRead',
      effect: iam.Effect.ALLOW,
      actions: ALARM_READ_ACTIONS,
      // THE CORE'S ALARMS, by name prefix (`coreAlarmNamePrefixes`). Each declared capability's are its own policy, below.
      resources: alarmArns(scope, coreAlarmNamePrefixes()),
      conditions: { StringEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: observers } },
    }));
    // EACH DECLARED CAPABILITY'S ALARMS, one policy per capability (`capabilityAlarmNamePrefixes`): a capability
    // adds its own read beside the core's, so the role reads exactly the alarms of the stacks this deployment has.
    for (const capability of opts.capabilities ?? []) {
      const prefixes = capabilityAlarmNamePrefixes(capability);
      if (!prefixes.length) continue;
      new iam.Policy(scope, `AssistantAlarmRead-${capability}`, {
        roles: [role],
        statements: [new iam.PolicyStatement({
          sid: 'RoleObservabilityAlarmRead',
          effect: iam.Effect.ALLOW,
          actions: ALARM_READ_ACTIONS,
          resources: alarmArns(scope, prefixes),
          conditions: { StringEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: observers } },
        })],
      });
    }
    // WHICH ALARMS THOSE ARE, as the stacks publish them (`publishAlarmNames`). `GetParametersByPath`
    // authorizes against the requested path itself, recursive or not.
    observability.addStatements(new iam.PolicyStatement({
      sid: 'RoleObservabilityAlarmNames',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParametersByPath'],
      resources: [`arn:${here.partition}:ssm:${here.region}:${here.account}:parameter${alarmNamesPathOf(SSM_ROOT)}`],
      conditions: { StringEquals: { [`aws:PrincipalTag/${SESSION_TAG.role}`]: observers } },
    }));
  }
  return { role, boundary };
}

/** Message-write actions blocked on an archived channel (read-only enforcement). */
export const ARCHIVE_DENIED_ACTIONS = new Set<string>([
  'chime:SendChannelMessage',
  'chime:UpdateChannelMessage',
]);

/**
 * SPEC-CONVERSATION-ARCHIVE (ADR-017) read-only enforcement — a Deny on message
 * writes for any channel tagged `archived=true`. A Deny overrides the tag-gated
 * Allow, making an archived channel read-only by IAM (the AWS-documented
 * read-only-channel pattern, applied with the `archived` tag).
 *
 * NEVER attach this to the admin plane / app-instance-admin bearer: that
 * principal posts the archive system message and must stay exempt. A Deny is
 * global for the principal, so it is scoped to `archived=true` channels only and
 * affects no other channel. `classificationChannelScopedAllow` attaches it automatically
 * for any send/update grant; the admin role does not go through that function,
 * so it is exempt by construction.
 */
export function archivedChannelReadOnlyDeny(appInstanceArn: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DenyWriteOnArchivedChannel',
    effect: iam.Effect.DENY,
    actions: [...ARCHIVE_DENIED_ACTIONS],
    resources: [`${appInstanceArn}/channel/*`],
    conditions: {
      StringEquals: { 'aws:ResourceTag/archived': 'true' },
    },
  });
}

/**
 * Instance namespace — lets MULTIPLE AgentEchelon deployments coexist in ONE
 * AWS account (e.g. upstream `agent-echelon` + a host's instance like `acme`)
 * without colliding on stack names, SSM paths, the AppInstance, buckets, etc.
 *
 * Sourced from the `AE_INSTANCE_NAME` **env var** (NOT CDK context) because this
 * module's constants are evaluated at import time, before bin's context reads run.
 * Default `agent-echelon` keeps the upstream/original names unchanged. Set
 * `AE_INSTANCE_NAME=acme` (+ the matching `instanceName` context in bin, which
 * derives the stack-ID prefix + AppInstance name + tags from the same value).
 */
export const INSTANCE_NAME = (process.env.AE_INSTANCE_NAME || 'agent-echelon').trim();
/** SSM root for this instance, e.g. `/agent-echelon` or `/acme`. */
export const SSM_ROOT = `/${INSTANCE_NAME}`;

/** Whether this is the upstream/default instance (names preserved unchanged). */
export const IS_DEFAULT_INSTANCE = INSTANCE_NAME === 'agent-echelon';

/** `acme` → `Acme`. Used to derive the CloudFormation stack-ID prefix. */
function pascal(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * CloudFormation stack-ID prefix — the PascalCase form of the instance name.
 * The default instance yields `AgentEchelon` (`AgentEchelonConversations`,
 * `AgentEchelonAssistants-basic`, …); a host instance gets its own PascalCase prefix
 * (`acme` → `Acme…`), so two instances never update each other's stacks.
 * Override with `AE_STACK_PREFIX`.
 */
export const STACK_PREFIX = process.env.AE_STACK_PREFIX || pascal(INSTANCE_NAME);

/**
 * Prefix for `agent-echelon-*` PHYSICAL resource names (guardrails, fixed-name
 * Lambdas/log-groups, pool/API display names). Equals the instance name, so the
 * default stays `agent-echelon-*` and a host instance becomes `${name}-*`.
 */
export const RES_PREFIX = INSTANCE_NAME;

/**
 * The ownership function's name, fixed so a provisioner can ask it to seed a bot it just created
 * without importing anything from the stack that owns it (SPEC-ADMIN-CONSOLE FR47).
 */
export const ASSISTANT_OWNERSHIP_FUNCTION_NAME = `${RES_PREFIX}-assistant-ownership`;

/**
 * The provisioner's name (`lib/constructs/assistant-provisioner.ts`), fixed so each caller's grant names it without
 * a reference to the core stack that owns it: `manage-assistants` and every stack's seed (ADR-048, amended
 * 2026-10-24).
 */
export const ASSISTANT_PROVISIONER_FUNCTION_NAME = `${RES_PREFIX}-assistant-provisioner`;

/**
 * The tag that records which team owns an assistant. Only the ownership function may write it, so
 * every other `chime:TagResource` grant carries {@link EXCLUDE_OWNER_TEAM_TAG}.
 */
export const OWNER_TEAM_TAG = 'owner-team';

/**
 * The condition every `chime:TagResource` / `chime:UntagResource` grant except the ownership
 * function's carries: the request may name any tag key but `owner-team`. Merged into a statement's
 * existing conditions; `every-tag-grant-excludes-ownership.test.ts` refuses a grant without it.
 */
export const EXCLUDE_OWNER_TEAM_TAG = { 'ForAllValues:StringNotEquals': { 'aws:TagKeys': [OWNER_TEAM_TAG] } } as const;

/**
 * Prefix for the analytics data-plane physical names (Kinesis streams, Firehose
 * delivery streams + log groups, the S3 archive buckets, the Athena workgroup) —
 * all account/region- or globally-unique, so they MUST differ per instance.
 * Equals the instance name (`agent-echelon` by default), so two instances never
 * collide.
 */
export const ANALYTICS_PREFIX = INSTANCE_NAME;

/** The Chime AppInstance display name for this instance. */
export const APP_INSTANCE_NAME = INSTANCE_NAME;

/** The Athena workgroup name for this instance (account/region-unique). */
export const ATHENA_WORKGROUP_NAME = `${ANALYTICS_PREFIX}-analytics`;

/**
 * The Glue/Athena database name for this instance. Underscores (Athena/Glue
 * identifiers can't contain dashes), and account/region-scoped so two instances
 * never share a catalog database (a shared name would be a multi-deploy
 * collision). `agent-echelon` → `agent_echelon`; `acme` → `acme`.
 */
export const ANALYTICS_DB_NAME = ANALYTICS_PREFIX.replace(/-/g, '_');

/**
 * The platform's shared SSM contract — published by the feature stacks
 * (AgentEchelonConversations, AgentEchelonExperiments, AgentEchelonBattle) and
 * resolved by Standard/Premium classifications at deploy time via
 * `valueForStringParameter` (a dynamic SSM ref, NOT Fn::importValue). Basic
 * does not need any of these — it has no tasks, no /battle.
 * **All paths derive from SSM_ROOT — never hardcode `/agent-echelon/...`.**
 */
export const SHARED_SSM = {
  agentTasksArn: `${SSM_ROOT}/shared/tables/agent-tasks-arn`,
  agentTasksName: `${SSM_ROOT}/shared/tables/agent-tasks-name`,
  userTasksArn: `${SSM_ROOT}/shared/tables/user-tasks-arn`,
  userTasksName: `${SSM_ROOT}/shared/tables/user-tasks-name`,
  // Per-user profile store (durable per-END-USER record: onboarded flag + collected facts). The
  // built-in table is a reference stand-in an implementer can swap for their own profile service via
  // USER_PROFILE_SERVICE_ARN. See SPEC-USER-PROFILE-AND-ONBOARDING.md.
  userProfileArn: `${SSM_ROOT}/shared/tables/user-profile-arn`,
  userProfileName: `${SSM_ROOT}/shared/tables/user-profile-name`,
  // The customer managed key the `claims` directory's contact copies are encrypted with (C5), published
  // only when the trusted-issuer registry declares an issuer with `directory: 'claims'`.
  contactCopyKeyArn: `${SSM_ROOT}/shared/keys/contact-copy-arn`,
  // Channel Context store (server-only private host grounding: participant profile, domain context,
  // extra contexts, display name), keyed by channelArn. Written by the create Lambdas, read only by
  // the assistant handler. NOT member-readable (contrast channel Metadata). See channel-context-client.
  channelContextArn: `${SSM_ROOT}/shared/tables/channel-context-arn`,
  channelContextName: `${SSM_ROOT}/shared/tables/channel-context-name`,
  // Abuse-controls control plane (dedup / spend budget / rate limit). SPEC-ABUSE-CONTROLS.
  // Turn state: which turn is answering a conversation, and what waits behind it (ADR-033).
  // A SEPARATE table from abuse controls on purpose - see the construct in conversations-stack.
  turnStateArn: `${SSM_ROOT}/shared/tables/turn-state-arn`,
  turnStateName: `${SSM_ROOT}/shared/tables/turn-state-name`,
  // Releases a turn lock whose invocation the platform killed, wired as the per-classification
  // AsyncProcessor's onFailure destination. It lives with the rest of the turn-state capability
  // rather than once per profile: one owner for stranded-lock recovery, one place to fix it.
  abuseControlsArn: `${SSM_ROOT}/shared/tables/abuse-controls-arn`,
  abuseControlsName: `${SSM_ROOT}/shared/tables/abuse-controls-name`,
  battleStateArn: `${SSM_ROOT}/shared/tables/battle-state-arn`,
  battleStateName: `${SSM_ROOT}/shared/tables/battle-state-name`,
  experimentsArn: `${SSM_ROOT}/shared/tables/experiments-arn`,
  experimentsName: `${SSM_ROOT}/shared/tables/experiments-name`,
  channelBattleConfigName: `${SSM_ROOT}/shared/tables/channel-battle-config-name`,
  // BattleOutcome (user head-to-head picks). Published by AgentEchelonBattle; consumed
  // at deploy time by AgentEchelonArchive for the per-variant battle-wins
  // join. Only the name is needed (the analytics Lambda scans it); IAM is
  // name-pattern-scoped, so the ARN param is unused today.
  battleOutcomeName: `${SSM_ROOT}/shared/tables/battle-outcome-name`,
  battleOutcomeArn: `${SSM_ROOT}/shared/tables/battle-outcome-arn`,
  battleOrchestratorArn: `${SSM_ROOT}/shared/battle-orchestrator-arn`,
  // Cognito user-pool id — standard/premium classifications run the per-classification handler
  // (router code) which does per-message classification enforcement (min(senderClearance,
  // channelClassification)) via AdminListGroupsForUser.
  cognitoUserPoolId: `${SSM_ROOT}/shared/cognito-user-pool-id`,
  // The Identities index ((issuer, subject) -> AppInstanceUser ARN), published by Identity beside the
  // exchange that is its only writer. Read by the resolver; see lambda/src/lib/person-identity.ts.
  identitiesName: `${SSM_ROOT}/shared/tables/identities-name`,
  identitiesArn: `${SSM_ROOT}/shared/tables/identities-arn`,
  // Aurora data-plane Lambda ARN. Published by AgentEchelonArchive;
  // consumed at RUNTIME (not deploy — that would be a circular stack dependency,
  // since the Aurora stack already depends on Identity's user pool) by the
  // admin-conversations handler to read conversations from Aurora instead of the
  // slow Athena archive (BUG #21). Absent in Athena mode.
  auroraDataPlaneArn: `${SSM_ROOT}/shared/analytics/data-plane-arn`,
  // WHAT A CLASSIFICATION'S OWN FUNCTIONS IN THE ARCHIVE'S VPC ARE BUILT ON (Aurora mode, `ClassificationArchiveFunctions`):
  // the data plane's subnets (comma-joined) and security group, the database host, and the IAM-auth resource ids of
  // the cluster and of the proxy where one runs. Published by Archive, read by each `Assistants-<classification>` at deploy.
  auroraDataPlaneSubnetIds: `${SSM_ROOT}/shared/analytics/data-plane-subnet-ids`,
  auroraDataPlaneSecurityGroupId: `${SSM_ROOT}/shared/analytics/data-plane-security-group-id`,
  auroraDbHost: `${SSM_ROOT}/shared/analytics/db-host`,
  auroraDbClusterResourceId: `${SSM_ROOT}/shared/analytics/db-cluster-resource-id`,
  auroraDbProxyResourceId: `${SSM_ROOT}/shared/analytics/db-proxy-resource-id`,
  // THE DETECTOR THE DE-IDENTIFIED COPY IS MADE WITH (`lib/config/deidentify-guardrail.ts`), published by Archive and
  // read by each classification's golden run at deploy, so an uploaded golden entry is de-identified by the same
  // guardrail as a conversation (ADR-065 decision 7).
  deidentifyGuardrailId: `${SSM_ROOT}/shared/analytics/deidentify-guardrail-id`,
  deidentifyGuardrailVersion: `${SSM_ROOT}/shared/analytics/deidentify-guardrail-version`,
  deidentifyGuardrailArn: `${SSM_ROOT}/shared/analytics/deidentify-guardrail-arn`,
  // The attachments bucket ARN, published by the Conversations stack that owns the bucket. Read at
  // RUNTIME by the credential exchange (for the attachment-read session policy) and by offboarding,
  // both in the Identity stack, which deploys before Conversations. A stack that deploys after
  // Conversations takes the bucket by reference instead.
  attachmentsBucketArn: `${SSM_ROOT}/shared/attachments-bucket-arn`,
  // The token store (A8): every single-use or bounded token, keyed `<kind>#<sha256>`, in Conversations.
  // Read at RUNTIME by the credential exchange, in Identity, for the guest refresh credential.
  tokensName: `${SSM_ROOT}/shared/tables/tokens-name`,
  tokensArn: `${SSM_ROOT}/shared/tables/tokens-arn`,
  // The person API's base URL, published by PersonApi. Read at RUNTIME by the email senders, which deploy
  // before it, for the preference link every stoppable email carries (B9).
  personApiUrl: `${SSM_ROOT}/shared/person-api-url`,
} as const;

/**
 * THE GUEST ISSUER'S KILL SWITCH (L16): an SSM parameter under `SSM_ROOT`, per guest issuer. Its value is
 * JSON, `{ "paused": boolean, "changedBy": string, "changedAt": string, "reason"?: string }`, written by
 * `scripts/guest-switch.mjs` with the caller's identity; SSM's own parameter history records the IAM
 * principal of every change as well. Guest start and guest refresh refuse with `paused` while it is on,
 * and with `unavailable` when it cannot be read.
 */
export const guestKillSwitchParameter = (issuerId: string): string => `${SSM_ROOT}/guest/${issuerId}/paused`;

/** Per-instance SSM keys used across stacks (the admin ARN, the assignment records). */
export const INSTANCE_SSM = {
  appInstanceAdminArn: `${SSM_ROOT}/app-instance-admin-arn`,
  /**
   * WHICH ASSISTANT HOLDS A ROLE - the authority for "which assistant is live", and the thing a
   * reader resolves through instead of building a key out of a classification
   * (DESIGN-SEPARATE-ASSISTANTS section 3.0).
   *
   * ONE KEY PER ENTRY RATHER THAN ONE ROSTER, because the entries are written by different writers: a
   * classification stack owns its live and alt records, `admin-experiments` writes the alt's assistant name,
   * and `manage-assistants` writes a runtime assistant's. A single JSON roster would make them race to
   * own one parameter, which is the shape
   * `adminNotificationChannelArn` records as having cost four deploys in the export form of the same
   * mistake. A reader wanting all of them uses `GetParametersByPath`.
   *
   * THE ASSISTANT IS NAMED, NOT THE CLASSIFICATION. `/assistant/{name}/…` already keys the write path
   * and the admin assistant already uses it (`admin-agent`, which is why the key above is name-shaped);
   * the three conversational classifications currently have a profile named the same as the
   * classification, so the two coincide and the collision is invisible until a second assistant
   * appears. Resolving through the assignment is what stops that coincidence being load-bearing.
   */
  assistantAssignment: (classification: string, role: string, occupancy: string) =>
    `${SSM_ROOT}/assistant-assignments/${classification}/${role}/${occupancy}`,
  /**
   * The admin assistant's AppInstanceBot ARN (DESIGN-ADMIN-AGENT-NOTIFICATIONS).
   *
   * Under the `assistant/{name}` prefix every profile's parameters use, because the admin assistant IS a
   * profile - the path says so rather than the code saying so somewhere else. Published by the
   * `AdminServices` stack, whose alert poster bears this identity rather than the service
   * app-instance-admin; read by operator scripts and the e2e suite. No other stack reads it.
   */
  adminAgentBotArn: `${SSM_ROOT}/assistant/admin-agent/bot-arn`,
  /**
   * The admin notification channel ARN, published by the `AdminServices` stack for operator scripts and
   * the e2e suite.
   *
   * NO STACK READS IT, which is the whole point. As a CloudFormation export imported by other stacks the
   * channel became immutable: CloudFormation refuses to let an in-use export change its name, change its
   * value, or be dropped by its producer. Every alert reaches the channel as an `ae.alert` event that
   * the `AdminServices` stack itself posts (`alertEmitterWiring`), so the channel is that stack's alone.
   */
  adminNotificationChannelArn: `${SSM_ROOT}/admin-notification/channel-arn`,
} as const;

/**
 * Wire the abuse-controls plane (SPEC-ABUSE-CONTROLS) into a classification's handler + processor. Returns
 * the env + an IAM grant on the shared control table. Request DEDUP is active whenever the table
 * is present (which it always is here) - it fixes the duplicate-fulfillment task clobber and is
 * always safe.
 *
 * THE SPEND LIMIT IS ON BY DEFAULT (maintainer, 2026-08-30), and it used to be opt-in. Opt-in was the
 * wrong default for the same reason an unset flag is never a safe one: the limits defaulted to 0,
 * the runtime reads 0 as "not configured" and allows everything, and the two flags that would have
 * turned them on were not even discoverable - they are read through the `ctxNum` wrapper below, so
 * the guard that lists every context flag could not see them and the example never documented them.
 * A deployment following the README therefore ran with NO bound on model spend, which is not a
 * default anyone would choose deliberately.
 *
 * The numbers are counts of dispatched model TURNS per rolling hour. They are set to bound a
 * runaway rather than to ration ordinary use: a real deployment should name its own with
 * `-c bedrockGlobalHourlyBudget=N -c bedrockUserHourlyBudget=N`, and an EXPLICIT 0 remains the
 * documented way to turn a limit off, so this is a safer default rather than a decision taken
 * away. Setting the global one also wires the circuit-trip param, so edge load-shedding follows it.
 *
 * Spread `env` on both the handler (runs the budget check) and the processor (runs the dedup
 * claim), and grant both.
 */
/**
 * Turn state: one turn at a time per responder per conversation (ADR-033).
 *
 * SEPARATE FROM `abuseControlsWiring`, deliberately, even though both hand a Lambda a generic pk+ttl
 * table. The abuse controls include a spend budget that FAILS SAFE - a table error becomes "over
 * budget" and blocks the turn, so a control-plane outage can never become unbounded spend. This one
 * FAILS OPEN, because a lock that cannot be read must never silence a conversation. Two opposite
 * policies on one table is how a queue bug becomes a spend-limit outage.
 *
 * OFF BY DEFAULT. `-c turnQueue=true` enables it. The env var is what the runtime reads, so the
 * feature can be switched off from configuration rather than by rolling back code that is already
 * deployed - which matters for a check on the critical path of every turn.
 */
export function turnQueueWiring(
  scope: Construct,
  turnStateArn: string,
  turnStateName: string,
): { env: Record<string, string>; grant: (role: iam.IRole) => void } {
  const flag = scope.node.tryGetContext('turnQueue');
  const enabled = flag === true || flag === 'true';
  const maxCtx = scope.node.tryGetContext('turnQueueMax');
  const env: Record<string, string> = {
    TURN_STATE_TABLE: turnStateName,
    TURN_QUEUE_ENABLED: enabled ? '1' : '0',
    ...(maxCtx ? { TURN_QUEUE_MAX: String(maxCtx) } : {}),
  };
  const grant = (role: iam.IRole): void => {
    // The table is granted whether or not the flag is on: the grant is what makes ENABLING it a
    // config change rather than a redeploy, which is the point of a runtime switch.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Conditional UpdateItem for the claim, the queue append and the release; GetItem for the
        // holder read and for the state a client renders.
        actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
        resources: [turnStateArn],
      }),
    );
  };
  return { env, grant };
}

/**
 * The abuse-controls environment and grant for one function. `wiredFor` names the function in a synthesis
 * error only (a classification stack passes its classification, the shared channel flow its own name); the
 * wiring is the same for every caller.
 */
export function abuseControlsWiring(
  scope: Construct,
  abuseControlsArn: string,
  abuseControlsName: string,
  wiredFor: string,
  region: string,
  account: string,
): { env: Record<string, string>; grant: (role: iam.IRole) => void } {
  const ctxNum = (k: string, dflt = '0'): string => {
    const v = scope.node.tryGetContext(k);
    return v === undefined || v === null ? dflt : String(v);
  };
  const cannedCtx = scope.node.tryGetContext('budgetCannedResponse');
  // Circuit-trip SSM param (edge-shedding signal). One shared per-instance param; flipped when the
  // global model-call count crosses the trip threshold. Wired only when a global budget is set
  // (the trip is meaningless otherwise); the grant + env follow the same condition.
  // ON BY DEFAULT. A runaway is bounded at this many model turns an hour instead of by nothing;
  // an explicit 0 still switches it off for a deployment that means to.
  const globalBudget = ctxNum('bedrockGlobalHourlyBudget', '500');
  const circuitParamName = `${SSM_ROOT}/abuse/circuit`;
  const wireCircuit = parseInt(globalBudget, 10) > 0;
  // THE LIMITS FAIL CLOSED, so a wiring without the table would refuse every turn at runtime. The spend
  // budgets are set here, and the rate limit is set per assistant (`rateLimitPerHour`) and read at
  // runtime, so a limit can apply to every function this wires. Refused at synthesis instead.
  if (!abuseControlsName) {
    throw new Error(`abuseControlsWiring(${wiredFor}): the abuse-controls table name is empty, and the rate limit and the spend budgets refuse every call without it`);
  }
  const env: Record<string, string> = {
    ABUSE_CONTROLS_TABLE: abuseControlsName,
    BEDROCK_USER_HOURLY_BUDGET: ctxNum('bedrockUserHourlyBudget', '100'),
    BEDROCK_GLOBAL_HOURLY_BUDGET: globalBudget,
    // Rate limit moved to the profile config (profiles.ts rateLimitPerHour), read at runtime
    // by the router — no longer a per-classification env var / -c rateLimit<Classification> knob.
    // Inbound length cap. Defaulted generously (16000 chars ~ 4k tokens) rather than CH's 2000:
    // CH is a portfolio widget, AE is an enterprise assistant where report/extraction prompts and
    // pasted content are legitimately long, so a 2000 cap would degrade real use (superset tenet).
    // Bounds egregious abuse; -c maxUserMessageLength overrides, 0 disables.
    MAX_USER_MESSAGE_LENGTH: ctxNum('maxUserMessageLength', '16000'),
    ...(wireCircuit
      ? { ABUSE_CIRCUIT_PARAM: circuitParamName, ABUSE_CIRCUIT_TRIP_THRESHOLD: ctxNum('bedrockCircuitTripThreshold', globalBudget) }
      : {}),
    ...(cannedCtx ? { BUDGET_CANNED_RESPONSE: String(cannedCtx) } : {}),
    // Admin exemption (SPEC-ABUSE-CONTROLS "Identity and exemptions"): OPT-IN, default off. When on, the
    // router exempts senders in a trusted admin group from the per-user rate limit + per-user budget
    // (never the global budget, which always protects the account). Group list overridable, defaults
    // to `admins`. -c abuseExemptAdmins=true [-c abuseExemptAdminGroups=admins,staff].
    ...(scope.node.tryGetContext('abuseExemptAdmins') === 'true' || scope.node.tryGetContext('abuseExemptAdmins') === true
      ? {
          ABUSE_EXEMPT_ADMINS: 'true',
          ABUSE_EXEMPT_ADMIN_GROUPS: (scope.node.tryGetContext('abuseExemptAdminGroups') as string) || 'admins',
        }
      : {}),
  };
  const grant = (role: iam.IRole): void => {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // dedup = conditional PutItem; budget + rate-limit counters = UpdateItem. GetItem reserved.
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
        resources: [abuseControlsArn],
      }),
    );
    if (wireCircuit) {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:PutParameter'],
          resources: [`arn:aws:ssm:${region}:${account}:parameter${circuitParamName}`],
        }),
      );
    }
  };
  return { env, grant };
}

/**
 * WHAT A CORE FUNCTION NEEDS TO RAISE AN ALERT (`lambda/src/lib/admin-notice.ts`): `events:PutEvents` on
 * the account's default bus, for the `ae.alert` source and no other, and the instance name the event
 * carries. The core never names the admin channel and holds no message send for it: the `AdminServices`
 * stack, present with the `admin` capability, owns the one rule that posts these events into the admin
 * notification channel. Without it the event is delivered nowhere and the log line is the record.
 */
export function alertEmitterWiring(scope: Construct): { env: Record<string, string>; grant: (role: iam.IRole) => void } {
  const stack = cdk.Stack.of(scope);
  const env: Record<string, string> = { ALERT_INSTANCE: INSTANCE_NAME };
  const grant = (role: iam.IRole): void => {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${stack.region}:${stack.account}:event-bus/default`],
      conditions: { StringEquals: { 'events:source': [ALERT_SOURCE] } },
    }));
  };
  return { env, grant };
}

/** The source every platform alert carries on the default bus, which the `AdminServices` rule matches. */
export const ALERT_SOURCE = 'ae.alert';

/**
 * What a platform service needs to SPEAK AS AN ASSISTANT of these classifications outside a user turn
 * (a scheduled briefing, a join notice, a Battle Mode notice): record the decision in the
 * classification's routing table, read where its vend is, and invoke only the vend. The vend then mints
 * a session tagged for the one assistant the record names, so the service itself holds no Amazon Chime
 * SDK bearer grant at all (`sessionForRoutedAssistant` in `lambda/src/lib/assistant-session.ts`).
 */
/** The environment `messagingClientAsAssistant` reads, beside `speakAsAssistantStatements`. */
export function speakAsAssistantEnv(): Record<string, string> {
  return { TURN_ROUTING_TABLE_PREFIX: `${RES_PREFIX}-turn-routing-`, SSM_ROOT };
}

/**
 * ONLY SPEAK ROUTES (Phase 1c). The condition a shared service's routing-table write carries: every key it
 * writes must start with the speak prefix, so the vend can only ever give it the speak edge. A turn record
 * is written by the classification's own router and nothing else.
 */
export const SPEAK_ROUTES_ONLY = { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${SPEAK_ROUTE_PREFIX}*`] } };

/**
 * WHAT `primaryAssistantOf` AND `primaryAssignmentOf` READ (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8): a room's
 * tags, for its classification and its `primaryAssistant`, and the classifications' assignment records, the
 * authority on which assistant holds which role. Reads only.
 *
 * A per-classification role reads its own classification's records; a shared one (`EVERY_CLASSIFICATION`)
 * reads every classification's under one path wildcard, so a classification added or removed changes nothing.
 */
export function roomPrimaryReadStatements(scope: cdk.Stack, classifications: ClassificationScope): iam.PolicyStatement[] {
  const { region, account } = scope;
  const assignments = `arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/assistant-assignments`;
  return [
    new iam.PolicyStatement({
      sid: 'ReadTheRoomsTags',
      actions: ['chime:ListTagsForResource'],
      resources: [`arn:aws:chime:${region}:${account}:app-instance/*/channel/*`],
    }),
    new iam.PolicyStatement({
      sid: 'ReadWhichAssistantHoldsEachRole',
      actions: ['ssm:GetParametersByPath', 'ssm:GetParameter'],
      resources: classifications === EVERY_CLASSIFICATION
        ? [`${assignments}/*`]
        : classifications.flatMap((c) => [`${assignments}/${c}`, `${assignments}/${c}/*`]),
    }),
  ];
}

/**
 * WHAT READING ONE CLASSIFICATION'S MESSAGE TEMPLATES TAKES (ADR-062 decision 2, `loadMessageTemplateSet`): its
 * templates under `templates/<classification>/`, the pointers that say which version of each is active, and the list
 * of which templates each family holds. Read-only, this classification's prefix and no other's. Held by every role
 * that says or words something for a room of the classification: its router, and its creators, which name a room from
 * the `conversation-name` template.
 */
export function messageTemplateReadStatements(scope: cdk.Stack, bucketArn: string, classification: string): iam.PolicyStatement[] {
  const { region, account } = scope;
  return [
    new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${bucketArn}/${templatePrefix(classification)}*`],
    }),
    new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${templatePointerPath(SSM_ROOT, classification)}/*`],
    }),
    new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${templatePrefix(classification)}*`] } },
    }),
  ];
}

/**
 * THE TURN-ROUTING TABLES `scope` reaches: a per-classification role's own tables by name, or every
 * classification's by the name pattern, bounded to this instance by its `Instance` tag (a pattern that starts
 * with the instance prefix also matches an instance whose prefix starts with this one).
 */
function turnRoutingTables(scope: cdk.Stack, classifications: ClassificationScope): { resources: string[]; conditions: Record<string, unknown> } {
  const { region, account } = scope;
  if (classifications === EVERY_CLASSIFICATION) {
    return {
      resources: [`arn:aws:dynamodb:${region}:${account}:table/${turnRoutingTableName('*')}`],
      conditions: { ...SPEAK_ROUTES_ONLY, StringEquals: { [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME } },
    };
  }
  return {
    resources: classifications.map((c) => `arn:aws:dynamodb:${region}:${account}:table/${turnRoutingTableName(c)}`),
    conditions: SPEAK_ROUTES_ONLY,
  };
}

export function speakAsAssistantStatements(
  scope: cdk.Stack,
  classifications: ClassificationScope,
): iam.PolicyStatement[] {
  const { region, account } = scope;
  const tables = turnRoutingTables(scope, classifications);
  return [
    new iam.PolicyStatement({
      sid: 'RecordWhichAssistantSpeaks',
      actions: ['dynamodb:PutItem'],
      resources: tables.resources,
      conditions: tables.conditions,
    }),
    new iam.PolicyStatement({
      sid: 'FindTheClassificationsVend',
      actions: ['ssm:GetParameter'],
      resources: classifications === EVERY_CLASSIFICATION
        ? [`arn:aws:ssm:${region}:${account}:parameter${vendArnKey('*')}`]
        : classifications.map((c) => `arn:aws:ssm:${region}:${account}:parameter${vendArnKey(c)}`),
    }),
    new iam.PolicyStatement({
      sid: 'AskTheVendForASession',
      actions: ['lambda:InvokeFunction'],
      // Name-pattern scoped, because the vend's generated name is unknown to a stack in another app, and
      // scoped by the tags (`ownInstanceFunctions`): this instance's functions, of the classifications the
      // caller serves. The pattern names only the instance prefix and the construct id, because
      // CloudFormation shortens the stack-name part of a generated function name.
      resources: [`arn:aws:lambda:${region}:${account}:function:${STACK_PREFIX}*AssistantVend*`],
      conditions: ownInstanceFunctions(classifications),
    }),
    // WHO SPEAKS FOR THE ROOM (§3.8): `primaryAssistantOf` reads the room's tags and the assignment records.
    ...roomPrimaryReadStatements(scope, classifications),
  ];
}

/**
 * SSM keys this classification PUBLISHES — read by create-conversation (per-classification bot member)
 * and the classification's own handler/processor. There is no shared-bot key; every classification
 * owns its own bot.
 */
/**
 * THE TABLE A TURN'S ROUTING RECORD LIVES IN, one per classification. Named rather than generated so
 * the battle stack, which routes duel rounds, can address it without a cross-stack reference.
 */
export function turnRoutingTableName(classification: string): string {
  return `${RES_PREFIX}-turn-routing-${classification}`;
}

export function botArnKey(classification: Classification): string {
  return `${SSM_ROOT}/assistant/${classification}/bot-arn`;
}
export function processorArnKey(classification: Classification): string {
  return `${SSM_ROOT}/assistant/${classification}/processor-arn`;
}
/** The classification's router/AgentHandler (Lex fulfillment) Lambda ARN — surfaced for the admin console's
 *  classification-level troubleshooting deep links (SPEC-ASSISTANT-CONFIG). */
/**
 * WHAT A SERVICE NEEDS TO NAME A NOTICE: invoke on the routers of these classifications, and the environment
 * `resolveRouterArn` reads (`lib/say-through-router.ts`). Nothing to speak with: no vend, no routing-table
 * write, no send.
 *
 * BY NAME, AT CALL TIME. The function reads each classification's own `router-arn` parameter when it needs it
 * (`ROUTER_ARN_PARAM_ROOT`), so a stack that names notices takes no deploy-time value from the classification
 * stacks and may deploy before them or without any one of them. The invoke is granted by the construct id the
 * classification stacks give their router, scoped to this account and region and to THIS instance's functions
 * by their tags (`ownInstanceFunctions`): a per-classification caller names its own classification, a shared
 * one (`EVERY_CLASSIFICATION`) any function that carries a classification. The router still validates every
 * notice.
 */
export function sayThroughRouterWiring(
  scope: Construct,
  classifications: ClassificationScope,
  opts: { resolvesPrimary?: boolean } = {},
): { env: Record<string, string>; statements: iam.PolicyStatement[] } {
  const stack = cdk.Stack.of(scope);
  const conversational = classifications === EVERY_CLASSIFICATION
    ? EVERY_CLASSIFICATION
    : classifications.filter((c) => profiles.isConversational(c));
  return {
    env: routerByNameEnvironment(),
    statements: [
      ...routerByNameStatements(stack, conversational, 'NameANoticeToTheRouter'),
      // A caller that names the room's primary as the notice's assistant resolves it first
      // (`primaryAssistantOf`), which reads the room's tags and the assignment records.
      ...(opts.resolvesPrimary === false ? [] : roomPrimaryReadStatements(stack, classifications)),
    ],
  };
}

/** The environment a function that finds a classification's router by name reads (`resolveRouterArn`). */
export function routerByNameEnvironment(): Record<string, string> {
  return { ROUTER_ARN_PARAM_ROOT: `${SSM_ROOT}/assistant` };
}

/**
 * INVOKE A CLASSIFICATION'S ROUTER, FOUND BY NAME AT CALL TIME: read its `router-arn` parameter and invoke the
 * function it names. The parameter read is the classification's own key, or every classification's under a
 * path wildcard; the invoke is the router's construct id, bounded to this instance's functions of `scope`.
 */
export function routerByNameStatements(stack: cdk.Stack, scope: ClassificationScope, sid = 'InvokeTheRouter'): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}*-AgentHandler*`],
      conditions: ownInstanceFunctions(scope),
    }),
    new iam.PolicyStatement({
      sid: 'ReadTheRouterByName',
      actions: ['ssm:GetParameter'],
      resources: (scope === EVERY_CLASSIFICATION ? ['*'] : scope).map((c) => cdk.Arn.format(
        { service: 'ssm', resource: 'parameter', resourceName: routerArnKey(c).replace(/^\//, '') },
        stack,
      )),
    }),
  ];
}

/** The environment a function that finds a classification's task service by name reads (`resolveTaskServiceArn`). */
export function taskServiceByNameEnvironment(): Record<string, string> {
  return { TASK_SERVICE_ARN_PARAM_ROOT: `${SSM_ROOT}/assistant` };
}

/**
 * INVOKE A CLASSIFICATION'S TASK SERVICE, FOUND BY NAME AT CALL TIME, the same shape as the router's: its
 * `task-service-arn` parameter, and the service's construct id bounded to this instance's functions of `scope`.
 */
export function taskServiceByNameStatements(stack: cdk.Stack, scope: ClassificationScope): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'InvokeTheTaskService',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}*-TaskService*`],
      conditions: ownInstanceFunctions(scope),
    }),
    new iam.PolicyStatement({
      sid: 'ReadTheTaskServiceByName',
      actions: ['ssm:GetParameter'],
      resources: (scope === EVERY_CLASSIFICATION ? ['*'] : scope).map((c) => cdk.Arn.format(
        { service: 'ssm', resource: 'parameter', resourceName: taskServiceArnKey(c).replace(/^\//, '') },
        stack,
      )),
    }),
  ];
}

/**
 * THIS INSTANCE'S FUNCTIONS OF THESE CLASSIFICATIONS, for an invoke granted by a name pattern because the
 * ARNs do not exist when the granting stack deploys. A name pattern alone reaches every instance deployed
 * in the account: CloudFormation truncates the stack-name part of a generated function name, so the
 * instance prefix is not reliably in it. The tags are: every resource carries the app-level `Instance`
 * tag (`applyStandardTags`) and a classification stack's resources its `classification` tag
 * (`AssistantsStack`), and Lambda evaluates `aws:ResourceTag` on `InvokeFunction`. An untagged
 * function matches neither, so the grant fails closed.
 *
 * A per-classification caller names its own classifications. A shared one passes `EVERY_CLASSIFICATION`: any
 * function of this instance that carries a `classification` tag, so the grant names no list.
 */
export function ownInstanceFunctions(classifications: ClassificationScope): Record<string, unknown> {
  if (classifications === EVERY_CLASSIFICATION) {
    return { ...ownInstanceFunctionsOnly(), ...anyClassificationTagged() };
  }
  return {
    StringEquals: {
      [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME,
      [CLASSIFICATION_TAG]: [...new Set(classifications)],
    },
  };
}

/**
 * THIS INSTANCE'S FUNCTIONS, for an invoke granted by a name pattern on a function that belongs to no
 * classification (the Aurora data plane, an assistant's name applier reached across classifications).
 * A pattern that starts with the instance prefix still matches an instance whose prefix starts with
 * this one (`AgentEchelon` and `AgentEchelonTwo`), so the `Instance` tag is what bounds it.
 */
export function ownInstanceFunctionsOnly(): Record<string, Record<string, string>> {
  return { StringEquals: { [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME } };
}

export function routerArnKey(classification: Classification): string {
  return `${SSM_ROOT}/assistant/${classification}/router-arn`;
}
/**
 * The Lambda that puts an assistant's display name onto its identity (DESIGN-SEPARATE-ASSISTANTS 3.0).
 *
 * KEYED BY THE ASSISTANT, NOT THE CLASSIFICATION, unlike the three keys above. Those name
 * classification-level infrastructure - one processor, one router, one bot per classification - and
 * predate an assistant being a separate thing from the classification it serves. This names something
 * that belongs to ONE ASSISTANT, and a classification is about to hold several, so keying it by
 * classification would need renaming the moment a second assistant arrives. `manage-profiles` also
 * holds a profile name rather than a classification, so this is the lookup it can actually do.
 */
export function nameApplierArnKey(assistant: string): string {
  return `${SSM_ROOT}/assistant/${assistant}/name-applier-arn`;
}
/**
 * The classification's task-service Lambda ARN.
 *
 * Published for the ADMIN PLANE, which is a different stack and cannot hold a direct reference.
 * The operator console asks every classification about a conversation, because a channel belongs
 * to one and the console does not know which. Without this the admin task route resolved no
 * services at all and answered 503 to every request.
 */
export function taskServiceArnKey(classification: Classification): string {
  return `${SSM_ROOT}/assistant/${classification}/task-service-arn`;
}

/**
 * The classification's assistant vend ARN (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b), for a
 * declared speaker in another stack (arrival triage, `lib/config/speakers.ts`) that speaks as that
 * classification's assistants and cannot hold a direct reference.
 */
export function vendArnKey(classification: string): string {
  return `${SSM_ROOT}/assistant/${classification}/vend-arn`;
}

/**
 * Resolve the platform's ALWAYS-PRESENT shared SSM contract at deploy time (tasks tables, profile,
 * channel context, turn state, abuse controls and the Cognito pool id). Published by the required core
 * (Conversations, Identity), which every deployment stands up. Returns the dynamic SSM refs a stack's
 * roles and environment use.
 *
 * A DECLARED CAPABILITY'S RESOURCES ARE NOT HERE. The experiments table and the battle tables and
 * orchestrator belong to stacks that exist only when `experiments` or `battle` is declared, and those
 * stacks deploy after this one's consumers: a core stack names them by their fixed names
 * (`CAPABILITY_RESOURCES`, `experimentsResourcesOf`, `battleResourcesOf`) and never resolves them here.
 */
export function resolveSharedSSM(scope: Construct): {
  agentTasksArn: string;
  agentTasksName: string;
  userTasksArn: string;
  userTasksName: string;
  userProfileArn: string;
  userProfileName: string;
  channelContextArn: string;
  channelContextName: string;
  abuseControlsArn: string;
  turnStateArn: string;
  turnStateName: string;
  abuseControlsName: string;
  cognitoUserPoolId: string;
} {
  const v = (name: string) => ssm.StringParameter.valueForStringParameter(scope, name);
  return {
    agentTasksArn: v(SHARED_SSM.agentTasksArn),
    agentTasksName: v(SHARED_SSM.agentTasksName),
    userTasksArn: v(SHARED_SSM.userTasksArn),
    userTasksName: v(SHARED_SSM.userTasksName),
    userProfileArn: v(SHARED_SSM.userProfileArn),
    userProfileName: v(SHARED_SSM.userProfileName),
    channelContextArn: v(SHARED_SSM.channelContextArn),
    channelContextName: v(SHARED_SSM.channelContextName),
    turnStateArn: v(SHARED_SSM.turnStateArn),
    turnStateName: v(SHARED_SSM.turnStateName),
    abuseControlsArn: v(SHARED_SSM.abuseControlsArn),
    abuseControlsName: v(SHARED_SSM.abuseControlsName),
    // READ ONLY WHEN ASKED FOR. Identity publishes the pool id only when the registry declares an issuer on
    // this deployment's own pool (L15), and resolving a parameter that does not exist fails the deploy, so
    // a stack that never names the pool must not resolve it.
    get cognitoUserPoolId(): string {
      return v(SHARED_SSM.cognitoUserPoolId);
    },
  };
}

/**
 * THE NAMES A CAPABILITY'S RESOURCES ARE GIVEN, FIXED, SO A CORE STACK NAMES THEM WITHOUT REFERENCING THEIR
 * STACK (STACKS.md, additivity).
 *
 * The experiments table belongs to `Experiments`, and the battle tables and the battle orchestrator to
 * `Battle`. Those stacks deploy AFTER the assistant stacks and the channel flow and attach their own grants to
 * those stacks' roles, so declaring the capability changes a core stack in one way only: the environment of
 * the functions that use it, which is told the name. A name known at synth needs no reference to the stack
 * that creates it, and a reference would make the core deploy after the capability.
 */
export const CAPABILITY_RESOURCES = {
  experimentsTable: `${RES_PREFIX}-experiments`,
  battleStateTable: `${RES_PREFIX}-battle-state`,
  channelBattleConfigTable: `${RES_PREFIX}-channel-battle-config`,
  battleOutcomeTable: `${RES_PREFIX}-battle-outcome`,
  battleOrchestrator: `${STACK_PREFIX}Battle-BattleOrchestrator`,
  /** The invitation and claim emails' sender, in `Notifications` (`lambda/src/transactional-mail.ts`). */
  transactionalMail: `${STACK_PREFIX}Notifications-TransactionalMail`,
} as const;

const tableArnIn = (scope: Construct, name: string): string => {
  const stack = cdk.Stack.of(scope);
  return `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${name}`;
};

/** The experiments table, by its fixed name. Use ONLY when the deployment declares `experiments`. */
export function experimentsResourcesOf(scope: Construct): { experimentsArn: string; experimentsName: string } {
  return { experimentsArn: tableArnIn(scope, CAPABILITY_RESOURCES.experimentsTable), experimentsName: CAPABILITY_RESOURCES.experimentsTable };
}

/** The battle tables and orchestrator, by their fixed names. Use ONLY where the deployment wires battle. */
export function battleResourcesOf(scope: Construct): {
  battleStateArn: string;
  battleStateName: string;
  channelBattleConfigArn: string;
  channelBattleConfigName: string;
  battleOutcomeArn: string;
  battleOutcomeName: string;
  battleOrchestratorArn: string;
  battleOrchestratorName: string;
} {
  const stack = cdk.Stack.of(scope);
  return {
    battleStateArn: tableArnIn(scope, CAPABILITY_RESOURCES.battleStateTable),
    battleStateName: CAPABILITY_RESOURCES.battleStateTable,
    channelBattleConfigArn: tableArnIn(scope, CAPABILITY_RESOURCES.channelBattleConfigTable),
    channelBattleConfigName: CAPABILITY_RESOURCES.channelBattleConfigTable,
    battleOutcomeArn: tableArnIn(scope, CAPABILITY_RESOURCES.battleOutcomeTable),
    battleOutcomeName: CAPABILITY_RESOURCES.battleOutcomeTable,
    battleOrchestratorArn: `arn:aws:lambda:${stack.region}:${stack.account}:function:${CAPABILITY_RESOURCES.battleOrchestrator}`,
    battleOrchestratorName: CAPABILITY_RESOURCES.battleOrchestrator,
  };
}

/**
 * Collect every Bedrock text model ARN this classification selects (its `models` on the registry; the image
 * models come from `imageModelArnsForClassification` in `image-gen-models.ts`, which reads the same selection,
 * so both halves of the grant derive from one rule: the platform allows, the classification selects).
 */
export function modelArnsForClassification(classification: Classification, catalog: ClassificationModelCatalog): string[] {
  const arns: string[] = [];
  for (const model of Object.values(catalog)) {
    if (profiles.selectsModel(classification, model.key)) {
      arns.push(...model.foundationModelArns);
      if (model.inferenceProfileArns) arns.push(...model.inferenceProfileArns);
    }
  }
  return arns;
}

/**
 * SSM key the ChannelFlow stack publishes the channel-flow ARN under. The
 * live-drift confirm path reads it to associate the standard channel flow onto
 * the channel it creates (so @all routing works there too). Literal-shared with
 * `channel-flow-stack.CHANNEL_FLOW_ARN_SSM_KEY` + conversations-stack — keep in sync.
 */
export const CHANNEL_FLOW_ARN_SSM_KEY = `${SSM_ROOT}/channel-flow-arn`;

/**
 * THE CONDITION EVERY ADMIN-BEARING `chime:CreateChannel` CARRIES: the
 * request must carry a `classification` tag (`Null` false) and its value must be one of these. A create
 * with no tag, or tagged with another classification, is refused at the create itself.
 *
 * WHAT HAS TO BE MEASURED. That Amazon Chime SDK supplies `aws:RequestTag/classification` and
 * `aws:TagKeys` to the `CreateChannel` authorization, as it does to the `TagResource` check a tagged
 * create also makes (`scripts/deny-test-owner-team-tag.mjs`, the step 39 lines). If it does not, every
 * create is refused at deploy, which is loud rather than silently wide.
 */
export function createOwnClassificationOnly(classifications: string | readonly string[]): Record<string, Record<string, unknown>> {
  const values = [...new Set(([] as string[]).concat(classifications))];
  if (!values.length) throw new Error('createOwnClassificationOnly: no classification to require');
  // AND ITS OWN CLASSIFICATION'S AUDIENCE, in the same request (`AUDIENCE_TAG`): a create carrying no audience,
  // or another audience than the classification declares, is refused at the create, so the tag the member-side
  // roles are denied on (`neverAnOutsideConversation`) is never missing or wrong on a conversation.
  return {
    StringEquals: { 'aws:RequestTag/classification': values, [AUDIENCE_REQUEST_TAG]: audiencesOf(values) },
    Null: { 'aws:RequestTag/classification': 'false', [AUDIENCE_REQUEST_TAG]: 'false' },
  };
}

/** The audiences `classifications` declare, as the `audience` tag values their channels are created with. */
export function audiencesOf(classifications: readonly string[]): string[] {
  return [...new Set(classifications.map((c) => profiles.audienceOf(c)))];
}

/** The `Sid` suffix of the statement that lets a creator tag on create while bearing its own classification's bot. */
export const ON_OWN_BOT_SID_SUFFIX = 'OnBearerBotOfThatClassification';

/**
 * TAGGING A CHANNEL AT CREATION WITHOUT BEING ABLE TO RECLASSIFY AN ASSISTANT.
 *
 * `CreateChannel` with `Tags` authorizes `chime:TagResource` against the CHIMEBEARER as well as the
 * new channel: the service admin user, or the AppInstanceBot a creator acts as. So a creator's tag
 * grant has to reach its bearer, and one written as `${appInstanceArn}/*` also reached every bot,
 * whose `classification` tag is what IAM evaluates for that assistant. A grant naming only the app
 * instance and `channel/*` refused every creation on the deployment (measured 2026-10-10, reverted).
 *
 * So the grant is split by what it reaches:
 *   - the app instance, `channel/*` and the one named service-admin user, under the caller's own
 *     conditions;
 *   - `bot/*` only where the bot ALREADY carries the classification being requested, one statement per
 *     classification. Stamping a bot with the value it has changes nothing, and every other value is
 *     refused, so no creator can move an assistant into another classification. The identity keys
 *     (`assistant`, `role`, `owner-team`) are kept off every grant by `ExcludeOwnerTeamTag`.
 *
 * `every-tag-grant-excludes-ownership.test.ts` refuses a tag grant on a bot without that condition, and
 * `scripts/deny-test-owner-team-tag.mjs` proves it on the deployed policies.
 */
export function tagOnCreateStatements(opts: {
  sid: string;
  appInstanceArn: string;
  /** The classifications this creator may stamp on a channel. */
  classifications: readonly string[];
  /** The service-admin user, when the creator bears it rather than a bot. */
  serviceAdminArn?: string;
  /** Conditions on the channel leg (the drift creators pin the requested classification). */
  conditions?: Record<string, Record<string, unknown>>;
  /**
   * Whether the creator also creates bearing its classification's assistant, which needs the bot leg.
   * True by default; false for a creator that creates only as the service admin (step 33).
   */
  bearsAssistant?: boolean;
}): iam.PolicyStatement[] {
  const { sid, appInstanceArn, classifications, serviceAdminArn, conditions = {}, bearsAssistant = true } = opts;
  const values = [...new Set(classifications)];
  if (!values.length) throw new Error(`tagOnCreateStatements(${sid}): no classification to stamp`);
  // THE AUDIENCE IS STAMPED BESIDE THE CLASSIFICATION AND IS AS IMMUTABLE: every tag call carries the
  // classification's own audience, and on an existing channel only where the channel carries that one or none.
  const audiences = audiencesOf(values);
  return [
    new iam.PolicyStatement({
      sid,
      effect: iam.Effect.ALLOW,
      actions: ['chime:TagResource'],
      resources: [`${appInstanceArn}/channel/*`],
      // NO CHANNEL IS RECLASSIFIED. Two conditions on the channel leg,
      // whatever else the caller pins:
      //   - the REQUESTED `classification` is one this creator may stamp, so every tag call carries it
      //     and never another classification's value;
      //   - the resource's CURRENT `classification`, IF IT HAS ONE, is that same set. At create the
      //     channel carries none, so the stamp is allowed; on an existing conversation of another
      //     classification it is refused, so the grant cannot move a conversation into this
      //     classification. Restamping a channel of its own classification with its own value changes
      //     nothing.
      conditions: {
        ...conditions,
        StringEquals: { ...(conditions.StringEquals ?? {}), 'aws:RequestTag/classification': values, [AUDIENCE_REQUEST_TAG]: audiences },
        StringEqualsIfExists: { ...(conditions.StringEqualsIfExists ?? {}), 'aws:ResourceTag/classification': values, [AUDIENCE_RESOURCE_TAG]: audiences },
      },
    }),
    // THE BEARER AND THE APP INSTANCE, on the requested value only. A tagged `CreateChannel` makes a
    // dependent `TagResource` check against its bearer, and the service admin carries
    // `classification=admin`, so the channel leg's resource condition refuses it and every create is
    // denied (measured by `deny-test-assistant-membership.mjs` line 12). The requested value is still
    // pinned to this creator's own, so no create carries another classification.
    new iam.PolicyStatement({
      sid: `${sid}OnBearer`,
      effect: iam.Effect.ALLOW,
      actions: ['chime:TagResource'],
      resources: [appInstanceArn, ...(serviceAdminArn ? [serviceAdminArn] : [])],
      conditions: {
        ...conditions,
        StringEquals: { ...(conditions.StringEquals ?? {}), 'aws:RequestTag/classification': values, [AUDIENCE_REQUEST_TAG]: audiences },
      },
    }),
    ...(bearsAssistant ? values : []).map((value) => new iam.PolicyStatement({
      sid: `${sid}${ON_OWN_BOT_SID_SUFFIX}${value.replace(/[^A-Za-z0-9]/g, '')}`,
      effect: iam.Effect.ALLOW,
      actions: ['chime:TagResource'],
      resources: [`${appInstanceArn}/bot/*`],
      conditions: {
        StringEquals: { 'aws:RequestTag/classification': value, 'aws:ResourceTag/classification': value, [AUDIENCE_REQUEST_TAG]: profiles.audienceOf(value) },
      },
    })),
  ];
}

/**
 * IAM the per-classification agent handler needs so the LIVE-drift confirm path can
 * create a follow-up channel (`createConversationFromDrift`). Attached ONLY in
 * Aurora mode (when drift is wired) — keeps the handler read-only on Chime
 * otherwise.
 *
 * Security split:
 * - `CreateChannel` targets a channel that does not exist yet, so it cannot be channel-tag-gated;
 *   `TagResource` is pinned to the requested classification instead.
 * - Membership and moderator changes are conditioned on the channel's classification and pinned to
 *   the bearer (step 31): the service admin by its exact ARN.
 * - No statement bears an assistant on a create, a tag, a flow or a membership change (steps 33 and
 *   37): every creator creates through the shared creator as the service admin.
 * - `SendChannelMessage` is granted SEPARATELY and TAG-GATED via
 *   `classificationChannelScopedAllow`, so the handler can message the new (own-classification)
 *   channel but NEVER one of a classification outside its set. The deny-tested Layer-1 send boundary
 *   stays intact even though the handler can now create channels.
 */
export function driftChannelCreateStatements(
  classification: Classification,
  appInstanceArn: string,
  region: string,
  account: string,
  /**
   * The SERVICE ADMIN this role bears, for creating a channel, attaching its flow and assembling its
   * membership.
   *
   * Amazon Chime SDK adds the `CreateChannel` bearer immediately and `CreateChannel` cannot take a
   * channel flow, so whichever identity creates the channel is a member for the whole round trip before
   * the flow is attached - and any welcome in that window bypasses the flow. Creating as the admin is
   * what moves every assistant's membership to AFTER the association. Every action below authorizes
   * against the bearer as well as the channel, so the admin is named on each bearer leg.
   *
   * REQUIRED, AND THE ROLE BEARS ONLY THE ADMIN: the shared creator refuses a creation with no admin
   * rather than creating as the assistant (step 33), and every creator, the proactive briefing and
   * federated add-member included, creates through it (step 37). So no bearer leg reaches `/bot/*`.
   */
  serviceAdminArn: string,
  opts: {
    /**
     * THE LINK IN THE PARENT CONVERSATION IS POSTED ON THE ASSISTANT'S SESSION (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b), so this role
     * needs no send of its own. True for the router, which speaks as the assistant it routed to; the
     * other creators post the link on their own role.
     */
    linkPostedOnSession?: boolean;
  } = {},
): iam.PolicyStatement[] {
  // An unknown classification fails synthesis: a grant pinned to nothing would be no pin at all.
  const own = profiles.resolveClassification(classification);
  if (!own) throw new Error(`driftChannelCreateStatements: unknown classification ${classification}`);
  if (!serviceAdminArn || serviceAdminArn.includes('*') || serviceAdminArn.includes('/bot/')) {
    throw new Error('driftChannelCreateStatements: the service admin must be named exactly; a conversation is never created as an assistant');
  }
  return [
    // ── CREATE, AND STAMP ONLY THIS CLASSIFICATION ────────────────────────────────────────────────
    //
    // `CreateChannel` cannot be tag-gated: the channel does not exist yet, so there is no
    // `aws:ResourceTag` to condition on. `TagResource` is conditioned on the tag being REQUESTED
    // instead, which is a different key and does exist at create time.
    //
    // WHY THAT CONDITION MATTERS MORE THAN IT LOOKS (ADR-042). Ungated, `chime:TagResource` on
    // `${appInstanceArn}/*` lets this role RETAG ANY EXISTING CHANNEL, which means the `classification`
    // tag that every boundary in the platform reads is writable by the same role those boundaries are
    // meant to constrain. The handler verifying a channel's classification and the handler able to
    // rewrite it is not a boundary. With `aws:RequestTag/classification` pinned to its own value, the
    // worst it can do is stamp its own classification, so it can never relabel a channel INTO another
    // classification and cannot escalate one.
    //
    // It still cannot be removed outright: tagging on create requires the tagging permission, and the
    // drift path passes `Tags` inline to `CreateChannel` (`lib/channel-creation.ts:189`) rather than
    // calling `TagResource` itself.
    //
    // AND THE BEARER IS NAMED (steps 33 and 37): the app instance, the channel to be, and the admin
    // itself, so this role cannot create as an assistant or as any person.
    //
    // AND ONLY A CONVERSATION OF ITS OWN CLASSIFICATION (step 39): `CreateChannel` itself requires the
    // `classification` tag in the request and requires it to be this role's own, so an untagged create
    // or another classification's create is refused at the create, not only at the tag it carries.
    new iam.PolicyStatement({
      sid: 'DriftCreateConversation',
      effect: iam.Effect.ALLOW,
      actions: ['chime:CreateChannel'],
      resources: [appInstanceArn, `${appInstanceArn}/channel/*`, serviceAdminArn],
      conditions: createOwnClassificationOnly(own),
    }),
    // THE ORIGIN'S CLASSIFICATION, READ BEFORE A CONVERSATION OPENED FROM ANOTHER ONE IS CREATED (step
    // 39): the creator refuses an origin of another classification (`OriginClassificationMismatchError`
    // in `lib/channel-creation.ts`), and this read is held only on a channel of its own classification,
    // so a mismatched origin is refused here too.
    new iam.PolicyStatement({
      sid: 'DriftReadTheOriginsClassification',
      effect: iam.Effect.ALLOW,
      actions: ['chime:ListTagsForResource'],
      resources: [`${appInstanceArn}/channel/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/classification': own } },
    }),
    // On a bot, only one that already carries this classification (`tagOnCreateStatements`): the
    // value pin alone, on `/*`, let this role stamp its own value onto another classification's bot.
    ...tagOnCreateStatements({
      sid: 'DriftStampOwnClassificationOnly',
      appInstanceArn,
      classifications: [own],
      serviceAdminArn,
      conditions: { StringEquals: { 'aws:RequestTag/classification': own } },
      bearsAssistant: false,
    }),
    // ── MEMBERSHIP, CONDITIONED ON THE CONVERSATION'S CLASSIFICATION (step 31) ───────────────────
    //
    // A membership or moderator change authorizes against the CHANNEL and the BEARER, measured by
    // `scripts/deny-test-assistant-membership.mjs`. The channel carries the `classification` tag from
    // `CreateChannel` itself, so the change is allowed only in a conversation of this classification.
    // The bearer is the service admin by its exact ARN. What stays outside IAM's view is the member added or removed (`MemberArn`),
    // a request parameter rather than a resource; the membership audit is the detection for it.
    //
    // AMAZON CHIME SDK'S OWN ROLE MODEL IS THE SECOND LAYER (ADR-042). Every conversation this platform
    // creates is `RESTRICTED`, so only a ChannelModerator of that channel, or an AppInstanceAdmin, may
    // add or remove a member, whatever the IAM policy says.
    //
    // THE ADMIN MAKES MODERATORS AND LEAVES. It adds the assistant and the opener as members and makes
    // them moderators, then drops its own moderator record (`CreateChannel` made it one, and deleting the
    // membership alone leaves that record behind) and its membership: a conversation carrying a member
    // nobody added shows in the roster and counts toward the AUTO trigger's member test.
    ...membershipAsServiceAdminStatements('DriftMembership', appInstanceArn, [own], serviceAdminArn),
    // ── AND THE POST-CREATE CHANNEL ACTIONS, WHICH CAN BE ────────────────────────────────────────
    //
    // By the time these run the channel exists and carries its tag, so they take the same boundary as
    // every other channel action this role holds. The spawned drift channel is given a TTL via
    // `PutChannelExpirationSettings`; without it the confirm ("yes") path throws AccessDenied after
    // `CreateChannel`, is caught, and silently falls back to a normal reply, so "yes" never creates or
    // navigates to the channel.
    new iam.PolicyStatement({
      sid: 'DriftConfigureOwnClassificationChannel',
      effect: iam.Effect.ALLOW,
      actions: ['chime:AssociateChannelFlow', 'chime:PutChannelExpirationSettings'],
      resources: [`${appInstanceArn}/channel/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/classification': channelsAnAssistantMayActIn(classification) },
      },
    }),
    // THE BEARER LEG OF THE TWO ACTIONS ABOVE, without which neither is permitted at all. Amazon
    // Chime SDK authorizes against the channel AND the `ChimeBearer`, and `channel-creation.ts` calls
    // `AssociateChannelFlow` bearing the service admin. Missing it, the associate AccessDenies into a
    // logged error and the spawned channel keeps NO channel flow - so that conversation has no mention
    // routing, no marker stripping and no private-address enforcement, while the create itself reports
    // success.
    // THE ADMIN IS NAMED, NOT `/user/*`. Widening to every user would let this role act as any person
    // in the deployment, which is a far larger grant than the one thing it needs: to create a channel
    // and attach its flow as the service identity.
    new iam.PolicyStatement({
      sid: 'DriftConfigureChannelAsBearerIdentity',
      effect: iam.Effect.ALLOW,
      actions: ['chime:AssociateChannelFlow', 'chime:PutChannelExpirationSettings'],
      resources: [serviceAdminArn],
    }),
    // ── AND THE CHANNEL FLOW ITSELF, WHICH IS THE THIRD RESOURCE IN THIS AUTHORIZATION ───────────
    //
    // `AssociateChannelFlow` names a channel, a bearer AND a channel flow, and Amazon Chime SDK
    // authorizes against all three. The two statements above cover the first two, so every associate
    // this role attempted was denied on the one resource nobody listed.
    //
    // MEASURED, and it is why this reads as a policy bug rather than a race: over seven days, SIX
    // creations and SIX `Failed to associate channel flow: AccessDeniedException`. A tag-propagation
    // delay would have let some through.
    //
    // The consequence was silent by construction. The associate is best-effort and its failure is a
    // caught warning, so every drift-spawned conversation came up with NO channel flow - no addressing,
    // no marker stripping, no private-address enforcement, no duplicate-placeholder claim - while the
    // create reported success. The `user` e2e phase only caught it because the backend-error guard
    // greps handler logs for `AccessDenied`.
    //
    // NO TAG CONDITION, because a channel flow carries no `classification` tag: there is one per
    // deployment and it is the same object for every conversation. The boundary that matters is on the
    // CHANNEL, and it is unchanged above. The grants that already worked (`conversations-stack`,
    // `notification-stack`) reach this resource the blunt way, with `${appInstanceArn}/*`; this one
    // names it, so the role still cannot touch any other sub-resource.
    new iam.PolicyStatement({
      sid: 'DriftAssociateTheChannelFlowResource',
      effect: iam.Effect.ALLOW,
      actions: ['chime:AssociateChannelFlow'],
      resources: [`${appInstanceArn}/channel-flow/*`],
    }),
    // SendChannelMessage to the freshly-created channel — tag-gated (the classifications
    // its set holds), NOT app-wide, so the handler can't message a channel of any other classification.
    // Bearer pinned to bots only (the handler sends AS the classification bot, never as a
    // user).
    ...(opts.linkPostedOnSession ? [] : classificationChannelScopedAllow(classification, appInstanceArn, ['chime:SendChannelMessage'], {
      // The drift channel-create send: the assistant posting into a conversation it just made, at its
      // own classification. ADR-042.
      actor: 'assistant',
      bearerResources: [`${appInstanceArn}/bot/*`],
    })),
    new iam.PolicyStatement({
      sid: 'DriftReadChannelFlowArn',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${CHANNEL_FLOW_ARN_SSM_KEY}`],
    }),
  ];
}

/**
 * THE ARCHIVE IN AURORA MODE, AS A CLASSIFICATION STACK BUILDS ON IT. Present only in Aurora mode: the stack then
 * builds its own turn data plane and classifier replay in the archive's VPC (`ClassificationArchiveFunctions`),
 * and, with `liveDrift`, wires its router to its own turn data plane (`auroraDriftWiring`).
 */
export interface AuroraDriftHookup {
  /** Whether the archive connects through its optional RDS Proxy (`enableRdsProxy`). */
  rdsProxy: boolean;
  /** Live drift (`-c enableLiveDrift=true`): the router invokes the turn data plane for retrieval and drift. */
  liveDrift: boolean;
}

/**
 * Out-of-band per-message analytics table (SPEC-MESSAGE-METADATA-CODEBOOK.md
 * Phase 1; ADR-016). Passed from the Aurora stack (the consumer) to each classification
 * stack so the classification's async processor can WRITE the full analytics blob there
 * keyed by message id (and slim the Chime Metadata). Present in Aurora mode
 * only; undefined in Athena mode ⇒ the processor keeps full inline metadata.
 */
export interface MessageAnalyticsWiring {
  tableName: string;
  tableArn: string;
}

/**
 * Wire a classification async processor to the out-of-band analytics table: set the env
 * var the shared lib reads (`MESSAGE_ANALYTICS_TABLE`) and grant write-only
 * access scoped to that table. No-op when the wiring is absent (Athena mode).
 * Write-only: the processor never reads analytics back (only the Aurora archival
 * Lambda does).
 */
export function wireMessageAnalytics(
  fn: { addEnvironment(k: string, v: string): unknown; addToRolePolicy(s: iam.PolicyStatement): unknown },
  wiring?: MessageAnalyticsWiring,
): void {
  if (!wiring) return;
  fn.addEnvironment('MESSAGE_ANALYTICS_TABLE', wiring.tableName);
  fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [wiring.tableArn] }),
  );
}

/**
 * Wire LIVE drift detection + RAG retrieval onto a per-classification agent handler.
 * Returns the env + the IAM the handler role needs to INVOKE the retrieval +
 * drift data-plane Lambda (ADR-013). The handler is NOT
 * VPC-attached; the data-plane Lambda owns the Aurora + Titan-embed access.
 * Wired on EVERY classification (basic/standard/premium) so each can run drift + RAG.
 * Drift is conversation-level and runs on EVERY classification (NOT premium-only — see
 * SPEC-DRIFT-CONVERGENCE, Overview). The live path itself is
 * opt-in (`-c enableLiveDrift=true`, Aurora mode only).
 *
 * Usage in a classification stack (only when `hookup` is provided, i.e. Aurora mode):
 *   const drift = auroraDriftWiring(this, classification, hookup);
 *   new lambdaNodeJs.NodejsFunction(this, 'AgentHandler', {
 *     environment: { ...baseEnv, ...drift.env },   // NO VPC props
 *     ...
 *   });
 *   drift.grantTo(handlerRole);
 */
export function auroraDriftWiring(
  scope: Construct,
  classification: Classification,
  /** The classification's own turn data plane, which its stack builds. */
  dataPlaneArn: string,
): {
  env: Record<string, string>;
  grantTo: (role: iam.IRole) => void;
} {
  // scope is retained for signature stability with the classification stacks; the
  // data-plane model needs no stack-scoped constructs here.
  void scope;
  if (!dataPlaneArn) {
    throw new Error(`auroraDriftWiring: no turn data plane for the ${classification} classification`);
  }

  return {
    // The handler reads HAS_AURORA = !!AURORA_DATA_PLANE_ARN and
    // ENABLE_LIVE_DRIFT === 'true'. ENABLE_LIVE_DRIFT is unconditional HERE because
    // this helper only RUNS when the deployer already opted in: the classification
    // stacks call it only when `hookup` is present, which `bin/backend.ts` supplies
    // only for `-c enableLiveDrift=true` in Aurora mode. Live drift stays OPT-IN,
    // default OFF (AURORA-MODE-GUIDE.md, ADR-013 decision 4). The handler is NOT
    // VPC-attached: it invokes the data-plane Lambda for the Aurora + Bedrock work
    // (ADR-013).
    env: {
      AURORA_DATA_PLANE_ARN: dataPlaneArn,
      ENABLE_LIVE_DRIFT: 'true',
    },
    grantTo: (role: iam.IRole) => {
      // The only privilege the classification handler needs for retrieval + drift: invoke
      // the data-plane Lambda. All DB / RDS-IAM / Titan-embed access lives on the
      // data-plane Lambda's own role in ArchiveStackAurora.
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [dataPlaneArn],
        }),
      );
    },
  };
}

/**
 * THE CATALOG OF GRANTS A VENDED SESSION IS NARROWED TO (tenet D4: an assistant's own declared reach is
 * enforced inside its classification by narrowing its vended session).
 *
 * One customer-managed policy per edge, named `AssistantGrant-{classification}-{edge}`. The vend passes
 * the edges an assistant's approved definition selects as session policies (`grantEdgesFor` in
 * `lambda/src/lib/assistant-grant.ts`), so the session's permission is the acting role, its boundary and
 * these policies together: it can only narrow. `base` carries everything a turn does that no definition
 * field selects; each other edge carries one family a definition can leave out.
 *
 * Nothing here widens the acting role. A statement below that names more than the role grants (`*`)
 * grants nothing the role does not, because the session gets the intersection.
 */
/** The session-policy edge that carries the platform utility model (`grantEdgesFor` adds it to every session). */
export const UTILITY_EDGE = 'utility';

export function assistantGrantCatalog(
  scope: cdk.Stack,
  opts: {
    classification: string;
    modelCatalog: ClassificationModelCatalog;
    /** The classification's text model ARNs, without the context-routing ones. */
    classificationModelArns: string[];
    contextRoutingArns: string[];
    /** Bedrock-hosted image models, by key, as foundation-model ARNs. */
    imageModelArns: Record<string, string>;
    streaming: boolean;
  },
): { edges: string[]; policyArnPrefix: string; policies: iam.ManagedPolicy[] } {
  const invoke = opts.streaming ? ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'] : ['bedrock:InvokeModel'];
  const name = (edge: string) => `${STACK_PREFIX}AssistantGrant-${opts.classification}-${edge}`;
  const NARROWED = [...invoke, 'bedrock:InvokeModelWithResponseStream', 's3:GetObject', 's3:ListBucket', ...OBSERVABILITY_READ_ACTIONS];
  const CONTEXT_OBJECTS = 'arn:aws:s3:::*/context/*';
  // PLATFORM KNOWLEDGE BY GRANT: `platform-knowledge/{c}/` for each classification this one
  // grants, so the external classification's session reaches the public overview and nothing internal.
  const PLATFORM_PREFIXES = profiles.grantsFor(opts.classification).map((c) => `platform-knowledge/${c}/`);
  const PLATFORM_OBJECT_ARNS = PLATFORM_PREFIXES.map((p) => `arn:aws:s3:::*/${p}*`);
  const policies: Record<string, iam.PolicyStatement[]> = {
    base: [
      new iam.PolicyStatement({ sid: 'EverythingNoDefinitionFieldSelects', notActions: [...new Set(NARROWED)], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'ObjectsOutsideTheNarrowedPrefixes', actions: ['s3:GetObject'], notResources: [CONTEXT_OBJECTS, 'arn:aws:s3:::*/platform-knowledge/*'] }),
      // WHICH TEMPLATES ITS OWN CLASSIFICATION HOLDS (ADR-062 decision 2). Every turn says messages, and wording one
      // is part of the assistant's turn, so the session lists each family it may say a line from: one listing per
      // family names the templates it holds, and each body and pointer is then read by the key the pointer gives
      // (the object read above, and `ssm:GetParameter`, which no definition field narrows). The acting role and its
      // boundary already confine the listing to this bucket and this classification's prefix; the condition repeats
      // the prefix so the session policy grants nothing wider than they do.
      new iam.PolicyStatement({
        sid: 'ItsOwnClassificationsTemplateListing',
        actions: ['s3:ListBucket'],
        resources: ['*'],
        conditions: { StringLike: { 's3:prefix': [`${templatePrefix(opts.classification)}*`] } },
      }),
    ],
    context: [
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [CONTEXT_OBJECTS] }),
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: ['*'], conditions: { StringLike: { 's3:prefix': ['context/*'] } } }),
    ],
    platform: [
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: PLATFORM_OBJECT_ARNS }),
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: ['*'], conditions: { StringLike: { 's3:prefix': PLATFORM_PREFIXES.map((p) => `${p}*`) } } }),
    ],
    telemetry: [
      new iam.PolicyStatement({ actions: [...METRIC_READ_ACTIONS], resources: ['*'] }),
      new iam.PolicyStatement({ actions: [...ALARM_READ_ACTIONS], resources: instanceAlarmArns(scope) }),
    ],
    // A SPEAK SESSION (Phase 1c): what a service posting as this assistant outside a turn may do, and no
    // more. The acting role still pins the bearer to the assistant's own bot and the room to this
    // classification; this edge removes everything else - models, context, telemetry, the data plane.
    [SPEAK_EDGE]: [new iam.PolicyStatement({ actions: [...SPEAK_ACTIONS], resources: ['*'] })],
    'models-all': [new iam.PolicyStatement({ actions: invoke, resources: opts.classificationModelArns })],
    // THE PLATFORM'S UTILITY MODEL, for platform utility work a turn does whatever the classification selects
    // (the first-turn conversation title, `channel-title.ts`). Scoped exactly like the router's grant of it
    // (`utilityModelArns`), and InvokeModel only: no answer streams from it.
    [UTILITY_EDGE]: [new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: utilityModelArns(scope.region, scope.account) })],
  };
  for (const model of Object.values(opts.modelCatalog)) {
    if (!profiles.selectsModel(opts.classification, model.key)) continue;
    const arns = [...model.foundationModelArns, ...(model.inferenceProfileArns ?? [])];
    if (arns.length) policies[`models-${model.key}`] = [new iam.PolicyStatement({ actions: invoke, resources: arns })];
  }
  if (opts.contextRoutingArns.length) {
    policies['models-cn'] = [new iam.PolicyStatement({ actions: invoke, resources: opts.contextRoutingArns })];
  }
  for (const [key, arn] of Object.entries(opts.imageModelArns)) {
    policies[`image-${key}`] = [new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [arn] })];
  }
  const managed: iam.ManagedPolicy[] = [];
  for (const [edge, statements] of Object.entries(policies)) {
    // FROZEN DESCRIPTION: a managed policy's Description is replace-only and the name is fixed, so an
    // edit here makes the replacement collide with the policy it replaces (see AssistantBoundary).
    managed.push(new iam.ManagedPolicy(scope, `AssistantGrant-${edge}`, {
      managedPolicyName: name(edge),
      description: `Session policy: the ${edge} reach an assistant of the ${opts.classification} classification may be narrowed to.`,
      statements,
    }));
  }
  return {
    edges: Object.keys(policies),
    // The policies themselves, so the vend can be made to wait for them: it names them by a literal
    // prefix, which gives CloudFormation no dependency to order on.
    policies: managed,
    policyArnPrefix: `arn:aws:iam::${scope.account}:policy/${STACK_PREFIX}AssistantGrant-${opts.classification}-`,
  };
}
