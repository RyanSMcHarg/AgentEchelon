# Image Generation Providers

**Audience:** Deployers configuring image generation. Image generation is a normal profile capability - an intent routed to an image model in a profile's `models.byIntent` (the `image_generation` intent as shipped) - and the image A/B experiments and battles are built on top of it. Anything that calls `invokeImageGenModel`.

**Scope:** Image generation supports multiple providers across two hosting modes (AWS Bedrock and external HTTP APIs). A profile's `models.image` selects the provider for ordinary `image_generation` turns; an Image Generation intent experiment (or a Profile vs Profile experiment) can pit two providers against each other on live traffic, and a battle runs both side by side and scores them. The active providers are Stability (Bedrock), OpenAI, and FAL; Amazon Titan Image v2 and Nova Canvas remain in the registry but are LEGACY-locked by AWS for accounts without recent usage, with no self-serve unblock.

## TL;DR

Pick an active model and configure auth. The registry knows which models are invocable on Bedrock (active vs legacy) and which need an external API key.

| Provider | Hosting | Auth | Status |
|---|---|---|---|
| Stability Image Core | AWS Bedrock | IAM (classification acting role) | Active |
| Stability Image Ultra | AWS Bedrock | IAM (classification acting role) | Active |
| OpenAI gpt-image-1 | External (OpenAI API) | `OPENAI_API_KEY`, and the classification selects `openai_gpt_image_1` | Active |
| FAL.ai FLUX 1.1 Pro | External (FAL API) | `FAL_KEY`, and the classification selects `fal_flux_pro_1_1` | Active |
| Amazon Titan Image v2 | AWS Bedrock | IAM | Legacy - AWS may block |
| Amazon Nova Canvas | AWS Bedrock | IAM | Legacy - AWS may block |

Source of truth: `backend/lambda/src/lib/image-gen-models.ts` (the `IMAGE_GEN_MODELS` registry). The legacy state, the auth env var name, and per-image rate estimates all live there.

**Where image generation is wired.** An image model is a key of the instance's catalog, like a text model, and a classification uses it when it selects it (`models.selected` on its entry, [MODEL_STRATEGY](../developer/MODEL_STRATEGY.md#three-layers)). A classification gets the image grants, the image guardrail and the image env exactly when it selects at least one image model (`imageModelsAllowedFor`), its grant names only the Bedrock image models it selects, and the external providers' key secret reaches its processor only when it selects an image model hosted outside AWS. In the shipped catalog that is premium only. To turn on image generation in another classification, add image models to its selection and deploy its stack; nothing else is set. `backend/test/image-gen-iam-parity.test.ts` synthesizes every classification and holds its image grant, guardrail, session-policy edges and provider keys to its selection.

**Which turn uses an image model.** A turn whose intent is routed to an image model in the served version's `models.byIntent`, whatever the intent is called, and a turn whose intent needs an image (the platform's `image_generation`, or a pack intent declaring `needs: 'image'`), which takes the `image_generation` route. Only an image model the classification allows is used, whatever names it: the version's image route (or its legacy `models.image`, read as the `image_generation` route's primary), an experiment variant's `imageGenModelKey`, or a battle side's pinned version (`resolveTurnImageRoute`). An image route has a primary and a fallback like every other intent: the fallback is tried once when the primary fails on the model side (unavailable, not accessible, a service error, a timeout, or throttling past its retries), never after a guardrail or content-policy refusal or an input-validation error, and the turn records the model that produced the image. In a classification allowed no image model the router refuses an image request, in a battle as well, and points the person to the classifications that produce images.

**Who chooses it.** An assistant manager routes an intent to an image model on a profile version, in the same per-intent list as every text route, and the write path refuses an image model the assistant's classification does not allow, a text model on an intent that needs an image, or a route whose fallback is of the other kind or repeats its primary. Nothing is backfilled: a version that names no image model generates no images. The premium seed routes `image_generation` to `stability_image_core` with `stability_image_ultra` as its fallback, both on Bedrock with no external key; the basic and standard seeds name none.

## Hosting modes

The registry supports **two hosting paths** so a deployer is not locked to a single vendor:

- **`aws-bedrock`** - invocation via the Bedrock SDK on the turn's assistant session (the classification's acting role). No secrets in env vars. Models limited to what AWS offers (Stability, plus the legacy Titan and Nova entries).
- **`external-http`** - invocation via `fetch` to the provider's own API, authenticated with an API key (OpenAI, FAL).

A deployer can run one, the other, or both. There is no required default. The registry's `listImageGenModels()` returns only `active` entries by default, but the admin console does not call it: the image-model picker in `frontend/packages/admin/src/components/admin/ExperimentsTab.tsx` (`IMAGE_GEN_MODEL_OPTIONS`) is a hand-kept list of the four active models. A model added to or retired from the registry must also be changed there; nothing checks that the two agree (**OPEN**).

## Choosing a provider

Three dimensions to consider:

**1. Credentials**
- Bedrock providers use IAM. `bedrock:InvokeModel` is granted on the classification's acting role, the role every turn's calls go out on; the processor Lambda's own execution role holds only logs, the session vend and the admin-alert post (`errAlert.grant(processorRole)` in `backend/lib/stacks/assistant-profile-stack.ts`). No secrets to rotate and no third-party billing. The grant is DERIVED from the registry (`BEDROCK_IMAGE_MODEL_ARNS`), so every `aws-bedrock` entry is covered and adding a model cannot leave it ungranted. It uses a region wildcard, which is what lets a region-pinned model be invoked cross-region.
- External providers need an API key (see [Storing provider keys](#storing-provider-keys)). The key is paid through that vendor's billing relationship, not the AWS account, and rotation is the deployer's job.

**2. Network path**
- Bedrock calls stay on AWS. No third-party data residency.
- External providers send the user's prompt and receive the generated image over the public internet. The prompt text and the image bytes traverse the OpenAI / FAL networks. Treat the prompt as data leaving AWS.

**3. Failure mode**
- Bedrock providers fail with Bedrock SDK errors. Throttle/quota is retried with backoff; access/validation/model errors fail fast.
- External providers fail with HTTP status codes. 429 / 5xx are retried (same backoff shape); 4xx fails fast.
- After the retries, a route's fallback is tried once on a model-side failure (429/5xx, unavailable, not accessible, timeout; `invokeImageGenWithFallback`). A 4xx input error, a guardrail or a content-policy refusal fails without fallback. An experiment variant's image model has no fallback: its failure is the variant's result.

## Provider matrix

### Stability AI (via AWS Bedrock)

Stability text-to-image models exposed by Bedrock. AWS-native, IAM-authed, active.

| Field | Value |
|---|---|
| Registry keys | `stability_image_core`, `stability_image_ultra` |
| Bedrock model ids | `stability.stable-image-core-v1:1`, `stability.stable-image-ultra-v1:1` |
| Region | us-west-2 only - the Stability base generators are not offered in us-east-1, where every Stability model Bedrock lists is an editing operation (upscale, inpaint, erase-object, style-transfer) rather than a generator. **No configuration is needed:** the registry declares `region: 'us-west-2'` on these entries and the invoker builds its Bedrock client for the model's own region, so they work from any deploy region. Set `IMAGE_GEN_REGION` / `imageGenRegion` only to OVERRIDE that (it wins over the registry). Check with `aws bedrock list-foundation-models --region us-west-2` |
| Auth | IAM - the acting role holds `bedrock:InvokeModel` on the model ARN (derived from the registry) |
| Approx cost per image | $0.04 (Core), $0.08 (Ultra) |
| Request body | `{ prompt, mode:'text-to-image', aspect_ratio:'1:1', output_format:'png', seed? }` |
| Response | `{ images: [base64,...], seeds, finish_reasons:['SUCCESS'|'CONTENT_FILTERED',...] }` |
| Non-SUCCESS handling | Image dropped - caller sees honest empty, not a censored image |

Enable in Bedrock console: us-west-2 / Bedrock / Model access, then request access to Stability models. Approval is usually immediate.

### OpenAI gpt-image-1

External-HTTP only.

| Field | Value |
|---|---|
| Registry key | `openai_gpt_image_1` |
| OpenAI model id | `gpt-image-1` |
| Endpoint | `https://api.openai.com/v1/images/generations` |
| Auth | `Authorization: Bearer $OPENAI_API_KEY` |
| Approx cost per image | $0.04 (standard quality, 1024×1024) |
| Request body | `{ model:'gpt-image-1', prompt, n, size:'1024x1024' }` |
| Response | `{ data: [{ b64_json:'...' }, ...] }` |

**API surface.** `gpt-image-1` always returns inline base64 (`data[].b64_json`) and rejects the `response_format` parameter, so the shaper does not send it. `seed` is likewise not a `gpt-image-1` parameter and is omitted. The base64 result feeds the persistence path identically to the Bedrock providers.

Provision:

1. Create an OpenAI account and API key at <https://platform.openai.com/api-keys>.
2. Set the spend limit on the OpenAI side (separate from AWS billing).
3. Store the key as described in [Storing provider keys](#storing-provider-keys).
4. Select the model in the classification's `models` and deploy that classification's stack, as described in [The classification selects it](#the-classification-selects-it). Without it the model is refused.

### FAL.ai FLUX 1.1 Pro

Black Forest Labs FLUX, hosted by FAL.ai.

| Field | Value |
|---|---|
| Registry key | `fal_flux_pro_1_1` |
| FAL model path | `fal-ai/flux-pro/v1.1` |
| Endpoint | `https://fal.run/fal-ai/flux-pro/v1.1` |
| Auth | `Authorization: Key $FAL_KEY` |
| Approx cost per image | ~$0.04 (pay-as-you-go; cheaper with subscription) |
| Request body | `{ prompt, image_size:'square_hd', num_images, sync_mode:true, output_format:'png', seed? }` |
| Response | `{ images: [{ url:'data:image/png;base64,...' \| 'https://...' }, ...] }` |

Provision:
1. Sign up at <https://fal.ai/dashboard>.
2. Create an API key (Settings, Keys).
3. Store the key as described in [Storing provider keys](#storing-provider-keys).
4. Select the model in the classification's `models` and deploy that classification's stack, as described in [The classification selects it](#the-classification-selects-it). Without it the model is refused.

**Sync endpoint.** The implementation uses FAL's **sync endpoint** (`fal.run/<model-path>`) with `sync_mode: true`, which makes FAL return the image inline as a base64 `data:` URI instead of a CDN URL - required because the persistence path base64-decodes the result. It also sends `output_format: 'png'` so the bytes match the persistence path's `.png` key and `image/png` content type (FLUX defaults to JPEG). FAL's async queue endpoint (`queue.fal.run`) requires polling and is **NOT BUILT**. A sync FLUX 1.1 Pro call is expected to return in 5-15s. If FAL's sync timeout limit tightens or a model exceeds it, the call hits an HTTP timeout, which fails fast in `invokeImageGenModel`'s catch path.

With `sync_mode: true` the response URL is an inline `data:image/png;base64,...` URI; the parser strips the `data:` prefix. The parser also passes a hosted `https://` URL through as-is, but the sync request shape keeps responses inline.

### Titan Image v2 / Nova Canvas (legacy)

Both models stay in the registry so an existing profile or battle binding keeps functioning if the deployer's AWS account has fresh usage. **AWS has effectively deprecated them:** accounts without recent invocation of either are blocked from re-enabling them, with no self-serve unblock. New deployments should not bind these models.

When a legacy model returns `ResourceNotFoundException` or `AccessDeniedException`, `invokeImageGenModel` wraps the SDK error with an actionable message:

> `invokeImageGenModel: Bedrock model "amazon.titan-image-generator-v2:0" is LEGACY-locked for this AWS account (ResourceNotFoundException). AWS blocks deprecated image models for accounts without recent usage, with no self-serve unblock. Switch to an active model: stability.stable-image-core-v1:1, stability.stable-image-ultra-v1:1, gpt-image-1, fal-ai/flux-pro/v1.1.`

The admin console's hand-kept picker (`IMAGE_GEN_MODEL_OPTIONS` in `ExperimentsTab.tsx`) omits both, so an operator cannot bind a legacy model in a new experiment from the console.

## Storing provider keys

The external providers read their key from the env var named by the registry's `authEnvVar` (`OPENAI_API_KEY`, `FAL_KEY`). Two supported ways to supply it, both wired in the image block of `backend/lib/stacks/assistant-profile-stack.ts`, for a classification that selects an image model hosted outside AWS:

**Secrets Manager (preferred).** Create one JSON secret keyed by env-var name:

```bash
aws secretsmanager create-secret \
  --name agent-echelon/image-gen-keys \
  --secret-string '{"OPENAI_API_KEY":"sk-...","FAL_KEY":"..."}'
```

Put its ARN in `imageGenKeysSecretArn` in the gitignored `backend/deploy.config.json` (see `backend/deploy.config.example.json`), or pass `-c imageGenKeysSecretArn=<arn>`, then deploy with `cd backend && npm run deploy`. The stack grants the classification's acting role read on the secret and sets `IMAGE_GEN_KEYS_SECRET_ARN` on the processor, with `IMAGE_GEN_KEY_FIELDS` naming the key of each external image provider the classification selects (`externalImageKeyFieldsFor`). At the first external call in a warm container, `hydrateImageGenKeysFromSecret` (`image-gen-models.ts`) fetches the secret and copies only those fields into `process.env`, each only where that variable is not already set, so a real env var wins and a classification that selects only OpenAI's model never holds the FAL key in its environment. The separation is in the environment, not in IAM: the acting role's grant is on the whole secret, because one secret serves the deployment. A fetch or parse failure is logged and retried on the next call; the caller then raises the "set `$ENV_VAR`" error. A rotated value is picked up by new containers; a warm container keeps the value it already hydrated.

**Deploy-shell env vars (fallback).** If `OPENAI_API_KEY` or `FAL_KEY` is exported in the shell that runs the deploy, the stack copies it onto the processor of a classification that selects that provider's model, as a plain Lambda env var. This writes the literal key into the synthesized CloudFormation template (in `cdk.out` and the CDK bootstrap bucket) and into the Lambda configuration. Use it only where every principal that can read those is already trusted.

If neither is wired on a classification that selects an external image model, synth emits a warning annotation; Bedrock image models still work and external models produce no image.

A key set by hand with `aws lambda update-function-configuration` is temporary: it is drift from the template, and the next deploy that updates the function's environment replaces it with the template's and drops it.

## The classification selects it

A key is not enough for an external provider (OpenAI, FAL). A model with `hosting: 'external-http'` resolves for a turn only in a classification that selects it (`resolveTurnImageGenModelId` in `backend/lambda/src/lib/async-processor-core.ts`), which is also the only classification whose processor holds the provider's key. No profile version or admin setting opens it, and a version that names one its classification does not select is refused on the write path. IAM cannot bound a call that leaves AWS, so the selection, made by the deployment, is the gate.

An assistant then uses the model by routing an intent to it in `models.byIntent` on a version, in the console's **Assistants** section (`edit-profiles`, then `activate-profiles`).
## Security posture

**Secrets handling.** Lambda env vars are visible in plaintext to any IAM principal with `lambda:GetFunctionConfiguration`, and they can leak into CloudWatch logs if upstream code logs a headers object or an SDK error path echoes the request. Encryption at rest protects against AWS-internal disk access, not against a principal with broad read IAM. The deploy-shell fallback above is acceptable only for a single-owner deployment; for a shared AWS account or a multi-team deployment use the Secrets Manager path.

**Literal keys in CDK.** Never put a literal key in CDK source: `environment: { OPENAI_API_KEY: 'sk-...' }` in a stack file ships the secret into the synthesized CloudFormation template stored in the CDK bootstrap S3 bucket, readable by anyone with read access to that bucket.

**Authorization header in logs.** The invoker never logs the headers object. Before raising `LOG_LEVEL` to `DEBUG` or adding any `console.log(request)` upstream of `fetch`, audit the path - a single `console.log({headers})` lands the bearer/key in CloudWatch, visible to anyone with `logs:GetLogEvents`.

**Network egress.** The image caller is the classification's asynchronous processor, which is not VPC-attached (its function definition in `assistant-profile-stack.ts` sets no `vpc`). It has direct internet egress in both Athena and Aurora mode, so external providers need no NAT Gateway and no extra infrastructure; the only incremental cost is the per-image API charge.

**Prompt handling.**

- **Bedrock providers (Stability, Titan/Nova).** Input prompt AND generated image both flow through `BattleImageGuardrails` (`backend/lib/constructs/battle-image-guardrails.ts`), which is created only for a classification the catalog allows an image model. The construct filters on TEXT (input prompt) and IMAGE (output) for sex / violence / hate / misconduct / prompt-injection. A blocked input returns `blockedInputMessaging`; a blocked output returns `blockedOutputsMessaging`. This is a basic default; production tuning is the deployer's responsibility, per the construct's own docstring.
- **External-HTTP providers (OpenAI, FAL).** No Bedrock guardrail in the loop. The deployer relies on the external provider's content policy, which the deployer cannot configure from this platform.
- **Retention.** OpenAI: under default API terms, inputs and outputs are retained for up to **30 days** for abuse review (zero-data-retention requires a business/enterprise agreement). FAL: prompts not retained per its docs; generated images are cached on signed CDN URLs that expire by plan-specific TTL. Both vendors' terms change; verify against the current agreement before sending sensitive prompts.

**Failure isolation.** A single image-gen invocation is bounded by `requestTimeoutMs` (default 60s). A hung call aborts and is never retried; the route's fallback runs only when the time the invocation has left covers the fallback's own timeout plus the margin to post the reply. This is the "long-running cost vector" guard documented in the module: a model that hangs would otherwise burn Lambda billed-seconds up to the function's timeout limit.

**No fallback for a model under test.** The two models in a `/battle` are an explicit head-to-head; silently swapping a failing model to a different one would corrupt the comparison, so an experiment variant's image model never falls back (`resolveTurnImageRoute` gives it no fallback). If one model fails, the user sees an honest "withheld/failed" line for that assistant's image, not a fabricated alternative.

## Performance posture

**Per-invocation latency.** Image generation is the slow path. Typical wall-clock:
- Stability Core: 5-10s
- Stability Ultra: 10-20s
- OpenAI gpt-image-1: 10-20s (standard quality)
- FAL FLUX 1.1 Pro: 5-15s

The `requestTimeoutMs` default of 60s leaves headroom for the slower end of these ranges. The processor's own timeout is the classification topology's `timeoutSeconds` (90 for premium). The per-call timeout must stay under the Lambda timeout, otherwise a hung call delivers its timeout error too late; raise `timeoutSeconds` before raising `requestTimeoutMs`.

**Retry shape.** Throttle (429 / `ThrottlingException` / `ServiceQuotaExceededException`) is the only retryable class. Default budget: 2 retries with 200ms + 800ms backoff. A timed-out attempt fails fast and is **never** retried (the long-running cost guard). Throttle retries each get a fresh per-attempt timer, so the realistic worst case for a healthy throttle pattern is one full timeout (~60s). The pessimistic case - every attempt throttles right at the timeout boundary - is `requestTimeoutMs × (maxRetries + 1) + 1000ms` (about 3 min at defaults), which exceeds premium's 90s Lambda timeout; raise `timeoutSeconds` above that limit to bound it.

**Concurrent fan-out.** A `/battle` runs **2 image-gen invocations in parallel** (one per assistant). Both share the account-level rate limit for whichever provider they target.
- OpenAI Images API default quotas range from ~50 to several hundred images/minute per tier; check `https://platform.openai.com/account/limits` for the limit on the provisioned key.
- FAL FLUX 1.1 Pro defaults to several concurrent requests per key; plan tier affects this.
- Bedrock Stability is governed by `bedrock:InvokeModel` quotas per region - request increases via the Service Quotas console.

If both assistants in a battle target the same provider, parallel fan-out doubles the rate-limit pressure on a single key. Two mitigations:
1. **Mix providers across the head-to-head** (one assistant on Stability/Bedrock, one on OpenAI). This isolates rate limits and makes the comparison "which model does X best" rather than "two flavors of the same family."
2. Request a quota increase before traffic ramps.

**Cold start.** Bedrock SDK clients are cached at module level, one per region (`defaultSendClient()` in `backend/lambda/src/lib/image-gen-models.ts`), and reused across warm invocations. The external-HTTP path has no client to instantiate - `fetch` is a built-in. Cold start cost is the Lambda and module-load cost, not the network client.

**Cost limit.** The registry's `maxImages` + `maxDimension` are HARD caps the shaper clamps to. The deployer's `battleImageMaxImages` / `battleImageMaxDimension` CDK context can only *lower* them further - a higher value can never raise the limit. See [SPEC-BATTLE.md](../../specs/interaction/quality/SPEC-BATTLE.md) for the per-battle cost guard math.

**Observability gap (OPEN).** Bedrock invocations carry an invocation ID natively, and per-stage EMF metrics live in `backend/lambda/src/lib/emf-metrics.ts`. External-HTTP calls do **not** emit EMF or carry a correlation ID through to provider logs. OpenAI returns `x-request-id` in response headers and FAL includes a request id in the body, but the invoker does not capture either into `ImageGenInvokeResult`, so there is no end-to-end trace across the HTTP boundary.

## Architecture placement

AgentEchelon's fulfillment path is the **self-hosted Converse tool loop** - see [ARCHITECTURE.md](../../overview/ARCHITECTURE.md). The shared `assistant-async-processor.ts` (via `async-processor-core.ts`) runs a Converse `toolConfig` loop on the serving assistant's session; there is no Bedrock Agent and no Action Group. Image generation is a normal capability of this path, not a battle-only branch: on an `image_generation` turn the worker resolves the image route with `resolveTurnImageRoute` (an experiment variant's image model, then the served version's image route, each only when the classification allows it) and calls `invokeImageGenWithFallback` instead of running the text loop. A battle side's served version is its pinned version, which carries its variant's image model, so a battle resolves the same way.

An `image_generation` turn that resolves no registered image model fails with an error naming what is unconfigured. A turn that resolves one but runs on a processor without `ATTACHMENTS_BUCKET` degrades to a text turn. Only a classification the catalog allows an image model (premium in the shipped config) carries the Bedrock image grant, the image guardrail and the key wiring, and only such a classification's assistant can be given `models.image`.

**Direct call.** Image generation is slow (5-20s per call). Folding it into the Converse text loop would push a turn's latency past acceptable bounds and couple the text timing to the image timing, so an `image_generation` turn takes the direct-invocation branch instead.

**Delivery.** The generated image is persisted to the attachments bucket and delivered as a message **attachment** - metadata `{ fileKey, name, size, type }` on the message - which the frontend renders inline as an `<img>` through `AttachmentDisplay`, fetching a fresh presigned URL on demand. The `<!--battleimage:-->` content marker is not used for delivery; it is recognized and stripped defensively.

This direct-invocation, attachment-delivery pattern is the shape for any slow generation step that must not block the text turn.

## Implementation practices

**Do:**
- Read secrets from Secrets Manager (or env vars). Never hard-code.
- Use a per-attempt timeout strictly under the Lambda timeout.
- Retry only throttle-class errors. 4xx fails fast.
- Surface actionable errors when configuration is missing - "set `$FAL_KEY` on the Lambda" beats "401 unauthorized".
- Pin the response shape per provider in tests so a vendor body change does not ship silently.
- Log the model id + retry count + correlation id, not the prompt body.

**Don't:**
- Give an experiment variant's image model a fallback. A battle is a comparison; falling back corrupts the comparison.
- Cache images in DynamoDB. They are large and the S3 attachment pipeline already handles them.
- Put all providers behind a separate abstraction layer. The shaper / parser dispatch on `provider` (the switch in `shapeImageGenRequest`) is the abstraction for four providers. Reconsider when the registry exceeds ~8 providers or a provider needs significantly different retry/error/auth shapes (for example async polling instead of sync POST).
- Reuse Bedrock Guardrails configuration for external models. Bedrock Guardrails attach to Bedrock invocations only via `guardrailIdentifier` on `InvokeModelCommand`; an external provider relies on its own provider-side moderation.

## Adding a new provider

The registry shape is the contract. To add a provider:

1. Pick a `provider` name (for example `replicate`, `together`). Extend the `ImageGenProvider` union in `image-gen-models.ts`.
2. Add one or more registry entries with the right `hosting`, `lifecycle`, `bedrockModelId` (or external model id), and `authEnvVar` if external.
3. Add a `case '<provider>':` in `shapeImageGenRequest` that returns the provider's request body.
4. Add a shape branch in `parseImageGenResponse` that extracts base64 PNG strings from the provider's response.
5. If external-HTTP: add an entry in `EXTERNAL_HTTP_ENDPOINTS` with the URL + auth-header function. This constant is typed `Record<'openai' | 'fal', ...>`; broaden the type union or refactor to `Partial<Record<ImageGenProvider, ...>>` when adding a third external provider. Add the new key to the JSON secret described in [Storing provider keys](#storing-provider-keys).
6. Add tests in `image-gen-models-providers.test.ts` for the new shape + parse + (if external) the env-var-missing error.
7. **If `hosting: 'aws-bedrock'`:** nothing to grant. The acting role's `bedrock:InvokeModel` statement is built from `BEDROCK_IMAGE_MODEL_ARNS`, which is derived from the registry, and `backend/test/lib/image-gen-region-and-iam.test.ts` guards that derivation. If the model is pinned to a region other than the deploy region, `backend/bin/backend.ts` provisions an image guardrail stack there automatically (derived from the registry), and the acting role's `bedrock:ApplyGuardrail` grant covers it.
8. Add the model to `IMAGE_GEN_MODEL_OPTIONS` in `frontend/packages/admin/src/components/admin/ExperimentsTab.tsx` so the admin console offers it.

The exhaustiveness check in `shapeImageGenRequest`'s switch fails the build if step 3 is missed.

## Related

- `backend/lambda/src/lib/image-gen-models.ts` - registry, shapers, invokers, key hydration
- `backend/test/lib/image-gen-models.test.ts` - Titan/Nova back-compat tests
- `backend/test/lib/image-gen-models-providers.test.ts` - Stability, OpenAI, FAL, lifecycle, external-HTTP routing tests
- `backend/test/lib/image-gen-region-and-iam.test.ts` - per-model region, registry-derived IAM grant, regional guardrail resolution
- `backend/test/lib/image-gen-output.test.ts` - persistence of generated images
- [SPEC-BATTLE.md](../../specs/interaction/quality/SPEC-BATTLE.md) - `/battle` generation-out spec, cost guards, scorecard math
