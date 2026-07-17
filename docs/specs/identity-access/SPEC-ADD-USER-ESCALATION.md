# SPEC: Add a user to a conversation (eligible-member invite and assistant escalation)

> **Status: DESIGN (not yet built).** This document specifies a proposed
> feature. No code in this repo implements it today. It reuses primitives that
> DO exist (`federated-add-member`, the marker pattern, the per-tier SSM config
> pattern, the membership-audit tier checks) and calls out, at the end, every
> place where a primitive is missing so the build delta is explicit.

## Why this exists

Adding another human to a conversation should be safe by construction: the person
added must be entitled to the conversation's tier, and no one should be able to email
an arbitrary address or pull in someone who cannot actually access the thread.
AgentEchelon supports two ways to add a user, and both pass through the SAME
tier / membership eligibility gate and the SAME email-with-deep-link delivery:

- **Human-initiated (the AgentEchelon primary path).** A user invites an eligible,
  already-registered user from a droplist filtered to those whose tier is at or above
  the conversation's tier. This is the everyday "bring a colleague in" action, and it
  replaces free-text email entry so an arbitrary or ineligible recipient can never be
  chosen.
- **Assistant-initiated escalation (automation).** The assistant reaches the edge of
  what it can resolve on its own (a user asks for a human, a request needs an approver,
  a conversation should go to a named specialist) and brings in a pre-approved human,
  greeting them with a targeted, private briefing (who is asking, why, and the running
  context) instead of telling the user to find someone out of band.

The reference implementation for the escalation shape is the communication-hub
`add-ryan` design (`auth-agent-handler.ts` `addRyanToChannel`): the model emits an
`<!--ADD_RYAN-->` marker, the backend runs `CreateChannelMembership` under an admin
AppInstanceUser bearer (Amazon Chime SDK requires an `AppInstanceUser`, not the bot, for that
call), and posts a targeted briefing to Ryan. The target there is **hardcoded** to a
single Cognito sub as the abuse control: even a prompt injection can only ever add one
specific person. AgentEchelon generalizes that single hardcoded target to a **per-tier
allowlist** the model selects from by KEY (never by raw ARN or sub), keeping the same
abuse property: the blast radius is "add one of N pre-approved people," and no LLM output
ever becomes an identity. For the human path the eligible-user list plays the same role
as the allowlist, computed by the tier eligibility filter. Either way, the added human
gets a targeted summary of what the conversation is about so they can get started quickly.

This spec pairs with:

- [`SPEC-WELCOME-AND-CONTEXT.md`](../conversation-messaging/SPEC-WELCOME-AND-CONTEXT.md): the welcome
  composition pattern (static, targeted, "only you can see this message").
- [`GUIDE-ASSISTANT-CONTEXT.md`](../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md): where
  system-prompt guidance and welcome copy live.
- [`SPEC-NOTIFICATION-BRIDGE.md`](../conversation-messaging/SPEC-NOTIFICATION-BRIDGE.md): the email mirror
  of the private welcome (`metadata.notify`, `notifyTargets`).
- [`SPEC-CONVERSATION-SECURITY.md`](SPEC-CONVERSATION-SECURITY.md) Layer 6
  (membership audit): the tier/eligibility checks reused here PRE-add rather
  than post-hoc.

## Use cases and future extensions

This capability is DESIGN: the base case matches today's eligibility rule and the
rest are forward-looking. All of them ride the same primitive: the model selects a
pre-approved KEY, and the dedicated Lambda enforces eligibility before any write.

- **Base case (AgentEchelon): invite a registered user of at least the
  conversation's tier.** The assistant brings in another registered user whose
  authoritative tier is at least the channel's tier. This is exactly the
  eligibility rule the design already enforces (see the eligibility guardrail
  under GUARDRAILS): the added human must be entitled to the conversation's
  classification and is never escalated above their own tier.
- **Account manager / sales engagement: bring in a named human on a live
  request.** Generalizing the communication-hub "add a specific person" shape, a
  deployment can allowlist an account manager or sales engineer, so the assistant
  can pull them into a conversation when a request warrants human sales
  engagement. The identity still comes from config by KEY, never from the model.
- **(FUTURE) Support: add a support agent who needs case context at add time.** A
  support agent is brought into a conversation that was previously just the
  assistant and a customer. On add, the agent needs a briefing about the customer,
  a case number when one exists, and potentially a prepopulated suggested-text area
  with drafted copy to send the customer. This implies the allowlist entry and the
  briefing payload GROW optional fields (for example `caseNumber`, `suggestedText`)
  beyond the current `{ sub, iss, role, welcomeCopy, whenToAdd }`. Those are a
  forward-compatible extension of the config schema: absent them the flow behaves
  exactly as today, and the loader treats unknown fields as optional so existing
  configs keep validating.
- **(FUTURE) Sales engagement via an MCP service in the workflow.** When a user
  requests help, an MCP service in the workflow resolves the assigned or routed
  sales agent. That resolution maps to an allowlist KEY (or a dynamically resolved
  eligible identity) that is then added to the conversation. The same eligibility
  guardrails still apply: the resolved identity must clear the tier / membership
  check before any membership write.

## Input modes: the eligible-user droplist (AgentEchelon primary) and the assistant marker

AgentEchelon exposes two ways to add a user. Both pass through the SAME eligibility
gate and the SAME email-with-deep-link delivery; they differ only in who initiates.

- **Human-initiated (the AgentEchelon primary path): an eligible-user droplist.** The
  add-a-user control is a dropdown populated ONLY with users eligible to join a
  conversation of THIS tier, with an inline note that only tier-eligible users appear.
  The user PICKS from the list and never types a free-text email address. This replaces
  the current free-text email input. The security value is direct: a user can neither
  email an arbitrary address nor add someone who cannot access the conversation's tier,
  because the only selectable identities are the pre-filtered eligible ones. The list IS
  the allowlist, computed by the same tier / membership eligibility predicate the
  guardrails enforce. The existing email-with-deep-link send (federated-add-member /
  share-conversation) is unchanged.

  This path is net-new work, not a reuse: it needs (a) a UI change (replace the free-text
  email field with a dropdown), and (b) a new SERVER-side endpoint that lists eligible
  users from Cognito (`ListUsers`) filtered to those whose `custom:tier` ranks at or above
  the conversation's tier (same `TIER_RANK` ordering as the guardrail), returning only the
  eligible set so the full directory is never exposed to the client. Open design points to
  settle: whether it fully replaces or coexists with email entry (email may still be needed
  for federated / not-yet-registered invitees), directory-privacy scoping (who may see whom),
  excluding existing members and unapproved users, and `ListUsers` pagination for large pools.
- **Assistant-initiated (automation): the `<!--add_user:KEY-->` marker** described below.
  This is for the sales / support cases where the assistant, not a human, decides to
  bring someone in; it draws its target from a config allowlist by KEY.

Both modes end in the same server-side flow: verify eligibility, then
CreateChannelMembership, the room notice, the targeted welcome, and the email mirror. The
droplist is a client-side convenience over the eligibility filter, so the server still
RE-VERIFIES eligibility before any write and never trusts the client-supplied list.

## Shape at a glance

```
model turn (async processor)
  emits  <!--add_user:KEY-->  in its reply text
        │
        ├─ processor detects + strips the marker (strip is net-new; see below)
        │  and fire-and-forget invokes a DEDICATED add-user Lambda (Event),
        │  exactly as it invokes the battle orchestrator today
        ▼
add-user Lambda (dedicated role: membership-write scoped)
  1. resolve KEY → allowlist entry { sub, iss, role, welcomeCopy, whenToAdd }
  2. verify ELIGIBILITY (tier/membership) BEFORE any write  ── fail closed
  3. CreateChannelMembership (bot bearer) into the CURRENT channel
  4. room-wide "**Name** joined" notice
  5. member-TARGETED private welcome (welcomeCopy + who/why/context briefing)
  6. email mirror via notify metadata (notifyTargets:[{sub,iss}])
```

The async-processor role is **not** widened with membership-write permissions.
The write lives in the dedicated Lambda, the same isolation `federated-add-member`
uses for third-party enrolment.

## Trigger: the `<!--add_user:KEY-->` marker

The assistant signals an escalation by emitting a marker in its reply text:

```
<!--add_user:KEY-->
```

`KEY` is a short, charset-safe identifier (`[A-Za-z0-9_-]{1,64}`) that selects
one entry from the deployment allowlist. It is **never** an ARN, a sub, an
email, or any raw identity. The model picks a KEY the same way it picks a
work-item id: from a fixed, enumerated set it was shown in its system prompt.

### Detection and stripping (parity with `<!--proposal:-->`)

AgentEchelon already embeds machine-readable markers in message content as HTML
comments. Today these persist in the stored message as invisible HTML comments
(the browser does not render them); they are NOT stripped server-side on the
live send path. The one place a `.replace(/<!--...-->/g, '')` runs is the
offline eval runner (`evaluation-runner.ts:516-517`), not the message send. So
server-side stripping for `add_user` is genuinely net-new work (the build delta
says so). Precedent markers in `lib/async-processor-core.ts`:

- `<!--proposal:base64-->` (`proposalMarker`, work-item confirm cards),
- `<!--corr:uuid-->` (correlation id),
- `<!--suggestions:base64-->`, `<!--battlestats:-->`, `<!--battlewaiting-->`.

`add_user` follows the same lifecycle:

1. **Detect.** After the Converse loop returns the reply, the processor tests
   for the marker (`/<!--add_user:([A-Za-z0-9_-]{1,64})-->/`), exactly as it
   tests `response.includes('<!--proposal:')` today.
2. **Capture.** The captured `KEY` is handed to the escalation dispatch (below).
   At most one add-user marker is honoured per turn; extras are ignored.
3. **Strip.** The marker is removed from the reply text before the message is
   sent to the channel, with a `.replace(...)` + whitespace-collapse. This is
   net-new on the live send path: unlike `<!--proposal:-->` and `<!--corr:-->`,
   which persist in the stored message as invisible HTML comments, `add_user`
   must be actively stripped so it never persists. (The only existing
   comment-stripping `.replace` lives in the offline eval runner, not here.)
4. **Dispatch.** The processor fire-and-forgets a `lambda:InvokeFunction`
   (`InvocationType.Event`) to the dedicated add-user Lambda, passing
   `{ channelArn, senderArn, key, contextHint }`. This mirrors exactly how the
   processor invokes `BATTLE_ORCHESTRATOR_ARN` today (`InvokeCommand`,
   `InvocationType.Event`), so the user-facing turn never blocks on the add.
   The `contextHint` is the ONLY model-influenced field on this payload and is
   UNTRUSTED: the Lambda length-caps it (the `.slice(...)` discipline in
   `federated-add-member.ts:102-104`, e.g. `String(...).slice(0, 80)`) and
   strips markup before it reaches any briefing or email, and never treats it
   as identity or as an authoritative instruction.

Unlike `proposal` (base64 JSON payload), `add_user` carries only an opaque KEY,
so no encoding is required. The KEY is validated against the allowlist inside
the dedicated Lambda, not trusted from the marker.

## Config surface: the per-tier allowlist

The allowlist mirrors the onboarding-intake config plumbing
(`lib/onboarding-intake.ts` + the tier stacks) one-for-one:

| Concern | onboarding-intake (existing) | add-user-allowlist (proposed) |
|---|---|---|
| Inline env | `ONBOARDING_INTAKE` | `ADD_USER_ALLOWLIST` |
| SSM param name env | `ONBOARDING_INTAKE_PARAM` | `ADD_USER_ALLOWLIST_PARAM` |
| SSM key | `/agent-echelon/tier/{tier}/onboarding-intake` | `/agent-echelon/tier/{tier}/add-user-allowlist` |
| Loader | `loadIntakeConfig(ssmGet)` (cached warm, null when absent/malformed) | `loadAddUserAllowlist(ssmGet)` (same contract) |
| Default | absent ⇒ onboarding OFF | absent ⇒ escalation OFF |

The config is a JSON object keyed by KEY. Each entry:

```jsonc
{
  "escalations": {
    "billing-lead": {
      "sub": "a1b2c3d4-0000-4444-8888-aaaabbbbcccc",
      "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_PRIMARY",
      "role": "standard",
      "welcomeCopy": "You've been brought in on a billing question the assistant couldn't resolve. The customer is waiting.",
      "whenToAdd": "The user has a billing dispute, a refund request over the self-serve limit, or explicitly asks to speak with a human about their invoice."
    },
    "security-oncall": {
      "sub": "d4c3b2a1-1111-4444-8888-ccccbbbbaaaa",
      "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_PRIMARY",
      "role": "premium",
      "welcomeCopy": "You've been paged into a conversation flagged as a possible security concern. Review the context before replying.",
      "whenToAdd": "The user reports a suspected account compromise, a data-exposure concern, or anything that reads as a security incident."
    }
  }
}
```

Per-entry fields:

- **`sub` + `iss`** (the human's identity in the deployment's identity
  provider). `iss` scopes the sub to a pool (parity with
  `notifyTargets:[{sub,iss}]` in the notification bridge, and with
  `federated-add-member`'s `{iss, sub}` map). These are the ONLY identity the add
  uses, and they come from config, never from the model.
- **`role`** (the eligibility marker, see Guardrails). In AgentEchelon this is
  the human's tier (`basic` / `standard` / `premium`); in the comm-hub reference
  it was a role (`site admin`). It is what "is this person allowed in THIS
  conversation" is checked against.
- **`welcomeCopy`**: deployment-authored copy prepended to the targeted private
  welcome, so the added human immediately understands why they were brought in.
- **`whenToAdd`**: natural-language guidance describing WHEN the assistant
  should emit `<!--add_user:KEY-->` for this entry. This string is injected into
  the assistant's system prompt (see below), so the model knows both which keys
  exist and the conditions each key is for.

### System-prompt escalation guidance

At system-prompt assembly the loader renders, for each allowlist entry, a line
of the form:

```
- To bring in help for <role>: emit <!--add_user:KEY--> when <whenToAdd>.
```

This is the only place the KEYs are surfaced to the model. The model is
instructed (in fixed persona text, not from config) that it may emit AT MOST one
`add_user` marker, only a KEY from this list, and never a raw identity. Absent an
allowlist, no guidance is injected and the capability is invisible to the model.
This mirrors how the intent-pack and onboarding-intake configs shape the router
without any code change (`GUIDE-ASSISTANT-CONTEXT.md`, "Welcome patterns").

## Add flow (the dedicated Lambda)

The add / email / welcome mechanics are the EXISTING flow and do not change. Both input
modes reuse the same `federated-add-member.ts` / `share-conversation` sequence unchanged:
verify the user is eligible, add them (`CreateChannelMembership`, which triggers the email
deep-link invite), and the targeted welcome is delivered when the user JOINS (a persistent
`Target`-scoped message they see when they open the conversation from the email link). This
feature adds ONLY two things on top of that unchanged flow: the trigger (the eligible-user
droplist for the human path, or the `<!--add_user:KEY-->` marker for the assistant path) and
the pre-add eligibility filter. The ordered steps below are that reused flow, stated in full
for the assistant (dedicated-Lambda) path:

1. **Resolve the KEY.** Load the allowlist (warm-cached). Look up `KEY`. If it is
   absent, **no-op and log** (a marker for an unknown key is never an add). This
   is the prompt-injection floor: an invented key resolves to nothing.
2. **Verify eligibility BEFORE any write** (see Guardrails). If ineligible,
   no-op and log; nothing is created. Tier resolution that FAILS (a
   `DescribeChannel` error, or a member tier that cannot be resolved) is a
   HARD REFUSE, not a default: escalation fails closed on an unknown tier,
   the exact opposite of the reactive audit, which defaults an unresolved
   channel to `basic`. The forked eligibility helper MUST invert
   `resolveChannelTier`'s default-to-`basic` so an unresolved channel tier
   blocks the add rather than silently lowering the ceiling.
3. **`CreateChannelMembership`** for the resolved human into the **current**
   channel (`channelArn` from the event). Bearer selection matches
   `federated-add-member`: the tier bot is the channel creator/moderator, so the
   **bot bearer** authorizes the membership write. (The comm-hub reference uses an
   admin AppInstanceUser bearer because there the admin, not the bot, is the
   moderator; AE's bot-as-moderator model lets the bot bearer do it, as
   `federated-add-member` already proves.) `ConflictException` is treated as
   "already a member" (idempotent), see Failure modes.
4. **Associate the channel flow** if not already associated (best-effort), so the
   new member's messages route through `@assistant`/`@all` (parity with
   `federated-add-member` step 3).
5. **Room-wide join notice**: a `SendChannelMessage` visible to everyone,
   `**Name** joined this conversation...` (parity with `federated-add-member`'s
   `member_joined` announcement).
6. **Targeted private welcome**: a `SendChannelMessage` with
   `Target:[{ MemberArn }]` and "Only you can see this message" framing. Content
   is composed from `welcomeCopy` plus a **who / why / context** briefing built
   the same way `addRyanToChannel` builds Ryan's briefing:
   - **who**: the requesting user's display name/profile (best-effort lookup;
     any failure degrades to "A user"),
   - **why**: the `contextHint` the assistant passed with the marker. This is
     UNTRUSTED, model-influenced text, never identity: it is length-capped on
     ingest (the `.slice(...)` discipline `federated-add-member.ts:102-104`
     applies to every display field), markup-stripped, and rendered as quoted
     context only, never as an instruction or an authoritative claim,
   - **context**: the running conversation summary/topics (best-effort).
   Every section is guarded, so missing data omits a line rather than blocking.
7. **Email mirror**: the targeted welcome carries
   `metadata.notify = { email: true }` and `notifyTargets: [{ sub, iss }]`
   (the allowlist entry's identity) plus a `notifySubject`, exactly as
   `federated-add-member` step 4 does. The notification bridge resolves the
   address from the identity provider at send time (never stored) and mirrors the
   in-app welcome to email (`SPEC-NOTIFICATION-BRIDGE.md`, outbound).
8. **Audit the successful add.** Emit a structured audit record for every
   COMPLETED escalation (`_auditEvent` / a Layer 6 finding via `writeFinding`):
   who initiated (the requesting sender), whom was added (the allowlist entry's
   sub), the KEY, the channel ARN, and the resolved tier. Membership mutations
   are exactly what Layer 6 / `membership-audit.ts` records (`writeFinding`,
   `_auditEvent`), so assistant-initiated adds land on the same admin review
   surface as reactive findings, not just in logs. Where the reactive audit
   records only violations, escalation records SUCCESSES too, so an assistant
   that brings people in is reviewable.

Every messaging step is best-effort and non-fatal past the membership write: a
greeting failure must not leave the human half-added with no notice logged.

## Dedicated Lambda and IAM

The add path runs in a DEDICATED Lambda, so the async-processor role is never
granted membership-write. This is the same isolation `federated-add-member`
uses. The role mirrors `FederatedShareMemberRole` in `foundations-stack.ts`:

- **Amazon Chime SDK (scoped to `${appInstanceArn}/*`):**
  `chime:CreateChannelMembership`, `chime:AssociateChannelFlow`,
  `chime:SendChannelMessage`, `chime:DescribeChannel` (read the channel's
  enforced tier for the eligibility check), and `chime:DescribeChannelMembership`
  (the already-a-member probe). No `DeleteChannelMembership`: escalation only
  adds. No `CreateChannel`: escalation adds into an EXISTING channel, it never
  creates one.
- **SSM (`ssm:GetParameter`):** the per-tier bot ARN
  (`/agent-echelon/tier/*/bot-arn`, the membership bearer) and the allowlist
  param (`/agent-echelon/tier/{tier}/add-user-allowlist`).
- **Cognito (`cognito-idp:AdminListGroupsForUser`, `AdminGetUser`):** resolve the
  added human's authoritative tier for the eligibility check, and the requester's
  display name for the briefing. Scoped to the primary user pool ARN.
- **Bearer identity:** the tier bot AppInstanceUser (`${appInstanceArn}/bot/*`
  as the ChimeBearer resource), matching how the tier processors already scope
  their Amazon Chime SDK grants.

The async-processor role gains exactly ONE new grant: `lambda:InvokeFunction`
on the add-user Lambda's ARN (the same shape as its existing
`BATTLE_ORCHESTRATOR_ARN` invoke). It gains NO Amazon Chime SDK membership permission.

## GUARDRAILS (critical)

These are the load-bearing controls. The feature is only safe because of them.

### 1. Prompt-injection floor: the model picks a KEY, never an identity

The LLM selects a KEY from an enumerated allowlist. It never emits an ARN, a
sub, an email, or a name that becomes an identity. The blast radius of ANY model
output (including an injected one) is bounded to "add one of the N pre-approved
people in this tier's allowlist." An invented key resolves to nothing (step 1
no-op). This is the direct generalization of the comm-hub control (which
hardcodes the single target): AE widens one hardcoded target to a small,
non-LLM-controllable set, and keeps the "identity is never model-controlled"
invariant.

### 2. Eligibility verified BEFORE the add (fail closed)

The added human must be eligible to be in THIS conversation. Eligibility is
checked BEFORE `CreateChannelMembership`, and an ineligible result is a hard
no-op (nothing is created).

- **AgentEchelon eligibility = tier / membership.** The conversation carries an
  enforced tier (`Channel.Metadata.modelTier`, tag `classification=<tier>`). The
  added human's authoritative tier comes from their Cognito groups. The add is
  refused unless the human's tier is at least the channel's tier. This reuses the
  membership-audit (Layer 6) tier logic: `isTierViolation(memberTier,
  channelTier)` is the exact predicate (member below channel ⇒ violation ⇒
  refuse), and channel-tier / member-tier resolution mirror
  `resolveChannelTier` / `resolveMemberTier`. Escalation runs this check
  **pre-add** (proactive), where Layer 6 runs it post-hoc off the Kinesis
  membership stream (reactive). Running it pre-add means an over-tier add never
  happens rather than being revoked after the fact.
- **Never escalate someone above their tier.** The check is directional: a
  `standard` human is eligible for a `basic` or `standard` channel, never a
  `premium` one. Two tier readings exist and their roles are distinct: the
  Cognito-group resolution is AUTHORITATIVE (it alone decides eligibility, and
  `isTierViolation` runs against it, never against the allowlist `role`), while
  the allowlist `role` is a DECLARED floor the deployer asserts about the entry
  (an exact-match assertion). Config drift resolves definitely, not ambiguously:
  Cognito resolving BELOW the declared `role` means the declared floor is unmet
  and the add is refused; Cognito resolving ABOVE the declared `role` is allowed
  (the human is simply more entitled than declared) but logged as drift. The
  declared `role` never raises a human above their authoritative Cognito tier.
- **Unresolved tier is a hard refuse (fail closed).** A `DescribeChannel` error
  or a member tier that cannot be resolved does NOT fall through to a default;
  escalation refuses the add. This is the exact inversion of the reactive
  Layer 6 audit, where `resolveChannelTier` returns `basic` on a
  `DescribeChannel` error (safe there: a lower assumed tier means fewer
  revocations) and `resolveMemberTier` skips an unresolvable member. As a
  PRE-add ceiling those same defaults are fail-OPEN (a below-tier human would
  pass the gate on a premium channel whose tier failed to resolve), so the
  forked eligibility helper MUST invert them: unknown channel tier and unknown
  member tier both block, never default to `basic`.
- **Per-deployment eligibility.** The `role` field is the seam. An AgentEchelon
  deployment reads it as a tier and checks tier/membership. A different
  deployment (e.g. the comm-hub shape) reads it as a role and checks that the
  person holds it (site admin). The eligibility predicate is deployment-supplied;
  the allowlist entry carries the datum it checks.

### 3. Entitlement: no cross-tier escalation

Directly implied by (2): escalation can never place a human on a conversation
above their entitlement. The channel's enforced tier is the ceiling; a
below-tier human is refused. This preserves the Layer 1 + Layer 6 invariant that
a conversation's participants never exceed the conversation's classification.

### 4. Failure modes (all fail safe)

| Situation | Behaviour |
|---|---|
| Marker emitted, KEY not in allowlist | No-op + log. No add, no message. |
| Marker emitted, allowlist absent/malformed | Loader returns null ⇒ capability disabled ⇒ no-op + log. |
| Config present but IAM grant missing | The Amazon Chime SDK/SSM/Cognito call throws ⇒ **fail closed** (no partial add), log the error. |
| Human already a member | `CreateChannelMembership` ⇒ `ConflictException` ⇒ skip the add; OPTIONALLY re-post the targeted welcome (deployment toggle) so a re-escalation still briefs them; never a duplicate join notice. The re-post carries the email mirror, so gate it behind a per-(channel, KEY) cooldown/dedupe: one-add-per-turn does NOT bound a marker repeated across many turns, which would otherwise re-page the human by email every turn. Suppress both the re-post and the email when the same (channel, KEY) already fired inside the cooldown window. |
| Eligibility check fails (over-tier / unresolvable identity) | No-op + log. An unresolvable identity (Cognito `UserNotFoundException`) is treated as ineligible, never as "allow" (parity with membership-audit skip-rather-than-act). |
| Briefing/summary lookup fails | Degrade to a simpler welcome; never block the add. |

### 5. Every successful add is audited (not just failures)

The reactive Layer 6 audit records only violations. Escalation additionally
records SUCCESSES: each completed add emits a structured audit record
(`_auditEvent` / a `writeFinding` Layer 6 finding capturing who / whom / KEY /
channel / tier), because a membership mutation is exactly what Layer 6 /
`membership-audit.ts` exists to track. Assistant-initiated adds therefore
appear on the admin review surface alongside reactive findings, so an assistant
that brings humans into conversations is reviewable rather than silent.

## "Tier assistants actually configured" checklist

For a given tier, escalation is live only when ALL FOUR line up. If any is
missing the capability is inert (fail closed), which is the intended default.

1. **SSM allowlist exists.** `/agent-echelon/tier/{tier}/add-user-allowlist`
   holds valid JSON with at least one entry. Absent/empty/malformed ⇒ disabled.
2. **System-prompt guidance references the keys.** The tier's system prompt
   renders the `whenToAdd` guidance for each KEY, so the model knows the keys
   exist and when to use each. Without this the model never emits the marker.
3. **Dedicated-Lambda IAM grant.** The add-user Lambda's role carries the scoped
   Amazon Chime SDK membership-write + SSM + Cognito grants, and the async-processor role
   carries `lambda:InvokeFunction` on the add-user Lambda ARN (and nothing more).
4. **A test proves the chain.** A test asserts
   marker → eligibility-check → add → welcome: given a channel of tier T and an
   allowlist entry eligible for T, emitting `<!--add_user:KEY-->` results in a
   membership add, a room notice, a targeted welcome, and a `notify` email
   mirror; and given an entry INELIGIBLE for T, it results in a no-op with no
   membership write. The chain test must ALSO cover: (a) the tier-resolution
   FAILURE path (a `DescribeChannel` error or an unresolvable member tier is a
   hard refuse with no write, proving fail-closed per guardrail 2, never a
   default-to-`basic` add); (b) the already-member / rate-limit path (a
   `ConflictException` skips the add, and a marker repeated across turns hits
   the per-(channel, KEY) cooldown so the duplicate welcome and email are
   suppressed); and (c) that a successful add emits an audit record, so the
   admin review surface sees assistant-initiated escalations. (Parity with the
   config-driven tier-safety tests.)

## Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant P as Async processor
    participant L as Add-user Lambda (dedicated role)
    participant SSM as SSM allowlist
    participant CID as Identity provider (Cognito)
    participant CH as Amazon Chime SDK channel
    participant NB as Notification bridge (email)
    participant H as Human (added)

    U->>P: message ("I need to talk to a person about my refund")
    Note over P: Converse loop; model emits reply + <!--add_user:billing-lead-->
    P->>P: detect + strip marker (parity with <!--proposal:-->)
    P-->>U: reply (marker stripped)
    P-)L: InvokeFunction (Event) {channelArn, senderArn, key, contextHint}
    L->>SSM: load allowlist, resolve KEY
    alt KEY not in allowlist
        L-->>L: no-op + log (prompt-injection floor)
    else KEY resolved
        L->>CH: DescribeChannel (enforced tier)
        L->>CID: AdminListGroupsForUser (human's tier)
        alt human tier < channel tier (ineligible)
            L-->>L: no-op + log (fail closed, no write)
        else eligible
            L->>CH: CreateChannelMembership (bot bearer)
            L->>CH: room-wide "Name joined" notice
            L->>CH: targeted private welcome (welcomeCopy + who/why/context)
            L->>NB: notify.email + notifyTargets:[{sub,iss}]
            NB->>H: email mirror of the private welcome
        end
    end
```

## Build delta (what AgentEchelon does NOT already have)

The primitives below EXIST and are reused as-is or as close templates:

- The marker embed/detect/strip lifecycle (`<!--proposal:-->`,
  `<!--corr:-->`, `<!--suggestions:-->`) in `lib/async-processor-core.ts`.
- Fire-and-forget dedicated-Lambda invoke from the processor
  (`InvokeCommand`, `InvocationType.Event` to `BATTLE_ORCHESTRATOR_ARN`).
- The add-member messaging primitives (`CreateChannelMembership`,
  `AssociateChannelFlow`, join notice, targeted "only you can see this" welcome,
  `notify` email mirror with `notifyTargets:[{sub,iss}]`) in
  `federated-add-member.ts`.
- The per-tier SSM config loader + tier-stack wiring pattern
  (`lib/onboarding-intake.ts` + `ONBOARDING_INTAKE_PARAM` in the tier stacks).
- A scoped dedicated-Lambda membership-write role (`FederatedShareMemberRole` in
  `foundations-stack.ts`).
- The tier/eligibility predicates (`classifyMember`, `isTierViolation`) in
  `membership-audit.ts`.

These do NOT exist and are net-new work:

1. **The `<!--add_user:KEY-->` marker itself**: emit-side persona instruction,
   detect/capture/strip in the processor, and the one-per-turn guard. Template
   exists (`proposal`), code does not.
2. **The add-user Lambda**: `federated-add-member` is keyed to FEDERATED
   identities (`deriveFederatedSub(iss, sub)` ⇒ disjoint `fed_` users) and adds
   into a DETERMINISTIC, host-context channel that it create-or-gets. Escalation
   adds a PRIMARY-pool Cognito user (native sub, not `fed_`) into the CURRENT
   channel (passed in, not derived). So `federated-add-member` is a template to
   fork, not a function to call.
3. **The allowlist loader + SSM param + tier-stack wiring**: net-new, but a
   direct copy of the onboarding-intake plumbing (`ADD_USER_ALLOWLIST` /
   `ADD_USER_ALLOWLIST_PARAM` / `/agent-echelon/tier/{tier}/add-user-allowlist`).
4. **Pre-add eligibility helpers are not exported.** In `membership-audit.ts`
   the two AWS-lookup helpers `resolveMemberTier` (Cognito groups) and
   `resolveChannelTier` (`DescribeChannel` ⇒ `Metadata.modelTier`) are
   module-private and wired to the reactive Kinesis path. What IS exported are
   the pure predicates (`classifyMember`, `isTierViolation`) AND the `TIER_RANK`
   / `AUDITED_EVENT_TYPES` constants. Escalation needs the SAME lookups PRE-add,
   so either those two helpers are extracted into a shared module and exported,
   or the add-user Lambda re-implements the two AWS lookups. Extracting them is
   the cleaner delta and keeps one source of truth for "what tier is this
   member/channel." One inversion is MANDATORY on the fork: `resolveChannelTier`
   returns `basic` on a `DescribeChannel` error and `resolveMemberTier` returns
   null on an unresolvable member; those defaults are safe for the reactive
   audit but FAIL-OPEN as a pre-add ceiling, so the escalation copy MUST treat
   an unresolved channel or member tier as a hard refuse, never as `basic`.
   Note also that `resolveMemberTier` queries only the primary `USER_POOL_ID`,
   so the allowlist entry's `iss` is currently DECORATIVE: eligibility is
   primary-pool-only, and a foreign-pool entry has no authoritative tier to
   resolve. Either document eligibility as primary-pool-only or reject
   foreign-pool (`iss` other than the primary pool) entries at allowlist load.
5. **System-prompt injection of `whenToAdd`**: the render-into-system-prompt step
   (one line per allowlist entry) is net-new, though it mirrors how the
   intent-pack and onboarding configs already shape prompt/router behaviour.
6. **The async-processor role gains `lambda:InvokeFunction`** on the new Lambda's
   ARN (one statement, same shape as the existing battle-orchestrator invoke) and
   the new env var carrying the ARN.
7. **The chain test** (checklist item 4): net-new, modelled on the config-driven
   tier-safety tests.
8. **The bot-as-moderator bearer assumption is unverified for ordinary
   channels.** Step 3 authorizes `CreateChannelMembership` with the tier bot's
   bearer on the assumption the bot is a moderator of the CURRENT channel.
   `federated-add-member.ts:144-179` only establishes that for channels the bot
   itself create-or-gets (it is the creator there). For an escalation into an
   arbitrary pre-existing conversation, verify the tier bot actually holds a
   moderator seat; if it does not, `CreateChannelMembership` under the bot
   bearer is unauthorized and the add must fall back to an admin
   AppInstanceUser bearer (the bearer the comm-hub reference uses for exactly
   this reason). Decide and document which bearer authorizes the write on
   ordinary channels before build.
