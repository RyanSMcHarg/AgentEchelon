# 012 - Assistant config store & drift (persona / intent pack): preserve-on-absent

**Status:** Accepted · **Date:** 2026-06-13

## Context

A team that has invested in customizing its assistant - its persona and its intent pack, the things that make it *their* assistant and not a generic bot - expects that configuration to stay put through routine operations. Silently reverting to "I'm an AI assistant without access..." because of an unrelated deploy is exactly the failure a user would not forgive. Keeping a configured assistant configured is the user problem this decision protects.

The per-tier assistant **persona** and **intent pack** live in SSM (`${SSM_ROOT}/assistant/{tier}/assistant-{system-prompt,intent-pack}`) because a rich persona + pack exceed the Lambda 4 KB env cap (the processor/handler hydrate them by name at cold start).

They were written by CFN-managed `ssm.StringParameter` constructs whose value came from `-c assistantSystemPrompt` / `-c assistantIntentPack`. This caused a production incident: a routine `cdk deploy` that **omitted** the context synthesised the parameter as `undefined` → CloudFormation **deleted** the param → the assistant silently fell back to the generic default ("I'm an AI assistant without access…"). Worse, after out-of-band churn CFN's recorded state still listed the param while the actual param was gone, so a re-deploy reported **"no changes"** and would not recreate it. There was also no safe operator path: a manual `aws ssm put-parameter` is reverted by the next deploy (CFN owns the value).

## Decision

**Preserve-on-absent via a custom resource.** Each config param is written by an `AwsCustomResource` that:

- `putParameter` (Overwrite) **only when a non-empty value is supplied** (`if (value.trim())`);
- has **no `onDelete`** - so removing the writer (an empty-context deploy) **does not delete** the param. An existing persona is preserved across deploys that don't carry the context.
- carries a **content hash in its `physicalResourceId`** so a changed value forces a re-PUT - busting the CFN "no changes"/drift no-op.

The committed repo files (`persona.txt`, `intent-pack.json`) remain the **floor** - the merge-into-`cdk.context.json` deploy step is how the value is supplied. The consuming Lambdas reference the param **by stable name** unconditionally + hold an unconditioned `ssm:GetParameter` grant, so they read a preserved value even on a deploy that didn't set it (and fall back to the code default when the param is genuinely absent).

Kept: the **synth `addWarning`** when a `standard`/`premium` tier resolves an empty persona/pack - a personaless deploy is loud, not silent.

## Consequences

- A deploy that omits the persona/pack context **can no longer blank** an existing config - the exact footgun is structurally removed (verified: the synthesized `<Instance>Tier-Standard` template has two `Custom::AWS` writers and **no `AWS::SSM::Parameter`** for persona/pack).
- A **changed** persona/pack re-PUTs reliably (hash in the physical id), so the drift "no changes" no-op is gone.
- Least-privilege: each writer's policy is scoped to `ssm:PutParameter` on its own param ARN.
- **Still open:** the **operator no-deploy path** (set persona at runtime via the admin API/console) with **admin authz + audit** - preserve-on-absent makes the *deploy* path safe, but an operator still needs a deploy to change the persona until that lands.
- Teardown: the params are now orphaned from the tier stack (not CFN-deleted on stack destroy) - a tier teardown must delete `${SSM_ROOT}/assistant/{tier}/assistant-*` explicitly (documented in HOW-TO-ADD-OR-MANAGE-A-PROFILE).

## Migration (2-step RETAIN - one-time)

The params are **already deployed** as CFN-managed `ssm.StringParameter`s (logical ids `SystemPromptParam` / `IntentPackParam`). Swapping `StringParameter → AwsCustomResource` writer in a **single** deploy would blank them: CFN runs the writer's `PutParameter` (create phase) and then **deletes the removed `StringParameter` last** (cleanup phase); the StringParameter's default `DeletionPolicy` is `Delete`, so `DeleteParameter` fires on the **same name** and wins. CFN reads `DeletionPolicy` from the **already-deployed** template when removing a resource, so the swap is two deploys, gated on `-c assistantParamWriter=true` (default = phase 1):

1. **Deploy 1 (phase 1, flag absent):** the `StringParameter` is kept (same logical id + name + Advanced tier ⇒ a **metadata-only** diff) but with `RemovalPolicy.RETAIN`. This teaches the live stack to **orphan** (not delete) the param when it is later removed.
2. **Deploy 2 (`-c assistantParamWriter=true`):** the `StringParameter` is gone and the writer is present. CFN orphans the old param (RETAIN honored - **no `DeleteParameter`**), and the writer's `PutParameter(Overwrite)` re-owns it. The value survives.

Both deploys **must** carry `-c assistantSystemPrompt` / `-c assistantIntentPack` (+ `assistantTier=standard`)
 - same as any persona-bearing deploy. After Deploy 2 has landed in every environment, a **follow-up commit drops the flag + the RETAIN branch** so the writer is the permanent default; running a plain (phase-1) deploy *after* Deploy 2 would try to re-create an orphaned param and fail "already exists" - hence the cleanup commit. Verified by synth: phase 1 emits two `AWS::SSM::Parameter` with `DeletionPolicy: Retain` and no writers; phase 2 emits two `Custom::AWS` writers and no `AWS::SSM::Parameter` for persona/pack.

## Alternatives considered

- **(b) Operator-owned store with precedence** (Lambda reads an operator store over the CFN param) - more moving parts, two sources of truth; deferred. Preserve-on-absent + the floor file is simpler and fixes the incident directly.
- **`StringParameter` with `RemovalPolicy.RETAIN`** as the *steady state* - preserves on absent, but a later set re-creates a param that already exists → CFN "already exists" conflict. Rejected as the end state; RETAIN is used only as the **one-time migration bridge** (see Migration above).
