---
title: "ADR-053: A conversation records its type rather than being pinned to it"
status: >-
  Accepted 2026-09-30. Phase 1 and decision 1 (the creation consolidation) are BUILT and DEPLOYED; decisions 2, 3, 6 and 7 are NOT BUILT. It settles how a conversation acquires a type, where type configuration is stored, what happens to a live conversation when that configuration changes, and how an archived conversation stays interpretable once it has.

  Built: the `ops` type is honored end to end, and the person-facing route creates through the canonical creator (it serves a bundled function that calls the library), so a type's retention, agents and flow reach the conversations people open and not only the ones a trigger opens. Verified on a deployment: a person-opened conversation carries the type's retention, the stamped type key, the flow, and no service admin left in the roster; an `ops` conversation opened from an event carries thirty days rather than its classification's, both assistants the type names added exactly once, and the type key `ops` rather than `premium`.

  Amended 2026-10-05 (owner): no type key is a classification value. The three classification-named entries collapse into one ordinary type, `general`, which takes the classification as an input and has manual membership; the resolver does not fall back to the classification, and a conversation stamped with a classification name resolves to `general`. A drift split takes its parent's classification rather than reading one off the type.

  Amended 2026-10-23: a type declares the events that open it (`openedBy`, `backend/lib/config/event-openers.ts`), and the classification stack builds one EventBridge rule per declaration targeting the creator, with a dead-letter queue, bounded retries and an alarm (`backend/lib/constructs/event-opened-conversations.ts`). The shipped `ops` type is opened by `ae.ops` / `Incident opened` on the default bus (`backend/scripts/send-ops-event.mjs`). The rule names the declaration; the type is the declaration's and the classification the deployment's. The creator welcomes the person the event named and the type's admitted people into the new room as its primary (`memberWelcome`), and each welcome is emailed with a link into that room. Verified by `test/event-opened-conversation-rules.test.ts` and `test/lib/an-event-opened-conversation-welcomes-its-people-by-email.test.ts`; the rule is built and deployed to dev, and no run of `tests/e2e/demo-cast-mail.spec.ts` (the ops event half) against it is recorded (NOT VERIFIED).

  Not built, and each is load-bearing for a different claim: **no client can NAME a type** (the person-facing API takes no `conversationType`, so the key it stamps is always `general`), nothing propagates a changed dimension to a conversation that already exists (decision 2), no dimension declares a disposition (decision 3), and nothing records which configuration a conversation ran under (decision 7). Eight of the fourteen dimensions are still read by nothing.
date: 2026-09-30
related:
  - "../../specs/interaction/conversation/SPEC-CONVERSATION-TYPES.md"
  - "../../specs/interaction/assistants/SPEC-PORTABLE-PROFILES.md"
  - "../../specs/interaction/governance/SPEC-ACCESS-AND-CONTROLS-AUDITING.md"
  - "../../overview/TENETS.md"
  - "./017-conversation-archive-mechanism.md"
  - "./046-classifications-are-a-set-not-a-ladder.md"
  - "../../../backend/lib/config/conversation-types.ts"
  - "../../../backend/lambda/src/lib/channel-creation.ts"
  - "../../../backend/lambda/src/lib/channel-context-client.ts"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
  - "../../../backend/lambda/src/create-conversation.ts"
  - "../../../backend/lambda/src/admin-conversation-sync.ts"
  - "../../../backend/lambda/share-conversation/index.js"
  - "../../../backend/test/lib/admission-mirrors-the-registry.test.ts"
  - "../../../backend/lambda/src/admin-notification-channel-provision.ts"
tracking: |
  The owner asked whether conversation types use SSM for change management, then corrected two answers. First: a snapshot of the policy a conversation was created under is wrong for most dimensions, because a renamed group, a withdrawn transport or a changed retention must reach conversations that already exist. Second: a type need not be pinned to a classification. The reconciliation those two corrections force is the whole of this record - propagation and provenance are different requirements, and the design that failed was the one that treated them as the same one.
---

# ADR-053: A conversation records its type rather than being pinned to it

## Status

**Accepted (2026-09-30). Phase 1 and decision 1 (the creation consolidation) are built and deployed; decisions 2, 3, 6 and 7 are NOT BUILT.** The front matter names what is built and each amendment. A conversation records its type at creation (`conversationType` in its context), `resolveConversationTypeKey` reads that recorded type with no fallback to the classification (`backend/lib/config/conversation-types.ts`), and the shipped types are `general`, `ops`, `ops-team`, `guest-visitor` and `customer-engagement`. **NOT BUILT:** a client naming a type, propagation of a changed dimension (decision 2), dispositions (decision 3) and a record of the configuration a conversation ran under (decision 7).

When this record was proposed, `CONVERSATION_TYPES` held three types named for the three conversational classifications. Three of its thirteen dimensions were read: `driftEnabled` at the turn, `expiration` at creation, and `classification` by the drift path and as a defect. **The other ten were declared and read by nothing**, which `SPEC-CONVERSATION-TYPES.md` Appendix A stated per field.

That matters for reading this record: any propagation behavior described for an unread dimension is a **plan**, not a finding.

**And the two that were read were read by CLASSIFICATION, not by type.** `getConversationTypeConfig` was called with the classification at creation, and `resolveConversationTypeKey` fell back to the classification because nothing recorded an explicit type on a conversation. So at that point a type is not merely mirrored by a classification, it is *reached only through* one: a type whose key is not a classification value cannot be selected for any conversation, and its dimensions would go unread even if a reader existed. That is the state every decision below has to move from, and it is why consolidating conversation creation is part of the work rather than beside it.

## The four questions, and why the obvious answer to one breaks another

**How does a conversation acquire a type?** By its classification. `resolveConversationTypeKey` prefers an explicitly named type where one is given, falls back to the classification, and falls back again to a default. No creation path passes an explicit type, and nothing records one on a channel, so in practice the type *is* the classification and the other two branches are unexercised.

**Where is the configuration stored?** Compiled config, changed by a deploy. The comparable artifact is an assistant profile, which is the opposite: SSM under `/agent-echelon/assistant/{name}/definition`, versioned, immutable per version, served through a movable `active` label, edited with no deploy.

**What happens to a live conversation when the configuration changes?** `SPEC-CONVERSATION-TYPES` FR13 answers "nothing - a conversation keeps the policy it was created under", and that answer is wrong for most of the bundle. A renamed group has to resolve to the new name or it resolves to nobody. A withdrawn transport has to stop being offered. A shortened retention is meant for the data that already exists, which is the point of shortening it.

**And what does an archived conversation say about the configuration it ran under?** Nothing, today. This is the question that makes the third one hard, because the intuitive fix for the third - propagate everything, keep no history - destroys the fourth, and the intuitive fix for the fourth - pin each conversation to a version - destroys the third.

**The reconciliation is that these are two requirements, not one.** Propagation is about what a conversation *does next*. Provenance is about what it *did*. A conversation can take new configuration immediately and still carry an unalterable record of every configuration it has run under, because the record is append-only and the behavior is not.

## Decision 1: a conversation's type is set at creation, explicitly, and recorded where it cannot be edited

**A creating caller supplies two parameters: the classification, and the type.** Neither is derived from the other. Absent a type it resolves from the classification exactly as today, so nothing shipped changes.

**A type declares which classifications it may be used at, and the creator refuses the rest.** That is a schema change rather than a reinterpretation: `classification: Classification` becomes `classifications: Classification[]`, the production read the drift path performs has to take the conversation's classification instead, and the two tests asserting a type's single classification against its key change with it. So "nothing shipped changes" holds for resolution and not for this field. That is the second enforcement layer tenet D3 asks for, and it is what makes a type's declared classifications load-bearing rather than decorative: a caller naming a type and a classification the type does not allow is refused before a channel exists. It also answers what a type carrying a classification is FOR, which neither a restatement of the lookup key nor a value to be read off could answer - it is a constraint, and the membership decision below is where it earns its keep, because a type whose roster comes from an identity-provider group is only safe at the classifications that group's members are cleared for.

The resolved key is then **recorded as an archived event**, not stamped on the channel. Two candidate homes are rejected for stated reasons:

- **Channel Metadata is member-writable.** Members hold `UpdateChannel`, which `channel-creation.ts` already refuses to rely on for anything load-bearing. A provenance record a participant can rewrite is not a provenance record.
- **The channel-context store is server-only and durable, and still cannot hold provenance.** It carries no TTL and has point-in-time recovery on, so a row outlives its channel as an orphan. What disqualifies it is that it is MUTABLE and last-write-wins rather than append-only, and it is not the system of record (tenet D7). A record that can be overwritten in place answers "what is the current value" and never "what was the value in August".

The archive is the store whose job this is (tenet D7): append-only, the system of record, and it survives channel deletion. It already captures channel Metadata on the archival path, so the store and its shape exist. What is missing is a producer as well as a schema: the archive ingests Amazon Chime SDK events off Kinesis, and a provenance record is not one of those, so something has to emit it.

**Not the `conversationType` channel tag.** That tag is already in use for an orthogonal concept - `private` on the person-facing and federated paths, `briefing` on the proactive one - which `conversation-types.ts` warns about by name. Reading a type key from it would mean the day a deployment names a type `private`, a privacy tag selects a template.

## Decision 2: a type is uniform across its own conversations, and a change to it propagates

A type is operational configuration, not a historical record, so a change is presumed to be *for* the conversations that already exist. Every conversation of a type has that type's configuration, and where two conversations should differ, they are conversations of **different types**.

**The worked example, because it settles what would otherwise be a per-conversation question.** A public conversation with unauthenticated participants retains for far less time than an internal one. That is not two conversations of one type disagreeing about retention; it is a `public` type and an `internal` type, each uniform within itself. Reaching for a per-conversation value where two kinds of conversation differ is reaching for a type that has not been declared yet.

**And for that example, propagation is a privacy obligation rather than a consistency preference.** Shortening the public type's retention has to reach the public conversations that already exist, because those are exactly the ones carrying a minimization commitment about people who never authenticated. A dimension that fails to re-apply there is not an inconsistency between conversations; it is data retained past the period the deployment committed to.

**A `public` type still cannot invent a classification.** Unauthenticated participation is a question about what a participant reaches, which is a declared grant set ([ADR-046](./046-classifications-are-a-set-not-a-ladder.md)) and not a relaxation of an existing one. The type declares the experience and the retention; the classification declares the reach; and a deployment offering public conversations declares a classification for them. The public case is the clearest instance of that separation: a type cannot grant unauthenticated reach by declaring itself public.

Each dimension declares one of three dispositions, in the type definition where a reader meets the field:

| Disposition | Meaning |
|---|---|
| `live` | Read at the moment it is needed. A change applies everywhere at once and nothing has to be re-applied |
| `applied` | Written onto an AWS resource at creation, so a change reaches existing conversations only when something re-applies it |
| `effected` | A one-time action at creation. A later change is a new decision, not a correction, and nothing may re-run it |

Today `driftEnabled` is `live` and `expiration` is `applied`. **The remaining ten are OPEN**, and `classification` is the read decision 3 removes rather than a dimension to classify, because a disposition for a dimension nothing reads is a decision about future behavior and belongs with the work that gives it behavior. Naming the three classes now is what stops each future reader inventing its own answer.

**The distinction that carries the risk is `applied` against `effected`.** Re-applying a retention change is the intent. Re-adding an assistant is not: a type that later names a different assistant is not describing a mistake in the conversations already running, and removing one is a membership decision with its own audit trail. So a re-application mechanism must be able to refuse a dimension, and `effected` is that refusal.

**UNIFORMITY MAKES RE-APPLICATION A CORRECTNESS PROPERTY, NOT A CONVENIENCE.** If every conversation of a type has that type's configuration, then an `applied` dimension that has not been re-applied means those conversations have diverged from their own type. That is a defect rather than a lag, and it is the state every deployment is in today: `expiration` is `applied`, nothing re-applies it, so changing a type's retention changes it for conversations created afterwards and for nobody else.

**The one exception, and it is bounded in one direction only.** Retention has a per-conversation override, accepted at creation as retention toggle 3 and ranked above the type's value. **A type's retention is a MAXIMUM: a conversation may choose shorter and never longer.** So the override is not a competing configuration, it is a conversation electing to keep less than it is allowed to, which is always safe and needs no permission.

**That makes re-application CLAMP rather than skip**, and the difference matters. If a type's retention shortens from ninety days to fourteen, a conversation that elected thirty is now above the deployment's maximum, so skipping it would leave it retaining data the policy no longer allows. Re-application therefore lowers any value above the new maximum and leaves anything already below it alone - which needs only the maximum, not a record of who chose what. A conversation electing less than the type allows is indistinguishable from the type having allowed less, and nothing needs to tell them apart.

**A legal hold is therefore not expressible as retention here**, because it would require keeping data longer than the deployment permits. That is the correct answer rather than a limitation: a hold that outlives a deployment's stated maximum is a decision about the maximum.

**THE TYPE'S CAP IS NOT ENFORCED, which is a defect rather than a subtlety.** The creation path validates an override against the DEPLOYMENT's limit, `MAX_CONVERSATION_TTL_DAYS`, and never against the type's own value: `expirationOverride ?? getConversationTypeConfig(typeKey).expiration` takes the override outright. So a caller can create a conversation retained for the deployment limit of 270 days under a type whose policy says 30, and nothing refuses it. The limit does bind, so the fifteen-year conversation that Amazon Chime SDK's own bound of 5475 days permits is refused. Recorded as its own row; it is a data-minimization hole independent of everything else here, and it is the reason this section says maximum rather than default.

## Decision 3: a type inherits its defaults, except the two things that must be said out loud

A type declares what differs and inherits the rest, as an assistant profile does. A catalog meant to grow is unmaintainable if every type restates every dimension, and a restated default is a default nobody notices drifting.

**Two dimensions are never inherited and never defaulted: the classification, and the message flow.** Both decide whether the conversation works at all rather than how it behaves, and both have a failure mode that is silent.

- **The classification** is the only closed axis IAM evaluates. An inherited one is a grant set arriving from somewhere other than the conversation. That is the hole the field opens: where a type is selected by fall-back, reading a classification off the selected type yields a value that is not the conversation's, and the drift path is the one caller that does read it. [ADR-046](./046-classifications-are-a-set-not-a-ladder.md) already settles the rule - an undeclared grant set reaches nothing rather than falling back to a floor - so **type resolution refuses an unregistered classification rather than defaulting to a type**. That is a stronger fix than removing the field it was read from: deletion removes one reader, refusal removes the whole class of a type being selected for a conversation it was never declared for.
- **The message flow** decides whether anybody in the conversation can be addressed. Every type names it, even while every type names the same one, so a new type cannot acquire routing by accident or lose it by omission.

**Inheritance grows the blast radius, and that is an argument for decision 6's label rather than against inheritance.** A change to a base moves every type that inherits it, which under decision 2 is the intent and is also the largest single edit anybody can make. Validate-then-activate is what stands between that edit and the whole catalog.

**And provenance fingerprints the RESOLVED configuration, not the declared delta.** A record saying "type `support`, delta v3" is not interpretable on its own: reading it later needs the base's history as well, and the base changed independently. Fingerprinting the resolved result keeps one conversation's record self-contained, which is the reason it is in the archive rather than in a table that has to be joined.

**The rule is declared now and the registry stays flat until a second type would share a base.** Three types that each mirror a classification have nothing to inherit from one another, and a hierarchy with one level is machinery pretending to be structure. Declaring the rule now is what lets the catalog grow into it without a reader inventing its own precedence.

## Decision 4: a type that declares who belongs enforces it, and a type that does not is manual

Membership today is several mechanisms with no common policy: the creating paths, plus `share-conversation` as a member-initiated invite that reads the immutable classification tag and fails closed, plus a host's add (`membershipHandler` in `conversation-management`) driven by a host identity provider, plus `admin-conversation-sync` - which is already the mechanism this decision proposes, hardcoded to one case.

**That last one is the argument for this decision and it is measured rather than imagined.** `admin-conversation-sync` resolves the Cognito `admins` group, adds members who are missing, **removes the humans who are no longer in the group**, converges the moderator set the same way, and runs on a schedule. It filters to humans explicitly - `if (arn.includes('/user/')) currentHumans.add(arn); // humans only; never touch bots` - which is the detail the rest of this decision depends on. What is missing is none of the mechanism: it is that the group is read from a context value rather than declared by a type.

A type declares a **membership source**, and **declaring one means enforcing it**. That is the whole rule, and it is worth stating as a test rather than as a mode list: a declared source nobody acts on is a convenience list, and a conversation whose roster anybody may add to is `manual` however the type describes itself. There is no useful third state between the two, and inventing one produces a dimension that reads as a boundary and is not - which is the failure this record keeps circling.

| Source | The allowed set | Enforcement |
|---|---|---|
| none | Anyone a member or moderator may add | **`manual`.** Additions and removals are individual acts with their own audit trail, and nothing reconciles |
| `group` | The members of a named identity-provider group | Enforced: the allowed set is the group |
| a declared list | The participants it names | Enforced: the allowed set is the list |
| both | The **union** of the group and the list | Enforced against the union |

**One mechanism, three ways to compute a set.** The modes are not four behaviors; they are one reconciliation against an allowed set, and they differ only in how that set is computed. `manual` is the absence of a set rather than a fourth algorithm. That is what makes this buildable in one piece instead of four, and it is why the union case needs no separate design.

**THE ALLOWED SET AND THE ENFORCEMENT LOOP ARE HUMAN-ONLY.** Assistants are channel members - the one that creates a conversation is a member by being the bearer, and the battle path adds more - and no membership source names a bot. Under this record `defaultAgents` would add them and would be `effected`; nothing reads it today. So a loop that removed everything outside the allowed set would remove every assistant from the conversation on its first pass, which is both the feature deleting itself and a direct collision with decision 2's rule that re-adding an assistant is never the intent. Assistant membership is governed by `defaultAgents` and is `effected`; the existing reconciler already draws this line and is the precedent for drawing it.

**Enforcement means removal, so every declared source removes people.** A human outside the allowed set is removed, and that is a write on somebody's behalf performed because a directory changed rather than because anyone asked. It is the part of this decision that deserves a second look before it ships, and it applies to all declared sources rather than to one of them: a list a person has been taken off enforces exactly as a group they have left does.

**AND IT UNDOES AN INVITE, WHICH HAS TO BE DECIDED RATHER THAN DISCOVERED.** `share-conversation` lets a member invite somebody, checks the classification, and succeeds. On a type with a declared source the next reconciliation removes them, with no message to the inviter, the invitee or the room. Two answers are coherent and this record does not pick one: the share API refuses on a type with a declared source and says why, or the declared source is a floor that adds and never removes - which is a different decision from the one above and would need its own name, because it is not enforcement. **OPEN**, and it blocks the declared sources rather than `manual`.

**A declared source is therefore continuously satisfied, never satisfied at creation.** A group is a live fact and a list is an edited one, so neither is settled by adding the right people once. This makes membership the first genuinely reconciled dimension in the registry, and the case that proves a reconciler has to be able to refuse a dimension, because the same sweep must not touch a `manual` conversation's roster or any conversation's assistants.

**The two sources have different triggers, and only one of them is covered by decision 5.** A declared list lives in the type, so editing it is a deploy or a parameter change and decision 5's event model covers it exactly. **A person leaving an identity-provider group is not a type change and emits neither of decision 5's events**, so for a group the sweep would be the primary mechanism, which is the one thing tenet D6 forbids. Two ways out, and this record picks neither: subscribe to the directory's own event where it has one, which on a Cognito deployment means the group-membership API calls and on a host-owned provider may mean nothing at all; or accept it as tenet D6's stated exception, since a person's absence from a group is the absence of an event on the platform's side. **OPEN**, and it is the reason a group costs more than a list.

**Where it sits in decision 2's dispositions.** A declared source is `live` in effect and `applied` in mechanism: the allowed set is read when it is needed, and the channel's actual roster is a resource that has to be brought into line with it. `manual` is `effected` - membership was decided at creation and afterwards by hand, and nothing re-derives it.

**THE ADMISSION CHECK IS WORK THIS DECISION SCHEDULES, NOT A PROPERTY IT INHERITS.** A member resolved from a group must be admitted at the conversation's classification, and the honest statement of today is that no group-sourced membership path checks anything: `ParticipantPolicy` declares the intent in a docstring and is read by nothing, and the existing reconciler adds group members as the service app-instance-admin with no classification test at all. By this record's own rule at the top - a behavior described for an unread dimension is a plan rather than a finding - the reassurance would be exactly the kind of claim this document keeps catching. So: the enforcement loop calls the admission registry itself, a person in the group who is not cleared is never added, and that refusal is a settled state rather than a discrepancy the loop retries forever.

**And the reconciler's own principal is the same IAM question decision 5 refuses to defer, on a stronger action.** The existing sweep holds `chime:CreateChannelMembership` and `chime:DeleteChannelMembership` across the app instance with no classification tag condition. Those calls are authorized against the channel and the bearer, both of which can be conditioned (`membershipAsAssistantStatements` does it for share, Battle Mode and federated sharing); only the member being added is invisible to IAM (`backend/scripts/deny-test-assistant-membership.mjs`). Generalizing that to every conversation produces an unconditioned cross-classification membership writer, which is precisely what Phase 1 says this record must not introduce while arguing the tag is the only closed axis IAM evaluates. One reconciler per classification keeps a boundary and costs N; one across all of them is cheap and removes the condition from the most consequential write in the platform. **OPEN**, and not out of scope.

**That is the reason a type declaring a source also declares its allowed classifications** (decision 1). A roster drawn from an organizational group is only safe at the classifications that group's members are cleared for, and the type is where that pairing is stated.

**Every removal is recorded naming the person, the conversation and the source that decided, and that is a requirement rather than an implication.** Decision 2 says a removal is a membership decision with its own audit trail, and the existing reconciler does not meet that bar: it emits counts. Tenet D4 requires a recorded grant, and a person removed from a conversation with no record of what decided it is the audit finding this design would otherwise create.

**Not all at once, and the order follows the cost.** `manual` is today's behavior and needs nothing. A declared list is the simplest allowed set and the cheapest place to build the enforcement loop once. A group needs group resolution, which is an identity-provider capability rather than a platform one and may not exist on every deployment. The union needs nothing beyond both. Phase 1 needs none of it.

## Decision 5: propagation is triggered by an event, and a sweep only ever sits behind one

Tenet D6 calls a low-frequency reconciliation sweep **behind an event path** correct design, and is explicit about what it may never be: "the sweep is a correctness backstop, never the primary mechanism."

An event exists at both storage stages, so no timer is needed as the mechanism:

- **While configuration is compiled**, a deploy is the event. Re-application runs at deploy time, gated on the configuration's own fingerprint changing, so a deploy that does not touch a type re-applies nothing.
- **Once configuration moves to SSM** (decision 6), Parameter Store emits a change event, so the trigger follows the edit.

A sweep is then legitimate as a backstop behind either, because events get dropped and handlers fail. It must be idempotent, must report what it would change before it changes anything, and must refuse every `effected` dimension.

**Re-application is required rather than optional, so the IAM question below has to be answered rather than deferred.** Decision 2 makes a type uniform across its own conversations, which an un-reconciled `applied` dimension breaks by definition. For the public-conversation case it breaks a retention commitment, so this is the step that carries the obligation.

**Whether re-application is one cross-classification worker or one per classification is OPEN, and it is an IAM question rather than a preference.** The existing `chime:PutChannelExpirationSettings` grant sits on the per-classification assistant roles and is conditioned on the channel's classification tag. A single worker sweeping every conversation needs that write without the tag condition, which takes the action outside the only closed axis IAM evaluates. One worker per classification keeps the condition and costs N workers. The cheap option is the one that weakens the boundary, and that trade is not this record's to make silently.

## Decision 6: storage moves to SSM after the dispositions exist, and the label indirection is the precondition

Not first, and the order is the decision rather than the destination.

Moving the registry to SSM buys live editing and the profile lifecycle. Doing it before decisions 2 to 5 buys live editing over a bundle whose propagation nobody has decided, which is worse than a deploy: a deploy is dated, reviewed and attributable.

**And it follows the profile precedent including the part that makes the precedent safe.** A profile edit is not live when it is written; it is live when the `active` label moves. Under decision 2, where a `live` dimension changes behavior everywhere the moment it is written, storage without that indirection means an unreviewed parameter edit changes every conversation at once. So versions plus a movable label are a precondition of the move, not a benefit of it.

**A change audit is a precondition too.** While types change by deploy, the deploy is the record. An SSM edit has no such record, and decision 2 makes most dimensions propagate, so the move without an audit means behavior changing everywhere with no attributable cause.

## Decision 7: an archived conversation is interpretable because provenance is an event, not a pin

Two events, both archived, both append-only:

- **At creation**, the resolved type key and a fingerprint of the configuration in force.
- **At every change**, the type that changed and its new fingerprint.

Together they answer "which configuration was in force for this conversation at this moment" by replay, for a conversation that has since been archived or deleted, without freezing anything.

**Why not pin a conversation to a version.** It is coherent for a profile and incoherent for a type, and the difference is what each decides. A profile decides what an assistant *says*, where serving last month's version is merely an older answer. A type decides what a conversation *reaches* - which transports, which participants, which external systems - where serving last month's version is a stale grant. Pinning would also defeat the corrections that motivated this record: a pinned conversation does not pick up a renamed group either.

**This narrows tenet P3, which has to be said rather than done quietly.** Tenet P3 names "a conversation snapshots its policy" as one of three forward-compatibility mechanisms. This record replaces a snapshot of the policy with a record of it, keeping the property tenet P3 wanted - an old conversation is interpretable by new code - through an append-only event rather than a frozen copy. `docs/overview/TENETS.md` and `SPEC-CONVERSATION-TYPES` FR13, its open question about what a snapshot contains, its standing invariant in the catalog-growth appendix, and the operator persona row that promises it all change with it. The additive-schema anti-goal does not: it stays true under this record.

**What provenance depends on, stated plainly:** it lives exactly as long as the archive's objects do, and today that is 90 days. The archive construct carries a hardcoded lifecycle - infrequent access at 30 days, expiry at 90 - with no prefix filter, no context switch and no test, which `SPEC-ACCESS-AND-CONTROLS-AUDITING` FR12 already records as a retention default pointed the wrong way for a system of record. A conversation whose retention counts from its last message can outlive that easily, so a creation-time provenance record would be deleted while the conversation it describes is still running. **Fixing that lifecycle is a precondition of this decision rather than a deployment preference, and it is OPEN.** It remains the reason provenance belongs in the archive rather than in a store that can be written over in place: the fix is a lifecycle, not a different store.

## Phase 1: the smallest thing that gives a working `ops` conversation

**BUILT, deployed and exercised.** All five items below ship: the `ops` type, the `defaultAgents` resolver, the type stamp and the two reads that honor it, the event-initiated entry on the canonical creator, and the one Lambda. Verified against a live deployment: an `ops` conversation was opened from an event concerning a premium group conversation, and carries thirty days of retention rather than the classification's ninety, the `premium` tag, four members (both humans carried, the primary as the creating bearer, and the assistant the type names), the flow association, and the type key recorded where the turn path reads it - with exactly one message in the conversation the event concerned. Both refusals were exercised: an unknown type key, and an event naming a conversation at another classification. The classification pin is deny-tested on three axes.

**Deliberately a subset.** None of the propagation, storage or provenance machinery above is needed for a first conversation of a new type, because a brand-new type has no existing conversations to reconcile and no history to interpret. Phase 1 is scoped by that, not by what the record eventually asks for.

**What it builds.**

1. **The `ops` type in the registry**, declaring its allowed classification (`premium`) and its message flow explicitly, per decisions 1 and 3. Drift off, retention shorter than an ordinary conversation, no membership source declared, which is today's behavior, so decision 4 costs Phase 1 nothing.

   **A precondition that is not Phase 1's work and blocks it anyway:** the `ops` role's bot, its Amazon Lex bot and its assignment record exist only where the deployment declares the role (`ops-premium` in `profiles` in `deploy.config.json`). Without that, the resolver in item 2 finds nothing and Phase 1's own refusal rule turns the demo into a hard failure at creation rather than a degraded one.
2. **A reader for `defaultAgents`**, which is `SPEC-CONVERSATION-TYPES` FR6 and the dimension its own OPEN note names as the one to read first. It needs a resolver from an agent handle to a bot ARN: the assignment records at `/{root}/assistant-assignments/{classification}/{role}/live` carry `assistant` and `botArn`, so a handle resolves by matching `assistant` within the conversation's classification. The classification's primary is also published at `/{root}/assistant/{classification}/bot-arn`, and Phase 1 uses the assignment records for both rather than special-casing the primary, because the two paths are not interchangeable and the coincidence that each shipped classification has a profile of the same name hides that.
3. **A stamp, and the reads that honor it - without which the type is inert.** Every consumer resolves a type config by the CLASSIFICATION today, not by a type key: the creator reads `getConversationTypeConfig(input.modelTier)`, and `resolveConversationTypeKey` falls back to the classification because nothing records an explicit type on a conversation. So a conversation created "of type `ops`" would resolve to type `premium` for its whole life - premium's retention, and drift ON despite the type declaring it off. Phase 1 therefore records the resolved key in the server-side conversation-context store, and the two places that decide use it: the creator is GIVEN the key as an input and looks the config up by it rather than by the classification, so the type's own `expiration` reaches the channel; and the turn path READS the stamp, so `driftEnabled` is the type's. The turn-path half is cheaper than it sounds - the drift gate already accepts a `conversationType` argument and no caller supplies one, so it is passing a parameter that exists rather than threading a new one. **Without this item the other three produce a type in name only**, which is the failure this whole record keeps circling: a dimension that looks configured and is read by nobody.
4. **An event-initiated entry on the canonical creator**, which today requires a drift origin. It takes the type key, the classification, and the conversation the event concerned. Three things the drift entry does that this one must not:

   - **It posts its own hardcoded message into the parent** - "Moved X to its own conversation" - so an event-initiated creation that also posts a notification would put TWO bot messages in the concerned conversation, one of them describing something that did not happen. The entry suppresses the creator's message and the notification is the only one.
   - **It stamps `createdViaDrift: true` into channel Metadata** and mints a channel id of the form `conv-drift-<timestamp>-<hex>`, both member-visible. An `ops` conversation branded a drift child is a thing an audience reads on screen.
   - **It writes the topic label as drift carry-over** for the welcome composer, which would have the assistant open by referring to a prior subject that does not exist.
5. **One Lambda, reached by a declared event or a manual invoke.** A type declares the events that open it (`openedBy`), and the classification stack builds one EventBridge rule per declaration whose target input is the declaration's id and the event (`{ aeOpener, event }`), so the type is the declaration's and never the event's, and the classification is the one the function was deployed with. It posts nothing into the conversation the event concerned, creates the typed conversation with the agents the type names, and welcomes the person the event named and the type's admitted people into the new conversation by email, as its primary (`memberWelcome` through the router). Verified by `test/event-opened-conversation-rules.test.ts`, `test/lib/an-event-opened-conversation-welcomes-its-people-by-email.test.ts` and `test/lib/a-typed-conversation-posts-nothing-into-the-concerned-room.test.ts`.

**What Phase 1's scope actually is, because it is narrower than "conversation types work".** The type is honored for conversations created through the canonical creator.

**The person-facing API honors its type through the consolidation below.** That path creates through the same canonical creator, so it carries its type's retention, agents and flow. What it still cannot do is be TOLD which type: the API takes no `conversationType` parameter, so the key it stamps is always the ordinary type, `general`, and that is the only type a person can open. That is why a `public` type cannot ship - not because the path ignores types, but because nothing can select one.

**The six choices that decide whether Phase 1 costs anything later.**

- **The `defaultAgents` reader goes in the canonical creator.** Five implementations issue `CreateChannel`, and four of them create a conversation, and a type can only mean something if one of them owns creation. Reading it anywhere else makes the type work on one path and silently not on the rest.
- **Agents are added through their own parameter, and a failed add fails the creation.** They must not ride the human carry-over list, whose loop is deliberately tolerant of a per-member failure: a failed add there is logged and the creation still succeeds, which would deliver exactly the one-assistant conversation this phase claims to refuse. Two lists, two failure semantics, because a person missing from a conversation is a degradation and an assistant missing from it is the feature absent.
- **The classification comes from the caller as a parameter, and the type constrains it.** The creator refuses a classification the type does not allow, per decision 1, so the type's declaration is a check rather than a value to be read.
- **AND THE TRIGGER'S OWN PRINCIPAL IS PINNED, because a manually invokable creator is otherwise a create-at-any-classification primitive.** Every existing creating path is bounded by a deploy-time classification plus IAM conditioning `chime:TagResource` on `aws:RequestTag/classification`. A Lambda that takes the classification from its payload with no such pin can stamp any tag it likes, which is the one thing this record must not introduce while arguing that the tag is the only closed axis IAM evaluates. Phase 1's role is pinned to one classification at deploy and its tagging is conditioned the same way.
- **The message flow is associated at creation**, and the key-to-ARN step does not exist yet. One unkeyed parameter publishes the flow ARN today and `resolveMessageFlowKey` has no production caller, so Phase 1 maps the key `default` onto that parameter and publishes no keyed namespace. The new caller also needs all three resource legs of the `AssociateChannelFlow` grant - the channel, the bearer, and the channel flow itself - which is a policy shape already paid for once over seven days of denials, and has its own guard test. Every CONVERSATION creator associates a flow today, including the proactive one, each resolving the same unkeyed parameter separately - which is uniformity by coincidence rather than by declaration, and is the reason decision 3 makes the flow non-inheritable. The fifth `CreateChannel` site is the admin notification channel, which associates none and sets no classification tag; both are recorded as known gaps and that channel is out of scope for types. What the proactive path actually omits is the channel context write, recorded as a known gap by `single-entry-point.test.ts`, which for Phase 1 matters because item 3 stamps the type there.
- **The type key is stamped in the server-side conversation-context store, and that is the READ path rather than the record.** The creator already writes there, so the write costs nothing structural - with one trap: that store's field allowlist silently discards a key it does not name, and the file says so in terms, that a forgotten entry looks exactly like a working write. The new field goes in both the type and the allowlist or item 3 ships as a no-op that passes review. **It is still not provenance**: the store is mutable and last-write-wins, so decision 7's archived event remains the durable answer. Two stores, two jobs, and Phase 1 builds only the one it cannot work without.

**What Phase 1 does not do, stated so the gap is not mistaken for a property.**

- **No propagation.** Changing the `ops` type's retention or any other `applied` dimension reaches conversations created afterwards and no others. For the `public` type in decision 2 that would be a retention commitment broken; for `ops` on a demo deployment it is a lag nobody is relying on. **The order matters: a `public` type must not ship before decision 5.**
- **No provenance.** An archived `ops` conversation will not say which configuration produced it.
- **No SSM, no inheritance, no per-conversation override.** Type changes are a deploy, the registry stays flat, and `ops` declares every dimension it uses.
- **It does not fix the sibling bug.** That is the drift path, a different caller, and Phase 1 neither worsens nor depends on it.

## The full implementation consolidates conversation creation, and that is not tidying

**Five implementations issue `CreateChannel`, and four of them create a conversation, and a type can only mean something if one of them owns creation.** This is tracked as deferred maintenance and is a prerequisite here: without it, every decision above applies to whichever conversations happened to be created through the right function. The person-facing route and the event-initiated path create through the canonical creator, so a type is honored on both. The federated and proactive creators do not, and a type means nothing on them until they do.

**What consolidation has to deliver for types**, which is narrower than making the six identical: one place that, for every created conversation, resolves the type, stamps it where the read paths can see it, associates the flow the type declares, applies the type's own expiration, and adds the agents it names. Everything else the six do differently can stay different.

**The blocker is one Lambda rather than six, and it is cleared.** The person-facing route, the path an actual person uses to open a conversation, serves `src/create-conversation.ts`, a bundled function that calls the classification registry and the canonical creator directly, so classification admission is read from the registry rather than mirrored into the function's environment. The remaining three create through the same canonical creator: a host's context conversation, a host's add (which creates a conversation that does not exist yet and adds its member as a member, never a moderator) and `proactive-briefing` (which has no opener, so every recipient is a member and only the assistant moderates).

**One of the six is deliberately out of scope.** `admin-notification-channel-provision` creates the single admin notification channel as a CloudFormation custom resource. It is not a conversation of a type and will not become one, so folding it in buys nothing and costs the provisioning lifecycle that owns its identity.

**The ordering this produces.** Phase 1 gives a working `ops` type on the canonical path, which is enough to record. Consolidation makes types apply to every conversation. Only then are the propagation, storage and provenance decisions buildable against one creator instead of six, which is why they sit after it rather than beside it.

**What proves Phase 1**, distinct from what proves the record. Every line below that is a property of the creating call is asserted by `an-ops-conversation-is-its-type-and-not-its-classification` or `a-handle-with-no-assistant-is-refused`; the two that are not are marked.

- A conversation created of type `ops` carries the classification the caller supplied, and a caller naming a classification the type does not allow is refused before a channel exists.
- **A deny-test on the trigger's own principal:** it cannot create or tag a channel outside the classification it is pinned to. Phase 1 introduces a new channel-creating principal, and tenet P4 says isolation is proven by a deny-test rather than by a code review. Proven on three axes against the deployed role by `a-typed-conversation-creator-creates-at-one-classification`: it may stamp its own classification and no other, read the membership of a conversation at its own classification and no other, and enumerate its own classification's assignment records and no other. Each axis alone is bypassable, which is why all three are asserted - a role pinned on tagging alone could still read a higher classification's roster and carry those people into a conversation at its own. `chime:CreateChannel` is deliberately unconditioned and asserted as such: the tag that would gate it does not exist until the channel does, so the role can create an UNTAGGED channel, which every per-classification identity is fail-closed on and which is therefore inert rather than a way in.
- Both named agents are members, and a failure to add either one fails the creation rather than being logged.
- The flow is associated, asserted by something arriving through it rather than by the association call returning. The association is confirmed on the live channel, and the assistant the type adds welcomed itself in the conversation in its own voice - which proves it is a member Amazon Lex fires for and that the flow did not swallow the turn. **An addressed turn (`@ops`) remains OPEN**, and it is the one thing only a person in the chat app can show.
- The type's own retention and drift settings are what the conversation has, which is the item-3 proof and the one that catches the type being inert.
- Nothing lands in the concerned conversation (`a-typed-conversation-posts-nothing-into-the-concerned-room`).
- Only a declared rule reaches the creator through EventBridge, and no rule carries a classification: the creator's resource policy admits each rule's ARN alone, and a declaration reading a classification or a type from the event fails synth (`event-opened-conversation-rules`; on a deployment, `a-typed-conversation-creator-creates-at-one-classification` reads the deployed policy).
- An agent handle that resolves to no assignment record is refused rather than producing a conversation with one assistant in it.

## What proves it

Nothing here is proven, and none of it should be accepted on a reading of the code. The defect this record grew out of admits three readings, and three readers produced three different answers before anybody proposed a deny-test.

- **Provenance replay** - a conversation created under one configuration, changed twice, then archived, replays to the correct configuration for a point in the middle. The test that matters is the one after the channel is deleted, because that is the case the archive exists for.
- **Precedence** - a conversation whose retention was set by request is untouched by re-application, asserted against the deployed channel's `ExpirationSettings` rather than against the re-applier's own report.
- **`effected` refusal** - re-application offered a type whose `defaultAgents` changed adds nobody. This is the safety-critical one: a sweep that re-added assistants would undo membership decisions people made deliberately.
- **Idempotency** - two consecutive runs, the second a no-op.
- **Event-triggered, not timed** - a deploy that changes no type re-applies nothing, asserted on the fingerprint gate rather than on the absence of log lines.
- **A bot member is never removed by enforcement**, which is the case that fails loudest if the allowed set is not human-only: the assistants leave the conversation and the feature deletes itself.
- **A human outside the allowed set is removed, and the removal is in the audit record** naming the person, the conversation and the source that decided it. Counts are not that record.
- **A group member the classification refuses is not added, and the loop settles** rather than retrying the same refusal forever.
- **A deny-test on the membership reconciler's principal**, which is the stronger version of the one below: membership is a heavier write than retention and carries no tag condition today.
- **A deny-test for the IAM question in decision 5** - whichever shape re-application takes, that its principal cannot write to a channel outside the classifications it is scoped to. If the answer is one cross-classification worker, this is the test that states the cost honestly.

## What this does not decide

- **The ten dimensions with no disposition.** Each is decided by the work that gives it a reader, and assigning one now would document behavior that does not exist. **OPEN.**
- **Whether re-application is one worker or one per classification.** An IAM trade, stated in decision 5, not resolved. **OPEN.**
- **Who may edit a type**, and under which capability, once editing is a runtime operation rather than a deploy. The nearest existing entry, `view-config`, is declared unwired on the reasoning that runtime configuration *is* the profile registry - which stops being true the moment this lands. **OPEN.**
- **What a per-conversation override of a non-retention dimension means.** Retention has one; nothing else does. Whether that generalizes is **OPEN**, and decision 2's precedence rule is written to accommodate it without requiring it.
- **The fingerprint's shape.** `metadataSchemaVersion` is declared and unread and is not this: it is the additive-compatibility version, which answers whether old data can be read by new code, not which configuration produced a conversation.
