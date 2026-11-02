---
title: "ADR-042: An assistant acts in exactly one classification"
status: >-
  Accepted 2026-09-16, BUILT and deployed. An assistant's IAM permitted it to act in its own classification AND every classification it granted, because the helper that builds that boundary is shared with the Cognito user roles and the grant set is correct for a PERSON. No argument was ever made for it on the assistant side; it was an inheritance rather than a decision. The resolver is now split: `classificationChannelScopedAllow` takes an explicit `actor`, and every assistant role is generated with `actor: 'assistant'`, which resolves to `channelsAnAssistantMayActIn` - its own classification alone. Verified by: `backend/test/lib/an-assistant-acts-in-exactly-one-classification.test.ts`; generated at `backend/lib/stacks/assistant-profile-stack.ts` and `backend/lib/stacks/agent-classification-common.ts`. An assistant still READS context from the set its classification grants; only the acting boundary narrowed.
date: 2026-09-16
related:
  - "./028-vector-store-classification-boundary.md"
  - "./032-where-a-rule-runs.md"
  - "../../overview/TENETS.md"
  - "../../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md"
  - "../../specs/interaction/governance/ACCESS-CONTROL-BY-EXAMPLE.md"
  - "../../specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md"
  - "../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md"
  - "../../../backend/lib/stacks/agent-classification-common.ts"
  - "../../../backend/lib/profile-registry.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
  - "../../../backend/lib/stacks/channel-flow-stack.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/assistant-async-processor.ts"
  - "../../../backend/lambda/src/membership-audit.ts"
  - "../../../backend/lambda/src/task-service.ts"
tracking: |
  Accepted 2026-09-16, BUILT and deployed. The split resolver is in
  `backend/lib/stacks/agent-classification-common.ts`, verified by
  `backend/test/lib/an-assistant-acts-in-exactly-one-classification.test.ts` and by the live deny-test
  `tests/e2e/assistant-classification-boundary.spec.ts`. The section "What is true today" is the
  before-state the decision is argued from: READ FROM CODE for what each component does and which
  resolver builds each boundary, and READ FROM THE DEPLOYMENT for the policy documents it quotes, read
  with `iam get-role-policy` and `lambda get-policy`, read-only, and labeled apart wherever they appear.
---

# ADR-042: An assistant acts in exactly one classification

## Status

**Accepted 2026-09-16, BUILT and deployed.** `classificationChannelScopedAllow` takes an explicit `actor`, and an assistant resolves to `channelsAnAssistantMayActIn` - its own classification alone (`backend/lib/stacks/agent-classification-common.ts`). **Verified by:** `backend/test/lib/an-assistant-acts-in-exactly-one-classification.test.ts` at the registry level and `tests/e2e/assistant-classification-boundary.spec.ts` as a live deny-test against the deployed processor roles.

**The recommendation: an assistant ACTS in exactly one classification, and keeps READING context from the set its classification grants.** Those are two different questions that one resolver answered before the split. [ADR-046](./046-classifications-are-a-set-not-a-ladder.md) replaces the rank ordering with a set, so where the body below says "rank and below", it describes the grant set as it was argued, and the set its classification grants is the as-built reading.

## Read this first

Every conversation carries an immutable `classification` tag, and every classification has its own assistant. The rule a reader would expect, and the rule `ACCESS-CONTROL-BY-EXAMPLE` already states, is that **a channel carries only its classification-matched assistant**.

The IAM that is supposed to enforce it does not say that. It says an assistant may act on its own classification and every classification below.

**This is not a decision anybody argued.** `backend/lib/stacks/agent-classification-common.ts:98-99` records why it is shaped this way:

> "Used for BOTH the per-classification assistant (async-processor) roles and the per-classification Cognito user roles - the same boundary, one definition."

The whole declared grant set is the right answer for a person. A premium user speaking in a basic room is ordinary. It was applied unchanged to the assistant roles, and the specs then documented the consequence rather than the intent.

**The owner stated the rule on 2026-09-13**, and it is recorded at the head of `backend/test/lib/an-assistant-is-assigned-one-classification.test.ts`. What followed was identity tagging and archival reporting. The IAM was never pinned, so the rule is recorded and unenforced.

## What is true today

### The assistant's own boundary is its whole grant set

`classificationChannelScopedAllow` conditions channel actions on `classificationsAllowedFor(classification)` (`backend/lib/stacks/agent-classification-common.ts:149`), which resolves through `ProfileRegistry.grantsFor`. No shipped classification declares `grants`, so every one falls through to `scopeAtOrBelow` (`backend/lib/profile-registry.ts:140`).

It is attached to the async-processor role (`assistant-profile-stack.ts:235`), the agent-handler role (`:1007`), the conversation-split role (`:1166`) and the drift channel-create grant (`agent-classification-common.ts:745`).

**Read from the deployment.** The premium processor role carries:

```
Sid: AllowGrantedClassificationChannelActions
Condition: StringEquals aws:ResourceTag/classification = ["basic","standard","probe","premium"]
Action: DescribeChannel, GetChannelMessage, ListChannelMessages, SendChannelMessage, UpdateChannel, UpdateChannelMessage
Resource: .../app-instance/<id>/channel/*
```

**So IAM permits the premium assistant to send into a basic or a probe conversation.** What stops it in practice is Amazon Chime SDK membership, because channels are `RESTRICTED` and the premium bot is not a member. That is a service-side membership check rather than the classification boundary, and it stops applying the moment the bot is added, which is the case the membership audit exists for.

### The handler asserts its classification rather than verifying it

`backend/lambda/src/router-agent-handler.ts:264-268`:

```ts
async function resolveChannelClassification(channelArn: string, botArn: string): Promise<string> {
  // Per-classification deployment: the handler IS the classification - no discovery needed.
  if (STATIC_CLASSIFICATION) return STATIC_CLASSIFICATION;
  ...
}
```

Every classification stack sets `CLASSIFICATION`, so the tag-read branch below that line is unreachable on every deployed topology. **The router never reads the conversation's tag and never compares it to its own.** Nothing anywhere in the handler refuses a mismatch.

**The async processor does not check either.** `CLASSIFICATION` is read from the environment and used only to label output (`assistant-async-processor.ts:2640`, and the analytics stamps at `:1618` and `:1910`). `lib/async-processor-core.ts` resolves no classification at all.

**One component does check, and its rule is the rank rule.** `backend/lambda/src/task-service.ts:219-282` reads the channel tag and refuses when `theirs > mine`, and an unreadable tag proceeds rather than refusing.

**What that means for a misrouted turn.** If the channel flow invoked the premium router for a `basic` conversation, the turn would be served as premium: premium model, premium context scope, premium guardrail, premium rate limit. Nothing refuses. Nothing logs, unless the SENDER's own grant set happens to exclude premium, which produces one `console.warn` and continues. The only detector is `analytics-aurora/kinesis-archival.ts:880-908`, which is Aurora-only, archival-lagged and log-only.

### No resource policy constrains the classification boundary

**Read from the deployment.** Each of the four agent handlers allows exactly one principal, the Amazon Lex service, pinned to the account with `AWS:SourceAccount`. Each of the four async processors allows exactly one principal, that classification's turn-recovery role. None of the four task services has a resource policy at all.

**A Lambda resource policy is additive for a caller that already holds an identity-policy grant in this account, which is every caller named above.** Same-account authorization succeeds on the identity policy OR the resource policy, so an Allow-only resource policy alongside an existing identity grant narrows nobody.

**It is NOT additive in three cases, and the distinction matters because two of them are live here.** A principal with no identity policy in this account, notably the Amazon Lex service principal these policies name, is authorized by the resource policy ALONE, so its `AWS:SourceAccount` condition is a real narrowing; `backend/lib/stacks/assistant-profile-stack.ts` makes this exact point for the router's Amazon Lex permission, that the Amazon Lex service principal alone would accept an invoke originating from any account. A cross-account caller requires the resource policy. And **an explicit `Deny` in a resource policy overrides every Allow**, which is how a resource policy can genuinely restrict a same-account caller; `PutResourcePolicy` accepts a full JSON document supporting `Deny`, where `AddPermission` and CDK's `grantInvoke` emit Allow only. The tree already relies on an explicit tag-conditioned `Deny` elsewhere, `DenyWriteOnArchivedChannel`, live on every processor role.

**So the accurate statement is narrower than "a resource policy cannot be a second layer".** No resource policy in this deployment carries a `Deny`, and every classification caller holds an identity grant, so **today** these policies add two principals and narrow nobody. A `Deny` naming everything except the classification's own handler would be a genuine second layer, and building one has two costs worth knowing before it is chosen: `PutResourcePolicy` REPLACES the whole document, so the Amazon Lex and turn-recovery statements have to be folded into it, and CDK models `AddPermission` rather than `PutResourcePolicy`.

**A caller that serves every classification reaches every classification's router, and names none of them.** The channel flow, post-processing and notifications invoke the routers (and the flow the task services) by a name pattern bounded to this instance and to a function carrying a `classification` tag (`routerByNameStatements` and `taskServiceByNameStatements` with `EVERY_CLASSIFICATION`, `agent-classification-common.ts`), and resolve the one ARN a turn needs from the classification's own parameter at call time (`resolveRouterArn`). That is the same reach a list of every deployed classification gave, without the list: a grant in a shared stack names a tag, never the set, so adding a classification changes nothing in that stack ([ADR-057](./057-assistant-stacks-come-from-the-registry.md) decision 6). The battle orchestrator invokes the routers the same way and no vend, since the router posts every line of a duel; and a duel's alt has its own Amazon Lex bot on its classification's router, so no battle handler stands between a person and that router.

**One grant crosses the boundary from the admin plane**: `admin-services-stack.ts` gives the admin-tasks handler invoke on `${STACK_PREFIX}*-TaskService*` (`taskServiceByNameStatements` with `EVERY_CLASSIFICATION`), conditioned on this instance's tag and a `classification` tag, which is every classification's task service from one caller. Administrators span every classification, so the reach is intended; what bounds a call is the task service, because `refusesChannel` (`task-service.ts`) refuses a conversation outside the set its own classification grants, and nothing in IAM separates one task service from another for this caller.

**Part of that is a naming accident worth recording.** CloudFormation truncates a generated physical name past 64 characters, so all four async processors are named `AgentEchelonClassification--AsyncProcessorA49E4D20-<suffix>` and are indistinguishable by pattern, and `probe` collides with `premium` on the handler and role truncation too, both becoming `AgentEchelonClassification-Pr-`. A name pattern cannot separate them.

**The exact ARN can, and only inside a stack.** `assistant-profile-stack.ts` names an exact ARN for `AgentHandlerSelfInvoke`, but that grant is same-stack. A cross-stack caller cannot name an exact ARN without taking a deploy-time value from every classification stack, which is the coupling decision 3 of ADR-057 removes: the cross-stack callers resolve the ARN by name at call time and are granted the tagged pattern above.

**So tenet D3 is unmet on this operation.** There is one enforcement layer, in the caller, and it is a function choosing the right ARN.

### Who is added has no IAM control

`chime:CreateChannelMembership` and `chime:DeleteChannelMembership` are authorized against the **channel** and the **bearer**, and never against the member: `MemberArn` is a request parameter, not a resource. Measured by `backend/scripts/deny-test-assistant-membership.mjs`: a `Deny` on the member's ARN was never consulted, CloudTrail records no resource for it, and the change succeeded on the strength of the channel. So **IAM** cannot say who is added or removed. It can say where and as whom, and it does: share, Battle Mode and federated sharing hold membership changes only on a channel and a bot carrying a declared `classification` tag (`membershipAsAssistantStatements`, `agent-classification-common.ts`), deny-tested in `tests/e2e/no-platform-role-speaks-as-an-assistant.spec.ts`. For a role serving several classifications the two legs are evaluated independently, so pairing the bot with the channel's own classification is the handler's. The conversation creators bear the service admin instead, and hold the change, with the moderator changes, only on a channel of their own classification and the admin's exact ARN (`membershipAsServiceAdminStatements`); the bearer leg carries no tag condition because the admin carries `classification=admin`, which matches no creator's classification. `backend/test/only-declared-speakers-can-speak.test.ts` refuses a membership grant on any resource without a classification condition, outside a named set of person and admin-plane roles.

**That is not the same as saying nothing prevents it, and conflating the two overstates the gap.** Amazon Chime SDK enforces its own role model underneath IAM, and its authorization-by-role table is explicit: on a channel whose `Mode` is `RESTRICTED`, a MEMBER may add another member only on an `UNRESTRICTED` channel, and a NON-MEMBER is refused outright. The table's legend defines that refusal as back-end enforcement: "even if correct Action/Resource context is specified in the IAM Policy, it will still be blocked". Only a **ChannelModerator** of that channel, or an **AppInstanceAdmin**, may add a member.

**Every conversation this platform creates is `RESTRICTED`** (`backend/lambda/src/lib/channel-creation.ts:733`, the one creator every origin now goes through), so the set of principals that can place an assistant into a conversation is not "anything holding the IAM action". It is the app-instance admin, and whoever is a moderator OF THAT CHANNEL. A role bearing its own classification's assistant reaches only the channels that assistant moderates. The creators bear the service admin, an app-instance admin that Amazon Chime SDK lets add a member to any channel, so for them the boundary is IAM's channel leg: a membership change only on a channel of their own classification.

**So the two layers tenet D3 asks for are present here and were mis-stated as absent.** IAM holds the action, Amazon Chime SDK holds the role, and the membership audit is a third, detective layer over both. What remains genuinely open is narrower and worth stating precisely: an **app-instance admin** credential, or a compromised moderator bearer, can still place a wrongly-classified assistant, and for those the audit is the only control and it is report-only by default.

Every ADMISSION path this platform owns binds correctly: `create-conversation` resolves the bot from the classification being created at, a host's add (`membershipHandler`) uses the context classification the registry names, and the channel flow resolves the primary bot from the tag. The membership audit detects a mismatch and, only when `membershipAuditEnforce=true`, revokes it. It is report-only by default.

**The exposure is not only out-of-band, and this is the strongest objection to decision point 3.** One in-band role family creates conversations: the drift channel-create grant (`driftChannelCreateStatements`, `agent-classification-common.ts`) gives every classification handler on an Aurora-mode deployment, the conversation split, the typed-conversation creator, the proactive briefing and federated add-member `chime:CreateChannel` bearing the service admin and only with `aws:RequestTag/classification` present and equal to the role's own, `chime:TagResource` pinned to that value and refused on a channel that already carries another (`StringEqualsIfExists` on `aws:ResourceTag/classification`), with the app instance and the bearer on a separate leg pinned to the requested value only, because a tagged create makes a dependent `TagResource` check against its bearer and the service admin carries `classification=admin` (measured 2026-10-16 on dev by `deny-test-assistant-membership.mjs`: with one leg the own-classification create was refused on `chime:TagResource` against the admin user; with the legs split it is allowed, and another classification's create, an untagged create and a retag of an existing conversation of another classification are refused), and `chime:CreateChannelMembership`, `chime:CreateChannelModerator`, `chime:DeleteChannelMembership` and `chime:DeleteChannelModerator` only on a channel carrying the role's own classification, bearing the service admin by its exact ARN. No creator bears an assistant: the builder refuses a role with no service admin at synth. Federated remove-member, which evicts bearing the room's assistant, holds `chime:DeleteChannelMembership` alone, only on a channel and a bot of its classification (`membershipAsAssistantStatements`). `ChannelBattleRole` holds `chime:CreateChannelMembership` and `chime:DeleteChannelMembership` only on a channel and a bot carrying a declared classification (`membershipAsAssistantStatements`, `battle-stack.ts`) and no send at all, but which alt it adds is a request parameter; the membership audit checks an alt against its classification like any assistant (ADR-045 decision 7).

**So "immutable" means not writable through `UpdateChannel`**, which is the property `router-agent-handler.ts:274-283` actually argues, and NOT that no role in the deployment can write it. Against a compromised or buggy handler role in Aurora mode, the tag the check reads is writable by the same role doing the checking. The check still refuses the misroute, the wrong-ARN and the ordinary out-of-band-membership cases; it is not a containment boundary against a compromised handler, and nothing here should be read as claiming it is.

**The audit is also one-directional.** It flags an assistant whose classification the channel's grants do not include. An assistant of another classification that the channel's grants do include is not flagged, on the reasoning that Layer 1 blocks it from acting.

## The distinction this record turns on

**Acting in a conversation and reading context are different questions, and `grantsFor` answers both.**

| Question | Right answer for a PERSON | Right answer for an ASSISTANT |
|---|---|---|
| Which conversations may this principal send and read in? | the set its classification grants | **exactly its own** |
| Which context corpora may it retrieve from? | the set its classification grants | the set its classification grants |

**The second row is deliberate and must not move.** Every profile declares `contextScope: 'granted'`, and three separate boundaries are generated from the same resolver: the S3 `context/` prefix grant, the pgvector `classificationScope` filter (`analytics-aurora/document-retrieval.ts:55-69`), and the per-classification Aurora reader roles of ADR-028 (`classification-boundary-sql.ts:185`). A premium assistant answering a premium conversation SHOULD draw on basic and standard corpora.

**So the fix is a split, not a narrowing.** What changes is the classification set used for CHANNEL actions by assistant-side roles. What does not change is `grantsFor` itself, the context scope, the retrieval filter, the Aurora readers, or the user-side credential-exchange roles.

## Options

**1. Leave it.** The membership audit detects the case and every platform path binds correctly. Rejected: the rule is already recorded as the owner's, the specs already state it as policy, and the gap is exactly the kind tenet D3 exists to refuse, which is one missed check being a breach.

**2. Pin `grantsFor` to a single value.** Rejected, and the blast radius is the reason. Premium would lose the `context/basic` and `context/standard` corpora, the retrieval filter would narrow, the Aurora reader role would stop seeing the rows of the other classifications premium grants, `admin` would lose the cross-classification reach its declared grant set exists to give it, and the USER-side exchange roles would narrow, which this record does not propose.

**3. Split the resolver: an assistant ACTS in exactly one classification and READS context from the set its classification grants. RECOMMENDED.** A separate accessor for the assistant channel boundary, leaving every context and analytics boundary on `grantsFor`.

**4. Narrow the four blanket invoke grants to exact ARNs.** Recommended ALONGSIDE 3 rather than instead of it. It removes a permission nobody needs and it is not by itself an enforcement layer, because the resource policies are additive for a same-account caller.

**5. Verify rather than assert in the handler. RECOMMENDED, and it is the load-bearing half.** The handler reads the conversation's tag and refuses a turn whose classification is not its own.

## Decision

**Each point is a rule rather than a preference.**

1. **An assistant acts in exactly one classification.** A person's reach is a ladder and an assistant's is a point, and the two stopped being the same question the moment every classification got its own assistant.

1a. **The admin assistant is covered by the same rule and loses nothing, because it was never a conversational assistant.** `admin` is an admin-plane classification, `ProfileRegistry.isConversational` refuses it on every creation path, and no `Classification-Admin` stack, role or function is deployed. Its cross-classification reach, which option 2 is rejected partly for removing, is a property of an administrator's USER clearance and of the admin-plane reads, not of an assistant's channel grant. Pinning the assistant boundary does not touch either.

2. **Reading context is not acting, and keeps the ladder.** A boundary that governs which conversations a principal may speak in is not the boundary that governs which corpora it may draw on. One resolver answering both is what produced this, and the split is the fix rather than a narrowing of either.

3. **A component that knows its own classification verifies the conversation's rather than asserting its own.** Returning a value that was never compared to anything is not a check. This is the layer that survives a widened grant, an out-of-band membership and a caller choosing the wrong ARN, and it is the only layer that can refuse a bot already sitting in the wrong room. The grant it needs already exists: every handler role holds `chime:ListTagsForResource` on `channel/*` (`assistant-profile-stack.ts:997`), so this costs no IAM change.

3a. **AN UNREADABLE TAG DOES NOT REFUSE, and this clause is not optional.** The check reads through `readChannelClassificationTag` (`backend/lambda/src/lib/channel-classification.ts:63-82`), which returns `undefined` when the tag is missing, invalid or unreadable, and NOT through the resolver that falls closed to the floor value. A handler comparing its own classification against a floor-defaulted read would refuse every legitimate turn during an Amazon Chime SDK throttle, which is exactly the defect `task-service.ts:239-252` records backing out of: refusing on an unreadable tag let a throttle impersonate a policy decision and silently drop real work. A mismatch refuses; an unreadable tag proceeds and is reported.

4. **An invoke grant names the function it needs.** A wildcard over a classification namespace is a permission to cross the boundary the rest of this record is about. Where a generated name cannot be matched, the exact ARN is used, which the tree already does in one place.

5. **An Allow-only resource policy is not a second layer for a caller that already holds an identity grant here, and an explicit `Deny` is.** Lambda authorizes same-account on the identity policy OR the resource policy, so adding an Allow narrows nobody. A `Deny` overrides every Allow and does narrow, and it is the form this boundary would use. A claim that a resource policy constrains this boundary states which principal it denies; every resource policy in this deployment today denies none.

6. **The containment claim in the specs is corrected rather than kept.** Two documents state that Layer 1 keeps a wrongly-added member inert. That is true of a human not cleared for the channel and false of an assistant of another classification, which is the case the same paragraph says Layer 1 does not stop.

7. **This boundary is proven by a deny-test, not by reading a policy.** Tenet P4 asks for isolation provable by deny-test, and no test today proves an assistant cannot act in another classification's conversation. The tests that exist pin the permissive behavior.

## What proves it, and what does not

**Read from the deployment, 2026-09-16, read-only.** The premium processor role's `AllowGrantedClassificationChannelActions` statement and its classification list. The resource policies on three agent handlers, three async processors and one task service. The channel flow processor role's `Classification-*` invoke resource.

**Read from code, not measured.** Every claim about which resolver builds which boundary, and every claim about what the handler and the processor do and do not check.

**Existing tests this record leans on, and what they actually pin.** `backend/test/cdk-synth.test.ts` asserts the premium assistant reaches `basic, standard, probe, premium`, so it **pins the permissive behavior** and will fail when this changes, which is correct and is the signal rather than an obstacle. `tests/e2e/classification-context.spec.ts` is a real deny-test using `simulate-principal-policy`, and it asserts premium CAN read the lower context prefixes, which decision point 2 deliberately keeps true.

**Not proven by anything, and this is the gap the change owes:** that an assistant cannot act in another classification's conversation. `tests/e2e/assistant-classification-boundary.spec.ts` simulates channel actions by each classification's assistant against another classification's channel, and `tests/e2e/no-platform-role-speaks-as-an-assistant.spec.ts` checks that the roles changing membership bearing an assistant are conditioned on the channel's and the bot's classification. Nothing can test which member is added, because IAM never sees it.

## What is not yet knowable

- **Whether any deployment depends on an assistant acting below its own classification.** Every path in this tree binds to the channel's tag, and an out-of-band membership is by definition not in the tree. A deployment that scripted one would break, and nothing here can see that.
- **What the handler's tag read costs on the turn path.** The router does not make this read today, so no figure exists. It is one `ListTagsForResource`, memoizable per channel per container exactly as the channel flow already memoizes it.

## Consequences

- **`SPEC-CONVERSATION-SECURITY` Layer 6, `ACCESS-CONTROL-BY-EXAMPLE` Gate 3 and `IDENTITY-AND-ACCESS-MODEL`'s boundary table already carry the correction and cite this record.** The table row is split into a person's boundary and an assistant's.
- **What still overclaims is `ACCESS-CONTROL-BY-EXAMPLE` Gate 2**, which the Gate 3 text cites as its own authority while Gate 2 itself still says a wrongly-added member is "inert: present, but unable to read or send". An assistant is a member, and an assistant above the channel reads and sends. Gate 2 is the paragraph a reader reaches first, so it is the correction that matters most.
- **`SPEC-CONVERSATION-SECURITY` section 4b repeats the same sentence** 176 lines above the corrected one, in the same file.
- **`IDENTITY-AND-ACCESS-MODEL` states "IAM is the real boundary"** in the assistant capability section, which is the section a developer reasoning about this would read, and which the corrected table row contradicts.
- **`AGENTS.md` stated the assistant direction inverted** and is corrected: an assistant is flagged when the channel's grants do not include its classification.
- **`backend/test/cdk-synth.test.ts` will fail when this is built**, by design.
- **`task-service.ts`'s `theirs > mine` becomes a rank rule in a world with no ladder for assistants**, and has to move with the decision rather than be left as the one component with the old rule.
- **`backend/test/invoke-grants-stay-inside-this-deployment.test.ts` refuses a function pattern that starts with a wildcard**, and `backend/test/a-pattern-invoke-reaches-only-its-own-instance.test.ts` requires the `Instance` tag condition on every pattern grant, so narrowing the grants moves those tests too.
- **Revisit when** Amazon Chime SDK authorizes `chime:CreateChannelMembership` against the member being added, so the member's `classification` tag could be conditioned and membership would be preventable rather than detectable (the channel and the bearer already are; `backend/scripts/deny-test-assistant-membership.mjs` is how a change would be noticed); or when a deployment has a reason for an assistant to act in a classification other than its own, which would make this a declared `grants` set rather than a rule.
