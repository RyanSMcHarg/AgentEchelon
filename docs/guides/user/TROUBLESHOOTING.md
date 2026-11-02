# AgentEchelon Troubleshooting Guide

> **Audience.** Anyone running AgentEchelon **in their own AWS account**. Every command uses placeholders and a discovery recipe instead of hardcoded account IDs, resource names, or profiles. Substitute your own values from the "Conventions" section below. **Structure.** Each entry follows `Symptom → Diagnosis CLI → Root Cause → Solution → Prevention`. The root causes and fixes here are properties of the AgentEchelon codebase, so they apply to *any* deployment; only the resource names differ, and the recipes below resolve those for your account.

> **Verification discipline (read first).** A passing E2E/demo run does **not** mean a feature works. A bubble-count-only assertion (`.message.battle-message` *count ≥ 2*) is satisfied by a placeholder bubble + an error bubble. **Read the captured message content** - the e2e suites' own outputs under `tests/test-results/` (a video of every test, and the Playwright trace of a failing one) - and check the message content + scorecard before declaring success. Bubble count lies.

---

## Conventions

All `aws` examples assume credentials for **your target account** are already configured (via `AWS_PROFILE`, environment variables, SSO, or an instance role). Examples omit `--profile`; export `AWS_PROFILE=<your-profile>` (or set creds) for the shell first. Confirm with:

```bash
aws sts get-caller-identity          # whoami / which account
aws configure list-profiles          # available profiles, if you use them
```

Placeholders used below - resolve each **once** and reuse:

| Placeholder | What it is | How to get it |
|---|---|---|
| `<REGION>` | Deploy region | `frontend/packages/chat/.env` → `VITE_AWS_REGION` (default `us-east-1`) |
| `<USER_POOL_ID>` | Cognito user pool | CDK output `AgentEchelonIdentity.UserPoolId` / `frontend/packages/chat/.env` `VITE_USER_POOL_ID` |
| `<APP_INSTANCE_ARN>` | Amazon Chime SDK app instance | CDK output `AgentEchelonMessaging.AppInstanceArnOutput` / `frontend/packages/chat/.env` `VITE_APP_INSTANCE_ARN` |
| `<DEMO_EMAIL>` | A seeded test identity | Whatever `backend/scripts/seed-demo.ts` created in *your* pool (the demo seed uses `*@stratum.example.com`, or the test inbox's domain when provisioning recorded one) |
| `<STACK>` | A CDK stack | `AgentEchelonAssistants-premium`, `AgentEchelonChannelFlow`, `AgentEchelonIdentity`, … |
| `<LOGICAL_ID>` | A construct's CFN logical id | Stable across accounts for the same CDK code (e.g. `AsyncProcessor`, `ChannelFlowProcessor`, `ExperimentsTable`, `ChannelBattleConfigTable`) |
| `<SSM_ROOT>` | The deployment's SSM parameter root | `/<instance-name>`; `/agent-echelon` for the default instance name |

Stack names carry the deployment's prefix, the PascalCase form of the instance name (`agent-echelon` gives `AgentEchelon`, overridable with `AE_STACK_PREFIX`). The examples use the default `AgentEchelon`; substitute yours.

### Resolve a physical resource name from its logical id

CDK gives resources a stable logical id but a per-deploy physical name. Three reusable shell helpers - paste once per session:

```bash
# Physical resource name for a (stack, logical-id-prefix)
res() { aws cloudformation list-stack-resources --stack-name "$1" \
  --query "StackResourceSummaries[?starts_with(LogicalResourceId,'$2')].PhysicalResourceId" \
  --output text ; }

# Lambda function name for a (stack, logical-id-prefix). Filters to the function itself, so the
# role and log group that share the prefix do not match.
fn() { aws cloudformation list-stack-resources --stack-name "$1" \
  --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'$2')].PhysicalResourceId | [0]" \
  --output text ; }

# Tail a Lambda's logs by (stack, logical-id-prefix), last N minutes.
# (Windows/Git-Bash: prefix the line with MSYS_NO_PATHCONV=1 so the
#  /aws/lambda/... path isn't mangled into a Windows path.)
fnlog() { aws logs tail "/aws/lambda/$(fn "$1" "$2")" --since "${3:-20m}" --format short ; }
```

Examples (used throughout this guide):

```bash
res AgentEchelonExperiments ExperimentsTable          # → the experiments table name
fnlog AgentEchelonAssistants-premium AsyncProcessor 25m
fnlog AgentEchelonChannelFlow ChannelFlowProcessor 20m
```

Searches use the same helper: `aws logs filter-log-events --log-group-name "/aws/lambda/$(fn <STACK> <LOGICAL_ID>)" ...`.

If a logical-id prefix is ambiguous, list them: `aws cloudformation list-stack-resources --stack-name <STACK> --query "StackResourceSummaries[].LogicalResourceId"`.

---

## 1. Battle error bubble

### Symptom

In a battle-enabled premium channel, `/battle <prompt>` produces two bubbles: the alt says *"Sorry, I encountered an issue processing your request."* and the default assistant's side shows a clarifying question instead of an answer; scorecard RESPONSE TIME / EST. COST are ` - `; sender names are the assistants' own stable names (`Advisor` / `Alt-premium`) rather than the experiment's variant display names, with a model badge that isn't the configured variant model.

This is a **layered failure** - several independent conditions on the same path. Work them in order.

### Diagnosis Steps

1. **Confirm Battle Mode armed** (rules out arming layers)
   ```bash
   aws dynamodb scan --table-name "$(res AgentEchelonExperiments ExperimentsTable)" \
     --query "Items[].{id:experimentId.S,battle:battleEnabled.BOOL,challenger:challengerAssistant.S,status:status.S}"
   aws dynamodb scan --table-name "$(res AgentEchelonBattle ChannelBattleConfigTable)" \
     --query "Items[].{ch:channelArn.S,enabled:enabled.BOOL,exp:experimentId.S,challenger:challengerAssistant.S,member:challengerBotArn.S}"
   ```
   Expect the experiment row `battle:true status:active` naming its classification's challenger (`alt-primary-premium`), and the channel row `enabled:true` naming the same challenger and the bot its enable added (`member`, the bot the alt's assignment record names). A row of the earlier shape (`altBotSlotId`, `altBotSlotArn`) shows neither field and is still read. Both present ⇒ arming is fine; the break is downstream.

2. **Was the ChannelFlowProcessor invoked, and did it fan out?**
   ```bash
   fnlog AgentEchelonChannelFlow ChannelFlowProcessor 20m > /tmp/cfp.log
   grep -nE '\[ChannelFlow\] routing|\[ChannelFlow\]\[battle\] (Detected|Fanning out)|classification unreadable|Battle Mode isn' /tmp/cfp.log
   ```
   - No `[ChannelFlow] routing` line, or `invokesBattle:false` → **§5**.
   - A *"Battle Mode isn't available in this conversation."* reply → **§6**.
   - `[ChannelFlow][SecurityEvent] channel classification unreadable; releasing the message and dispatching nothing` → the flow could not read the channel's `classification` tag, so nothing ran at all (see §6, Diagnosis).
   - `[ChannelFlow][battle] Fanning out { botCount:2 … }` → fan-out happened; go to step 3.

3. **Read the premium async processor (generates each assistant's reply)**
   ```bash
   fnlog AgentEchelonAssistants-premium AsyncProcessor 25m > /tmp/pap.log
   grep -niE 'ValidationException|ResourceNotFound|AccessDenied|substring|BedrockResilience|Round-1 clarification|Model resolution' /tmp/pap.log
   ```
   | Log signature | Section |
   |---|---|
   | `ValidationException: …on-demand throughput isn't supported…inference profile` | **§7** |
   | `ResourceNotFoundException: This model version has reached the end of its life` | **§8** |
   | `TypeError: Cannot read properties of undefined (reading 'substring')` | **§9** |
   | `Round-1 clarification` | not a bug (see note) |
   | `AccessDenied … bedrock:InvokeModel on resource: arn:aws:bedrock:`**`us-east-2`**`…` (region ≠ deploy region) | **§11** (cross-region inference profile) |
   | `AccessDenied … bedrock:InvokeModel` (deploy region) | the handler's IAM role lacks the model's Bedrock grant for that classification |
   | `AccessDenied … aws-marketplace:Subscribe … subscription cannot be completed` | **§12** (model agreement not accepted; works in Playground but not Lambda) |
   | `BadRequestException: Channel Messages size limit exceeded` (after a long answer) | **§13** (encoded Content/Metadata cap) |

**Note (not a bug):** the control assistant may legitimately enter `WAITING_FOR_USER` - it asked a clarifying question, which replaces its placeholder (ADR-029; clarification is a measured dimension, see `docs/specs/interaction/quality/SPEC-BATTLE.md`). The demo never answers it, so single-turn shows no final answer on that side. By design.

### Root causes

| Condition | Where |
|---|---|
| Experiment create returns 500 (DynamoDB marshalling) | §2 |
| Battle Mode panel not rendered for the caller | "Battle panel", below |
| `/battle` not detected | §5 |
| Battle not capable or not turned on for the classification, or the flow role cannot read the setting | §6 |
| Model invoked by bare id where only an inference profile is supported | §7 |
| `substring` TypeError in the task prompt | §9 |
| Retired (end-of-life) model id in the catalog | §8 |
| IAM grant missing a member region of a cross-region inference profile (the alt's `AccessDenied` on `us-east-2`) | §11 |
| Default assistant not on the experiment's configured **control** variant | "Resolution", below |
| Variant display name missing from the scorecard and chip | "Resolution", below |

**Battle panel.** The Battle Mode section renders only for a channel moderator in a battle-eligible conversation. `ChannelMembersPanel` reads the caller ARN from `useAwsClient().userArn` (the canonical chimeService ARN), checks it against the channel's live moderator list (`chimeService.listModerators`), and renders the section only when the fetched battle config reports `battleEligible`. A caller who is not a moderator, or a classification whose battle config is not eligible (§6), sees no section. File: `frontend/packages/chat/src/components/ChannelMembersPanel.tsx`.

### Resolution

The battle side resolution is correct: the alt resolves its pinned version (named Echo, base model `opus`) as intended. The visible breakage comes from three separate conditions on the same frame:

1. **The alt's `AccessDeniedException` (the "Sorry, I encountered an issue" bubble).** A treatment model invoked through the `us.` cross-region inference profile can be routed by Bedrock to **us-east-1 / us-east-2 / us-west-2**. The classification's IAM grant comes from the catalog's `foundationModelArns` via `modelArnsForClassification` (`backend/lib/stacks/agent-classification-common.ts`); if those ARNs do not cover the region Bedrock picked, the invoke is denied. On `access_denied` `bedrock-resilience` fails hard by design (no model fallback) → the error bubble. **Full detail + fix: §11.**

2. **Default assistant on the intent-default model.** The default assistant's side serves the control's pinned version (`variants[0].controlPin`, a never-activated version of the live assistant derived when the battle was armed) through `resolveBattleSides` in `backend/lambda/src/lib/experiment-manager.ts`, and serves the live assistant as it is only when no battle or control pin is bound. A default side answering on the intent default (for example Haiku for premium + general) instead of the control variant (for example Sonnet) means no control version resolved: check that the experiment row carries `controlPin` (a battle armed before both sides were pinned does not; re-arm it), then recheck the row from step 1. A battle compares the same experiment's two variants head-to-head ([SPEC-BATTLE](../../specs/interaction/quality/SPEC-BATTLE.md), "Functional Requirements and Acceptance Criteria", FR8).

3. **Side name missing from the frontend.** The `<!--battlestats:-->` marker carries `name=<uri-encoded name>`, the side's profile name as `battleSideNames` settles it (`BattleSide.displayName`), which the router passes to the processor as `battleContext.selfName`; `messageParser.ts` parses it into `battle.label`; `ConversationInterface.tsx` (`toScorecardVariant`, `battleVariantLabel`) prefers it over `sender.name`. A scorecard header or variant chip showing the generic Amazon Chime SDK AppInstanceBot name ("Assistant"/"Alt-premium") means the marker reached the client without `name=`. Both columns showing the live assistant's name means a version's own `displayName` reached the marker instead of the settled name, which marks the challenger's `{name} (alt)` when the two match.

Once Opus actually runs (1), the model badge reads `OPUS`/`SONNET` (it is `message.modelId` from analytics metadata), so no separate badge fix is needed. Re-verify by reading the captured battle messages (the e2e run's own traces/screenshots) per the verification-discipline note, not by the green run.

---

## 2. Experiment create 500

**Symptom** - Admin → Experiments → "Create & Activate" → *"Internal error"* (`500 {"error":"Internal error"}`); nothing persisted.

**Diagnosis**
```bash
fnlog AgentEchelonAdminServices AssistantAdministrationAdminExperimentsFunction 15m
```
Look for a DynamoDB marshalling throw from `PutCommand`.

**Root Cause** - a `DynamoDBDocumentClient.from(new DynamoDBClient({}))` without `marshallOptions: { removeUndefinedValues: true }`. `validateAndSanitizeExperiment` legitimately leaves optional fields `undefined` (blank `systemPromptAddendum`, text-only `imageGenModelKey`), so the marshaller throws and the handler returns a bare 500. Mocked unit tests do not catch it.

**Solution** - the doc clients in `admin-experiments`, `experiment-manager`, `battle-state` and `task-tracking` set `marshallOptions: { removeUndefinedValues: true }`. A 500 of this shape means a doc client without it. **If you add a new `DynamoDBDocumentClient.from(...)`, include the marshall option by default.**

---

## 3. Create returns `TIER_FORBIDDEN`

**Symptom** - Creating a Premium conversation returns `403 {"code":"TIER_FORBIDDEN"}` with the message *"Your tier (none) does not authorize premium conversations"*, though `custom:tier=premium`.

**Diagnosis**
```bash
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id <USER_POOL_ID> --username <DEMO_EMAIL> \
  --query "Groups[].GroupName"
```
Empty ⇒ the user is in **no Cognito tier group**.

**Root Cause** - Cognito **group** membership is the authoritative tier signal (see `AGENTS.md` → Tier authorization): `create-conversation` resolves the caller's reach from their groups (`resolveHolderToken`, then `grantsFor`), never from `custom:tier`. Seeded or admin-created users skip the post-confirmation trigger that mirrors `custom:tier` → group.

**Solution** - put the person in the clearance group they should hold, in the console's Users tab, or:
```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <USER_POOL_ID> --username <DEMO_EMAIL> --group-name premium
```
They reach it at their next sign-in. A person from another identity provider is placed in the provider group their issuer's entry maps ([IDENTITY-PROVIDER-GUIDE](IDENTITY-PROVIDER-GUIDE.md#groups-from-your-provider)).

**Prevention** - `seed-demo.ts`, `provision-admin.mjs` and `provision-test-users.mjs` place the people they create in their groups, and `post-confirmation.js` places a self-signed-up person at sign-up. A person created any other way is in no group until someone places them.

---

## 4. Invalid app instance user ARN

**Symptom** - tier check passes, then 500 with `code: CONVERSATION_CREATION_FAILED`. The `create-conversation` log line `Error creating conversation:` carries the Amazon Chime SDK error naming an invalid app instance user ARN (the caller sees that message only when `DEBUG_ERRORS` is set).

**Diagnosis** - find the AppInstanceUser the credential exchange recorded for the person. Its `Identities` row is keyed `<issuer id>|<subject>`; for a person on the deployment's own pool that is `deployment|<their sub>`.
```bash
SUB=$(aws cognito-idp admin-get-user --user-pool-id <USER_POOL_ID> \
  --username <DEMO_EMAIL> --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)
aws dynamodb get-item --table-name "$(res AgentEchelonIdentity IdentitiesTable)" \
  --key "{\"issuerSubject\":{\"S\":\"deployment|$SUB\"}}" \
  --query "Item.{personArn:personArn.S,status:status.S}"
```
No item ⇒ the person has never signed in through the credential exchange, so they have no AppInstanceUser yet. An item ⇒ compare its `personArn` with the ARN the failing call sent; they must be the same.

**Root Cause** - the ARN the call sent names no AppInstanceUser. A person's AppInstanceUser id is an opaque UUID v7 that the credential exchange mints at their first sign-in for one issuer and subject (`mintOrResolvePerson` in `backend/lambda/src/lib/person-identity.ts`, called by the credential exchange and, for a visitor, by the guest session in `guest-session.ts`), records in the `Identities` table, and answers as `userArn`. It is never the Cognito username, `sub` or email, so an ARN composed as `<APP_INSTANCE_ARN>/user/<username>` names nobody. The post-confirmation trigger creates no AppInstanceUser.

**Solution** - never create an AppInstanceUser by hand: a second AppInstanceUser for the same person is a duplicate identity the exchange never resolves to. Have the person sign in through the app, which calls the exchange, which mints or resolves their AppInstanceUser; for test and demo users, `node scripts/provision-test-users.mjs` and `seed-demo.ts` sign each user in through the exchange. A client or script takes `userArn` from the exchange's response and never composes it.

**Prevention** - `provision-test-users.mjs` and `seed-demo.ts` sign every user they create in through the exchange and record the `userArn` it answers with. A person created any other way has an AppInstanceUser from their first sign-in.

---

## 5. `/battle` silently ignored

**Symptom** - ChannelFlowProcessor invoked for the `/battle` message but returns quickly with only the entry log; no `[ChannelFlow][battle] Detected`.

**Diagnosis** - `grep -n '\[ChannelFlow\] routing' /tmp/cfp.log` (from §1 step 2). `invokesBattle:false` for a `/battle` prompt ⇒ detection missed.

**Root Cause** - `decodeContent(Content)` (`lib/chime/history.ts`) returns the **raw, still-encoded** string when `decodeURIComponent` throws on any malformed `%`-sequence, leaving a percent-encoded leading token that a decoded-only test against `/^\s*\/battle\b/i` misses.

**Solution** - the flow detects `/battle` / `@all` against **both** decoded and raw `Content` (`matchesBattleCommand(decodedContent) || matchesBattleCommand(Content)`) and strips the prefix from whichever carried it. The `[ChannelFlow] routing {…}` line shows the decision in one log line. A miss with this shape means a new detection path tests only one form. File: `backend/lambda/src/channel-flow-processor.ts`.

---

## 6. Battle Mode unavailable

**Symptom** - in a conversation where battle should run, `/battle` replies *"Battle Mode isn't available in this conversation. Reply normally and I'll respond as usual."* and nothing fans out.

**Diagnosis** - that reply means `canRunBattle` returned false for the channel's classification (`handleBattleMessage` in `backend/lambda/src/channel-flow-processor.ts`). It asks two questions in order (`backend/lambda/src/lib/battle-enablement.ts`): is the classification **battle-capable** (its registry entry's `battleCapable`, the same field its stack builds the battle plumbing from), and has an operator **turned battle on** for it (the parameter `<SSM_ROOT>/battle/<classification>/enabled` reads `true`).

```bash
aws ssm get-parameter --name "<SSM_ROOT>/battle/<classification>/enabled" \
  --query Parameter.Value --output text          # ParameterNotFound = never turned on
grep -n 'battle-enablement' /tmp/cfp.log          # a read fault, if any
```

- `ParameterNotFound`, or a value other than `true`: battle is off for this classification. It is off by default.
- `[battle-enablement] could not read the battle setting; treating battle as OFF`: the ChannelFlowProcessor role cannot read the parameter.
- A classification that is not battle-capable (basic, in the shipped sample config) never reaches the parameter read.

An unreadable `classification` tag produces a different outcome and no reply at all: the flow logs `[ChannelFlow][SecurityEvent] channel classification unreadable; releasing the message and dispatching nothing` and releases the message. That points at `chime:ListTagsForResource` on the ChannelFlowProcessor role.

**Root Cause** - one of three, and all fail CLOSED: the classification is not battle-capable; battle is not turned on for it; or the ChannelFlowProcessor role lacks `ssm:GetParameter` on `<SSM_ROOT>/battle/*/enabled`, so the setting reads as off.

**Solution** - turn battle on for the classification from the admin console's battle setting (the experiments API, `POST /admin/experiments/battle-settings`, which refuses a classification that is not battle-capable with `BATTLE_NOT_CAPABLE`). The flow caches the setting for 30 seconds. For a role fault, keep the `ssm:GetParameter` grant on `<SSM_ROOT>/battle/*/enabled` and `chime:ListTagsForResource` (same `<APP_INSTANCE_ARN>/*` scope as the other Amazon Chime SDK actions) in `backend/lib/stacks/channel-flow-stack.ts`, and redeploy `AgentEchelonChannelFlow` with the full context (§18b).

**Prevention** - when a Lambda's code adds a new AWS call, audit its CDK role in the same change. A fail-closed read masks an IAM gap as a "feature off" message, so log the underlying error where it is caught.

---

## 7. On-demand throughput unsupported

**Symptom** - `ValidationException: Invocation of model ID <model> with on-demand throughput isn't supported. Retry … with … an inference profile…`.

**Root Cause** - some models (e.g. newer Anthropic Sonnet/Opus) **cannot** be invoked on-demand by bare model id; Bedrock requires an inference-profile id/ARN. The invoke path uses `bedrockInvokeId(def)` in `backend/lib/config/model-strategy.ts`, which returns `inferenceProfileArns?.[0] ?? bedrockModelId`, and it is used by `model-resolver.ts`, `assistant-async-processor.ts` (battle path) and `experiment-manager.ts` (A/B). So this error means the catalog entry for that model has no `inferenceProfileArns`.

**Solution** - add the inference-profile ARN to the model's catalog entry.

**Check any model's requirements (your account/region):**
```bash
aws bedrock list-foundation-models \
  --query "modelSummaries[?modelId=='<MODEL_ID>'].{id:modelId,inf:inferenceTypesSupported,status:modelLifecycle.status}"
```
No `ON_DEMAND` in `inferenceTypesSupported` ⇒ that model **must** have an `inferenceProfileArns` entry in the catalog. Inference-profile availability varies by account/region - verify in *yours*.

---

## 8. Model end of life

**Symptom** - `ResourceNotFoundException: This model version has reached the end of its life` for a model id.

**Diagnosis**
```bash
fnlog AgentEchelonAssistants-premium AsyncProcessor 30m | grep -i "end of its life"
# List live successors from the same provider:
aws bedrock list-foundation-models --by-provider <provider> \
  --query "modelSummaries[?modelLifecycle.status=='ACTIVE' && contains(outputModalities,'TEXT')].modelId"
```

**Root Cause** - a `bedrockModelId` in `model-strategy.ts` points at a model version AWS has retired. Bedrock model availability and lifecycle differ per account/region, so this can surface in your account even if it works in another.

**Solution** - re-point the catalog entry to a live model id (keep the catalog **key** stable so `BackendModelKey`/strategy/admin wiring is unaffected). Prefer an Anthropic→Anthropic fallback for provider consistency where a route's primary is Anthropic.

**Prevention** - periodically audit every `bedrockModelId` in `model-strategy.ts` against `aws bedrock list-foundation-models … modelLifecycle.status` for your target account/region. The catalog is the single source of truth - never hardcode model ids in Lambdas.

---

## 9. `substring` TypeError

**Symptom** - the premium async processor crashes on TASK_* (report/document) battles with `TypeError: Cannot read properties of undefined (reading 'substring')`; the task goes to `failed`.

**Root Cause** - a task row with no recorded request text reaching a prompt builder that truncates it unguarded.

**Solution** - `buildTaskContextForPrompt` in `backend/lambda/src/lib/task-tracking.ts` guards it: the request line reads `(task.requestExcerpt ?? task.userMessage)?.substring(0, TASK_EXCERPT_MAX_CHARS) ?? '(not recorded)'`. A crash with this signature means the deployed processor bundle does not carry that guard, or another path truncates task text without one. Rebuild and redeploy the affected `AgentEchelonAssistants-*` stack (§18a), and check any new task-text truncation for optional chaining.

---

## 10. Battle panel looks absent

**Symptom** - an automated check (or a quick manual look) concludes the Battle Mode section is absent and moves on, yet the experiment and its challenger are armed.

**Root Cause** - `ChannelMembersPanel` keeps the Battle Mode section (`section.channel-members-panel-battle`) hidden until the channel's moderator list and the conversation's battle config have both loaded; an instant visibility check runs before either resolves.

**Solution** - wait for `section.channel-members-panel-battle` to become visible before concluding Battle Mode is unavailable (the e2e helper `tests/e2e/helpers/battle-setup.ts` waits up to 10 seconds). Conclude absence only if it never appears, and then check the two render conditions in §1 "Battle panel": the caller is a channel moderator, and the battle config is eligible (§6).

---

## 11. Cross-region `AccessDenied`

### Symptom

A handler resolves a model to an **inference-profile** id/ARN correctly (logs show e.g. `resolvedModel: arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-opus-4-6-v1`), then the invoke fails:

```
AccessDeniedException: User: …<role>… is not authorized to perform:
bedrock:InvokeModel on resource:
arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-opus-4-6-v1
because no identity-based policy allows the bedrock:InvokeModel action
```

The denied resource region (**`us-east-2`** above) is **not** your deploy region (`us-east-1`). On `access_denied`, `bedrock-resilience` fails hard by design (no model fallback) so the assistant posts the generic error bubble.

### Diagnosis

```bash
fnlog AgentEchelonAssistants-premium AsyncProcessor 25m | grep -A2 -i AccessDenied
# Which regions does the profile fan out to?
aws bedrock get-inference-profile \
  --inference-profile-identifier us.anthropic.claude-opus-4-6-v1 \
  --region <REGION> --output json
```

The profile's `description` / `models[].modelArn` list every member region (for the `us.` Anthropic profiles: **us-east-1, us-east-2, us-west-2**).

### Root Cause

A `us.` (or `eu.`/`apac.`) **SYSTEM_DEFINED cross-region inference profile** routes each request to *one of several* member regions for capacity. Bedrock evaluates `bedrock:InvokeModel` authorization against the **destination foundation-model ARN in whichever member region it picked** - not the caller's region and not the inference-profile ARN alone. `modelArnsForClassification` grants exactly the catalog entry's `foundationModelArns` plus its `inferenceProfileArns`, so an entry whose `foundationModelArns` list only the deploy region leaves every other member region denied.

This is **distinct from §7** (that one is "model can't be invoked on-demand by bare id - use a profile"; this one is "profile resolved fine but IAM doesn't cover every region the profile can route to").

### Solution

In `backend/lib/config/model-strategy.ts`, the profile-backed catalog entries build `foundationModelArns` across **every member region** of the `us.` profile (deploy region unioned in defensively) via `crossRegionFoundationModelArns()` / `US_CROSS_REGION_PROFILE_REGIONS`. Build a new profile-backed entry the same way; `modelArnsForClassification` then covers all member regions on the next deploy. A catalog change touches IAM + the Lambda bundle in **each per-classification stack**, so redeploy the affected `AgentEchelonAssistants-*` stack(s): `cd backend && npm run deploy`, or the single-stack form in §18b.

### Prevention

When you add a model that uses a cross-region (`us.`/`eu.`/`apac.`) inference profile, its `foundationModelArns` MUST enumerate every member region the profile routes to - confirm the set with `aws bedrock get-inference-profile … --output json` for your account (member sets can change; foundation-model ARNs carry an empty account field so the set is account-independent). Re-verify periodically alongside the §8 EOL audit.

---

## 12. Model agreement not accepted

### Symptom

A model resolves correctly (the right inference-profile ARN in the logs), the model is ACTIVE in list-foundation-models, and it even works in the Bedrock console Playground, yet the Lambda invoke fails:

    AccessDeniedException: Model access is denied due to IAM user or
    service role is not authorized to perform the required AWS
    Marketplace actions (aws-marketplace:ViewSubscriptions,
    aws-marketplace:Subscribe) to enable access to this model ... Your
    AWS Marketplace subscription for this model cannot be completed at
    this time. If you recently fixed this issue, try again after 2 min.

This is distinct from section 11 (that one is the Lambda role's bedrock:InvokeModel policy missing a cross-region member region). Here the policy is fine; the account-level model AGREEMENT is not accepted. The Playground works because the console user's credentials carry aws-marketplace permissions and auto-complete the subscription; a Lambda role does not, and should not.

### Diagnosis

    aws bedrock get-foundation-model-availability --model-id <id> \
      --query "{agreement:agreementAvailability.status,auth:authorizationStatus}"

`agreementAvailability` AVAILABLE = good. NOT_AVAILABLE = the blocker. PENDING = accepted and provisioning; it becomes AVAILABLE in about 1-2 minutes.

### Solution

The Bedrock console does not show a per-model "Model access" toggle for this. Accept the agreement programmatically (one-time, per account+region, reversible):

    aws bedrock list-foundation-model-agreement-offers --model-id <id> > offers.json
    # offers.json is large; grep the token rather than printing it:
    #   grep -oE '"offerToken": "[^"]+"' offers.json | head -1
    aws bedrock create-foundation-model-agreement --model-id <id> \
      --offer-token "<offerToken>"
    aws bedrock get-foundation-model-availability --model-id <id> \
      --query "agreementAvailability.status"     # NOT_AVAILABLE -> PENDING -> AVAILABLE

Reverse with `aws bedrock delete-foundation-model-agreement --model-id <id>`.

### Prevention

Adding a model to `model-strategy.ts` is not enough on its own: also confirm `get-foundation-model-availability` shows agreement AVAILABLE in the target account+region, and (for cross-region `us.` profile models) that section 11's all-member-region IAM holds. Both gates plus the Bedrock-console model-access check in "CDK / deploy notes" must pass.

---

## 13. Message size limit exceeded

### Symptom

An assistant generates a real, long answer (logs show a large `responseLength` and `Long response split into N chunks`), the continuation messages send, then the placeholder UPDATE throws `BadRequestException: Channel Messages size limit exceeded` and the user sees the generic "Sorry, I encountered an issue" instead of the answer. Most visible on `/battle` (Opus/Sonnet answers are long).

### Root Cause

Amazon Chime SDK Messaging caps the REQUEST PARAMETER length: Content max 4096, Metadata max 1024 - measured on the URL-encoded string actually sent (`encodeURIComponent(...)`), not the raw character count. Markdown/prose roughly doubles (worst case triples) when encoded. A chunk sized by RAW length can therefore exceed 4096 encoded, and chunk[0] additionally gets the battlestats/ACTIVE_TASK marker appended before the encoded UPDATE. The per-message analytics Metadata can also exceed 1024 on battle turns.

### Solution

`backend/lambda/src/lib/async-processor-core.ts`: `splitIntoChunks` is encoded-length-aware (binary search on `encodeURIComponent(...).length`, natural-boundary backoff), chunk[0] gets a smaller budget reserving marker headroom (`CHUNK0_MARKER_HEADROOM`), and `safeMetadataString` drops an oversized Metadata with a warning rather than fabricating it or failing the post (the battle scorecard/name ride the Content marker, not Amazon Chime SDK Metadata; analytics also flows via the archival pipeline). Pinned by tests in `backend/test/lib/async-processor-battle.test.ts`. An error of this shape means a send path that bypasses these. `async-processor-core.ts` is bundled into every classification's async processor, so redeploy the affected `AgentEchelonAssistants-*` stack(s) after a change.

### Prevention

Any new Send/UpdateChannelMessage path must budget by encoded length, not raw `String.length`, and keep Metadata under 1024 encoded.

---

## 14. Admin tabs silently empty

### Symptom

After a deploy, the admin **Overview / Models / Latency / Evaluations / Users / Intent** tabs show "No analytics data yet" indefinitely. New conversations don't surface. The frontend looks fine, and the analytics and evaluation Lambdas run without errors - but every query returns zero rows.

### Diagnosis Steps

The archival pipeline starts with a Kinesis stream that Amazon Chime SDK Messaging streams into. It lives in the `Messaging` stack in both archive modes (`AgentEchelonMessaging` on the default instance, `messaging-stack.ts`), and its name embeds the instance name: `chime-messaging-<instance-name>`.

```bash
# 0. Read the stream name from the Messaging stack.
STREAM=$(aws cloudformation describe-stacks --stack-name AgentEchelonMessaging \
  --query "Stacks[0].Outputs[?OutputKey=='KinesisStreamName'].OutputValue" --output text)

# 1. Are Amazon Chime SDK events arriving at Kinesis at all?
aws cloudwatch get-metric-statistics \
  --namespace AWS/Kinesis --metric-name IncomingRecords \
  --dimensions Name=StreamName,Value="$STREAM" \
  --start-time "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 3600 --statistics Sum

# 2. If Sum is 0, the Amazon Chime SDK → Kinesis wiring is broken. Verify it.
APP_INSTANCE_ARN="$(aws cloudformation describe-stacks \
  --stack-name AgentEchelonMessaging \
  --query 'Stacks[0].Outputs[?OutputKey==`AppInstanceArnOutput`].OutputValue' \
  --output text)"
aws chime-sdk-messaging get-messaging-streaming-configurations \
  --app-instance-arn "$APP_INSTANCE_ARN"
```

### Root Cause

The Amazon Chime SDK → Kinesis streaming configuration is missing, points at the wrong stream, or the Amazon Chime SDK AppInstance was rotated and the wiring lost. The Messaging stack re-applies it on every deploy via an `AwsCustomResource` (`putMessagingStreamingConfigurations`), so it normally heals itself - but a partial deploy, a manual `delete-messaging-streaming-configurations` call, or an account-level service issue can leave it disconnected.

### Solution

Redeploy the Messaging stack; the custom resource re-applies the wiring. Use the supported path, which forwards the full context:

```bash
cd backend && npm run deploy
```

To target only the Messaging stack (`AgentEchelonMessaging`), use the single-stack form in §18b, which passes every `deploy.config.json` key.

### Prevention

In either archive mode, the Notifications stack (`AgentEchelonNotifications`, `backend/lib/stacks/notification-stack.ts`, present when `notifications` is a declared capability) deploys an opt-in CloudWatch alarm on the Messaging stack's stream, delivered by the one alarm notifier (`backend/lambda/src/alarm-to-admin-channel.ts`), that fires when Kinesis `IncomingRecords` stays at 0 for 1 hour. Enable it by setting `alertRecipientArns` (the AppInstanceUser ARNs of the people to email, comma-separated; their addresses are read from their identity provider at send time) and a verified `senderEmail` in `backend/deploy.config.json`, then `npm run deploy`. Without `alertRecipientArns`, the alarm + Lambda are not deployed (no cost, no false noise on low-traffic dev accounts). In SES sandbox, every recipient must also be verified. Without the alarm, a disconnected stream surfaces only as empty tabs, so run the diagnosis above after any deploy that touches the analytics or messaging stacks.

---

## 15. Every reply is `{"Code":403}`

### Symptom

Every assistant reply - in 1:1 and multi-user channels, across all classifications - is the literal text `{"Code":403}`, returned suspiciously fast (~400-600ms, far below real Bedrock latency). The conversation is created fine and the assistant appears to "respond", but the response is this error blob. Typically appears **after a fresh deploy, or a teardown → redeploy**, where the Lex bots were re-created.

> Bubble-count-only E2E checks (e.g. mentions asserting "count grew by ≥2") will still PASS here - the `{"Code":403}` blob is a message. Read response content.

### Diagnosis Steps

```bash
# 1. Confirm the router barely ran (fast 403 = it never reached Bedrock).
#    Count router invocations vs. any "Welcome"/real-work log lines.
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AgentHandler)" \
  --start-time $(( ($(date +%s) - 600) * 1000 )) \
  --filter-pattern START --query 'length(events)'

# 2. Inspect the Lex bot's resource policy (the smoking gun: there is none,
#    or it lacks messaging.chime.amazonaws.com). Get a Lex bot id first:
aws lexv2-models list-bots --query "botSummaries[?contains(botName,'Assistant')].[botName,botId]" --output text
aws lexv2-models describe-resource-policy --resource-arn \
  "arn:aws:lex:<REGION>:<ACCOUNT>:bot/<BOT_ID>"            # may 404 = missing
aws lexv2-models describe-resource-policy --resource-arn \
  "arn:aws:lex:<REGION>:<ACCOUNT>:bot-alias/<BOT_ID>/TSTALIASID"
```

### Root Cause

Amazon Chime SDK Messaging invokes an AppInstanceBot's configured Lex bot via the **bot-alias ARN**, and is denied unless a Lex **resource policy** grants `messaging.chime.amazonaws.com` permission to call it. **BOTH** the Lex bot **and** the bot alias need the policy (the alias one is the one most often missed - Amazon Chime SDK invokes the *alias*). The condition must use `ArnLike` (not `ArnEquals`) so the `app-instance/<id>/bot/*` source wildcard matches.

The provisioner creates both resource policies when it builds an assistant's Lex bot (`allowChimeToInvoke` in `backend/lambda/src/lib/assistant-lex-bot.ts`, called by `buildIdentity` in `assistant-provisioner.ts` for every assistant, declared or created in the console). It writes them once, at the build, so a Lex bot that exists without the policies stays without them until patched.

### Solution

For **Lex bots that already exist** without the policy, patch them in place:

```bash
# Pass every classification's Lex bot id (list-bots above). Idempotent; replaces if present.
AWS_PROFILE=<profile> AWS_ACCOUNT_ID=<ACCOUNT> \
  node backend/scripts/grant-chime-lex-invoke.mjs <BOT_ID> [<BOT_ID>...]
```

The script reads the app instance from the `<prefix>Messaging` stack, with the prefix resolved as every operator script resolves it: `AE_STACK_PREFIX` when set, otherwise the PascalCase of `AE_INSTANCE_NAME` (default `agent-echelon`, so `AgentEchelonMessaging`). Set the same variables the deploy used.

After patching, new conversations get real answers immediately (no redeploy of the AppInstanceBots needed - the policy is on the Lex side).

### Prevention

The policies ship in the provisioner's build path, so a freshly built Lex bot is correct. A deploy does not rebuild an assistant that exists (a declared one is seeded once), so it does **not** restore missing policies; use the `grant-chime-lex-invoke.mjs` script.

### WelcomeIntent not firing

**Symptom:** normal replies work, but no greeting appears when a conversation is created (router logs show `FallbackIntent` invocations but zero `WelcomeIntent`).

**Root cause:** `WelcomeIntent` must be configured on the **specific AppInstanceBot that is a member of the conversation channel** - and that AppInstanceBot's Lex bot also needs the resource policy above. `create-conversation` enrolls the classification's **primary assistant** (`primaryAssignmentOf` in `backend/lambda/src/lib/conversation-primary.ts`, read from the live assistant assignments) as a channel member before the user joins. There is no shared cross-classification fallback, so `WelcomeIntent` must be set on the AppInstanceBot that holds that role. Confirm which AppInstanceBot is in the channel before chasing config:

```bash
# Members of a conversation (run as a member's AppInstanceUser ARN):
aws chime-sdk-messaging list-channel-memberships --channel-arn "<CHANNEL_ARN>" \
  --chime-bearer "<APP_INSTANCE_ARN>/user/<PERSON_ID>" --query 'ChannelMemberships[].Member.Arn'
# The AppInstanceBot in that list is the one that needs WelcomeIntent + the resource policy.
aws chime-sdk-identity describe-app-instance-bot \
  --app-instance-bot-arn "<BOT_ARN>" --query 'AppInstanceBot.Configuration.Lex'
```

**Fix:**
```bash
aws chime-sdk-identity update-app-instance-bot --app-instance-bot-arn "<BOT_ARN>" \
  --name "Assistant" --metadata "" --configuration \
  '{"Lex":{"LexBotAliasArn":"<ALIAS_ARN>","LocaleId":"en_US","WelcomeIntent":"WelcomeIntent","InvokedBy":{"StandardMessages":"<LIVE_VALUE>","TargetedMessages":"ALL"}}}'
```

**Match `StandardMessages`.** The provisioner sets `NONE` on every identity it builds (`assistantBotConfiguration`), but a live AppInstanceBot can carry a different value, such as `AUTO`. Read the live value with `describe-app-instance-bot` first and write back the same one; writing a different value changes which messages invoke the assistant.

In code: the provisioner sets `WelcomeIntent` on every identity declared to greet (`buildIdentity`, `assistant-provisioner.ts`), so fresh builds are correct. A classification's alt and the admin assistant are declared with `welcome: false` (`assistant-profile-stack.ts`, `admin-services-stack.ts`), and both stay silent on join. The AppInstanceBot must also be a channel **member** to send the greeting - `create-conversation` enrolls it explicitly, before the user joins.

---

## CDK / deploy notes

- **Supported deploy:** `cd backend && npm run deploy` builds, deploys with the live `appUrl`, syncs context, generates the per-package frontend env and publishes the frontend. It forwards every key in the gitignored `backend/deploy.config.json` (see `backend/deploy.config.example.json`).
- **Single-stack deploy:** `cd backend && npm run deploy:stack -- <prefix><Stack>` (§18b) applies every `deploy.config.json` key, without which context-gated flags revert to their defaults, and refuses a stack name `cdk list` does not print under that context. Never a raw `cdk deploy`. The ChannelFlowProcessor is in **`AgentEchelonChannelFlow`**; the experiments table in **`AgentEchelonExperiments`**; the admin-experiments and manage-profiles Lambdas in **`AgentEchelonAdminServices`** (the `admin` capability); the battle tables + orchestrator in **`AgentEchelonBattle`**; each classification's async-processor + agent-handler Lambdas in its own **`AgentEchelonAssistants-{basic,standard,premium}`** stack. A model-catalog change touches IAM (via `modelArnsForClassification`) **and** bundles into Lambdas in every per-classification stack → redeploy the affected `AgentEchelonAssistants-*` stack(s).
- **Frontend:** never ships via `cdk deploy`; it ships via `node scripts/deploy-frontend.mjs` (see [`FRONTEND-DEPLOY.md`](FRONTEND-DEPLOY.md)).
- **Verify the deploy actually applied:** a stack can be `UPDATE_COMPLETE` yet stale. Confirm the Lambda's `LastModified` advanced past "now":
  ```bash
  aws lambda get-function-configuration \
    --function-name "$(fn <STACK> <LOGICAL_ID>)" --query LastModified
  ```
- **IAM from catalog:** `modelArnsForClassification` includes `inferenceProfileArns`; adding a model with a profile to the catalog grants it on next deploy. **Cross-region profiles also need every member region's `foundation-model` ARN in `foundationModelArns`** - see §11.
- **Bedrock model access:** every model id in the catalog must be **enabled** in your account's Bedrock console (model access) for the target region, or invokes fail with AccessDenied regardless of IAM. Verify: `aws bedrock list-foundation-models --query "modelSummaries[?starts_with(modelId,'anthropic')].modelId"`.

## Environment gotchas

- **Credential expiry.** `aws sts get-caller-identity` failing mid-session (expired SSO token, expired assumed-role) ⇒ re-authenticate with whatever your account uses (`aws sso login`, refresh static keys, re-assume role). Re-check before each diagnostic batch on long sessions.
- **Windows / Git-Bash path mangling.** Prefix AWS-logs commands with `MSYS_NO_PATHCONV=1` or `/aws/lambda/...` becomes `C:/Program Files/Git/aws/lambda/...`. (The `fnlog` helper line: prefix it.)
- **`/tmp` on Git-Bash** isn't resolvable by some editors/tools - if you need to read a dump with a non-shell tool, write it under the repo (e.g. `tests/`) and delete it after.
- **Re-created identities are new people.** A demo identity deleted and re-created is a new subject, so it is in no group until placed (§3) and its first sign-in mints a new AppInstanceUser (§4); `seed-demo.ts` and `provision-test-users.mjs` do both.

## Useful commands

```bash
aws sts get-caller-identity
res <STACK> <LOGICAL_ID>                       # physical name from logical id
fnlog <STACK> <LOGICAL_ID> 20m                 # tail a Lambda (MSYS_NO_PATHCONV=1 on Windows)
aws ssm describe-parameters \
  --query "Parameters[?starts_with(Name,'<SSM_ROOT>/assistant-assignments') && ends_with(Name,'/alt')].Name"   # each battle alt's record
# Promote grounding a conversation holds only in channel metadata (dry-run first; see §21):
cd backend && npx ts-node scripts/backfill-channel-context.ts --dry-run
```


## 16. Live drift returns `{"Code":429}`

### Symptom

With live drift / RAG on (`enableLiveDrift` true) in Aurora mode, every conversation returns the literal text `{"Code":429}` with a very long TTFR (~43s, near the handler's 30s timeout plus Amazon Chime SDK retries). The classification's AgentHandler log group shows ZERO events for the turn, so it looks like an upstream Lex/Amazon Chime SDK throttle. It is not.

### Diagnosis

```bash
# 1. Confirm the handler never ran (0 START events = it never reached Bedrock).
fnlog AgentEchelonAssistants-premium AgentHandler 10m   # expect near-zero events
# 2. Is the handler VPC-attached? A non-empty VpcId is the smoking gun.
aws lambda get-function-configuration --function-name "$(fn AgentEchelonAssistants-premium AgentHandler)" \
  --query '{Vpc:VpcConfig.VpcId,LiveDrift:Environment.Variables.ENABLE_LIVE_DRIFT,DataPlane:Environment.Variables.AURORA_DATA_PLANE_ARN}'
# 3. What endpoints does the VPC actually have?
aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<VPC_ID> \
  --query 'VpcEndpoints[].ServiceName'
```

If the endpoint set is `{bedrock-runtime, secretsmanager, kinesis}` with no `ssm`, `cognito-idp`, or `lambda` endpoint, and the subnets are isolated (no NAT), that is the gap.

### Root Cause

A VPC-attached, Lex-facing AgentHandler in ISOLATED subnets cannot reach the control-plane services it needs at runtime: SSM (assistant ARN / channel-flow ARN parameters), Cognito (`AdminListGroupsForUser`), and Lambda (`InvokeFunction` to start the async processor). None of those has a VPC endpoint in the analytics VPC, and isolated subnets have no NAT egress. The handler hangs on the first such call, hits its 30s timeout, and Amazon Chime SDK retries the Lex fulfillment until it posts `{"Code":429}`. The drift / ingestion Lambdas run from the same subnets because they need only Bedrock + Secrets + Aurora, which DO have endpoints. `createVpcEndpoints=true` does NOT fix this: it creates only the analytics endpoints (no SSM/Cognito/Lambda).

### Solution

The shipped handler is not VPC-attached (ADR-013). Retrieval and drift run in a VPC-attached **turn data plane**, one per classification (the function `AgentEchelonAssistants-<classification>-TurnDataPlane`, built in that classification's Assistants stack by `ClassificationArchiveFunctions`); the handler stays non-VPC and invokes it. `enableLiveDrift` true wires the handler with `AURORA_DATA_PLANE_ARN` + `lambda:InvokeFunction`, not a VpcConfig. A healthy handler shows `Vpc` empty and `DataPlane` set. A handler with a VpcId has been attached by a change outside the shipped stacks: remove the VpcConfig and redeploy the classification stacks with the full context (§18b), or add `ssm` + `cognito-idp` + `lambda` interface endpoints. See `docs/guides/developer/RAG.md` and `docs/guides/admin/INFRASTRUCTURE-COST.md`.

### Prevention

Do not VPC-attach a synchronous, Lex-facing handler that calls SSM / Cognito / Lambda into isolated subnets. Keep only the Aurora + Bedrock data work in the VPC (the data plane) and invoke it from the non-VPC handler.

---

## 17. Wrong classification answers

### Symptom

A user signs in with premium (or standard) clearance, asks for classification-gated data (for example the premium financial ARR), and the assistant replies that it has no access, or identifies itself as basic. Common in E2E classification tests. The premium AgentHandler / AsyncProcessor log groups show ZERO events for the turn; the BASIC ones ran instead.

### Diagnosis

```bash
# Which classification's handler actually ran? Compare event counts per log group.
for T in basic standard premium; do
  echo -n "$T: "; fnlog "AgentEchelonAssistants-$T" AgentHandler 6m | grep -c "START RequestId"
done
```

If Basic ran and Premium did not, the conversation is a basic conversation.

### Root Cause

The effective classification is the channel's classification (IAM refuses a sender without clearance for it). The channel's classification is set by the ASSISTANT chosen at conversation creation (the classification card: Claude Haiku = basic, Claude Sonnet = standard, Claude Opus = premium), NOT by the signed-in user alone. A premium user who opens a Claude Haiku conversation gets basic access by design. If a test helper hardcodes one assistant for every classification, the other cases silently run at basic and can never see their own data, regardless of context / IAM / retrieval.

### Solution

Open the conversation with the classification's own assistant: `createConversation(page, title, 'Claude Opus')` for premium, `'Claude Sonnet'` for standard, `'Claude Haiku'` for basic. See `tests/e2e/classification-context.spec.ts` `ask()`.

### Prevention

When a classification "cannot see" its data, first confirm WHICH classification's handler ran before suspecting context, IAM, or retrieval. The conversation's assistant is a real classification boundary, not just a model label.

---

## 18. Deploy landmines

These bite any deployment. The one-command `npm run deploy` avoids all of them; they show up when you run `cdk deploy` by hand or target a single stack.

### 18a. Stale Lambda bundle

**Symptom.** You change a `.ts` module a Lambda imports, `cdk deploy`, and CloudFormation reports no change to that function (or it deploys but the old behavior persists).

**Root cause.** CDK's `NodejsFunction` esbuild bundles the on-disk **compiled `.js`** of imported modules, not the `.ts` source. Without a fresh compile it bundles a stale `.js`, so the edit never ships and the bundle hash is unchanged.

**Fix.** Deploy with `npm run deploy` or `npm run deploy:stack -- <prefix><Stack>` (in `backend/`), which both compile first. Verify by confirming the function's asset hash changed in the deploy output.

### 18b. Single-stack context loss

**Symptom.** After deploying ONE stack by hand, previously-enabled features turn off (admin IAM enforcement, admin personas, membership audit, ...), or the live app suddenly shows "Failed to fetch" / CORS errors on every request.

**Root cause.** Context-gated behavior reads `cdk` context. The persisted per-instance context lives in `backend/deploy.config.json` and is forwarded by `npm run deploy`. A bare `cdk deploy <Stack>` passes NONE of it, so every `-c`-gated flag falls back to its default (often OFF), and `appUrl` defaults to `http://localhost:5173`, which sets the APIs' `ALLOWED_ORIGIN` to localhost and breaks CORS for the real CloudFront origin.

**Fix.** Never deploy a stack without the full context and a real `appUrl`:

```bash
cd backend

# Prefer the one-command path (forwards deploy.config.json + resolves appUrl live):
npm run deploy

# To target one stack, name it with the instance prefix (AgentEchelon on the default instance).
# deploy:stack builds, applies every deploy.config.json key, and deploys that stack alone
# (--exclusively); --diff-only shows the change without deploying:
npm run deploy:stack -- AgentEchelonIdentity --diff-only
npm run deploy:stack -- AgentEchelonIdentity
npm run deploy:stack -- AgentEchelonConversations
```

`deploy:stack` applies `deploy.config.json`, checks the stack name against `cdk list` under that context, and refuses when `appUrl` is missing from it, so set `appUrl` there first. It also refuses an analytics mode that differs from the deployed one, as `npm run deploy` does, and a checkout that does not contain the commit the stack was last deployed from (see the rollback check in [`STACKS.md`](../../overview/STACKS.md)).

With the admin console enabled, `adminAppUrl` must also be in `deploy.config.json` (see [`FRONTEND-DEPLOY.md`](FRONTEND-DEPLOY.md)).

**Prevention.** Treat `deploy.config.json` as required input to every backend deploy. A value containing a space is split by the shell in the command above and reaches `cdk` as a bare token that fails with `assignment.split is not a function`; quote such a value by hand, or avoid spaces in context values.

### 18c. Windows path mangling

**Symptom.** ARNs or `/`-paths in a deploy/CLI command become `C:/Program Files/Git/...`; or the AWS CLI aborts printing a resource with a `UnicodeEncodeError: 'charmap'` on emoji output.

**Fix.** Prefix commands that carry ARNs or absolute paths with `MSYS_NO_PATHCONV=1`. For CLI output that may include emoji, set `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`.

### 18d. `SignatureDoesNotMatch`

**Symptom.** CDK/CLI calls fail `SignatureDoesNotMatch` even though `aws sts get-caller-identity` worked earlier.

**Root cause.** Stale static credentials in the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`) shadow, and conflict with, the profile you intend to use.

**Fix.** Use the profile and clear the static vars so they cannot shadow it: `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; export AWS_PROFILE=<profile>`.

---

## See also

- `docs/specs/interaction/quality/SPEC-BATTLE.md` - battle design; clarification as a measured dimension
- `AGENTS.md` - tier authorization
- `README.md` "Quick Start" - where CDK outputs / `.env` values come from
- §18 - deploy landmines (stale bundles, single-stack context, CORS, Windows)

---

## 19. Placeholder never resolves

**Symptom** - the user sends a message, the assistant posts *"One moment..."*, and the answer never replaces it. Either the answer arrives as a separate new message while the placeholder stays as it was, or no answer arrives at all.

**Diagnosis** - when the processor has an answer and cannot find the placeholder to put it on, it posts the answer as a new message from the assistant's own session and logs one of two lines:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AsyncProcessor)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"no placeholder"' \
  --query "events[].message" --output text
```

`[AssistantAsyncProcessor] no placeholder; the answer was posted as a new message` means the answer reached the conversation as its own message. `[AssistantAsyncProcessor] no placeholder, and the answer could not be posted either` means the turn was lost: the processor records `reply_undeliverable` for the person's client and returns. A queue reading (correlation id `arrival-<hash>-<n>`) owns no placeholder by design and skips this path: see [§22](#22-queued-message-unanswered). Read the resolution line for the same turn:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AsyncProcessor)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"Deferred placeholder resolution"' \
  --query "events[].message" --output text | grep "<CORRELATION_ID>"
```

`resolved: false` with a `scanMs` means the mapping read missed and the channel scan found nothing either.

**Why a lookup exists** - on the Lex path the placeholder is created by Amazon Chime SDK Messaging *from the Lex response*, so its `MessageId` does not exist when the router invokes the processor (`InvocationType.Event`). The processor's handle is the `<!--corr:{id}-->` marker. Every message carrying the marker passes through the channel flow, which records `corr#<id> -> MessageId` (`claimPlaceholderMapping`) before releasing it. At delivery, after the model call, the processor:

1. reads that mapping once (`resolveDeliveryMessageId` in `backend/lambda/src/lib/async-processor-core.ts`), falling back to a `placeholderMessageId` it was handed;
2. if nothing resolves, scans the channel once (`scanForPlaceholderMessage`): one `ListChannelMessages` call over the 20 most recent messages, matching the marker in the decoded content or inside the Lex envelope;
3. if both miss, posts the answer as a new message with no correlation marker and logs the first line above; if that send fails too, logs the second, records `reply_undeliverable`, marks any task it opened as failed, and returns (`backend/lambda/src/assistant-async-processor.ts`).

There is no retry loop. The placeholder has had the whole model call to land and its mapping to be written, so a miss at delivery means the mapping was never written. No path passes `placeholderMessageId`: the field on `TurnRequest` in `backend/lambda/src/router-agent-handler.ts` has no producer (ADR-029), which leaves the handed-id fallback in step 1 unreachable. `@all`, `/battle` round 1 and a battle continuation each dispatch the processor before their placeholder exists, so they find it through the same mapping read and then the scan as the Lex path.

**Cause** - the placeholder carrying this correlation id never materialized. The established way that happens is a duplicate fulfillment. Amazon Chime SDK and Lex deliver at least once, and Amazon Chime SDK materializes one message per turn from the LAST fulfillment response. When two fulfillments of one turn carry different correlation ids, the processor dispatched by one searches for a marker only the other's response could carry, and no search width can find it.

**Controls** - three, specified in [ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md):

1. **The correlation id is derived from the turn** (`turnCorrelationId` in `backend/lambda/src/lib/correlation.ts`: channel, sender, transcript, 90 second bucket) rather than minted at random, so a retried fulfillment reuses the label and the processor's `dedup#<correlationId>` claim collapses it. Every input is one a retry provably replays. The Lex `sessionId` is deliberately not among them: the session is per channel and per user, both already hashed, so it discriminates nothing, while adding a dependency on Amazon Chime SDK replaying the same session on a retry, which is undocumented. If such an input varied, every derived id would differ and this control would silently do nothing. No claim is taken on the inbound message at the flow: the duplicate is a retried *fulfillment*, which happens after the flow released the message, and the only way a flow can stop a message reaching Lex is `callbackDeny`, which would remove the user's own message from the conversation.
2. **The router replays the same placeholder on a duplicate fulfillment.** Having derived the same id, the retry fails to claim `fulfil-<correlationId>` and returns the SAME placeholder text carrying the SAME `<!--corr:-->` marker, doing no work. It does not go silent, because Amazon Chime SDK materializes the LAST response and that may be the only one that reaches the channel. Replaying makes the two attempts interchangeable, so whichever materializes carries the marker the dispatched processor is looking for. The one exception is a duplicate of a gate-blocked fulfillment: the winner returned the block notice and dispatched nothing, so the duplicate returns an empty envelope (`formatLexSilentResponse`) and the notice stands. This is the only place the duplicate can be caught, because **channel flows do not intercept Lex responses** and nothing downstream sees that placeholder before it lands.
3. **The flow writes the `corr#<id> -> MessageId` mapping** when an assistant message carrying the marker passes through it, and the processor point-reads that key before scanning. That includes the normal path's placeholder: a message Amazon Chime SDK materializes from a Lex response runs through the flow like any other. The flow sees it synchronously, before the message is released, so the mapping exists before the message is visible to `ListChannelMessages`.

With all three in place, a `no placeholder` line means the turn's id was not stable across the duplicate, or the mapping write failed and the scan did not match the message.

**The answer as a new message** - the answer was already paid for, so the processor posts it rather than discarding it, and the rest of delivery runs against the new message as it would against a placeholder, so a battle side still records its terminal state. The cost is the one-message-updated-in-place pattern (see [DESIGN-BATTLE](../../specs/interaction/quality/DESIGN-BATTLE.md)): the placeholder it could not find stays in the conversation beside the answer. When a processor fails on a turn whose placeholder does resolve, the error notice lands on that placeholder in place (`handleProcessingError`, which uses the same mapping-then-scan resolution).

**Log identification** - `[AssistantAsyncProcessor] Invoked` carries the channel id, the placeholder message id when one was handed over, the correlation id and the task fields. The Amazon Chime SDK ARN prefix is deliberately absent: it is identical on every line, carries the account and app-instance ids, and identifies nothing.

**OPEN** - which layer redelivers: Amazon Chime SDK re-invoking the flow, or Lex re-fulfilling a released message. The derived id collapses the duplicate either way, but the answer determines whether a duplicate is also visible as a second flow invocation.

**OPEN** - the scan matches the decoded content and the Lex envelope form only. A stored `Content` encoding other than those two would not match, the same class of problem as the still-encoded content in §5. The mapping read runs first, so this affects only turns whose mapping was never written.

**Prevention** - load-sensitive rather than deploy-sensitive: the busier the channel, the likelier a duplicate delivery. Widening the scan window does not address it, because the losing invocation is searching for a marker that was never written.

---

## 20. Previous turn forgotten

**Symptom** - a user states a fact, asks for it back a turn or two later, and the assistant denies ever having seen it ("I do not have any record of you mentioning a cutover date"). It is intermittent: the same exchange succeeds on one run and fails on the next, with no code change between them. Nothing reports an error, and the reply is fluent, so it reads as a model quality problem rather than a defect.

There are two independent causes. They present identically. Establish which one applies before changing anything.

### Diagnosis

Start at the router, because the first cause never reaches the model at all:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AgentHandler)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"short-circuiting the turn"' \
  --query "events[].message" --output text
```

A hit (`[Drift] suggestion fired, short-circuiting the turn`) means drift answered the turn instead of the assistant. If there is no hit, look at what the processor actually assembled:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AsyncProcessor)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"messages from channel history"' \
  --query "events[].message" --output text
```

Read the `roles` field, not the count. A healthy second turn is `aua` (the welcome, the user's opening turn, the reply). The count alone cannot distinguish that from `aa`, which is the same length with the user's own turn missing - and a leading run of assistant turns is promoted wholesale into `priorAgentContext`, leaving the model nothing but the current message.

### Cause A: drift short-circuit

A fired drift suggestion returns immediately from the router. The agent flow never runs, so the turn is answered without conversation history and without a model call. That is by design, and it is correct when the user really has pivoted.

It misfires on a turn that refers *backwards* into the same conversation. Once the opening exchange is summarized and embedded, a follow-up asking for a detail from that first turn can score past `DRIFT_DISTANCE_THRESHOLD` (0.84 by default) and fire. The signal is the nearest cosine distance between the message and the conversation's anchors (its summary and each of its subjects), and a short referential question ("what did I mention?") carries almost none of the topic words the summary embedding was built from, so it lands far from an anchor that summarizes one exchange.

This is the same false-positive shape `activeTaskInProgress` suppresses, documented in `drift-detection.ts`: an answer the assistant solicited is a continuation, not a pivot, and cosine cannot see the difference. That suppression applies only while a task is live.

**Metric confirmation.** The decision runs in the classification's turn data plane (the function `<prefix>Assistants-<classification>-TurnDataPlane`, built in that classification's Assistants stack with a fixed name by `turnDataPlaneName` in `backend/lib/constructs/classification-archive-functions.ts`; `AgentEchelonAssistants-premium-TurnDataPlane` for premium on the default instance) and emits EMF:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/AgentEchelonAssistants-premium-TurnDataPlane" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"drift_fired"' --query "events[].message" --output text
```

`drift_fired` confirms the cosine path. `drift_fastpath_explicit_intent` means the explicit-routing allowlist matched instead, which is a different defect - that allowlist is deliberately narrow and should not match an ordinary question.

### Cause B: history filter

`loadChannelHistory` excludes placeholder messages so the *"One moment..."* bubble is not fed back to the model as an assistant turn. Placeholders are identified by the `<!--corr:{id}-->` marker every one of them carries (`isPlaceholderMessage`); the answer arrives as an update whose content has no marker, so a resolved placeholder correctly stops matching.

Identifying them by their punctuation instead does not work, and is worth stating because it looks reasonable. Every placeholder copy ends in an ellipsis (*"One moment..."*, *"Analyzing..."*, *"Looking into that..."*), but so does ordinary prose, so a substring test on `...` silently deletes real assistant turns from the next turn's context. The drop is invisible, and intermittent in exactly the reported way, because it depends on whether that one reply happened to use an ellipsis.

Losing the trailing assistant turn has a second effect. Bedrock requires alternating roles, which is why the history is consolidated before the model call; a history that ends on a user turn puts two user turns next to each other once the current message is appended. The composition therefore consolidates the history *and* the current turn as one array, not the history alone.

### Prevention

Both causes are silent by construction, so the guard is observability rather than a check:

- The router logs every drift interception, so a short-circuited turn is distinguishable from a turn that failed to dispatch.
- The history load logs the role shape alongside the count. A count cannot diagnose this; a shape can.

Neither cause is deploy-sensitive. Cause A tracks how the conversation is worded, cause B tracks how the model happened to punctuate a reply, so a deployment that works one day can fail the next with no change shipped.

## 21. Lost grounding

### Symptom

An existing conversation answers generically, without the plan, the participant's profile or their name, and one meant for another language or region replies in the deployment's default language on the default model. New conversations are fine. Nothing errors.

### Cause

`participantProfile`, `domainContext`, `otherContexts`, `userName`, `userLanguage` and `segment` live in the server-only channel-context store, not in channel metadata. Channel metadata is member-**writable** (a channel's creator is a moderator of their own channel and holds `chime:UpdateChannel`, which sets Name and Metadata in one call), so the router reads those six only from the store and never falls back to metadata. Every writer of the store is on a conversation-create path, so a conversation whose grounding exists only in its metadata has no store row and gets none.

### Confirm

The router log group carries one line per affected turn, naming the channel and which keys are still in metadata (never their values):

```
[host-grounding] channel <arn> has legacy private grounding in member-readable Metadata (...)
```

### Fix

```bash
cd backend
AWS_PROFILE=<your-profile> npx ts-node scripts/backfill-channel-context.ts --dry-run
AWS_PROFILE=<your-profile> npx ts-node scripts/backfill-channel-context.ts
```

Set `AE_INSTANCE_NAME` to the instance (default `agent-echelon`): the script reads the table name and the app-instance-admin bearer from that instance's SSM root. It promotes what metadata still carries, re-bounded and marker-stripped, and never overwrites a row the store already owns; the run reports what it recovered and what it left alone. A conversation whose metadata has since been rewritten without those fields cannot be recovered from anywhere, and the host application must re-send its grounding through the create/edit call.

## 22. Queued message unanswered

### Symptom

Someone sent a second message while the assistant was mid-answer. They saw a notice saying it was waiting - and then either nothing came back for it, or the answer arrived but their message is still rendered with the waiting styling and the notice still claims the assistant is busy.

### Cause

These are two different faults with one appearance, and the record tells them apart. A conversation answers one turn at a time (ADR-033): a message arriving behind a running turn is queued on a single DynamoDB row, read as a group, turned into tasks, and then cleared. Everything a person sees - the notice, the depth, the waiting styling - is derived from that row, so a queue that did not drain and a queue that drained without telling the client look identical in the transcript.

### Check the record

The record is the authority, so read it first:

```bash
# One row per (conversation, assistant). The pk is turn#<channelArn>#<responderId>.
aws dynamodb get-item \
  --table-name "$(aws dynamodb list-tables --query "TableNames[?contains(@,'TurnStateTable')]|[0]" --output text)" \
  --key "{\"pk\":{\"S\":\"turn#${CHANNEL_ARN}#${RESPONDER_ID}\"}}" \
  --consistent-read
```

| What the row shows | What it means |
|---|---|
| `queued` still holds message ids | The queue genuinely did not drain. The drain stopped somewhere - read `queueStatus` for where |
| No `queued`, but `noticeId` remains | The queue drained and the notice was never settled. The client subscribes to that message, so with nothing to react to the waiting styling never clears |
| No `queued`, no `noticeId` | The backend finished correctly. The fault is client-side |
| `holder` set with nothing running | A turn died holding the conversation. The next message takes the lock over once `holderAt` is older than `STALE_AFTER_MS` (`turn-lock.ts`), counted as `LockTakeover` (`StrandedLockAlarm`). The table has no TTL, and nothing needs deleting by hand |
| `drainTaskId` present | A drain is open. It is removed only when the queue empties, so a stale one means the drain never finished |

`queueStatus` is the instrument for the first case, and it names the last stage the drain reached: `reviewing` means the reading started, `clarifying` that it put something to somebody, `clearing` that it was emptying the queue. A stage that never advanced past `reviewing` is a reading that died; one sitting at `clearing` is a clear that failed its condition. Both are in the processor logs under `[AsyncProcessor][triage]`.

### Undelivered reading

A reading owns no placeholder. While a queue is being read there is one thing showing progress and it is the notice, so nothing else is opened, and the reading posts its own message when it has the proposal. The processor therefore skips the placeholder lookup, the scan and the no-placeholder path for a reading (`readingOwnsNoPlaceholder` in `assistant-async-processor.ts`), and a reading never appears in the no-placeholder lines:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AsyncProcessor)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"no placeholder"' \
  --query "events[].message" --output text
```

A correlation id of the form `arrival-<hash>-<n>` in those lines is a reading the check did not apply to, which is a defect in the check. Asserted by `backend/test/lib/a-reading-opens-no-placeholder-of-its-own.test.ts`.

The same lines with an ordinary hexadecimal correlation id are a different fault: see [§19](#19-placeholder-never-resolves).

### Captured work

A queue that drained should have left durable work behind. Every queued message becomes a task, and which KIND tells you how the reading went:

```bash
aws dynamodb scan \
  --table-name "$(aws dynamodb list-tables --query "TableNames[?contains(@,'AgentTasksTable')]|[0]" --output text)" \
  --filter-expression "channelArn = :c" \
  --expression-attribute-values "{\":c\":{\"S\":\"${CHANNEL_ARN}\"}}" \
  --projection-expression "taskId,taskType,taskState,assigneeType"
```

- `queued_request` in `proposed` - the reading understood it and proposed the work.
- `queued_clarification` in `asked` - it held the message and could not tell what it asked for. This is not a failure; it is the assistant saying so rather than guessing, and it waits on the sender.
- `work_still_wanted` in `asked` - it could not tell whether the work already running was still wanted, and asked.
- `queue_drain` - the reading itself. It is owned by the ASSISTANT and closes when the queue empties; one open long after the queue cleared is a drain that did not finish.

No rows at all, with an empty queue, is the bad case: the messages were cleared without becoming work. That is the one worth escalating, and the processor log line `tasksLost` names it directly.

### Stale waiting styling

The client reads the record, so a clean record with the styling still showing looks like a client fault. It is not: the client has no event telling it the queue changed, because the notice was never rewritten.

Check the notice itself before the client. If it still reads "Still working on your earlier message" after the drain, the settle was refused:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonAssistants-premium AsyncProcessor)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"could not settle the notice"' \
  --query "events[].message" --output text
```

`No operations allowed for messages in processing` is Amazon Chime SDK refusing an update while another update to the same message is still in the channel flow. The drain advances the notice to its `clearing` stage a few hundred milliseconds before settling it, so the two can collide. The settle retries that refusal specifically, trying up to three times on a widening wait (400 ms × attempt), and reports a stale notice only after the last one (`turn-queue-notice.ts`). Asserted by `backend/test/lib/one-notice-updated-not-many.test.ts`.

The retry is on the settle alone. Every other write to the notice is superseded by the next one, so losing one costs a moment of stale text; nothing follows the settle, so losing it is permanent and lands on the person's own message.

---

## 23. No credential configured

**Symptom** - A person authenticates, and then every call that needs a messaging credential fails with `403 {"error":"no credential is configured for this combination of groups"}`. The credential exchange returns 403 and the chat UI cannot open a messaging session. Nothing is wrong with the password, the pool or the token.

**Diagnosis** - Read the person's groups, then look for the security event.

```bash
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id <USER_POOL_ID> --username <EMAIL> \
  --query "Groups[].GroupName"

aws logs filter-log-events \
  --log-group-name "/aws/lambda/$(fn AgentEchelonIdentity CredentialExchangeFunction)" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '"[CredentialExchange][SecurityEvent]"' \
  --query "events[].message" --output text
```

**Root cause** - The person's Cognito groups name a combination the deployment has not declared, so no role key resolves and nothing is vended (`credential-exchange.ts`, `resolveRoleKey`). The log line is `groups name no declared classification combination; vending nothing`.

This is a **deployment config gap, not a user problem**, and the refusal is deliberate. There is no floor to fall back to: between peer classifications there is no least-privileged one to pick ([ADR-046](../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)).

**Two security events.** Reading the wrong one sends you after the wrong fault:

| Log line | What happened | Result for the person |
|---|---|---|
| `groups name no declared classification combination; vending nothing` | no role key resolved | **403, no session.** This section |
| `the vended token does not cover this caller's clearances` (`holderTokenCovers`) | **Unreachable by construction.** A resolved key is a declared classification whose grants are the union of what the caller holds, and every classification grants itself, so the shortfall cannot be expressed. The check is kept as the invariant in executable form | Nothing. If it ever logs, `resolveHolderToken` has changed and is under-vending: treat the log as the defect, not the person |

**Resolution** - Either declare a classification whose `grants` equal that combination (`backend/lib/config/profiles.ts`, and see [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) section 2.2), or remove one of the groups from the person so their remaining groups name a combination that exists. Changing the person's groups is the faster fix; declaring the classification is the right one when the combination is intended.

**Prevention** - Every group combination an administrator can grant needs a declared classification behind it. Adding a Cognito group without adding the classification that names it is what produces this, and `validateProfilesConfig` cannot catch it: it validates the classifications that exist, not the group combinations a directory might hand out.

## 24. Notification e2e fails

**Symptom** - The mention-email test in `tests/e2e/notification-bridge.spec.ts` skips with `no test inbox is configured` or `is not on the inbox domain` (under `npm run validate`, that stated skip fails the optional `notifications` phase), or it fails with `no email to <address> ... reached s3://<bucket>/<prefix>`.

**Diagnosis** - Read what the suite was given, then follow one test address through SES.

```bash
# What provisioning wrote: the inbox and the test users' addresses
aws secretsmanager get-secret-value --secret-id agent-interface/test-credentials   --query SecretString --output text | jq '{testInbox, premiumUser: .premiumUser.email, secondPremiumUser: .secondPremiumUser.email}'

# Which receipt rule set is active in the region, and which recipients its rules take
aws ses describe-active-receipt-rule-set --query "Rules[].{name:Name,recipients:Recipients,enabled:Enabled}"

# Where the domain's mail goes
nslookup -type=MX <inbox-domain>

# Whether the bridge sent at all
aws logs filter-log-events --log-group-name "/aws/lambda/$(fn AgentEchelonNotifications NotificationBridgeFunction)"   --start-time $(( ($(date +%s) - 1800) * 1000 )) --filter-pattern '"notify fan-out"' --query "events[].message" --output text
```

`npm run validate` also reports the inbox in its DATA READINESS block as `test inbox (testInbox in the test secret)`, and probes the inbox bucket.

**Root causes**

| What you see | Cause | Fix |
|---|---|---|
| No `testInbox` in the secret | No inbox was configured when provisioning ran | Name an existing inbox (`TEST_EMAIL_DOMAIN`, `TEST_INBOX_BUCKET`, `TEST_INBOX_PREFIX`), or deploy the opt-in `TestInbox` stack, which exists only when `testInboxDomain` is set (`-c testInboxDomain=<a domain used only for tests>`, or the key in `deploy.config.json`); then re-run `provision-test-users` |
| Test users are not on the inbox domain | Provisioning ran before the inbox existed | Re-run `provision-test-users`; it moves the existing users to the inbox domain in place |
| The rule set holding the test-inbox rule is not the active one | SES allows one active set per region, and the stack's own set is created inactive | Redeploy with `testInboxRuleSet` set to the active set, or activate the stack's set (its `ActivateRuleSet` output) if nothing else in the region receives mail |
| The active rule lists exact addresses that do not include the test users | Receipt rules match a domain or exact addresses, never a wildcard | Use a domain-wide rule on a domain used only for tests |
| MX record missing or pointing elsewhere | DNS for the inbox domain does not route to SES in this region | Add `MX 10 inbound-smtp.<region>.amazonaws.com`. The stack writes this record itself when `testInboxHostedZoneId` and `testInboxHostedZoneName` are set; without a hosted zone it emits the record as its `MxRecord` output for you to add |
| The fan-out log shows `emailed: []` | The bridge chose no recipient: the message had no mention, or the person named is not a member | See SPEC-NOTIFICATION-BRIDGE FR4 and FR5; this is the bridge, not the inbox |

**Prevention** - Configure the inbox before the first `provision-test-users` on a new deployment, and keep the inbox domain for tests only: every message to any address on it is stored.

---

## 25. Image request refused or not generated

**Symptom** - In a basic or standard conversation an image request is answered with a refusal (shipped copy: "I don't produce images in this conversation."), in a `/battle` as well as an ordinary turn. The refusal names no classification. Only a request addressed privately also gets an access line, to the person alone: the display names of the conversations their clearance reaches that produce images, or, when none does, a line to ask an administrator for access (`composeRefusal` in `backend/lambda/src/lib/capability-refusal.ts`). Or, in premium, an assistant answers an image request with an error naming no image model. Or an experiment with image models is refused at create with `VARIANT_IMAGE_MODEL_NOT_ALLOWED`.

**Diagnosis**
```bash
fnlog AgentEchelonAssistants-<classification> AsyncProcessor 15m   # 'image_generation turn cannot run'
fnlog AgentEchelonAssistants-<classification> AgentHandler 15m     # '[Router] refused'
```
Look also for `serving a version without the model selections its classification does not allow`, which names a stored selection the read ignored.

**Root Cause** - One rule decides every model ([MODEL_STRATEGY](../developer/MODEL_STRATEGY.md#one-rule-for-every-model)): a classification may use an image model only when it selects it (`models.selected` on its entry; premium only as shipped), and only an intent that needs an image is served by one. A classification that selects none has no image grant and no image guardrail, so the router refuses the request rather than dispatching a turn that cannot succeed. In a classification that selects image models, an assistant whose version routes no intent to an image model generates none: nothing is backfilled.

**Solution** - To generate images in another classification, add image models to its selection (`models.selected` on its entry) and deploy that classification's stack; the grant, the guardrail and `produces: image` follow. To give a premium assistant an image model, route `image_generation` (or another intent) to an image model in the per-intent models list of a new version in the Profiles tab, and activate it.

**Prevention** - `backend/test/image-gen-iam-parity.test.ts` holds each classification's image grant, guardrail and session-policy edges to the catalog, and the profile write path refuses an image model the classification is not allowed.

---

## 26. Battle side serves the wrong version

**Symptom** - In a `/battle`, the alt answers with no pinned version (the vend refuses it), a side answers every intent on one model rather than through its routes, or the alt's identity shows its provisioned name (`Alt-<classification>-<role>`) rather than the treatment's profile name.

**Diagnosis**
```bash
fnlog AgentEchelonAssistants-<classification> AgentHandler 15m   # 'battle side has no pinned version'
fnlog AgentEchelonAdminServices AssistantAdministrationRuntimeApplyAssistantNameFunction 15m   # '[apply-assistant-name]': the rename the applier made
fnlog AgentEchelonAdminServices AssistantAdministrationAdminExperimentsFunction 15m            # "the alt identity's battle name did not land"
```
Read the experiment row: `servesVersions` is `true`, `variants[0].controlPin` names the live assistant's active version, and `variants[1].altPin` names a version of `alt-{role}-{classification}`.

**Root Cause** - Every experiment, battle or not, pins two versions when it is armed ([DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](../../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) section 3.5): the control is the live assistant's active version, served from the live identity, and the treatment a candidate in the alt's history, served from the alt identity, each through its own per-intent routes. A battle armed before pins existed has no `controlPin`; one armed before experiments pinned two versions has a control derived under the live name and no `servesVersions`, and keeps reading it until it is re-armed. The treatment's profile name (`battleSideNames`) is applied to the alt's identity when the experiment takes the alt: the experiments function asks the profile writer, which invokes the admin backend's one name applier (`RuntimeApplyAssistantNameFunction` in the `AdminServices` stack), the same applier every assistant's rename goes through. The rename is best-effort, and a failure is logged by the experiments function rather than refusing the experiment.

**Solution** - Pause and resume the experiment: activation pins both versions again (reusing a candidate that still says the same thing), marks the row `servesVersions`, and puts the treatment's name on the alt. If the name still does not land, read the applier's log (above), and redeploy `AgentEchelonAdminServices` (`npm run deploy:stack -- AgentEchelonAdminServices`) if the applier function is missing.

**Prevention** - The arm path refuses an experiment without both pins (`armRefusal` in `admin-experiments.ts`; `backend/test/admin-experiments.test.ts`), and round 2 re-resolves each side's pinned version rather than trusting the dispatch (`backend/test/a-shared-service-only-speaks.test.ts`).

---

## 27. Arming is refused

**Symptom** - Create and Activate, Activate or Resume answers 409 or 400 with `CONTROL_DIFFERS_FROM_LIVE`, `CONTROL_HAS_NO_ACTIVE_VERSION`, `EXPERIMENT_ONE_CLASSIFICATION` or `EXPERIMENT_TWO_VERSIONS`, and nothing is stored.

**Diagnosis**
```bash
fnlog AgentEchelonAdminServices AssistantAdministrationManageProfilesFunction 15m   # the derivation's refusal and reason
```
List the live assistant's versions in the Profiles tab and read which is active.

**Root Cause** - Arming pins the live assistant's active version as the control (`deriveExperimentVersions` in `manage-profiles.ts`). A control variant that names a model, addendum or image model the live version does not serve describes a comparison that would not run (`CONTROL_DIFFERS_FROM_LIVE`); an assistant serving its compiled seed has no version to pin (`CONTROL_HAS_NO_ACTIVE_VERSION`); and an experiment compares two versions of one assistant, which acts in one classification (`EXPERIMENT_ONE_CLASSIFICATION`, `EXPERIMENT_TWO_VERSIONS`).

**Solution** - Leave the control's model unset for an Intent or Base Model experiment, or name what the live version uses; activate a version in the Profiles tab; pick exactly one tier and two variants. To compare two configurations neither of which is live, use a Profile vs Profile experiment.

**Prevention** - `backend/test/manage-profiles.test.ts` ("arming pins two versions") holds each refusal.

---

## 28. Promote refused: live version moved

**Symptom** - Promote answers 409 `LIVE_VERSION_MOVED`, naming the version the live assistant now serves and the control version the experiment measured against.

**Diagnosis**
```bash
fnlog AgentEchelonAdminServices AssistantAdministrationManageProfilesFunction 15m   # '[ProfileLifecycle][audit]' activate or rollback since the experiment was armed
```

**Root Cause** - The candidate is the control plus the experiment's change. Once another version of the live assistant is activated, the candidate is a variation of a version that no longer serves, and promoting it would also undo whatever that activation changed. `promoteCandidate` (`profile-lifecycle.ts`) checks the active version before it reads and again before it writes, so a refusal writes nothing.

**Solution** - Run a new experiment against the current version; pausing and resuming this one re-arms it against the current version as a new, untested candidate.

**Prevention** - Do not activate versions of an assistant while an experiment on it is running. `backend/test/manage-profiles.test.ts` ("promotion copies the measured candidate") holds the refusal.

---

## 29. Promote refused: copy mismatch

**Symptom** - Promote answers 409 `PROMOTION_HASH_MISMATCH`, naming the copy's `configId` and the measured one.

**Diagnosis**
```bash
aws ssm get-parameter --name "<SSM_ROOT>/assistant/alt-<role>-<classification>/definition:<version>" \
  --query Parameter.Value --output text   # compare its configId with the experiment row's altPin.configId
```

**Root Cause** - Promotion activates only a byte-identical copy of what was measured: the copy is rebuilt from the candidate's stored body and must hash to the candidate's `configId`. A mismatch means the stored candidate is not what the experiment measured (an edited or corrupted record, or a body whose offloaded persona cannot be read the same way). Nothing was written or activated.

**Solution** - Treat the candidate as untrusted. Run a new experiment so a new candidate is derived and measured.

**Prevention** - Candidates are written only by the experiment's derivation, and the ordinary edit routes refuse an alt's profile (`ALT_PROFILE_IS_EDITED_THROUGH_ITS_EXPERIMENT`).

---

## 30. Promote not offered or refused

**Symptom** - The Experiments list shows no Promote button, Promote answers 403 (`PROMOTION_NEEDS_ACTIVATE_PROFILES`, or a gateway 403 with no code), or 409 `PROMOTION_NEEDS_TWO_VERSIONS`, `PROMOTION_CONTROL_NOT_LIVE` or `EXPERIMENT_NOT_RUNNING`.

**Diagnosis** - Read the experiment row (`status`, `servesVersions`, `experimentType`, `variants[0].controlPin`) and the caller's capabilities (the console's access view).

**Root Cause** - Promotion activates a version of the live assistant, so its route (`POST /admin/experiments/{id}/promote`) is in the `activate-profiles` capability and the handler re-checks the profile capability beside the experiment-admin check: a role that only manages experiments is refused. It applies only to a running or paused experiment that pinned two versions, whose control is the live assistant. An experiment armed before experiments pinned two versions has no measured candidate, and a Profile vs Profile experiment whose control is not the live assistant compared two non-live configurations.

**Solution** - Promote with a role holding `activate-profiles`. Pause and resume an experiment armed before pins to arm it with two versions. For a Profile vs Profile comparison of two non-live versions, record the decision by ending it and promote by hand (create and activate a version, or export and import the winner).

**Prevention** - `backend/test/admin-experiments.test.ts` ("promoting an experiment's treatment") and `frontend/packages/admin/src/components/admin/PromoteExperiment.test.tsx` hold the capability check and the offer.

---

## 31. Promoted but not completed

**Symptom** - Promote answers 409 `PROMOTED_BUT_NOT_COMPLETED`, naming the version that is now active.

**Root Cause** - The promoted version was written and activated, and the experiment row changed (another admin paused, ended or edited it) before the promotion could complete it. The row's write is conditioned on the row it was decided from, so the concurrent change is kept rather than overwritten.

**Solution** - Reload the experiment and end it, recording **promoted treatment**. Do not promote it again: the live assistant already serves the promoted version.

**Prevention** - One operator acts on an experiment at a time.

---

## 32. Rollback to a derived version refused

**Symptom** - Rolling back to a version answers 422 with "was derived by experiment ... and has never served a conversation, so it cannot be activated by rollback".

**Root Cause** - The version is an experiment's candidate (it carries `derivedFrom`). A candidate never served a conversation, and a label move would serve a room a version nobody approved (`activateExistingVersion` in `profile-lifecycle.ts`). Candidates live in the alt's history, not the live assistant's.

**Solution** - Promote it with its experiment's Promote action, which copies the measured candidate into the live assistant as a new version (entries 28 to 31 cover its refusals). Between instances, export it and import it as a draft.

**Prevention** - `backend/test/lib/profile-lifecycle.test.ts` holds the refusal and its copy.

---

## 33. Thin verdict on heavy traffic

**Symptom** - An experiment with hundreds of exchanges per variant reads *inconclusive* ("below the 5-conversation floor"), *underpowered: need about N more conversations per variant*, or not significant with a wide interval, while a per-exchange calculation on the same numbers would call it.

**Diagnosis** - Read the variant's **Sample (conversations)** row beside **Sample (exchanges)** in Experiment Results, or `conversation_count` beside `exchange_count` in the `experiment_recommendation` response. Many exchanges from few conversations is the cause.

**Root Cause** - An experiment holds an enrolled conversation to one arm while it is active, so its counted turns are one person on one topic and are not independent. Every test, guardrail, power figure and the sample floor count conversations ([DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](../../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) section 4.2, "The unit of analysis"); the interval widens by the clustering (`clusterDesignEffect` in `experiment-stats.ts`) while the averages stay per exchange.

**Solution** - Collect more conversations, not more turns in the same ones. The verdict is computed correctly; it reflects how many people the evidence came from.

**Prevention** - `backend/test/lib/experiment-stats-per-conversation.test.ts` holds the correlated case (per exchange significant, per conversation not).

---

## 34. Assistant changed mid-conversation

**Symptom** - A person's conversation answered in one style or model and, from one turn on, answers like the live assistant; or a battle stops mid-way with no rebuttal; or an experiment's results stop growing for conversations that were already running.

**Diagnosis**
```bash
fnlog AgentEchelonAssistants-<classification> AgentHandler 15m   # 'enrollment released' or abandoned:experiment-ended
```
Read the experiment row's `status`, `endDate` and `transitions`.

**Root Cause** - The experiment the conversation was enrolled in was paused, completed (Promote included), deleted, or passed its end date. Only an active experiment holds a conversation to its arm (ADR-050 as amended 2026-10-15; `enrollmentHolds` in `experiment-manager.ts`), so from its next turn the conversation is served the live assistant's active version, with no experiment attribution, and a battle on that experiment ends (`abandoned:experiment-ended`). A pause releases for good: resuming enrolls only conversations created after the resume.

**Solution** - Expected behavior. To keep collecting evidence, resume the experiment and let new conversations accrue; to see the treatment again, start a new experiment.

**Prevention** - `backend/test/lib/an-ended-experiment-releases-its-conversations.test.ts` holds every release case and the battle stop.

---

## 35. Clone fails on Windows with "Filename too long"

**Symptom** - `git clone` on Windows stops with `error: unable to create file ...: Filename too long` and leaves a partial checkout.

**Root Cause** - Some paths in the repository (deeply nested tests and docs) pass the 260-character limit that Git for Windows applies unless long paths are enabled.

**Solution** - Clone with long paths enabled for that one command:
```bash
git -c core.longpaths=true clone <repository-url>
```
or enable them once for every repository on the machine, then clone again:
```bash
git config --global core.longpaths true
```

**Prevention** - Keep `core.longpaths` set on every Windows machine that clones the repository, and clone into a short parent directory.
