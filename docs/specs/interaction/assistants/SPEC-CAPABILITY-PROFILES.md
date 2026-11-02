# SPEC: Capability profiles and deployment-defined classifications

**Status:** Implemented. Classifications and assistant profiles are deployment configuration (`backend/lib/config/profiles.ts`), and `backend/lib/profile-registry.ts` is the only module that interprets a classification value: no rank table, group list or hardcoded classification set exists anywhere else. The model catalog names no classification: each classification selects the models it uses from it and declares a default (`models`), and its own stack grants exactly that selection. One parametrized stack body, `backend/lib/stacks/assistant-profile-stack.ts`, serves every classification through a thin per-classification descriptor. Classifications declare the SET they grant and carry no rank ([ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)): the schema has no `rank`, no `failClosedTo` and no minimum cap, and no consumer reads one.

**Coverage:** `tests/e2e/classification-context.spec.ts`, `tests/e2e/profile-config.spec.ts`, `tests/e2e/agent-intents.spec.ts`

**Verified by:** `backend/test/profile-registry.test.ts` (resolution, alias mapping, the declared grant sets and `reaches`, group clearance and the holder token, and context scope, each against a non-default config so a hardcoded triple cannot satisfy it, including a genuine peer deployment where neither classification reaches the other), `backend/test/cdk-synth.test.ts` (per-classification IAM statements are generated from the config's classification list, and no classification's context read reaches outside its own grant set), `backend/test/classification-naming-ratchet.test.ts` (the vocabulary cannot regress: the list of files permitted to carry the old word may only shrink), `backend/test/no-code-names-a-sample-classification.test.ts` (no runtime, CDK, script or frontend code names a sample classification outside the sample's configuration, seed data and checks), and `backend/test/a-deployment-of-other-names-runs-on-its-own-classifications.test.ts` (a deployment declaring `internal`, `partner` and `customer` labels its context, resolves its turns' models and holds its briefing on its own classifications, and refuses the sample's names).

**Related:** [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) (a profile version as a portable, versioned artifact), [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) (what the assistant is, per experience), [`SPEC-PER-PROFILE-OWNERSHIP.md`](./SPEC-PER-PROFILE-OWNERSHIP.md), [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md) (the tag and IAM boundary this configures), [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).

**Site section:** Interaction layer, assistants.

---

## Overview

**Four load-bearing concepts carry four separate names here, and each has one owner.** A deployment names its own data-sensitivity labels, binds each to a named bundle of assistant capabilities, maps its own directory groups onto those labels, and gets one parametrized stack instance per classification, hosting every assistant that classification declares. What a deployment does not get to change is the enforcement mechanism: the tag key stays `classification`, it stays immutable by policy, and IAM stays keyed on `aws:ResourceTag/classification`. This is a vocabulary and configurability layer over a security design that does not move.

| Concept | What it is | Owned by |
|---|---|---|
| **Classification** | The channel's `classification` tag value: a deployment-defined data and sensitivity label that declares the set it grants | Deployment config |
| **Assistant profile** | A named capability bundle: model routing, classifier mode, timeout, context scope, rate limit, attachment readability, display name | Deployment config |
| **Clearance** | The group to classification mapping. Group names are a deployment choice | Deployment config and the identity provider |
| **Classification stack** | One parametrized stack construct, instantiated per classification from a thin descriptor, hosting the classification's primary and every role it declares | CDK, driven by config |

**Two kinds of addition cost two different things.** A new ROLE in an existing classification is a profile entry plus a role name on the classification in `profiles.ts`, and a deploy of that classification's stack (FR9). A new CLASSIFICATION is a new boundary: it is a registry entry with a `topology` in `profiles.ts`, and `bin/backend.ts` creates its `Assistants-<classification>` stack from the registry ([`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)). The first is a role on an existing boundary; the second deploys a new stack and a new boundary.

**A classification is a declared set of grants, not a ladder** ([ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)). There is no rank to compare. A classification reaches exactly what its `grants` array declares, so the defense in depth is a set-membership test - which is precisely what the IAM `StringEquals` condition already evaluated. The three classifications the sample ships happen to nest, and that is a property of what they declare rather than of the axis: a deployment is free to declare `legal` and `finance` as peers granting only themselves, and nothing in the platform tries to order them.

**An undeclared or unreadable classification reaches nothing, and there is no fallback floor** ([ADR-045](../../../design/decisions/045-a-refusal-from-the-classification-boundary-ends-the-turn.md)). Naming a fail-closed default would require a least-privileged classification to name, which only a total order provides; a deployment whose classifications are `legal` and `finance` has none, so substituting a value for an unreadable tag is not merely unsafe there, it is undefined. Every consumer refuses instead. The one place a value is still needed is stamping content whose classification cannot be established, and that is a different question with its own answer on the registry (`failClosedContentValue`), deliberately excluded from the admin plane so untagged content does not go invisible in every user conversation.

**`contextScope` admits the single literal `'granted'`**: the serving classification's own declared grant set, and nothing else.

### A principal holds a set of classifications, not one

The grant is not one classification per principal. `classificationsAllowedFor` returns the grant set a principal holding that classification may reach, and `StringEquals` against a list matches any member of it, which is why the statement is named `AllowGrantedClassificationChannelActions`. The set is derived from the declared grants and never enumerated separately: the S3 context prefixes and the channel-action allow list are built from the same call, so adding or renaming a classification moves both and an assistant cannot end up able to message a conversation whose context it cannot read.

### One classification per assistant, and more than one assistant per classification

**An assistant acts in exactly one classification** ([ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md)), and a classification may hold several assistants. A classification declares the roles it instantiates beyond the `primary` every classification has; a role is access structure rather than behavior, so each role gets its own pair of acting roles (live and alt) and its own share of the classification boundary. The sample declares an `ops` role at `premium` whose boundary names operational metric and log reads that the same classification's primary is refused.

The classification-to-profile mapping in this document's schema is therefore one pointer, not the model. **A profile belongs to an assistant, not to a classification**, and the single pointer is the degenerate case of N assistants per conversation with declared roles ([`DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md`](./DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md), [ADR-048](../../../design/decisions/048-an-assistant-is-not-a-classification.md)).

## Business Problem

A business deploying an assistant platform needs the data-sensitivity labels its own organization already uses, such as internal, confidential and restricted, and needs the assistant serving each label to be a named bundle of capabilities it can define and extend. One vendor-chosen set of consumer pricing names, wired into stack files and handler constants, forces every deployment to adopt someone else's vocabulary and makes adding a fourth assistant a code change rather than a configuration entry. A vocabulary that is also an assumed ordering is worse than inconvenient: an organization whose labels are `legal` and `finance` has no ladder, and a platform that quietly imposes one either blocks reads it should allow or allows reads it should block. What a deployer wants is to state the labels, the capability bundles, the group mapping and the number of assistants as configuration, over a security mechanism that does not change underneath them.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three of them touch this configuration, and they touch different halves of it: the vocabulary and the bundles are one job, the group mapping is another, and the deploy topology is a third.

### AI developer

**How this relates to them:** they own what an assistant is, so the capability bundle is their editing surface - which model serves a label, whether the classifier is model-backed or keyword, how long a turn may run, whether a person may attach a file, and what the assistant is called. They do not choose the labels and they cannot widen a boundary from here.

| What they need | Requirement |
|---|---|
| A named capability bundle they can add and edit as configuration rather than as a stack file | FR6, FR7 |
| A model, classifier mode, timeout and rate limit per bundle, with no per-label environment variable to keep in step | FR6 |
| A label for the assistant that a person reads, separate from the identifier every stored key is addressed by | FR8 |
| Confidence that no bundle they write can widen what the assistant may reach | FR2, FR4 |
| More than one assistant in a classification, each with its own reach | FR9 |

### Platform developer

**How this relates to them:** they answer for the mechanism rather than for any one deployment, so their concern is that exactly one module interprets a classification value and that the IAM boundary and the retrieval walk cannot drift apart from each other.

| What they need | Requirement |
|---|---|
| One interpreter of a classification value, with no second hardcoded set, rank table or group list | FR4 |
| The IAM boundary and the context read derived from the same resolver | FR5 |
| A malformed configuration refused at synth rather than deployed | FR3 |
| Vocabulary regressions caught mechanically rather than by review | FR4 |

### Admin / operator

**How this relates to them:** they govern which groups reach which data and they carry the consequence of a wrong answer, so what they need from this configuration is that the mapping is theirs to state, that an unreadable label refuses rather than guesses, and that a label a channel already carries keeps working for the life of that channel.

| What they need | Requirement |
|---|---|
| Their own directory group names mapped onto their own labels | FR8 |
| Labels that do not have to nest, and are never ordered on their behalf | FR1, FR2 |
| An unknown or unreadable label that reaches nothing, with no substituted floor | FR2 |
| A legacy label that keeps resolving, because no channel is ever retagged | FR10 |
| Console and analytics surfaces that enumerate the profiles actually present | FR12 |

**Also served, and not a persona in `PERSONAS.md`:** the **deployer** standing a deployment up for the first time, whose whole interaction with this document is one configuration file and one `cdk deploy`.

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | A deployment declares its own classification values and their aliases, and the tag key, its immutability and its IAM condition are not among the things it changes | Differentiator | Yes | `profile-registry` (unit, behavior), `cdk-synth` (unit, behavior) |
| FR2 | A classification declares the set it grants, carries no rank, and an undeclared, unknown or unreadable value reaches nothing rather than falling back to a floor | Differentiator | Yes | `profile-registry` (unit, behavior) - asserted against a peer deployment where neither classification reaches the other |
| FR3 | A malformed configuration is refused at synth with a named error rather than deployed: an unknown profile, a duplicate value, an absent or self-omitting grant set, two identical grant sets, an unresolvable grant, a profile named after a classification, an unknown clearance target, or a colliding alias | Enabler | Yes | `profile-registry` (unit, behavior) |
| FR4 | One module interprets a classification value, and no site holds a second set, rank table or group list | Enabler | Yes | `profile-registry` (unit, behavior), `classification-naming-ratchet` (unit, source text) |
| FR5 | The per-classification IAM statements and the retrieval walk derive their prefixes from one resolver, so no classification's context read reaches outside its declared grant set | Table stakes | Yes | `cdk-synth` (unit, behavior) - **deny-test by absence:** a prefix outside the grant set is not granted; `classification-context` (e2e, behavior) |
| FR6 | An assistant's capabilities are a named bundle in configuration - model key, classifier mode, timeout, context scope, rate limit, attachment readability - and adding one for a role in an existing classification is a configuration entry plus a deploy of that classification's stack, with no new stack file and no handler edit | Differentiator | Yes - a role is a configuration entry and a deploy of its classification's stack; a new classification is a registry entry with a `topology`, from which `bin/backend.ts` creates its `Assistants-<classification>` stack | `cdk-synth` (unit, behavior), `profile-config` (e2e, behavior) |
| FR7 | A profile name is the stable storage identifier and may not be a classification value, so `/assistant/{profile}` and `/assistant/{classification}` cannot collide | Enabler | Yes | `profile-registry` (unit, behavior) |
| FR8 | A deployment maps its own group names onto its own classifications, and what a person reads is a separate editable display name | Table stakes | Yes | `profile-registry` (unit, behavior) for the mapping; `admin-profiles` (e2e, behavior) for the rename reaching the identity |
| FR9 | A classification may declare roles beyond its primary, each with its own assistants, its own identities and its own reach on the classification's acting role, conditioned on the role session tag and bounded by the classification boundary | Differentiator | Yes | `an-assistant-acts-through-one-tagged-role` (unit, synthesized policy), `the-assignment-says-which-assistant-is-live` (unit, behavior), `an-ops-role-reaches-only-its-own-classification` (e2e, behavior) - **deny-test**, simulated against the deployed acting role |
| FR10 | A legacy tag value resolves through an alias for the life of the channel, and no channel is ever retagged | Differentiator | Yes | `profile-registry` (unit, behavior) |
| FR11 | Whether a duel may run is a property of the classification rather than of the assistant serving it, and a capable classification is not thereby a battle-enabled one | Table stakes | Yes | `battle-enablement` (unit, behavior), `versioned-profile-omits-deploy-time-fields` (unit, behavior) |
| FR12 | Admin console and analytics surfaces enumerate the profiles and classifications present in configuration and in data rather than assuming a fixed set | Table stakes | Yes | none |
| FR13 | A classification declares the **set** of assistants available to a conversation at that classification, each with its role, and the platform resolves that set for a given conversation - naming which of them are enrolled in it and which are merely eligible. This is the one place either surface asks the question, so the console and the client cannot disagree about what a conversation may have | Gap - prioritize | No - a classification declares its primary `profile` and its further roles (`roles` on `DeploymentClassification`, `backend/lib/config/profiles.ts`), but no resolver names which assistants are enrolled in a given conversation and which are merely eligible, and that distinction has nowhere to be recorded | none |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Acceptance criteria.** A deployment whose classifications do not nest resolves every reach question without an ordering being imposed. A configuration that omits a grant set, declares two identical grant sets, or names a profile after a classification fails synth. An absent, unknown or unreadable tag is refused by every consumer rather than resolved to a floor. A channel carrying a legacy tag value keeps routing, enforcing and reporting correctly without being retagged. A role declared on a classification reaches only what its own role boundary names, proven by a deny-test against the deployed role.

**OPEN:** whether `rolesFor` and the role declaration itself warrant coverage in `profile-registry.test.ts`, which asserts resolution, grants, clearance, the holder token and context scope but not the role list.

**OPEN:** what asserts FR12. The claim that console and analytics surfaces enumerate rather than assume is stated as an unchanged contract, and no test is named for it.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Per-conversation profile overrides | A conversation's classification is set once and is immutable, and a per-conversation override would be a second, mutable answer to the question the tag already settles | [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md) - the layered access model the tag drives |
| Runtime editing of this configuration | The classification list, the group mapping and the deploy topology are the boundary, and a boundary is infrastructure. What a version may edit at runtime is behavior only | [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) - the behavior-versus-boundary cut, and what a version may carry |
| Changing the tag key, its immutability or the fail-closed posture | Every live decision reads that tag, and its immutability is the security design rather than an inconvenience around it | [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md), and the alias mechanism in Appendix A |
| A fail-closed default classification | It would require a least-privileged classification to name, which only a total order provides. A peer taxonomy has none, so a substitution there is undefined rather than merely unsafe | [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md) and [ADR-045](../../../design/decisions/045-a-refusal-from-the-classification-boundary-ends-the-turn.md) - every consumer refuses |
| One profile per classification as a modeled limit | The single pointer in this schema is the degenerate case rather than the model: a classification holds several assistants, each its own principal | [`DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md`](./DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md), and FR9 for the role that divides the boundary |
| A per-classification IAM policies stack | There is one boundary, keyed on a tag of the channel. A second one keyed on a tag of the caller enforces nothing and looks load bearing while doing so | Appendix A, decision D-2 |

## User Experience Description and Mocks

**This configuration has no console surface of its own, and that is deliberate: it is the boundary, so it moves at deploy time.** What an AI developer or a deployer actually does is edit one file and deploy.

1. **Declare the labels.** Each classification names its tag value, the set it grants, the profile that serves it, and optionally its aliases, its roles, whether it is the admin plane and whether it is battle-capable.
2. **Declare the bundles.** Each profile names its stable identifier, its display name, its model key, its classifier mode, its timeout, its context scope, its rate limit and whether its processor may read an attachment.
3. **Map the groups.** Each directory group name points at the one classification it clears for.
4. **Deploy, and be refused early if it does not hold together.** Validation runs at synth and throws on the first violation with a named error, so a configuration that would deploy an unreachable or degraded state does not deploy at all.
5. **Read the result in the console.** The profiles and classifications present in configuration are what the admin console's model and profile surfaces enumerate; nothing in the console writes back to this file.

Editing an assistant's behavior after the deploy is a different surface and a different lifecycle - the Profiles tab and the versioned definition of [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md).

## Related Documents

- [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) - a profile version as a portable, versioned artifact, and the behavior-versus-boundary cut
- [`SPEC-PER-PROFILE-OWNERSHIP.md`](./SPEC-PER-PROFILE-OWNERSHIP.md) - the per-classification stack topology this configuration drives
- [`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md) - the per-assistant axes that ride the versioned definition
- [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) - what the assistant is, per experience
- [`DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md`](./DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) - several assistants in one conversation, with roles
- [`DESIGN-ADDING-AN-ASSISTANT-ROLE.md`](./DESIGN-ADDING-AN-ASSISTANT-ROLE.md) - declaring a role, its acting roles and its boundary
- [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md) - the tag and IAM boundary this configures
- [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) - the practical steps
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet D2, which the declared-grant model follows from
- [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md), [ADR-045](../../../design/decisions/045-a-refusal-from-the-classification-boundary-ends-the-turn.md), [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md), [ADR-048](../../../design/decisions/048-an-assistant-is-not-a-classification.md), [ADR-049](../../../design/decisions/049-a-deployment-descriptor-contains-only-what-is-consumed-before-the-request-runs.md)

## Appendix A - The configuration model in detail

Section numbers in this appendix are cited from the code and are kept.

### 2. The config schema

`backend/lib/config/profiles.ts` is the single source, following the same pattern as the model catalog: stacks, IAM generation and runtime all derive from it.

An excerpt; the full interfaces, including `roleContext`, `produces`, `displayName`, `audience`, `badgeToken`, `topology`, `holdsBriefing`, `groupPrecedence` and `models` on a classification, are in `profiles.ts`.

```ts
export interface DeploymentClassification {
  value: string;           // the tag value, e.g. 'confidential'
  grants: string[];        // the classifications a principal HOLDING this one may reach. Required.
  profile: string;         // which assistant profile serves channels with this classification
  aliases?: string[];      // legacy tag values this classification recognizes (section 7)
  adminPlane?: boolean;    // this classification is the admin plane; its grant set is what it declares, like any other
  roles?: string[];        // the roles it instantiates beyond `primary`
  battleCapable?: boolean; // whether its stack wires the battle plumbing at all
  topology?: AssistantTopology; // present on a classification that gets an Assistants-<classification> stack
}

export interface AssistantProfile {
  name: string;            // the stable identifier and the SSM segment: /{instance}/assistant/{name}/...
  displayName?: string;    // what a person reads; a profile version may override it
  modelKey: string;
  classifierMode: 'keyword' | 'llm';
  timeoutSeconds: number;
  contextScope: 'granted';
  rateLimitPerHour?: number;
  attachmentsReadable?: boolean;
  ownerTeam?: string;      // the team that owns it when first provisioned; a seed for the owner-team tag
  defaultPersona?: string; // the persona it answers with when no version or parameter supplies one
}

export interface ProfilesConfig {
  classifications: DeploymentClassification[];
  profiles: AssistantProfile[];
  // There is NO failClosedTo. An absent, invalid or unreadable tag is refused, not substituted.
  groupClearance: Record<string, string>; // group name -> the classification it clears for
}
```

`validateProfilesConfig` runs at synth time and rejects a malformed config loudly rather than deploying it: at least one classification and one profile must exist, classification values must be unique, every classification must declare a non-empty `grants` set that includes itself and names only declared classifications, no two classifications may grant the same set, every classification's `profile` must exist, no profile name may equal a classification value, every `groupClearance` target must exist, and an alias may collide with neither a primary value nor another alias.

**Why no two classifications may grant the same set.** `resolveHolderToken` answers "which declared classification means exactly what this person holds" by matching the union of their grants against each declared set. Two identical sets make that answer depend on declaration order, so it is refused at synth rather than decided arbitrarily at runtime.

**The shipped default is the demo's sample set.** A deployment runs the set it declares in `profiles` in `deploy.config.json` (`resolveDeploymentProfiles`): a selection of the shipped catalog, `DEFAULT_PROFILES_CONFIG`, or a fully custom set, with the admin plane in every set. Declaring nothing runs the catalog minus its two outside classifications, `guest` and `customer` (each `audience: 'outside'`, with its own profile, `greeter` and `liaison`), which deploy only where declared. That default declares four classifications - `basic`, `standard` and `premium` with prefix-shaped grants, plus `admin`, marked as the admin plane, granting itself alone - and four profiles: `concierge`, `analyst` and `advisor` serving the three ordinary classifications, and `admin-agent` serving the admin plane. The catalog also offers `ops-premium` (the `ops` role at `premium`), deployed only where `profiles` names it. `groupClearance` maps `basic`, `standard` and `premium` to their like-named classifications and `admins` to `admin`. Those names are a sample, not a platform concept, and neither is the prefix shape: the grants are written out precisely so a deployment can declare `legal` and `finance` reaching only themselves.

### 3. The registry is the only interpreter

`backend/lib/profile-registry.ts` is the single module that turns a classification value into a decision. Every site that would otherwise hardcode a set, a rank table or a group list reads through it.

| Question | Registry method |
|---|---|
| Is this tag value known, and what does it resolve to? | `resolveClassification` (primary or alias, `undefined` for anything else), `isKnownClassification` |
| Is a conversation ever created at it? | `isConversational` (an admin-plane classification is refused on every creation path) |
| What does a holder of it reach? | `grantsFor` |
| May a holder of one reach the other? | `reaches` |
| What does this user's group membership clear them for? | `clearanceForGroups`, `clearancesForGroups`, `resolveHolderToken`, `holderTokenCovers` |
| Which context prefixes may it read? | `contextPrefixesGranted`, derived from `grantsFor` |
| Which channels may an assistant in it act in? | `channelsActableBy` |
| Which roles does it instantiate? | `rolesFor` |
| May a duel run in it? | `isBattleCapable` |
| Which assistant serves it? | `profileFor`, `requireProfileFor`, `profileByName`, `classificationFor`, `displayNameFor` |
| What value is stamped on content whose classification cannot be established? | `failClosedContentValue` (never the admin plane) |

The capability questions read off the resolved profile rather than standalone booleans: `classifierMode` chooses the keyword or model-backed classifier, and `rateLimitPerHour` lives on the profile rather than in a per-classification environment variable. The profile is the one of the assistant a turn is addressed to, not the classification's primary: the router resolves the assistant once (`turnAssistantProfile`, `backend/lambda/src/lib/turn-assistant.ts`) and reads both fields from it, so a turn to `ops-premium` is keyword-classified and held to its own limit of 120 while `advisor` in the same classification keeps its own. An alt, whose assistant has no published profile, resolves to the classification's primary. Verified by: `backend/test/a-turn-runs-on-its-assistants-profile.test.ts`. Whether duels may run is the classification's `battleCapable` plus a runtime operator setting, and is not a field on the assistant ([ADR-049](../../../design/decisions/049-a-deployment-descriptor-contains-only-what-is-consumed-before-the-request-runs.md)).

`contextPrefixesGranted` maps the declared grant set onto `context/{classification}/` prefixes. Its `reversed` option reverses the declared order, so on a prefix-shaped deployment the serving classification's own documents survive a character budget first; the IAM generator takes the default order and appends `*`.

### 4. Identity and IAM

- **IAM generation** iterates the config's classifications to emit the per-classification scoped-allow statements with their `aws:ResourceTag/classification` conditions. `classificationChannelScopedAllow` in `backend/lib/stacks/agent-classification-common.ts` is the single definition, used for both the per-classification assistant roles and the per-classification user roles.
- **Directory groups** are created from the `groupClearance` keys at deploy time. The demo keeps sample group names; a deployment names them after its own directory groups.
- **The membership audit** asks whether the member's clearance reaches the channel's classification (`reaches`), and whether the assistant may act in that channel (`channelsActableBy`). Both are set-membership questions against declared grants, which is what makes the audit correct on a peer taxonomy as well as on a nesting one.
- **Declaring the grant set is a security requirement, not tidiness.** An inherited default would impose an ordering on a deployment that never asked for one, so validation rejects an absent set, a set omitting its own classification, and two classifications granting the same set.

### 5. Decisions

**D-1. The boundary is a RESOURCE tag, evaluated as a set, and fail closed.** The condition is the global `aws:ResourceTag/classification` on the channel. It is deliberately not a deny on other classifications: an untagged channel, or one carrying an unexpected value, matches no entry in the allowed set, so no Allow applies and the action is implicitly denied. A deny list would fail **open** on exactly those channels. The condition key is the global `aws:` form rather than a service-specific one because Amazon Chime SDK exposes no service-specific condition keys, so a `chime:` form never appears in the request context and silently grants everything it was meant to gate. Both of these rest on live deny tests rather than on reading the policy.

**D-2. There is no per-classification IAM policies stack.** The consolidation plan was to keep one and have it iterate the configured classifications. It is removed instead, because it enforced nothing: its policies gated on a **principal** tag that was never populated, used an action prefix that is not an IAM action namespace, and were attached to no principal.

The distinction that decides this is the one D-1 rests on. The dead boundary keys on a tag of the **caller**; the live boundary keys on a tag of the **channel**. Generalizing the dead one would produce a config-driven stack that still enforces nothing, and make it look load bearing while doing so. Removing it leaves one boundary, in one function, that a deny test can exercise.

**D-3. A profile version carries selections, never references, so it cannot widen a boundary across instances.** The portable definition holds behavior: models, tools, persona, intent pack, onboarding, message templates (`messages`), event workflows (`eventWorkflows`), variables (`variables`), display name, a workflow selection, a context-source selection and a guardrail selection. It holds no classification, no context scope, no ARN and no policy. Which classification a profile serves is deployment config, so importing a profile does not place it anywhere; an operator binds it and that is a deploy.

Import validates every selection against the target deployment's own catalogs and **rejects rather than degrading**: a guardrail the target has not provisioned is refused, and a version whose guardrail catalog cannot be read is refused outright rather than landed unverified. A model outside the deployment's allowlist fails at the write path instead of surfacing later as a runtime access denial. The full statement of this cut, including which fields are runtime-editable and which are deploy-time only, is in [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md).

### 6. Topology and naming

One `assistant-profile-stack.ts` construct is instantiated per classification that declares a `topology` in the registry, and the construct reads the classification's profiles and roles from the config, which is what makes a profile data rather than a file: **adding a role's profile to an existing classification is a config entry and a deploy of that classification's stack, with no new stack file and no handler edit.** A new classification is a new stack instance, created by `bin/backend.ts` from its registry entry, so it is a config entry and a deploy of a new stack.

SSM keys divide by what they name. A profile's versioned definition is keyed by the **profile name** (`/{instance}/assistant/{profile}/definition`, `/draft`), because it belongs to one assistant, and so is its directory entry (`/{instance}/assistant-directory/{profile}`), through which the one name applier finds its identity. The classification-level infrastructure a stack publishes - the bot, processor, router and task-service ARNs, the guardrail catalog, the context-source catalog, the intent pack and the system prompt - is keyed by the **classification**, because there is one of each per classification. Acting roles and assignments are keyed by classification, role and occupancy.

**The `AppInstanceBot` identities are preserved across the stack consolidation.** New bot ARNs would orphan every existing channel membership, so the bot resources keep stable logical IDs and only the SSM pointers and stack names move.

### 7. Aliases, and why the tag is never rewritten

The `classification` tag is immutable by design, and that property is the security design rather than an inconvenience around it. **Existing channels are therefore never retagged.** A channel tagged with a legacy value keeps it, and the registry's `aliases` mechanism maps that value onto its successor classification, so enforcement, routing and analytics resolve it correctly for the rest of the channel's life. The conversation retention window bounds how long an alias is useful, and a deployment that never used the legacy values declares none.

### 8. Analytics and the admin console

The analytics columns and the metadata contract are unchanged; the values flowing into them are profile and classification names. The archival consumer resolves aliases at write time, so a rollup does not split one population across two labels. Admin console surfaces enumerate the distinct profiles present in config and data rather than assuming a fixed set, and the model surface presents per-profile availability.
