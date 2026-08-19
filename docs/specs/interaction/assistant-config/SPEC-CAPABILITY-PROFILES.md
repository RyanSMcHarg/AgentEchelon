# SPEC: Capability profiles and deployment-defined classifications

**Status:** Implemented. Classifications and assistant profiles are deployment configuration (`backend/lib/config/profiles.ts`), and `backend/lib/profile-registry.ts` is the only module that interprets a classification value. The legacy constants this replaced (`VALID_TIERS`, `TIER_RANK`, `TIER_GROUPS`, `minTier`, `isAdvancedTier`) are deleted, and the per-tier stack files are consolidated into one parametrized `backend/lib/stacks/assistant-profile-stack.ts`.

**Coverage:** `e2e/classification-context.spec.ts`, `e2e/profile-config.spec.ts`, `e2e/agent-intents.spec.ts`

**Verified by:** `backend/test/profile-registry.test.ts` (resolution, alias mapping, rank ordering, the min cap, group clearance and context scope, each against a non-default config so a hardcoded triple cannot satisfy it), `backend/test/cdk-synth.test.ts` (per-classification IAM statements are generated from the config's classification list, and each classification's context read excludes higher classifications), and `backend/test/classification-naming-ratchet.test.ts` (the vocabulary cannot regress: the list of files permitted to carry the old word may only shrink).

**Problem and who it's for:** A business deploying an assistant platform needs the data-sensitivity labels its own organization uses, such as internal, confidential and restricted, and needs the assistant serving each label to be a named bundle of capabilities it can define and extend. One vendor-chosen set of consumer pricing names, wired into stack files and handler constants, forces every deployment to adopt someone else's vocabulary and makes adding a fourth assistant a code change. This is for the platform engineer standing up a deployment and the operator who governs which groups reach which data. It makes the labels, the capability bundles, the group mapping and the number of assistants deployment configuration, over a security mechanism that does not change.

**Site section:** Interaction layer, Assistant Configuration pillar.

**Related:** [`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md) (a profile version as a portable, versioned artifact), [`SPEC-ASSISTANT-CONFIG.md`](SPEC-ASSISTANT-CONFIG.md) (what the assistant is, per experience), [`SPEC-PER-PROFILE-OWNERSHIP.md`](SPEC-PER-PROFILE-OWNERSHIP.md), [`SPEC-CONVERSATION-SECURITY.md`](../identity-access/core/SPEC-CONVERSATION-SECURITY.md) (the tag and IAM boundary this configures), [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).

---

## 1. The four concepts, separated

One word used to name four load-bearing things at once: a security tag value, a Cognito group, a CDK deployment unit and a capability bundle. The mechanism (an immutable `classification` tag driving an IAM decision) is general. The vocabulary was not, and each concept now has its own name and its own owner.

| Concept | What it is | Owned by |
|---|---|---|
| **Classification** | The channel's `classification` tag value: a deployment-defined data and sensitivity label with a declared rank order | Deployment config |
| **Assistant profile** | A named capability bundle: model routing, classifier mode, timeout, task depth, context scope, rate limit, battle eligibility | Deployment config |
| **Clearance** | The group to classification mapping. Group names are a deployment choice | Deployment config and the IdP |
| **Profile stack** | One parametrized stack construct, instantiated per profile from config | CDK, driven by config |

**The enforcement mechanism is unchanged, and that is the point.** The tag key stays `classification`, it stays immutable by policy, IAM stays keyed on `aws:ResourceTag/classification`, resolution stays fail closed, and the minimum-cap defense in depth stays. The cap needs an ordering, which classifications now declare explicitly rather than inheriting from a constant. This is a vocabulary and configurability change over a security design that did not move.

## 2. The config schema

`backend/lib/config/profiles.ts` is the single source, following the same pattern as the model catalog: stacks, IAM generation and runtime all derive from it.

```ts
export interface DeploymentClassification {
  value: string;          // the tag value, e.g. 'confidential'
  rank: number;           // ordering for the minimum cap and context scope (higher = more privileged)
  profile: string;        // which assistant profile serves channels with this classification
  aliases?: string[];     // legacy tag values this classification recognizes (section 7)
}

export interface AssistantProfile {
  name: string;                       // also the SSM segment: /agent-echelon/assistant/{name}/...
  modelKey: string;
  classifierMode: 'keyword' | 'llm';
  timeoutSeconds: number;
  taskSupport: 'lightweight' | 'full';
  contextScope: 'own-rank-and-below';
  rateLimitPerHour?: number;
  battleEligible?: boolean;
}

export interface ProfilesConfig {
  classifications: DeploymentClassification[];
  profiles: AssistantProfile[];
  failClosedTo: string;                   // used when the tag is absent, invalid or unreadable
  groupClearance: Record<string, string>; // Cognito group name -> highest classification it clears for
}
```

`validateProfilesConfig` runs at synth time and rejects a malformed config loudly rather than deploying it: every classification's `profile` must exist, ranks must be unique, `failClosedTo` must exist and must be the lowest rank, every `groupClearance` target must exist, and an alias may not collide with a primary value.

**Why `failClosedTo` must be the floor.** A fail-closed default that is not the least privileged classification is a misconfiguration that reads as a working deployment: an unreadable tag would silently grant more access than the channel was provisioned for. Unique ranks are enforced for the same class of reason. The minimum cap reproduces its intended behaviour only over a total order, so a partial order is rejected at synth rather than resolved arbitrarily at runtime.

**The shipped default is the demo's sample set.** `DEFAULT_PROFILES_CONFIG` declares `basic`, `standard` and `premium` ranked 1, 2 and 3, three profiles, `failClosedTo: 'basic'`, and groups mapped one to one. Those names are a sample, not a platform concept.

## 3. The registry is the only interpreter

`backend/lib/profile-registry.ts` is the single module that turns a classification value into a decision. Every site that used to hardcode a set, a rank table or a group list reads through it.

| Question | Registry method |
|---|---|
| Is this tag value known, and what does it resolve to? | `resolveClassification` (primary or alias, fail closed to `failClosedTo`), `isKnownClassification` |
| How privileged is it? | `rank` |
| Which of two applies, when a user meets a channel? | `min` |
| What does this user's group membership clear them for? | `clearanceForGroups` |
| Which classifications may this one read context from? | `scopeAtOrBelow`, `contextPrefixesAtOrBelow` |
| Which assistant serves it? | `profileFor`, `profileByName` |

The capability questions that used to be booleans read off the resolved profile: `classifierMode` chooses the keyword or LLM classifier, `rateLimitPerHour` replaces per-classification environment variables, and `battleEligible` replaces a deploy-time list of eligible classifications.

## 4. Identity and IAM

- **IAM generation** iterates the config's classifications to emit the per-classification scoped-allow statements with their `aws:ResourceTag/classification` conditions. The Layer 1 boundary keeps its shape and its value set becomes configuration. `classificationChannelScopedAllow` in `backend/lib/stacks/agent-classification-common.ts` is the single definition, used for both the per-classification assistant roles and the per-classification user roles.
- **Cognito groups** are created from the `groupClearance` keys at deploy time. The demo keeps sample group names; a deployment names them after its own directory groups.
- **The membership audit** compares a member's clearance rank against the channel's classification rank through the registry. The semantics are unchanged and the finding now states what it always meant, which is that a member lacks clearance for the conversation.

### A principal holds a SET of classifications, not one

The grant is not one classification per principal. `classificationsAllowedFor` returns `scopeAtOrBelow`, so the condition carries **every classification at or below the principal's own**, and `StringEquals` against a list matches any of them. The statement is named for this: `AllowOwnAndLowerClassificationChannelActions`. A principal at the highest classification of a three-classification deployment therefore matches all three.

Two consequences that are easy to get wrong in a reimplementation:

- **The set is derived from rank, never enumerated.** `scopeAtOrBelow` filters the deployment's classifications by rank, and `contextPrefixesAtOrBelow` builds the S3 context prefixes from that same call. The IAM boundary and the retrieval walk therefore cannot drift, because adding or renaming a classification moves both. This replaced a hardcoded prefix list, which is the drift it exists to prevent.
- **Unique ranks are a security requirement, not tidiness.** The set and the minimum cap reproduce their intended behaviour only over a total order, which is why `validateProfilesConfig` rejects duplicate ranks at synth rather than resolving an ambiguous order at runtime.

## 5. Decisions

**D-1. The boundary is a RESOURCE tag, evaluated as a set, and fail closed.** The condition is the global `aws:ResourceTag/classification` on the channel. It is deliberately not a deny on higher classifications: an untagged channel, or one carrying an unexpected value, matches no entry in the allowed set, so no Allow applies and the action is implicitly denied. A deny on higher would fail **open** on exactly those channels. The condition key is the global `aws:` form rather than a service-specific one because Amazon Chime SDK exposes no service-specific condition keys, so a `chime:` form never appears in the request context and silently grants everything it was meant to gate. Both of these were established by live deny tests rather than by reading the policy.

**D-2. The per-classification IAMPolicies stack is deleted rather than generalized.** The migration plan was to keep that stack and have it iterate the configured classifications. It was removed instead, because it enforced nothing: its policies gated on `aws:PrincipalTag/tier`, a **principal** tag that was never populated, used a `chime-sdk-messaging:` action prefix that is not an IAM action namespace, and were attached to no principal.

The distinction that decided it is the one D-1 rests on. The dead boundary was keyed on a tag of the **caller**; the live boundary is keyed on a tag of the **channel**. Generalizing the dead one would have produced a config-driven stack that still enforced nothing, and made it look load bearing while doing so. Deleting it leaves one boundary, in one function, that a deny test can exercise.

**D-3. A profile version carries selections, never references, so it cannot widen a boundary across instances.** The portable definition holds behaviour: models, tools, machines, persona, classifier mode, timeouts, context source keys and a guardrail selection. It holds no classification, no context scope, no ARN and no policy. Which classification a profile serves is deployment config, so importing a profile does not place it anywhere; an operator binds it and that is a deploy.

Import validates every selection against the target deployment's own catalogs and **rejects rather than degrading**: a guardrail that the target has not provisioned is refused, and a version whose guardrail catalog cannot be read is refused outright rather than landed unverified. A model outside the deployment's allowlist fails at the write path instead of surfacing later as a runtime access denial. The full statement of this cut, including which fields are runtime-editable and which are deploy-time only, is in [`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md).

## 6. Topology and naming

One `assistant-profile-stack.ts` construct is instantiated per profile from the config, which is what makes a profile data rather than a file: **adding one is a config entry and a deploy, with no new stack file and no handler edit.** SSM keys are namespaced per profile as `/agent-echelon/assistant/{name}/...`, carrying the bot, processor and router ARNs each profile publishes.

**The AppInstance Bot identities are preserved across this consolidation.** New bot ARNs would orphan every existing channel membership, so the bot resources keep stable logical IDs and only the SSM pointers and stack names move.

## 7. Aliases, and why the tag is never rewritten

The `classification` tag is immutable by design, and that property is the security design rather than an inconvenience around it. **Existing channels are therefore never retagged.** A channel tagged with a legacy value keeps it, and the registry's `aliases` mechanism maps that value onto its successor classification, so enforcement, routing and analytics resolve it correctly for the rest of the channel's life. The conversation retention window bounds how long an alias is useful, and a deployment that never used the legacy values declares none.

## 8. Analytics and the admin console

The analytics columns and the metadata contract are unchanged; the values flowing into them are profile and classification names. The archival consumer resolves aliases at write time, so a rollup does not split one population across two labels. Admin console surfaces enumerate the distinct profiles present in config and data rather than assuming a fixed set, and the model surface presents per-profile availability.

## 9. Non-goals

Multiple profiles per classification (the mapping is one to one, and the schema permits relaxing this later), per-conversation profile overrides, and runtime profile editing of this config, which is deploy-time like the intent pack. Nothing here changes the tag key, its immutability, bearer pinning or the fail-closed posture.
