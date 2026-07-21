# Image Generation Providers

**Audience:** Deployers configuring `/battle` generation-out (and any future feature that calls `invokeImageGenModel`).

**Scope:** `/battle` generation-out supports multiple image providers across two hosting modes (AWS Bedrock and external HTTP APIs). The active providers are Stability (Bedrock), OpenAI, and FAL; Amazon Titan Image v2 and Nova Canvas remain in the registry but are LEGACY-locked by AWS for accounts without recent usage, with no self-serve unblock.

## TL;DR

Pick an active model and configure auth. The registry knows which models are still invocable on Bedrock today (active vs legacy) and which need an external API key.

| Provider | Hosting | Auth | Status |
|---|---|---|---|
| Stability Image Core | AWS Bedrock | IAM (Lambda role) | ✅ Active |
| Stability Image Ultra | AWS Bedrock | IAM (Lambda role) | ✅ Active |
| OpenAI gpt-image-1 | External (OpenAI API) | `OPENAI_API_KEY` env var | ✅ Active |
| FAL.ai FLUX 1.1 Pro | External (FAL API) | `FAL_KEY` env var | ✅ Active |
| Amazon Titan Image v2 | AWS Bedrock | IAM | ⚠️ Legacy - AWS may block |
| Amazon Nova Canvas | AWS Bedrock | IAM | ⚠️ Legacy - AWS may block |

Source of truth: `backend/lambda/src/lib/image-gen-models.ts` (the `IMAGE_GEN_MODELS` registry). The legacy state, the auth env var name, and per-image rate estimates all live there.

## Why two hosting modes

The registry supports **two hosting paths** so a deployer is not locked to a single vendor:

- **`aws-bedrock`** - invocation via the Bedrock SDK using the Lambda's IAM role. No secrets in env vars. No egress costs. Models limited to what AWS currently offers (today: Stability).
- **`external-http`** - invocation via `fetch` to the provider's own API. Auth via an env var the deployer sets on the Lambda. Opens up best-in-breed models from any vendor (today: OpenAI, FAL).

A deployer can run one, the other, or both. There's no required default; the registry lists what's configured and the admin UI surfaces only `active` entries.

## Choosing a provider

Three dimensions to consider:

**1. Where do credentials live?**
- Bedrock providers use IAM. The Lambda execution role gets `bedrock:InvokeModel` on the configured model ARN. No secrets to rotate, no env vars to set, no third-party billing.
- External providers need an API key in the Lambda's environment. The key gets paid through that vendor's billing relationship, not your AWS account. Rotation is on you.

**2. Where does network traffic go?**
- Bedrock providers stay inside AWS (VPC + Bedrock private endpoint if you want it). No egress charge. No third-party data residency.
- External providers send the user's prompt and receive the generated image over the public internet. The prompt text and the image bytes traverse the OpenAI / FAL networks before returning. Treat the prompt as data leaving your VPC.

**3. What's the failure mode you tolerate?**
- Bedrock providers fail with Bedrock SDK errors. Throttle/quota retried with backoff; access/validation/model errors fail fast. No cross-model fallback.
- External providers fail with HTTP status codes. 429 / 5xx retried (same backoff shape); 4xx fails fast. Same "no cross-model fallback" rule applies - if you've picked OpenAI and it's down, the request fails; the registry doesn't silently swap you to Stability.

## Provider matrix - detail

### Stability AI (via AWS Bedrock)

Modern Stability text-to-image models exposed by Bedrock. AWS-native, IAM-authed, currently active.

| Field | Value |
|---|---|
| Registry keys | `stability_image_core`, `stability_image_ultra` |
| Bedrock model ids | `stability.stable-image-core-v1:1`, `stability.stable-image-ultra-v1:1` |
| Region | us-west-2 only - the Stability base generators are not offered in us-east-1 (a us-east-1 deployment reaches them by setting `IMAGE_GEN_REGION` / `imageGenRegion` to `us-west-2`; check `aws bedrock list-foundation-models --region us-west-2`) |
| Auth | IAM - Lambda role needs `bedrock:InvokeModel` on the model ARN |
| Approx cost per image | $0.04 (Core), $0.08 (Ultra) |
| Request body | `{ prompt, mode:'text-to-image', aspect_ratio:'1:1', output_format:'png', seed? }` |
| Response | `{ images: [base64,...], seeds, finish_reasons:['SUCCESS'|'CONTENT_FILTERED',...] }` |
| Non-SUCCESS handling | Image dropped - caller sees honest empty, not a censored image |

Enable in Bedrock console: us-east-1 / Bedrock / Model access → request access to Stability models. Approval is usually immediate.

### OpenAI gpt-image-1

The current state of the art for prompt adherence and typography. External-HTTP only.

| Field | Value |
|---|---|
| Registry key | `openai_gpt_image_1` |
| OpenAI model id | `gpt-image-1` |
| Endpoint | `https://api.openai.com/v1/images/generations` |
| Auth | `Authorization: Bearer $OPENAI_API_KEY` |
| Approx cost per image | $0.04 (standard quality, 1024×1024) |
| Request body | `{ model:'gpt-image-1', prompt, n, size:'1024x1024', response_format:'b64_json', seed? }` |
| Response | `{ data: [{ b64_json:'...' }, ...] }` |

**API surface caveat (verify against current OpenAI docs).** The current shaper passes `response_format: 'b64_json'`. That field is documented for DALL-E 3 but **may not be honored by `gpt-image-1`**, which is OpenAI's post-2024 image model and returns base64 by default. OpenAI's APIs generally tolerate extra fields, but if a future surface change starts returning hosted URLs instead of inline base64, the parser will currently return empty. The parser would need a URL-handling branch (the FAL parser already does this pattern) - small change, not yet implemented. Watch the first live invocation against `gpt-image-1` and confirm the response shape.

Provision (the image-gen invocations are made from the shared `assistant-async-processor` Lambda - the premium profile's instance, whose topology is defined in `backend/lib/stacks/premium-classification-stack.ts` and wired by `backend/lib/stacks/assistant-profile-stack.ts`):

1. Create an OpenAI account + API key at <https://platform.openai.com/api-keys>.
2. Set the spend limit on the OpenAI side (separate from your AWS billing).
3. Store the key - pick one of:

 **Option A (quick, single-deployer):** AWS Lambda env var, set via CLI:
   ```bash
   aws lambda update-function-configuration \
     --function-name <Tier-Premium-AsyncProcessor-function-name> \
     --environment "Variables={OPENAI_API_KEY=sk-...,FAL_KEY=...,...existing vars}"
   ```
 ⚠️ Replace the entire Variables map - this command overwrites, doesn't merge. Capture existing vars first via `aws lambda get-function-configuration`.

 **Option B (preferred for production):** AWS Secrets Manager + a cold-start fetch:
   ```bash
   aws secretsmanager create-secret \
     --name agent-echelon/openai-key \
     --secret-string '{"OPENAI_API_KEY":"sk-..."}'
   ```
 Then reference in CDK and grant `secretsmanager:GetSecretValue` to the PremiumAsyncProcessor role; have the Lambda load the secret into `process.env` at module init. Adds ~$0.40/month per secret + ~$0.05 per 10K reads.

**Never** put the literal key string into the CDK source file as `environment: { OPENAI_API_KEY: 'sk-...' }` - it ends up in the synthesized CloudFormation template in your bootstrap S3 bucket.

### FAL.ai FLUX 1.1 Pro

Black Forest Labs FLUX, hosted by FAL.ai. Best-in-breed open-weights quality, fast inference, simple billing.

| Field | Value |
|---|---|
| Registry key | `fal_flux_pro_1_1` |
| FAL model path | `fal-ai/flux-pro/v1.1` |
| Endpoint | `https://fal.run/fal-ai/flux-pro/v1.1` |
| Auth | `Authorization: Key $FAL_KEY` |
| Approx cost per image | ~$0.04 (pay-as-you-go; cheaper with subscription) |
| Request body | `{ prompt, image_size:'square_hd', num_images, seed? }` |
| Response | `{ images: [{ url:'data:image/png;base64,...' \| 'https://...' }, ...] }` |

Provision:
1. Sign up at <https://fal.ai/dashboard>.
2. Create an API key (Settings → Keys).
3. Set `FAL_KEY` on the `PremiumAsyncProcessor` Lambda environment using the same patterns shown for OpenAI above (CLI for quick, Secrets Manager for production).

**Sync vs async endpoint.** The current implementation uses FAL's **sync endpoint** (`fal.run/<model-path>`) which returns inline. FAL also offers an async queue endpoint (`queue.fal.run`) that requires polling; the implementation does NOT support it today. Practical effect: a sync FLUX 1.1 Pro call is expected to return in 5-15s. If FAL's sync timeout ceiling tightens or a future model exceeds it, the deployer hits an HTTP timeout (which fails fast in `invokeImageGenModel`'s catch path). Migrating to the queue endpoint would be a per-provider invoker change - manageable but not yet done.

The response URL can be either an inline `data:image/png;base64,...` (small images) or a hosted `https://fal.run/cached/...` URL (large/cached). The parser strips the `data:` prefix; hosted URLs pass through as-is.

### Titan Image v2 / Nova Canvas (legacy)

Both models are still in the registry so existing channel-battle configs that bind them keep functioning if the deployer's AWS account has fresh usage. **AWS has effectively deprecated them:** accounts without recent invocation of either are blocked from re-enabling them, with no self-serve unblock. New deployments should not bind these models.

When a legacy model returns `ResourceNotFoundException` or `AccessDeniedException`, `invokeImageGenModel` wraps the SDK error with an actionable message:

> `invokeImageGenModel: Bedrock model "amazon.titan-image-generator-v2:0" is LEGACY-locked for this AWS account (ResourceNotFoundException). AWS blocks deprecated image models for accounts without recent usage, with no self-serve unblock. Switch to an active model: stability.stable-image-core-v1:1, stability.stable-image-ultra-v1:1, gpt-image-1, fal-ai/flux-pro/v1.1.`

The admin UI calls `listImageGenModels()` (default: active only) so deployers don't accidentally bind a legacy model in a new battle experiment.

## Security posture

**Secrets handling - the threat model is wider than "env vars are encrypted at rest."** Lambda env vars are visible in plaintext to any IAM principal with `lambda:GetFunctionConfiguration`, and they can leak into CloudWatch logs if upstream code accidentally logs the headers object or if certain SDK error paths echo the request. The encryption-at-rest property protects against AWS-internal disk access, not against the much more common "someone with broad read IAM gets the key" scenario.

This is acceptable for single-owner deployments where every principal that can read the Lambda config is already trusted. **Do not assume it's acceptable for a shared AWS account, a multi-team deployment, or any environment where the trust boundary is wider than "the deployer."**

**Never put the literal key in CDK source code.** Writing `environment: { OPENAI_API_KEY: 'sk-...' }` in the CDK stack file looks ergonomic but ships the secret into the synthesized CloudFormation template - which is stored in the CDK bootstrap S3 bucket. Anyone with read access to that bucket (broader than you think) can extract the key. Concrete patterns:

```ts
// CDK example using Secrets Manager - preferred for any non-trivial deployment
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
const openaiSecret = secrets.Secret.fromSecretNameV2(this, 'OpenAIKey', 'agent-echelon/openai-key');
new lambdaNodeJs.NodejsFunction(this, 'AsyncProcessor', { // shared construct id in assistant-profile-stack.ts
  environment: {
    // Pass the secret ARN; have the Lambda fetch the value at cold start.
    OPENAI_API_KEY_SECRET_ARN: openaiSecret.secretArn,
  },
});
openaiSecret.grantRead(/* the lambda role */);
```

The current implementation reads from `process.env.OPENAI_API_KEY` directly. To use Secrets Manager, either: (a) populate `OPENAI_API_KEY` from the secret at Lambda cold start, or (b) change the registry's `authEnvVar` semantics to be a secret ARN and add a fetch step in `invokeExternalHttp`. Either is a small, isolated change.

**Authorization header in logs.** The current implementation never logs the headers object directly. Before raising `LOG_LEVEL` to `DEBUG` or adding any `console.log(request)` upstream of `fetch`, audit the path - a single `console.log({headers})` lands the bearer/key in CloudWatch where it's then visible to anyone with `logs:GetLogEvents`.

**Network egress.** External-HTTP providers send the user prompt and receive image bytes over the public internet.

- **Non-VPC Lambda (Athena mode default):** Lambda has direct internet egress; `fetch` works immediately. No extra infra cost. AWS-side egress is billed via Lambda data transfer (negligible at typical /battle volume).
- **VPC-attached Lambda (Aurora mode):** Lambda has NO direct internet egress. Reaching `api.openai.com` or `fal.run` requires either a **NAT Gateway** or **VPC interface endpoints** (which neither vendor exposes today). NAT Gateway costs ~**$32/month per AZ fixed + $0.045/GB processed**, on top of the existing Aurora-mode baseline.
- **Cross-cutting concern:** a NAT Gateway enables egress for ANY function in that VPC, not just this image-gen path. If that's broader than you want, scope egress via security-group rules + NACLs, or run external-HTTP providers from a non-VPC Lambda partition.

Bedrock providers do not have this constraint - they reach Bedrock through the VPC interface endpoint already provisioned by `analytics-stack-aurora.ts` (`vpc.addInterfaceEndpoint('BedrockEndpoint', ...)`).

**Important framing.** The NAT Gateway requirement is **not unique to this project's image-gen path** - it's standard production AWS architecture. Any VPC-attached Lambda that calls out to anything not in AWS hits the same line item. Real-world examples a production deployer of this codebase (or any similar agentic app) will encounter:

- External LLM APIs: Anthropic Direct, OpenAI text completions, Together AI, Groq, Replicate
- **External MCP servers** - Model Context Protocol endpoints hosted outside AWS (third-party MCP services, your own self-hosted-outside-AWS MCP server). MCP servers hosted INSIDE the VPC (your own EC2/Fargate/ECS) reach Lambdas via private networking and don't need NAT.
- External vector DBs: Pinecone Cloud, Weaviate Cloud, Qdrant Cloud
- Webhook callbacks: Stripe, Slack, Linear, any SaaS that the agent integrates with
- External observability sinks: Datadog, New Relic, Sentry

The Aurora-mode + NAT-Gateway cost line will appear in any production AWS app that combines a private VPC posture with external integrations. The right way to think about it: this is a **table-stakes production-AWS cost** for any agentic app integrating beyond Bedrock - not a hidden cost this project introduced. The cost only surprises a deployer who's running this as a single-cloud, single-vendor showcase; the moment external integrations land (which is the typical agentic-app trajectory), the line item is sitting there waiting.

The three escape paths still apply: (1) stick to Bedrock providers via VPC interface endpoints, (2) stay on Athena mode (non-VPC) so direct internet egress is free, (3) split Lambdas so the ones needing external HTTP run outside the VPC and the ones needing Aurora stay inside.

**Prompt handling.**

- **Bedrock providers (Stability, Titan/Nova).** Input prompt AND generated image both flow through `BattleImageGuardrails` (`backend/lib/constructs/battle-image-guardrails.ts`). The construct filters on TEXT (input prompt) and IMAGE (output) for sex / violence / hate / misconduct / prompt-injection. A blocked input returns `blockedInputMessaging`; a blocked output returns `blockedOutputsMessaging`. This is the OSS "basic default" - production tuning is the deployer's responsibility, per the construct's own docstring.
- **External-HTTP providers (OpenAI, FAL).** No Bedrock guardrail in the loop. The deployer relies on the external provider's content policy. OpenAI applies its own safety filters to all generations (block list, NSFW detection); FAL applies model-specific filters per FLUX's baked-in safety. Neither is configurable by the deployer.
- **Retention.** OpenAI: under default API terms, inputs and outputs are retained for up to **30 days** for abuse review (zero-data-retention requires business/enterprise tier). FAL: prompts not retained per current docs; generated images are cached on signed CDN URLs that expire by plan-specific TTL. Both vendors' terms change; verify against the current agreement before sending sensitive prompts.

**Failure isolation.** A single image-gen invocation is bounded by `requestTimeoutMs` (default 60s). A hung call aborts and fails fast - never retried, never fallen back. This is the "long-running cost vector" guard documented in the module: a model that hangs would otherwise burn Lambda billed-seconds up to the function's timeout ceiling.

**No cross-model fallback by design.** The two models in a `/battle` are an explicit head-to-head; silently swapping a failing model to a different one would corrupt the comparison. If one model fails, the user sees an honest "withheld/failed" line for that bot's image, not a fabricated alternative.

## Performance posture

**Per-invocation latency.** Image generation is the slow path. Typical wall-clock:
- Stability Core: 5-10s
- Stability Ultra: 10-20s
- OpenAI gpt-image-1: 10-20s (standard quality)
- FAL FLUX 1.1 Pro: 5-15s

The `requestTimeoutMs` default of 60s leaves headroom for the slower end of these ranges plus retry budget. **Adjust the Lambda's own timeout** (`Duration.seconds(180)` or higher in the CDK stack) before raising `requestTimeoutMs` - the per-call timeout must stay under the Lambda timeout, otherwise a hung call delivers the timeout error too late.

**Retry shape.** Throttle (429 / `ThrottlingException` / `ServiceQuotaExceededException`) is the only retryable class. Default budget: 2 retries with 200ms + 800ms backoff. A timed-out attempt fails fast and is **never** retried (that's the long-running cost guard). Throttle retries each get a fresh per-attempt timer, so realistic worst case for a healthy throttle pattern is one full timeout (~60s). The absolute pessimistic case - every attempt happens to throttle right at the timeout boundary - is `requestTimeoutMs × (maxRetries + 1) + 1000ms` (≈ 3 min at defaults). Keep the Lambda timeout above that ceiling if you care about bounding it.

**Concurrent fan-out.** A `/battle` runs **2 image-gen invocations in parallel** (one per bot). Both share the deployer's account-level rate limit for whichever provider they target.
- OpenAI Images API default quotas range from ~50 to several hundred images/minute per tier; check `https://platform.openai.com/account/limits` for the actual ceiling on the key you provisioned.
- FAL FLUX 1.1 Pro defaults to several concurrent requests per key; plan tier affects this.
- Bedrock Stability is governed by `bedrock:InvokeModel` quotas per region - increase requests via Service Quotas console if you hit them.

If both bots in a battle target the same provider, parallel fan-out doubles the rate-limit pressure on a single key. Two mitigations:
1. **Mix providers across the head-to-head** (one bot on Stability/Bedrock, one on OpenAI). Natural rate-limit isolation, and the comparison becomes "which model does X best" rather than "two flavors of the same family."
2. Pre-emptively request a quota increase before traffic ramps.

**Cold start.** The Bedrock SDK client is a module-level singleton (`defaultSendClient()`) reused across warm invocations. The external-HTTP path has no client to instantiate - `fetch` is a built-in. Cold start cost is essentially the Lambda + module-load cost, not the network client.

**Cost ceiling.** The registry's `maxImages` + `maxDimension` are HARD caps the shaper clamps to. The deployer's `battleImageMaxImages` / `battleImageMaxDimension` CDK context can only *lower* them further - fat-fingering a higher cap can never raise the ceiling. See [SPEC-BATTLE.md](../../specs/capabilities/SPEC-BATTLE.md) for the per-battle cost guard math.

### Cost picture: how this layers on top of the existing modes

This isn't a unique cost structure - it's the standard production-AWS bill for "private VPC + external integrations." Stating the layering explicitly so a deployer can plan:

| Deployment shape | Monthly baseline | External-HTTP image gen | Notes |
|---|---|---|---|
| **Athena mode** (default, non-VPC Lambda) | minimal | $0 incremental infra; only per-image API costs | The most common starting point. `fetch` to OpenAI/FAL has no NAT cost. |
| **Aurora mode**, Bedrock-only image gen | ~$50-95 (proxy off; +~$44 stack-created endpoints) | n/a (uses Bedrock VPC endpoint) | Single-cloud, all-AWS. Cheapest path to drift detection + advanced analytics. |
| **Aurora mode + external-HTTP image gen** | ~$122-174 (above + NAT Gateway, 1-2 AZ) | per-image API costs + ~$0.045/GB bandwidth | NAT gateway is the new line. Realistic for any agentic app integrating beyond Bedrock. |

The NAT Gateway line is **not introduced by this project** - it's the cost of running ANY VPC-attached Lambda that calls anything outside AWS. The moment a deployer adds an external MCP server, a Pinecone vector DB, a Stripe webhook, or any other non-AWS integration, the same NAT Gateway sits in front of all of them. Image-gen happens to be the first concrete trigger; it's not the only one.

**Observability gap on the external-HTTP path.** Bedrock invocations carry an invocation ID natively and per-stage EMF metrics live in `lib/emf-metrics.ts` for the drift-detection path. External-HTTP calls do **not** currently emit EMF or carry a correlation ID through to provider logs. OpenAI returns `x-request-id` in response headers; FAL includes a request id in the body. Capturing those into `ImageGenInvokeResult` is a clean follow-up that would enable end-to-end tracing - tracked as a v0.3.x enhancement.

## Agentic integration - where image-gen sits in the architecture

AgentEchelon's fulfillment path is the **self-hosted Converse tool loop** - see CLAUDE.md > Architecture. The shared `assistant-async-processor.ts` (via `async-processor-core.ts`) runs a Converse `toolConfig` loop under the serving profile's own IAM role; there is no Bedrock Agent and no Action Group. Image generation is called directly from `assistant-async-processor.ts` during the `/battle` fan-out, and only for battle-eligible profiles (premium by default).

**Why call it directly rather than as a tool?** Image generation is slow (5-20s per call). Folding a 15-second image-gen into the synchronous Converse tool loop would: (a) push the text reply's latency well past acceptable bounds, (b) couple the text reply timing to the image timing in a way that prevents the user from seeing the text-side response first.

Today's split: the text side runs through the Converse tool loop → produces the text reply → the `/battle` orchestrator (after the text battle settles) fires `invokeImageGenModel` separately for each bot's image-gen variant. The image arrives as an out-of-band Amazon Chime SDK message with a `<!--battleimage:-->` marker, decoupled from the text reply.

This decoupled, direct-invocation pattern is the correct shape for any slow generation step that must not block the text turn.

## Common-practice notes for calling external models from AWS

A few patterns this design follows (and a few it deliberately doesn't, with rationale):

**Do:**
- Read secrets from env vars (or Secrets Manager). Never hard-code.
- Use a per-attempt timeout strictly under the Lambda timeout.
- Retry only throttle-class errors. 4xx fails fast.
- Surface actionable errors when configuration is missing - "set `$FAL_KEY` on the Lambda" beats "401 unauthorized".
- Pin the response shape per provider in tests so a vendor body change doesn't ship silently.
- Log the model id + retry count + correlation id, not the prompt body.

**Don't:**
- Don't add cross-model fallback. A battle is a comparison; falling back corrupts the comparison.
- Don't cache images in DynamoDB. They're large and the existing S3-attachment pipeline already handles them.
- Don't centralize all providers behind one abstraction layer **yet**. The shaper / parser dispatch on `provider` is enough - full abstraction (e.g. LangChain-style provider classes) is over-engineering for four providers. **Reconsider this when the registry exceeds ~8 providers** or when a provider needs significantly different retry/error/auth shapes (e.g. async polling instead of sync POST). Today, the switch in `shapeImageGenRequest` is the abstraction.
- Don't reuse Bedrock Guardrails configuration for external models. Bedrock Guardrails attach to Bedrock invocations only via `guardrailIdentifier` on `InvokeModelCommand`; an external provider needs its provider-side moderation (OpenAI and FAL both apply their own, but neither is configurable by the deployer).

## Adding a new provider

The registry shape is the contract. To add a provider:

1. Pick a `provider` name (e.g. `replicate`, `together`). Extend the `ImageGenProvider` union in `image-gen-models.ts`.
2. Add one or more registry entries with the right `hosting`, `lifecycle`, `bedrockModelId` (or external model id), and `authEnvVar` if external.
3. Add a `case '<provider>':` in `shapeImageGenRequest` that returns the provider's request body.
4. Add a shape branch in `parseImageGenResponse` that extracts base64 PNG strings from the provider's response.
5. If external-HTTP: add an entry in `EXTERNAL_HTTP_ENDPOINTS` with the URL + auth-header function. (Note: this constant is currently typed `Record<'openai' | 'fal', ...>` - broaden the type union or refactor to `Partial<Record<ImageGenProvider, ...>>` when adding a third external provider.)
6. Add tests in `image-gen-models-providers.test.ts` for the new shape + parse + (if external) the env-var-missing error.
7. **If `hosting: 'aws-bedrock'`:** grant `bedrock:InvokeModel` on the model ARN to the invoking Lambda's IAM role. The caller is the shared `assistant-async-processor` running as a battle-eligible profile (premium by default) - find the image-gen `iam.PolicyStatement` in the `imageGen` block of `backend/lib/stacks/assistant-profile-stack.ts` and add the new ARN to its `resources` array. External-HTTP entries skip this step (IAM doesn't gate the call; the provider's API key does).

That's the surface - no other module changes needed. The exhaustiveness check in `shapeImageGenRequest`'s switch will fail the build if you miss step 3.

## Related

- `backend/lambda/src/lib/image-gen-models.ts` - registry + shapers + invokers
- `backend/test/lib/image-gen-models.test.ts` - Titan/Nova back-compat tests
- `backend/test/lib/image-gen-models-providers.test.ts` - Stability, OpenAI, FAL, lifecycle, external-HTTP routing tests
- `docs/specs/capabilities/SPEC-BATTLE.md` - `/battle` generation-out spec, cost guards, scorecard math
