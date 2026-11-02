---
title: "ADR-046: Classifications are a set, not a ladder"
status: Accepted 2026-09-17. `rank` is removed from the configuration schema and `grants` is the only model; `failClosedTo` and every fail-closed-to-the-floor substitution are removed, and the consumers that reached for them refuse instead. Built the same day; the ladder no longer appears in any access decision in the tree.
date: 2026-09-17
related:
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "./045-a-refusal-from-the-classification-boundary-ends-the-turn.md"
  - "../../specs/interaction/assistants/SPEC-CAPABILITY-PROFILES.md"
  - "../../../backend/lib/config/profiles.ts"
  - "../../../backend/lib/profile-registry.ts"
  - "../../../backend/lib/classification-admission.ts"
tracking: |
  The owner, 2026-09-17: "These are not necessarily supposed to be a ladder anyway. A classification could be legal and finance. That concept needs to carry throughout." This record is that concept carried through. It completes ADR-045 decision 3, which asked only that rank comparisons leave the assistant-plane components, and widens it: the ordering leaves the model entirely.
---

# ADR-046: Classifications are a set, not a ladder

## Status

**Accepted and built (2026-09-17).** `npx tsc --noEmit` is clean on both the source and test configurations; the affected suites are green.

## The problem, in one example

A deployment's classifications might be `legal` and `finance`.

Neither is above the other. Neither is a floor. A finance-cleared person in a legal conversation is not "below" it, they simply do not reach it. There is no "most restrictive" value to stamp unclassifiable content with, and no "lowest" value for an unreadable tag to fall back to.

Every one of those sentences describes something the code did.

## What the code believed

`DeploymentClassification` carried a required `rank: number`, documented as "ordering for the min-cap and RAG scope (higher = more privileged). Unique across the set." `ProfilesConfig` carried `failClosedTo`, which `validateProfilesConfig` required to be the lowest rank. From those two, an ordering reached:

- `rank()`, `min()` (the min-cap downgrade), `scopeAtOrBelow()`, `mostRestrictiveValue`, and `clearanceForGroups` ("the highest group they hold") on the registry.
- `isClassificationViolation` (`m < c`) and the uncleared assistant check (`botRank > chRank`) in the membership audit.
- `theirs > mine` in the task service.
- `classificationRank` and its rank comparison in the admin caller scope.
- `rank(agent_type) > rank(room)` in the archival boundary detector.
- `rank(parent) > rank(deployed)` in conversation split.
- Roughly a dozen `failClosedValue` substitutions, each reading as a safe default.

**The codebase had already written down that this was wrong**, in `backend/lib/classification-admission.ts`: "`grants` ... is a SET and need not be a rank prefix, so no consumer may compare ranks ... No ranks travel. Every consumer bug being fixed here was a rank comparison." `grantsFor` and `channelsActableBy` were already set predicates. The ladder was the legacy that outlived the model, kept alive by one optional field: a classification that declared no `grants` fell back to own-rank-and-below.

## The decision

1. **`rank` is removed from the configuration schema.** Every classification declares `grants`, the set a principal holding it may reach, and it is required. A ladder-shaped deployment declares prefix-shaped grants, which is what `DEFAULT_PROFILES_CONFIG` now does; the shipped behavior is unchanged and is now a statement rather than an inference.

2. **There is no floor.** `failClosedTo` and `failClosedValue` are deleted. Every consumer that substituted them refuses instead. ADR-045 decision 2 had already done this for the assistant-plane callers, on the narrower grounds that the floor was a *wrong* classification; under a peer model it is not even a well-defined one, so refusing is the only coherent answer rather than the safer of two.

3. **Every comparison becomes set membership.** `reaches(holder, target)` replaces `min`; `channelsActableBy` replaces the uncleared and `theirs > mine` checks; `grantsFor` replaces `scopeAtOrBelow`. These read from the same declared sets the deployed IAM conditions are generated from, so a detective control and a preventive control now answer from one source. The audit and the credential exchange disagreeing about the same pairing is the failure this removes.

4. **Two order-shaped questions get order-free answers.** `mostRestrictiveValue` ("the top of the ladder") becomes `widestReachingValue`, the classification whose reach contains every other, which is `undefined` when none does. `failClosedContentValue` ("the highest ordinary classification") becomes the conversational classification the FEWEST holders reach: the same answer on a ladder, and the only one that means anything between peers.

5. **Ordering, where it is still needed, is declaration order.** Generated policies, role names and Cognito group precedence need a stable order across runs. With no rank, the order the deployment wrote is the stable one. Group precedence specifically orders by reach, because that is the only thing precedence means: the classification that reaches more takes a lower number and wins the `cognito:groups` claim.

## What this costs, stated once

**An unreadable or undeclared value now ends a turn where it used to degrade one.** That is the same trade ADR-045 states, applied more widely. A throttled tag read makes an assistant briefly silent rather than briefly acting in the wrong classification, and a person holding a group combination the deployment has not declared is refused a credential rather than quietly given the least-privileged one.

**The second is the one an operator will meet first.** `resolveHolderToken` returns `undefined` for an unnamed combination, and the credential exchange now refuses with a logged SecurityEvent naming the groups. Previously that person received a working session at the floor, which reads as a permissions puzzle to them and as normal traffic to an operator. A combination worth granting is worth declaring, and `holderTokenCovers` distinguishes "this config has a gap" from "this person holds no clearance".

**The two credential-exchange security events are different outcomes, and conflating them sends an operator after the wrong fault.** `resolveRoleKey` returning nothing is the 403: nothing is vended. `holderTokenCovers` returning false never refused anything; it logged that the caller had been vended LESS than they hold and let the request proceed, so it presented as reduced access rather than a failure. That second path is now **unreachable by construction**, and the review that found the discrepancy is what surfaced it: an undeclared combination used to resolve to the floor, which is exactly when a shortfall was expressible. With no floor, the token a caller is vended has grants equal to the union of what they hold, and every classification grants itself, so a shortfall cannot occur. The check is kept as the invariant in executable form and its message rewritten, because the old one said "vending the fail-closed floor" and would send the next reader looking for a floor this record deletes.

**An untagged row is no longer visible to everyone.** `classificationAllowed` read an absent item classification as the floor, and the comment called that "permissive, and it is the module's existing and deliberate treatment". It is now refused. An item nobody classified is an item whose audience nobody established.

## What proves it

- `backend/test/profile-registry.test.ts`, rewritten from pinning a ladder to pinning sets, including a genuine peer deployment (`legal` and `finance`) where `widestReachingValue` is `undefined`, neither reaches the other, and holding both groups yields no token.
- `validateProfilesConfig` refuses a classification declaring no grants, one that does not grant itself, two that grant the same set (which would make a holder token ambiguous), and a duplicate classification value. The rank-uniqueness check it replaces was the schema asserting the ladder.
- `backend/test/lib/admission-mirrors-the-registry.test.ts`, which pins that the data shipped to the raw Lambdas no longer carries `failClosedTo`.
- `backend/test/lib/caller-scope.test.ts`, whose fail-closed-to-the-floor cases are rewritten as no-scope-sees-nothing.

## What this does not decide

**Per-pair boundary verification.** `classification-boundary-verify.ts` asserts that a wide reader sees a narrow reader's content and not the reverse, which presupposes containment. Between peers there is nothing to assert that way, so it now reports that the proof does not apply rather than passing vacuously. Verifying each declared pair against its `grants` is the honest replacement and is not built.

**Whether the shipped sample should stay a ladder.** `basic`, `standard` and `premium` remain prefix-shaped because the sample is configured that way; it is a statement in `DEFAULT_PROFILES_CONFIG`, not a property of classifications. Many deployments should not nest them: an internal person does not usually reach an external classification, and the shipped `customer` classification already works that way, granting only itself so that nothing a member holds reaches it (`validateProfilesConfig` refuses a member classification that grants it, and `lib/config/issuers.ts` refuses an issuer naming it beside the deployment's own).
