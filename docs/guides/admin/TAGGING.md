# Resource Tagging & Cost Attribution

> **This page is about COST tags.** There is a second, unrelated tag - `classification` - on channels, assistants and people, and it is what the IAM access boundary is keyed on. It is not applied at the app root, it is not a cost signal, and no rule on this page governs it. See [SPEC-CONVERSATION-SECURITY](../../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md) for its schema, [METADATA-AND-TAGS](../developer/METADATA-AND-TAGS.md) for every tag family, and [CHIME_SDK_INTEGRATION](../developer/CHIME_SDK_INTEGRATION.md) for what to do when you create one of those resources. The two families share a mechanism and nothing else.

This platform deploys as **multiple independent instances** (one per `AE_INSTANCE_NAME`). For cost attribution to work, each instance's resources must carry **its own** identity - so the tagging rule is:

> **Derive `Project` from the deployment identity; never hardcode it, never override it per-stack.**

A hardcoded `Tags.of(app).add('Project', 'AgentEchelon')` (or worse, a per-stack override) makes every instance report under the same value, collapsing all deployments into one cost bucket. A guardrail test (`test/tagging.test.ts`) prevents that regression.

## The standard tag set
Applied **once at the app root** in `bin/backend.ts` via `applyStandardTags` (`lib/tagging.ts`):

| Tag | Value | Notes |
|-----|-------|-------|
| `Project` | `STACK_PREFIX`: `AE_STACK_PREFIX` when set, otherwise the PascalCase of `AE_INSTANCE_NAME` (e.g. `Stratum`; `AgentEchelon` for the default instance) | the per-instance cost identity |
| `Codebase` | `AgentEchelon` | aggregate all instances of this platform |
| `Instance` | `INSTANCE_NAME` (`AE_INSTANCE_NAME`, default `agent-echelon`) | |
| `Environment` | `environment` in `deploy.config.json` (or `-c environment=…`): `dev` or `production`, default `dev`; any other value is refused at synth | never hardcode |
| `ManagedBy` | `CDK` | |

`STACK_PREFIX` and `INSTANCE_NAME` are defined in `backend/lib/stacks/agent-classification-common.ts`; the `environment` value and its `dev` default are parsed once, by `parseEnvironment` in `backend/lib/config/environment.ts`.

Individual stacks may add **only** stack-specific keys (e.g. `Component`), never `Project`.

The CloudFormation stacks carry the same set as their resources. `cdk.json` sets `@aws-cdk/core:explicitStackTags`, under which an app-level tag reaches resources but not the stack itself, so `applyStandardTags` also sets the set on every stack it covers. A required-tags rule that evaluates `AWS::CloudFormation::Stack` finds `Project` there.

## Per-channel label tag
Each conversation channel also carries a `conversationType` tag set to the room's type key, written in the same create call as its `classification` tag (`CONVERSATION_TYPE_TAG` in `backend/lambda/src/lib/channel-creation.ts`; federated rooms are tagged `general`). It is a label an operator can filter on. It is intended as a cost-allocation dimension too; whether Amazon Chime SDK messaging charges surface per channel tag in Cost Explorer is unverified. Nothing reads it to decide access or policy: the type that decides policy is the server-side context store's `conversationType` (see [METADATA-AND-TAGS](../developer/METADATA-AND-TAGS.md)).

## Relation tags
Two tags record a relation between resources rather than a cost or a label: the **channel link tag**, on a conversation opened from another one, naming the source channel's ARN; and the **owner tag** on the admin-plane AppInstanceUser, naming its owner's AppInstanceUser ARN. Both are written by the creating path and never by a member, which is why a relation lives in a tag and never in member-writable channel Metadata. Neither is a cost signal or an access grant. The owner tag is written. The channel link tag is written on one relation, the upgrade: a customer conversation a path B claim opens, and the conversation a path A bind continues the visit in, carry `upgradedFrom` (the visitor's conversation ARN) and `upgradedFromPerson` (the visitor's AppInstanceUser ARN). **NOT BUILT:** the link tag on a drift split, an event conversation and a meeting conversation. The rule and the current state are in [METADATA-AND-TAGS](../developer/METADATA-AND-TAGS.md), section 3.

## Rules
1. **Set `Project` once, at the app root**, derived from `STACK_PREFIX`. Deploy the same code as a new instance and its tags follow automatically - no code change.
2. **Never** `cdk.Tags.of(this).add('Project', …)` inside a stack/construct. A per-stack override wins over the app-root tag and silently fragments cost reports.
3. Cost-allocation tags must be **activated in the Org payer account** before Cost Explorer can group by them (they only apply going forward from activation).

## Guardrail (tests)
`test/tagging.test.ts` enforces the invariants and fails CI on a regression:
- `Project` is derived onto resources (+ the full standard set is applied);
- reuse-safety: a different instance self-tags with its own `Project`;
- every stack carries the standard set, synthesized under the flags in `cdk.json`;
- **guardrail:** a format-agnostic scan (`collectProjectTagValues`) asserts no stack carries a `Project` value other than the derived one - this is what catches a stray per-stack override.

Add a stack? Nothing to do for tagging - it inherits the app-root tags. Just don't re-add `Project`, and the guardrail test will keep it honest.
