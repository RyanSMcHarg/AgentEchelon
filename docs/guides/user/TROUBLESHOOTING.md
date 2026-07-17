# AgentEchelon Troubleshooting Guide

> **Audience.** Anyone running AgentEchelon **in their own AWS account** - not
> just the reference deployment. Every command uses placeholders and a
> discovery recipe instead of hardcoded account IDs, resource names, or
> profiles. Substitute your own values from the "Conventions" section below.
>
> **Structure.** Each entry follows `Symptom → Diagnosis CLI → Root Cause →
> Solution → Prevention`. The root causes and fixes here are properties of
> the AgentEchelon codebase, so they apply to *any* deployment; only the
> resource names differ, and the recipes below resolve those for your
> account.

> **Verification discipline (read first).** A passing E2E/demo run does **not**
> mean a feature works. The `/battle` demo driver only asserts
> `.message.battle-message` *bubble count ≥ 2* - a placeholder bubble + an
> error bubble satisfy it. **Open the captured frames**
> (`tests/demo-output/post2/*.png`) and read the message content + scorecard
> before declaring success. Bubble count lies.

---

## Conventions - make these commands work in your account

All `aws` examples assume credentials for **your target account** are already
configured (via `AWS_PROFILE`, environment variables, SSO, or an instance
role). Examples omit `--profile`; export `AWS_PROFILE=<your-profile>` (or set
creds) for the shell first. Confirm with:

```bash
aws sts get-caller-identity          # whoami / which account
aws configure list-profiles          # available profiles, if you use them
```

Placeholders used below - resolve each **once** and reuse:

| Placeholder | What it is | How to get it |
|---|---|---|
| `<REGION>` | Deploy region | `frontend/.env` → `VITE_AWS_REGION` (default `us-east-1`) |
| `<USER_POOL_ID>` | Cognito user pool | CDK output `AgentEchelonCognitoAuth.UserPoolId` / `.env` `VITE_USER_POOL_ID` |
| `<APP_INSTANCE_ARN>` | Amazon Chime SDK app instance | CDK output `AgentEchelonChimeMessaging.AppInstanceArn` / `.env` `VITE_APP_INSTANCE_ARN` |
| `<DEMO_EMAIL>` | A seeded test identity | Whatever `backend/scripts/seed-demo.ts` created in *your* pool (reference seed uses `*@stratum.example.com`) |
| `<STACK>` | A CDK stack | `AgentEchelonTier-Premium`, `AgentEchelonChannelFlow`, `AgentEchelonCognitoAuth`, … |
| `<LOGICAL_ID>` | A construct's CFN logical id | Stable across accounts for the same CDK code (e.g. `AsyncProcessor`, `ChannelFlowProcessor`, `ExperimentsTable`, `ChannelBattleConfigTable`) |

### Resolve a physical resource name from its logical id

CDK gives resources a stable logical id but a per-deploy physical name. Two
reusable shell helpers - paste once per session:

```bash
# Physical resource name for a (stack, logical-id-prefix)
res() { aws cloudformation list-stack-resources --stack-name "$1" \
  --query "StackResourceSummaries[?starts_with(LogicalResourceId,'$2')].PhysicalResourceId" \
  --output text ; }

# Tail a Lambda's logs by (stack, logical-id-prefix), last N minutes.
# (Windows/Git-Bash: prefix the line with MSYS_NO_PATHCONV=1 so the
#  /aws/lambda/... path isn't mangled into a Windows path.)
fnlog() { aws logs tail "/aws/lambda/$(res "$1" "$2")" --since "${3:-20m}" --format short ; }
```

Examples (used throughout this guide):

```bash
res AgentEchelonExperiments ExperimentsTable          # → the experiments table name
fnlog AgentEchelonTier-Premium AsyncProcessor 25m
fnlog AgentEchelonChannelFlow ChannelFlowProcessor 20m
```

If a logical-id prefix is ambiguous, list them:
`aws cloudformation list-stack-resources --stack-name <STACK> --query "StackResourceSummaries[].LogicalResourceId"`.

---

## 1. `/battle` shows a placeholder + an error instead of two real answers

### Symptom

In a battle-enabled premium channel, `/battle <prompt>` produces two bubbles:
one alt-slot bot says *"Sorry, I encountered an issue processing your
request."* and the default bot stays on *"… waiting for your response."*;
scorecard RESPONSE TIME / EST. COST are ` - `; sender names are generic
(`Assistant` / `AltSlot0`) rather than the experiment's variant display names,
with a model badge that isn't the configured variant model.

This is a **layered failure** - several independent defects on the same path.
Work them in order.

### Diagnosis Steps

1. **Confirm Battle Mode actually armed** (rules out arming layers)
   ```bash
   aws dynamodb scan --table-name "$(res AgentEchelonExperiments ExperimentsTable)" \
     --query "Items[].{id:experimentId.S,battle:battleEnabled.BOOL,slot:altBotSlotId.S,slotArn:altBotSlotArn.S,status:status.S}"
   aws dynamodb scan --table-name "$(res AgentEchelonBattle ChannelBattleConfigTable)" \
     --query "Items[].{ch:channelArn.S,enabled:enabled.BOOL,exp:experimentId.S,slotArn:altBotSlotArn.S}"
   ```
   Expect the experiment row `battle:true status:active` with a resolved
   `slotArn`, and the channel row `enabled:true` with a matching `slotArn`.
   Both present ⇒ arming is fine; the break is downstream.

2. **Was the ChannelFlowProcessor invoked, and did it fan out?**
   ```bash
   fnlog AgentEchelonChannelFlow ChannelFlowProcessor 20m > /tmp/cfp.log
   grep -nE '\[ChannelFlow\] routing|\[ChannelFlow\]\[battle\] (Detected|Fanning out)|premium-only|DescribeChannel' /tmp/cfp.log
   ```
   - No `[ChannelFlow] routing` line, or `invokesBattle:false` → **§5**.
   - `DescribeChannel … AccessDenied` then a *"battles are only available on
     premium-tier channels"* reply → **§6**.
   - `[ChannelFlow][battle] Fanning out { botCount:2 … }` → fan-out happened;
     go to step 3.

3. **Read the premium async processor (generates each bot's reply)**
   ```bash
   fnlog AgentEchelonTier-Premium AsyncProcessor 25m > /tmp/pap.log
   grep -niE 'ValidationException|ResourceNotFound|AccessDenied|substring|BedrockResilience|Round-1 clarification|Model resolution' /tmp/pap.log
   ```
   | Log signature | Section |
   |---|---|
   | `ValidationException: …on-demand throughput isn't supported…inference profile` | **§7** |
   | `ResourceNotFoundException: This model version has reached the end of its life` | **§8** |
   | `TypeError: Cannot read properties of undefined (reading 'substring')` | **§9** |
   | `Round-1 clarification → WAITING_FOR_USER` | not a bug (see note) |
   | `AccessDenied … bedrock:InvokeModel on resource: arn:aws:bedrock:`**`us-east-2`**`…` (region ≠ deploy region) | **§11** (cross-region inference profile) |
   | `AccessDenied … bedrock:InvokeModel` (deploy region) | the handler's IAM role lacks the model's Bedrock grant for that tier |
   | `AccessDenied … aws-marketplace:Subscribe … subscription cannot be completed` | **§12** (model agreement not accepted; works in Playground but not Lambda) |
   | `BadRequestException: Channel Messages size limit exceeded` (after a long answer) | **§13** (encoded Content/Metadata cap) |

**Note (not a bug):** the control bot may legitimately enter
`WAITING_FOR_USER` - it asked a clarifying question (the measured
clarification dimension; see `docs/specs/experiments-battle/SPEC-BATTLE.md`). The demo never answers
it, so single-turn shows no final answer on that side. By design.

### Root causes on this path

| Defect | Where |
|---|---|
| admin-experiments PutCommand 500 (undefined marshalling) | §2 |
| Battle panel never rendered (frontend `userArn` + create `createdByArn`) | §c below |
| `/battle` detection brittle (`safeDecodeURIComponent`) | §5 |
| ChannelFlowProcessor role missing `chime:DescribeChannel` (tier gate) | §6 |
| Bedrock invoke used bare model id for inference-profile-only models | §7 |
| `buildTaskContextForPrompt` TypeError | §9 |
| EOL fallback model | §8 |
| Cross-region inference profile: IAM only granted the deploy-region foundation-model ARN (alt-slot `AccessDenied` on `us-east-2`) | §11 |
| Default bot ran the intent-default model, not the experiment's configured **control** variant (battle wasn't the configured A/B) | §1 resolution below |
| Variant `displayName` resolved server-side but never surfaced to the frontend (scorecard/chip showed the bot's Amazon Chime SDK name) | §1 resolution below |

§c - *Battle Mode panel never renders*: `ChannelMembersPanel` must read the
caller ARN from `useAwsClient().userArn` (the canonical chimeService ARN), and
the create-conversation API response must include `createdByArn`; otherwise
`isCurrentUserModerator` is permanently false and the panel never shows. Files:
`frontend/src/components/ChannelMembersPanel.tsx`,
`backend/lambda/create-conversation/index.js` (response body).

### Resolution - three independent defects, not a threading bug

This is not a variant-threading bug: `prepareBattleInvocation` threads the
variant correctly (the alt-slot resolves `self: 'Echo', variantModelKey:
'opus'` as intended). The visible breakage is three separate root causes on
the same frame:

1. **Alt-slot `AccessDeniedException` (the "Sorry, I encountered an issue"
   bubble).** The treatment model (Opus 4.6) is invoked through the `us.`
   cross-region inference profile, which Bedrock fans out to
   **us-east-1 / us-east-2 / us-west-2**. The IAM grant (built from the
   catalog's `foundationModelArns` via `collectArnsForTier`) only listed
   the **deploy-region** foundation-model ARN, so Bedrock denied the
   invoke on `arn:aws:bedrock:us-east-2::foundation-model/…opus`. On
   `access_denied` `bedrock-resilience` fails hard by design (no model
   fallback) → the error bubble. **Full detail + fix: §11.**

2. **Default bot ignored the configured control variant.**
   `prepareBattleInvocation` resolved a variant only for the alt-slot;
   the default bot fell through to normal tier+intent resolution (Haiku
   for premium+general) instead of the experiment's configured
   **control** variant (e.g. Atlas / Sonnet). The battle therefore wasn't
   the configured A/B. Fix: the default-bot side now resolves
   `variants[0]` via `resolveBattleControlVariantByAltSlotArn`
   (`backend/lambda/src/lib/experiment-manager.ts`,
   `async-processor-core.ts` `prepareBattleInvocation`), degrading to the
   tier+intent path only when no battle/control variant is bound.
   See `docs/specs/experiments-battle/SPEC-BATTLE.md` §413.

3. **Variant `displayName` never reached the frontend.**
   `prepareBattleInvocation` resolves `selfDisplayName` ("Atlas"/"Echo")
   but it was only logged. No marker field carried it, so the scorecard
   header + variant chip fell back to the bot's generic Amazon Chime SDK
   AppInstanceUser name ("Assistant"/"AltSlot0"). Fix: the
   `<!--battlestats:-->` marker now carries `name=<uri-encoded
   displayName>`; `messageParser.ts` parses it into `battle.label`;
   `ConversationInterface.tsx` (`toScorecardVariant`, `battleVariantLabel`)
   prefers it over `sender.name`.

Once Opus actually runs (1), the model badge becomes `OPUS`/`SONNET`
automatically (it's `message.modelId` from analytics metadata) - no
separate badge fix is needed. Re-verify by opening
`tests/demo-output/post2/P2-B1.png` per the verification-discipline note,
not by the green run.

---

## 2. Experiment create returns `500 {"error":"Internal error"}`

**Symptom** - Admin → Experiments → "Create & Activate" → *"Internal error"*;
nothing persisted.

**Diagnosis**
```bash
fnlog AgentEchelonExperiments AdminExperimentsFunction 15m
```
Look for a DynamoDB marshalling throw from `PutCommand`.

**Root Cause** - `DynamoDBDocumentClient.from(new DynamoDBClient({}))` created
without `marshallOptions: { removeUndefinedValues: true }`.
`validateAndSanitizeExperiment` legitimately leaves optional fields
`undefined` (blank `systemPromptAddendum`, text-only `imageGenModelKey`) → the
marshaller throws → bare 500. Mocked unit tests didn't catch it.

**Solution** - add `marshallOptions: { removeUndefinedValues: true }` to the
doc client. This class of bug was audited across **all** doc clients;
`admin-experiments`, `experiment-manager`, `battle-state`, `task-tracking`
carried it. **If you add a new `DynamoDBDocumentClient.from(...)`, include the
marshall option by default.**

---

## 3. Conversation create → `403 TIER_FORBIDDEN` ("Your tier (none)…")

**Symptom** - Creating a Premium conversation returns
`403 {"code":"TIER_FORBIDDEN","userTier":null}` though `custom:tier=premium`.

**Diagnosis**
```bash
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id <USER_POOL_ID> --username <DEMO_EMAIL> \
  --query "Groups[].GroupName"
```
Empty ⇒ the user is in **no Cognito tier group**.

**Root Cause** - Cognito **group** membership is the authoritative tier signal
(see `CLAUDE.md` → Tier authorization). Seeded / admin-created users skip the
post-confirmation trigger that mirrors `custom:tier` → group.

**Solution**
```bash
USER_POOL_ID=<USER_POOL_ID> node backend/scripts/backfill-tier-groups.mjs
```
Idempotent, pool-wide, self-correcting; does not touch the `admins` group.

**Prevention** - after any deploy that re-seeds demo users, always run
`backfill-tier-groups.mjs` **and** `backfill-channel-flow.mjs`. `seed-demo.ts`
does not register groups. This is a documented post-deploy step in `CLAUDE.md`.

---

## 4. Conversation create → `500 … "An invalid app instance user ARN was supplied"`

**Symptom** - tier check passes, then 500
`"User could not be added to conversation: An invalid app instance user ARN…"`.

**Diagnosis**
```bash
USERNAME=$(aws cognito-idp admin-get-user --user-pool-id <USER_POOL_ID> \
  --username <DEMO_EMAIL> --query Username --output text)
aws chime-sdk-identity describe-app-instance-user \
  --app-instance-user-arn "<APP_INSTANCE_ARN>/user/$USERNAME"
```
`NotFoundException` ⇒ the user was never registered as an Amazon Chime SDK
AppInstanceUser. (Note: an email-alias pool's canonical `Username` is a UUID,
not the email - always resolve it as above.)

**Root Cause** - same family as §3: seeded users skip the post-confirmation
trigger that calls `CreateAppInstanceUser`. The frontend builds
`userArn = <APP_INSTANCE_ARN>/user/<cognitoUsername>`; with no AppInstanceUser
the membership call rejects the ARN.

**Solution** - mirror `backend/lambda/cognito-triggers/post-confirmation.js`:
```bash
aws chime-sdk-identity create-app-instance-user \
  --app-instance-arn "<APP_INSTANCE_ARN>" \
  --app-instance-user-id "$USERNAME" --name "<DEMO_EMAIL>"
```
Repeat for every seeded identity a flow exercises.

**Prevention** - `seed-demo.ts` should register AppInstanceUsers (it currently
does not). Until then, treat this as a mandatory post-seed step alongside the
tier-group backfill.

---

## 5. `/battle` is silently ignored (no fan-out, fast processor return)

**Symptom** - ChannelFlowProcessor invoked for the `/battle` message but
returns quickly with only the entry log; no `[ChannelFlow][battle] Detected`.

**Diagnosis** - `grep -n '\[ChannelFlow\] routing' /tmp/cfp.log` (from §1
step 2). `invokesBattle:false` for a `/battle` prompt ⇒ detection missed.

**Root Cause** - `safeDecodeURIComponent(Content)` returns the **raw,
still-encoded** string when `decodeURIComponent` throws on any malformed
`%`-sequence, leaving a percent-encoded leading token that defeats
`/^\s*\/battle\b/i`.

**Solution** - detect `/battle` / `@all` against **both** decoded and raw
`Content`; strip the prefix from whichever carried it. Routing/dispatch
instrumentation (`[ChannelFlow] routing {…}`) makes this one log line to
confirm. File: `backend/lambda/src/channel-flow-processor.ts`.

---

## 6. `/battle` answered "battles are only available on premium-tier channels" (on a premium channel)

**Symptom** - on a real premium channel, `/battle` wrongly replies
premium-only and returns before fan-out.

**Diagnosis** - `grep -n 'DescribeChannel failed, defaulting to basic'
/tmp/cfp.log`. An `AccessDeniedException` on `chime:DescribeChannel` for the
ChannelFlowProcessor role ⇒ this bug.

**Root Cause** - `handleBattleMessage`'s tier gate calls `DescribeChannel` to
read the channel `modelTier`. The role granted
`ChannelFlowCallback`/`SendChannelMessage`/`ListChannelMemberships` but **not
`chime:DescribeChannel`**; the `catch` defaulted `channelTier='basic'` →
rejected every battle.

**Solution** - add `chime:DescribeChannel` to that role statement (same
`<APP_INSTANCE_ARN>/*` scope as the other Amazon Chime SDK actions). File:
`backend/lib/stacks/channel-flow-stack.ts`; redeploy `AgentEchelonChannelFlow`.

**Prevention** - when a Lambda's code adds a new AWS call, audit its CDK role
in the same change. A fail-open-to-wrong-default `catch` masks an IAM gap as a
"feature off" message - always log the underlying error so it's visible.

---

## 7. Bedrock `ValidationException: …on-demand throughput isn't supported`

**Symptom** - `ValidationException: Invocation of model ID <model> with
on-demand throughput isn't supported. Retry … with … an inference profile…`.

**Root Cause** - some models (e.g. newer Anthropic Sonnet/Opus) **cannot** be
invoked on-demand by bare model id; Bedrock requires an inference-profile
id/ARN. The catalog carried `inferenceProfileArns`, but the invoke path passed
`bedrockModelId`.

**Solution** - `bedrockInvokeId(def)` in
`backend/lib/config/model-strategy.ts` returns
`inferenceProfileArns?.[0] ?? bedrockModelId`; used by `model-resolver.ts`,
`assistant-async-processor.ts` (battle path), `experiment-manager.ts` (A/B).

**Check any model's requirements (your account/region):**
```bash
aws bedrock list-foundation-models \
  --query "modelSummaries[?modelId=='<MODEL_ID>'].{id:modelId,inf:inferenceTypesSupported,status:modelLifecycle.status}"
```
No `ON_DEMAND` in `inferenceTypesSupported` ⇒ that model **must** have an
`inferenceProfileArns` entry in the catalog. Inference-profile availability
varies by account/region - verify in *yours*.

---

## 8. Bedrock `ResourceNotFoundException: This model version has reached the end of its life`

**Symptom** - `ResourceNotFoundException` with the EOL message for a model id.

**Diagnosis**
```bash
fnlog AgentEchelonTier-Premium AsyncProcessor 30m | grep -i "end of its life"
# List live successors from the same provider:
aws bedrock list-foundation-models --by-provider <provider> \
  --query "modelSummaries[?modelLifecycle.status=='ACTIVE' && contains(outputModalities,'TEXT')].modelId"
```

**Root Cause** - a `bedrockModelId` in `model-strategy.ts` points at a model
version AWS has retired. Bedrock model availability and lifecycle differ per
account/region, so this can surface in your account even if it works in
another.

**Solution** - re-point the catalog entry to a live model id (keep the
catalog **key** stable so `BackendModelKey`/strategy/admin wiring is
unaffected). Prefer an Anthropic→Anthropic fallback for provider consistency
where a route's primary is Anthropic.

**Prevention** - periodically audit every `bedrockModelId` in
`model-strategy.ts` against
`aws bedrock list-foundation-models … modelLifecycle.status` for your target
account/region. The catalog is the single source of truth - never hardcode
model ids in Lambdas.

---

## 9. `TypeError: Cannot read properties of undefined (reading 'substring')`

**Symptom** - premium async processor crashes on TASK_* (report/document)
battles right after `Context not found at premium/context.json`; task →
`failed`.

**Root Cause** - `buildTaskContextForPrompt` guarded `!task` but then called
`task.userMessage.substring(0,200)` unconditionally; a task row without
`userMessage` throws.

**Solution** - `task.userMessage?.substring(0,200) ?? '(not recorded)'`.
File: `backend/lambda/src/lib/task-tracking.ts`.

---

## 10. Demo driver honest-degrades at P2-S4 though battle is armed

**Symptom** - `post2-abtest-battle.demo.spec.ts` captions *"Battle infra
absent - not faked"* and exits green, yet the experiment/slot are armed.

**Root Cause** - `ChannelMembersPanel` renders the empty-state on its
pre-fetch initial paint; the driver's instant visibility check saw it before
`listExperiments()` resolved.

**Solution** - wait for `#battle-experiment-select` to appear, only
honest-degrade if it never does. File:
`tests/e2e/demo/post2-abtest-battle.demo.spec.ts`.

---

## 11. Bedrock `AccessDeniedException` on a region that isn't your deploy region (cross-region inference profile)

### Symptom

A handler resolves a model to an **inference-profile** id/ARN
correctly (logs show e.g.
`resolvedModel: arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-opus-4-6-v1`),
then the invoke fails:

```
AccessDeniedException: User: …<role>… is not authorized to perform:
bedrock:InvokeModel on resource:
arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-opus-4-6-v1
because no identity-based policy allows the bedrock:InvokeModel action
```

The denied resource region (**`us-east-2`** above) is **not** your
deploy region (`us-east-1`). On `access_denied`, `bedrock-resilience`
fails hard by design (no model fallback) so the bot posts the generic
error bubble.

### Diagnosis

```bash
fnlog AgentEchelonTier-Premium AsyncProcessor 25m | grep -A2 -i AccessDenied
# Which regions does the profile fan out to?
aws bedrock get-inference-profile \
  --inference-profile-identifier us.anthropic.claude-opus-4-6-v1 \
  --region <REGION> --output json
```

The profile's `description` / `models[].modelArn` list every member
region (for the `us.` Anthropic profiles: **us-east-1, us-east-2,
us-west-2**).

### Root Cause

A `us.` (or `eu.`/`apac.`) **SYSTEM_DEFINED cross-region inference
profile** routes each request to *one of several* member regions for
capacity. Bedrock evaluates `bedrock:InvokeModel` authorization against
the **destination foundation-model ARN in whichever member region it
picked** - not the caller's region and not the inference-profile ARN
alone. The catalog's `foundationModelArns` for the profile-backed models
(`sonnet`, `opus`) listed only the **deploy region**, so
`collectArnsForTier` granted only `arn:aws:bedrock:<deploy>::foundation-model/…`.
Any request the profile routed to another member region was denied.

This is **distinct from §7** (that one is "model can't be invoked
on-demand by bare id - use a profile"; this one is "profile resolved
fine but IAM doesn't cover every region the profile can route to").

### Solution

In `backend/lib/config/model-strategy.ts`, the profile-backed catalog
entries build `foundationModelArns` across **every member region** of
the `us.` profile (deploy region unioned in defensively), via
`crossRegionFoundationModelArns()` / `US_CROSS_REGION_PROFILE_REGIONS`.
`collectArnsForTier` reads `foundationModelArns`, so the IAM grant
auto-covers all member regions on the next deploy. A catalog change touches
IAM + the lambda bundle in **each per-tier stack**, so redeploy the affected
`AgentEchelonTier-*` stack(s).

```bash
cd backend && npx cdk deploy AgentEchelonTier-Basic AgentEchelonTier-Standard AgentEchelonTier-Premium --require-approval never
```

### Prevention

When you add a model that uses a cross-region (`us.`/`eu.`/`apac.`)
inference profile, its `foundationModelArns` MUST enumerate every member
region the profile routes to - confirm the set with
`aws bedrock get-inference-profile … --output json` for your account
(member sets can change; foundation-model ARNs carry an empty account
field so the set is account-independent). Re-verify periodically
alongside the §8 EOL audit.

---

## 12. Bedrock AccessDenied: aws-marketplace:Subscribe (model agreement not accepted)

### Symptom

A model resolves correctly (the right inference-profile ARN in the
logs), the model is ACTIVE in list-foundation-models, and it even works
in the Bedrock console Playground, yet the Lambda invoke fails:

    AccessDeniedException: Model access is denied due to IAM user or
    service role is not authorized to perform the required AWS
    Marketplace actions (aws-marketplace:ViewSubscriptions,
    aws-marketplace:Subscribe) to enable access to this model ... Your
    AWS Marketplace subscription for this model cannot be completed at
    this time. If you recently fixed this issue, try again after 2 min.

This is distinct from section 11 (that one is the Lambda role's
bedrock:InvokeModel policy missing a cross-region member region). Here
the policy is fine; the account-level model AGREEMENT is not accepted.
The Playground works because the console user's credentials carry
aws-marketplace permissions and auto-complete the subscription; a Lambda
role does not, and should not.

### Diagnosis

    aws bedrock get-foundation-model-availability --model-id <id> \
      --query "{agreement:agreementAvailability.status,auth:authorizationStatus}"

agreementAvailability AVAILABLE = good (e.g. Opus 4.6 in the reference
account). NOT_AVAILABLE = the blocker. (PENDING = accepted, provisioning;
becomes AVAILABLE in about 1-2 minutes.)

### Solution

The modern Bedrock console hides the old per-model "Model access"
toggle. Accept the agreement programmatically (one-time, per
account+region, reversible):

    aws bedrock list-foundation-model-agreement-offers --model-id <id> > offers.json
    # offers.json is large; grep the token rather than printing it:
    #   grep -oE '"offerToken": "[^"]+"' offers.json | head -1
    aws bedrock create-foundation-model-agreement --model-id <id> \
      --offer-token "<offerToken>"
    aws bedrock get-foundation-model-availability --model-id <id> \
      --query "agreementAvailability.status"     # NOT_AVAILABLE -> PENDING -> AVAILABLE

Reverse with `aws bedrock delete-foundation-model-agreement --model-id <id>`.

### Prevention

Adding a model to `model-strategy.ts` is not enough on its own: also
confirm `get-foundation-model-availability` shows agreement AVAILABLE in
the target account+region, and (for cross-region `us.` profile models)
that section 11's all-member-region IAM holds. Both gates plus the
Bedrock-console model-access check in "CDK / deploy notes" must pass.

---

## 13. Amazon Chime SDK BadRequestException: Channel Messages size limit exceeded (long answers)

### Symptom

A bot generates a real, long answer (logs show a large `responseLength`
and `Long response split into N chunks`), the continuation messages send,
then the placeholder UPDATE throws
`BadRequestException: Channel Messages size limit exceeded` and the user
sees the generic "Sorry, I encountered an issue" instead of the answer.
Most visible on `/battle` (Opus/Sonnet answers are long).

### Root Cause

Amazon Chime SDK Messaging caps the REQUEST PARAMETER length: Content max 4096,
Metadata max 1024 - measured on the URL-encoded string actually sent
(`encodeURIComponent(...)`), not the raw character count. Markdown/prose
roughly doubles (worst case triples) when encoded. The long-response
splitter chunked by RAW length, and chunk[0] additionally gets the
battlestats/ACTIVE_TASK marker appended before the encoded UPDATE, so a
"safe" raw chunk still blew past 4096 encoded. The per-message analytics
Metadata can also exceed 1024 on battle turns.

### Solution

`backend/lambda/src/lib/async-processor-core.ts`: `splitIntoChunks` is
encoded-length-aware (binary search on `encodeURIComponent(...).length`,
natural-boundary backoff), chunk[0] gets a smaller budget reserving
marker headroom (`CHUNK0_MARKER_HEADROOM`), and `safeMetadataString`
drops an oversized Metadata with a warning rather than fabricating it or
failing the post (the battle scorecard/name ride the Content marker, not
Amazon Chime SDK Metadata; analytics also flows via the archival pipeline). Pinned
by tests in `backend/test/lib/async-processor-battle.test.ts`.
`async-processor-core.ts` is bundled into every tier's async processor, so
redeploy the affected `AgentEchelonTier-*` stack(s).

### Prevention

Any new Send/UpdateChannelMessage path must budget by encoded length, not
raw `String.length`, and keep Metadata under 1024 encoded.

---

## 14. Admin dashboard tabs silently empty (archival pipeline stopped)

### Symptom

After a deploy that previously worked, the admin **Overview / Models /
Latency / Evaluations / Users / Intent** tabs show "No analytics data yet"
indefinitely. New conversations don't surface. The frontend looks fine.
The Lambda logs for `EvaluationRunner` and `AnalyticsQueryFunction` run
without errors - but every Athena query returns zero rows.

### Diagnosis Steps

```bash
# 1. Are Amazon Chime SDK events arriving at Kinesis at all?
aws cloudwatch get-metric-statistics \
  --namespace AWS/Kinesis --metric-name IncomingRecords \
  --dimensions Name=StreamName,Value=chime-messaging-agent-echelon \
  --start-time "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 3600 --statistics Sum

# 2. If Sum is 0, the Amazon Chime SDK → Kinesis wiring is broken. Verify it.
APP_INSTANCE_ARN="$(aws cloudformation describe-stacks \
  --stack-name AgentEchelonChimeMessaging \
  --query 'Stacks[0].Outputs[?OutputKey==`AppInstanceArnOutput`].OutputValue' \
  --output text)"
aws chime-sdk-messaging get-messaging-streaming-configurations \
  --app-instance-arn "$APP_INSTANCE_ARN"
```

### Root Cause

The Amazon Chime SDK → Kinesis streaming configuration is missing, points at the
wrong stream, or the Amazon Chime SDK AppInstance was rotated and the wiring lost.
`AnalyticsStack` re-applies this on every deploy via an
`AwsCustomResource`, so it normally heals itself - but a partial deploy,
manual `delete-messaging-streaming-configurations` call, or account-level
service issue can leave it disconnected.

### Solution

```bash
# Re-run the CDK Analytics stack — the custom resource re-applies the wiring.
cd backend && AWS_PROFILE=<profile> npx cdk deploy AgentEchelonAnalytics \
  --require-approval never
```

### Prevention

`AnalyticsStack` exposes an opt-in CloudWatch alarm + SES email Lambda
(`backend/lambda/src/archival-alarm.ts`) that fires when Kinesis
`IncomingRecords` stays at 0 for 1 hour. Enable it at deploy time:

```bash
cd backend && npx cdk deploy AgentEchelonAnalytics \
  --context senderEmail=you@verified.example.com \
  --context alertRecipients='[{"email":"ops@you.com","name":"Ops"}]'
```

Without `alertRecipients`, the alarm + Lambda are not deployed (no cost,
no false noise on low-traffic dev accounts). In SES sandbox, every
recipient must also be verified.

---

## 15. Bot replies with `{"Code":403}` to every message (Amazon Chime SDK can't invoke Lex)

### Symptom

Every assistant reply - in 1:1 and multi-user channels, across all tiers - is
the literal text `{"Code":403}`, returned suspiciously fast (~400-600ms, far
below real Bedrock latency). The conversation is created fine and the bot
appears to "respond", but the response is this error blob. Typically appears
**after a fresh deploy, or a teardown → redeploy**, where the Lex bots were
re-created.

> Bubble-count-only E2E checks (e.g. mentions asserting "count grew by ≥2") will
> still PASS here - the `{"Code":403}` blob is a message. Read response content.

### Diagnosis Steps

```bash
# 1. Confirm the router barely ran (fast 403 = it never reached Bedrock).
#    Count router invocations vs. any "Welcome"/real-work log lines.
MSYS_NO_PATHCONV=1 aws logs filter-log-events \
  --log-group-name "$(aws logs describe-log-groups \
    --log-group-name-prefix /aws/lambda/AgentEchelonTier-Premium-AgentHandler \
    --query 'logGroups[0].logGroupName' --output text)" \
  --start-time $(( ($(date +%s) - 600) * 1000 )) \
  --filter-pattern START --query 'length(events)'

# 2. Inspect the Lex bot's resource policy (the smoking gun: there is none,
#    or it lacks messaging.chime.amazonaws.com). Get a bot id first:
aws lexv2-models list-bots --query "botSummaries[?contains(botName,'Assistant')].[botName,botId]" --output text
aws lexv2-models describe-resource-policy --resource-arn \
  "arn:aws:lex:<REGION>:<ACCOUNT>:bot/<BOT_ID>"            # may 404 = missing
aws lexv2-models describe-resource-policy --resource-arn \
  "arn:aws:lex:<REGION>:<ACCOUNT>:bot-alias/<BOT_ID>/TSTALIASID"
```

### Root Cause

Amazon Chime SDK Messaging invokes an AppInstanceBot's configured Lex bot via
the **bot-alias ARN**, and is denied unless a Lex **resource policy** grants
`messaging.chime.amazonaws.com` permission to call it. **BOTH** the Lex bot
**and** the bot-alias need the policy (the alias one is the one most often
missed - Amazon Chime SDK invokes the *alias*). The condition must use `ArnLike` (not
`ArnEquals`) so the `app-instance/<id>/bot/*` source wildcard matches.

Newly-created Lex bots do not get these policies unless the creation code adds
them. The reference deployment had them applied manually long ago, which masked
the gap - so it only surfaces on a clean deploy (exactly what an OSS deployer
hits first).

### Solution

`backend/lambda/lex-bot/create-lex-bot.ts` now creates both resource policies on
bot creation (it needs `APP_INSTANCE_ARN` in its Lambda env - wired in the tier
stacks). For **bots that already exist** (a redeploy left them without the
policy, and the create custom-resource has no Update path), patch them in place:

```bash
# Pass every tier bot id (list-bots above). Idempotent; replaces if present.
AWS_PROFILE=<profile> AWS_ACCOUNT_ID=<ACCOUNT> \
  node backend/scripts/grant-chime-lex-invoke.mjs <BOT_ID> [<BOT_ID>...]
```

After patching, new conversations get real answers immediately (no redeploy of
the AppInstanceBots needed - the policy is on the Lex side).

### Prevention

The policies ship in `create-lex-bot.ts`, so fresh deploys are correct. Because
the Lex-bot custom resource only runs on **Create** (no Update handler),
changing bot config on an existing stack does **not** re-run it; use the
`grant-chime-lex-invoke.mjs` script, or recreate the bot.

### Related: on-join welcome (`WelcomeIntent`) not firing

**Symptom:** normal replies work, but no greeting appears when a conversation is
created (router logs show `FallbackIntent` invocations but zero `WelcomeIntent`).

**Root cause:** `WelcomeIntent` must be configured on the **specific
AppInstanceBot that is actually a member of the conversation channel** - and
that bot also needs the resource policy above. `create-conversation` enrolls the
**per-tier** AppInstanceBot for the conversation's tier (resolved from SSM
`/agent-echelon/assistant/{tier}/bot-arn`); that per-tier bot is the channel's
creator and its member. There is no shared cross-tier bot fallback, so the
`WelcomeIntent` must be set on the per-tier bot that owns the channel. Confirm
which bot is in the channel before chasing config:

```bash
# Members of a conversation (run as a member's AppInstanceUser ARN):
aws chime-sdk-messaging list-channel-memberships --channel-arn "<CHANNEL_ARN>" \
  --chime-bearer "<APP_INSTANCE_ARN>/user/<SUB>" --query 'ChannelMemberships[].Member.Arn'
# The bot in that list is the one that needs WelcomeIntent + the resource policy.
aws chime-sdk-identity describe-app-instance-bot \
  --app-instance-bot-arn "<BOT_ARN>" --query 'AppInstanceBot.Configuration.Lex'
```

**Fix (live bot without it):**
```bash
aws chime-sdk-identity update-app-instance-bot --app-instance-bot-arn "<BOT_ARN>" \
  --name "Assistant" --metadata "" --configuration \
  '{"Lex":{"LexBotAliasArn":"<ALIAS_ARN>","LocaleId":"en_US","WelcomeIntent":"WelcomeIntent","InvokedBy":{"StandardMessages":"AUTO","TargetedMessages":"ALL"}}}'
```

In code: `create-bot.ts` sets `WelcomeIntent` on creation (the same source the
per-tier + alt-slot bots are built from), so fresh deploys are correct.
The bot must also be a channel **member** (not just the creator) to send the
greeting - `create-conversation` enrolls it explicitly, before the user joins.

---

## CDK / deploy notes

- **Single-stack deploy:** `cd backend && npx cdk deploy <STACK> --require-approval never`. The ChannelFlowProcessor is in **`AgentEchelonChannelFlow`**; the experiments table + admin-experiments lambda in **`AgentEchelonExperiments`**; the battle tables + orchestrator in **`AgentEchelonBattle`**; each tier's async-processor + agent-handler lambdas in its own **`AgentEchelonTier-{Basic,Standard,Premium}`** stack. A model-catalog change touches IAM (via `collectArnsForTier`) **and** bundles into lambdas in every per-tier stack → redeploy the affected `AgentEchelonTier-*` stack(s).
- **Verify the deploy actually applied:** a stack can be `UPDATE_COMPLETE` yet stale. Confirm the Lambda's `LastModified` advanced past "now":
  ```bash
  aws lambda get-function-configuration \
    --function-name "$(res <STACK> <LOGICAL_ID>)" --query LastModified
  ```
- **IAM from catalog:** `collectArnsForTier` already includes `inferenceProfileArns`; adding a model with a profile to the catalog auto-grants it on next deploy. **Cross-region profiles also need every member region's `foundation-model` ARN in `foundationModelArns`** - see §11.
- **Bedrock model access:** every model id in the catalog must be **enabled** in your account's Bedrock console (model access) for the target region, or invokes fail with AccessDenied regardless of IAM. Verify: `aws bedrock list-foundation-models --query "modelSummaries[?starts_with(modelId,'anthropic')].modelId"`.

## Environment gotchas

- **Credential expiry.** `aws sts get-caller-identity` failing mid-session
  (expired SSO token, expired assumed-role) ⇒ re-authenticate with whatever
  your account uses (`aws sso login`, refresh static keys, re-assume role).
  Re-check before each diagnostic batch on long sessions.
- **Windows / Git-Bash path mangling.** Prefix AWS-logs commands with
  `MSYS_NO_PATHCONV=1` or `/aws/lambda/...` becomes
  `C:/Program Files/Git/aws/lambda/...`. (The `fnlog` helper line: prefix it.)
- **`/tmp` on Git-Bash** isn't resolvable by some editors/tools - if you need
  to read a dump with a non-shell tool, write it under the repo (e.g.
  `tests/`) and delete it after.
- **Provisioning gaps don't survive re-seeding.** Tier groups (§3) and
  AppInstanceUsers (§4) must be re-applied whenever demo identities are
  re-created.

## Useful commands

```bash
aws sts get-caller-identity
res <STACK> <LOGICAL_ID>                       # physical name from logical id
fnlog <STACK> <LOGICAL_ID> 20m                 # tail a lambda (MSYS_NO_PATHCONV=1 on Windows)
aws ssm describe-parameters \
  --query "Parameters[?starts_with(Name,'/agent-echelon/alt-bot')].Name"   # battle slot roster
# Post-deploy backfills (run BOTH after re-seeding):
USER_POOL_ID=<USER_POOL_ID> node backend/scripts/backfill-tier-groups.mjs
node backend/scripts/backfill-channel-flow.mjs
```

## 16. Bot replies with `{"Code":429}` at ~43s (VPC-attached Lex handler can't reach its control plane)

### Symptom

After enabling live drift / RAG (`-c enableLiveDrift=true`) in Aurora mode, every tier conversation returns the
literal text `{"Code":429}` with a very long TTFR (~43s, near the handler's 30s timeout plus Amazon Chime SDK retries). The
tier AgentHandler log group shows ZERO events for the turn, so it looks like an upstream Lex/Amazon Chime SDK throttle. It
is not.

### Diagnosis

```bash
# 1. Confirm the handler never ran (0 START events = it never reached Bedrock).
fnlog AgentEchelonTier-Premium AgentHandler 10m   # expect near-zero events
# 2. Is the handler VPC-attached? A non-empty VpcId is the smoking gun.
aws lambda get-function-configuration --function-name "$(res AgentEchelonTier-Premium AgentHandler)" \
  --query '{Vpc:VpcConfig.VpcId,LiveDrift:Environment.Variables.ENABLE_LIVE_DRIFT}'
# 3. What endpoints does the VPC actually have?
aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<VPC_ID> \
  --query 'VpcEndpoints[].ServiceName'
```

If the endpoint set is `{bedrock-runtime, secretsmanager, kinesis}` with no `ssm`, `cognito-idp`, or `lambda`
endpoint, and the subnets are isolated (no NAT), that is the gap.

### Root Cause

A VPC-attached, Lex-facing AgentHandler in ISOLATED subnets cannot reach the control-plane services it needs at
runtime: SSM (bot ARN / channel-flow ARN parameters), Cognito (`AdminListGroupsForUser` to resolve the caller
tier), and Lambda (`InvokeFunction` to start the async processor). None of those has a VPC endpoint in the
analytics VPC, and isolated subnets have no NAT egress. The handler hangs on the first such call, hits its 30s
timeout, and Amazon Chime SDK retries the Lex fulfillment until it posts `{"Code":429}`. The drift / ingestion Lambdas
survive from the same subnets because they only need Bedrock + Secrets + Aurora, which DO have endpoints.
`createVpcEndpoints=true` does NOT fix this: it only creates the same five endpoints (no SSM/Cognito/Lambda).

### Solution

The handler no longer VPC-attaches (project decision 018). Retrieval and drift run in a dedicated VPC-attached
**data-plane Lambda** in the Aurora stack; the handler stays non-VPC and invokes it. `enableLiveDrift=true` now
wires the handler with `AURORA_DATA_PLANE_ARN` + `lambda:InvokeFunction`, not a VpcConfig. Verify the handler
shows `Vpc=""` and `AURORA_DATA_PLANE_ARN` set. If you are on an older build that still VPC-attaches the
handler, either roll back `enableLiveDrift` (redeploy the 3 tier stacks without it, plus `-c appUrl` to avoid
the CORS trap in §... credential reset) or add `ssm` + `cognito-idp` + `lambda` interface endpoints. See
`docs/guides/developer/RAG.md` and `docs/guides/admin/INFRASTRUCTURE-COST.md`.

### Prevention

Do not VPC-attach a synchronous, Lex-facing handler that calls SSM / Cognito / Lambda into isolated subnets.
Keep only the Aurora + Bedrock data work in the VPC (the data-plane Lambda) and invoke it from the non-VPC
handler.

---

## 17. A premium (or standard) user gets basic-tier answers (wrong conversation assistant)

### Symptom

A user signs in on the correct tier, asks for tier-gated data (for example the premium financial ARR), and the
assistant replies that it has no access, or identifies itself as basic tier. Common in E2E tier tests. The
premium AgentHandler / AsyncProcessor log groups show ZERO events for the turn; the BASIC ones ran instead.

### Diagnosis

```bash
# Which tier's handler actually ran? Compare event counts per tier log group.
for T in Basic Standard Premium; do
  echo -n "$T: "; fnlog "AgentEchelonTier-$T" AgentHandler 6m | grep -c "START RequestId"
done
```

If Basic ran and Premium did not, the conversation is a basic conversation. The data-plane / drift EMF metric
`UserTier` dimension (or the resolved tier in the async processor) will read `basic` for what should be a
premium turn.

### Root Cause

Effective tier = `min(userTier, channelTier)`. The channel's tier is set by the ASSISTANT chosen at conversation
creation (the classification card: Claude Haiku = basic, Claude Sonnet = standard, Claude Opus = premium), NOT
by the signed-in user alone. A premium user who opens a Claude Haiku conversation gets basic access by design.
If a test helper hardcodes one assistant for every tier, the higher-tier cases silently run at basic tier and
can never see their own data, regardless of context / IAM / retrieval.

### Solution

Open the conversation with the tier's own assistant: `createConversation(page, title, 'Claude Opus')` for
premium, `'Claude Sonnet'` for standard, `'Claude Haiku'` for basic. See `tests/e2e/tier-context.spec.ts`
`ask()`.

### Prevention

When a tier "cannot see" its data, first confirm WHICH tier handler ran before suspecting context, IAM, or
retrieval. The conversation's assistant is a real tier boundary, not just a model label.

---

## See also

- `docs/specs/experiments-battle/SPEC-BATTLE.md` - battle design; clarification as a measured dimension
- `CLAUDE.md` - tier authorization, post-deploy backfill steps
- `README.md` "Setup" - where CDK outputs / `.env` values come from
