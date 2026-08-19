# Stacks: what each one owns, what it depends on, and what deploys when

**Audience:** anyone deploying AgentEchelon into their own AWS account, or deciding where a new
resource belongs.

Every stack is prefixed with the instance name (default `AgentEchelon`), so a second instance in the
same account is `MyInstanceFoundations`, `MyInstanceCognitoAuth`, and so on. The prefix is also the
safety gate: `npm run deploy` refuses to run if `cdk list` returns a stack outside the expected
prefix, which is what stops a `--all` deploy touching a co-tenant project in a shared account.

## The ownership rule

**A stack owns a capability, not a technology.** The question is never "does this use Cognito?" or
"does this write to Aurora?" - it is "what is this FOR?". Nearly every API needs the user pool for an
authorizer and most features need a table; neither makes a feature part of identity or analytics.

Two corollaries that have each been violated in practice:

- **Needing an authorizer is not an identity coupling.** A feature API that authenticates its callers
  belongs with the feature. Otherwise every API in the platform would live in the identity stack.
- **A route is part of the API it is mounted on.** Adding a resource to another stack's API puts your
  feature in that stack's deploy unit, throttle budget, and authorization posture, no matter where the
  handler code lives. Grepping for `new apigateway.RestApi` will NOT reveal this - see "Auditing".

## The stacks

Listed in deployment order. Order is derived by CDK from construct references, not hand-maintained;
what follows explains WHY each dependency exists.

| # | Stack | Owns | Depends on |
|---|---|---|---|
| 1 | `ChimeMessaging` | The Amazon Chime SDK app instance, channel flow, messaging streaming config | - |
| 2 | `CognitoAuth` | Identity ONLY: user pool, identity pool, per-classification Identity-Pool roles, credential exchange, user management (Cognito-coupled by nature), the feedback TABLE | ChimeMessaging (app instance ARN) |
| 3 | `S3Storage` | Attachments bucket + presigned-URL API | ChimeMessaging, CognitoAuth |
| 4 | `Foundations` | Shared always-on plane: task tables, per-user profile, channel context, abuse controls, create-conversation / add-agent, **user feedback API** | ChimeMessaging, CognitoAuth (pool for authorizer, feedback table by reference) |
| 5 | `Experiments` | Experiments table + admin experiments API (**also hosts `/admin/profiles`** - see Known problems) | CognitoAuth |
| 6 | `Analytics` (Athena mode) *or* `AnalyticsAurora` | Analytics/eval store + admin analytics API; Aurora mode adds the VPC, pgvector, the retrieval + drift **data-plane Lambda**, and the summary updater | CognitoAuth, Foundations |
| 7 | `Battle` | `/battle` alt-slot Lex + battle state tables + battle APIs | ChimeMessaging, CognitoAuth (API authorizer), Experiments (resolves the experiments SSM at deploy) |
| 7b | `ChannelFlow` | The Amazon Chime SDK **channel flow** processor: intercepts messages in-flight for `@all` fan-out and `/battle` dispatch. Resolves the per-classification processors from the SSM contract at deploy rather than by stack import, so it does not hard-depend on the classification stacks | ChimeMessaging; optionally Battle (its tables are undefined when `/battle` is off) and Experiments |
| 7c | `ImageGuardrail-{region}` | Conditional, one per region hosting an active image model outside the deploy region: the regional image-generation content guardrail (Bedrock guardrails are regional, so a cross-region image invoke needs a guardrail in the model's region) | - (the classification stacks reference its outputs cross-region) |
| 8 | `Classification-{Basic,Standard,Premium}` | One per classification: Lex bot, AppInstanceBot, router handler, async processor, per-classification IAM | Most of the above |
| 8b | `PostProcessing` | Unconditional, one consumer on the message stream: acts on messages delivery did not route (post-delivery correction, off the synchronous channel-flow path) | The analytics stack (its Kinesis stream), Foundations (SSM contract), the classification stacks (router ARNs via SSM) |
| 9 | `AdminPlane` | Admin conversation read API | CognitoAuth, analytics |
| 10 | `Notifications`, `AdminNotification` | Outbound email / admin alerting | CognitoAuth |
| 11 | `Frontend`, `AdminFrontend` | The two CloudFront distributions + their S3 origins | - (consume outputs at build time) |

### Analytics mode is a choice, not two products

`-c analyticsMode=athena` (default) or `aurora`. **Athena/S3 is the system of record in both modes** -
the same append-only conversation archive is written either way. Aurora adds a fast, queryable
projection plus the capabilities that need pgvector (drift, RAG, evaluation). Aurora is a strict
superset for QUERY, never for durability. See `guides/admin/AURORA-MODE-GUIDE.md`.

Aurora mode introduces a VPC with **isolated subnets and no NAT**. Anything VPC-attached therefore has
no egress except through VPC endpoints (S3, Kinesis, bedrock-runtime, Secrets Manager, DynamoDB).
This is why the reply handler stays OUT of the VPC and calls the data-plane Lambda instead of talking
to Aurora directly (ADR-013). **New Aurora-side work on the request path belongs as a new `op` on that
data-plane dispatch, not as a new VPC endpoint.**

## Deploy

```bash
npm run deploy          # from backend/ - the supported path
```

It does five things in order, and each exists because skipping it caused a real failure:

1. **`npm run build`** - the Lambda bundler resolves `.js` on disk, so without a fresh compile a clean
   exit-0 deploy can ship stale code.
2. **Safety gate** - refuses to `--all` deploy if any stack falls outside the instance prefix.
3. **Backend stacks** with `appUrl` pre-resolved, so the CORS allowlist is never transiently wrong.
4. **Context sync + `gen-frontend-env`** - merges outputs from ALL `<prefix>*` stacks by output key
   into `packages/{chat,admin}/.env`. This is why moving an API between stacks needs no frontend edit:
   the key is found wherever it now lives.
5. **Publish the chat SPA, then the admin console** (the latter only when `enableAdminApp` is set).

> **Do not hand-roll `cdk deploy <Stack>`.** A bare single-stack deploy forwards none of the persisted
> context, so every `-c`-gated flag silently reverts to its default and `appUrl` falls back to
> localhost, breaking CORS for the live origin. If you must target stacks, pass every key from
> `deploy.config.json` plus a real `appUrl`, and `--exclusively`.

Per-instance context lives in `backend/deploy.config.json` (gitignored; see
`deploy.config.example.json`), forwarded as `--context key=value`.

### Options that change what gets deployed

| Context flag | Effect |
|---|---|
| `analyticsMode=athena\|aurora` | Which analytics stack, and whether pgvector capabilities exist |
| `enableAdminApp=true` | Provisions the admin console stack AND publishes it on deploy |
| `enableLiveDrift=true` | Opt-in live drift suggestions (Aurora only) |
| `enableRdsProxy=true` | RDS Proxy for Aurora. Off by default - it carries a standing monthly floor |
| `identityProvider=<name>` | Descriptive. Non-`cognito` values make the console point at your IdP for user administration |
| `analyticsVpcId` | Reuse an existing VPC instead of creating one |
| `adminIamEnforcement` (default on) | Admin read APIs require SigV4; the console signs its requests to match |

## Auditing stack placement

A misplaced resource is easy to miss because the obvious check is incomplete. `new apigateway.RestApi`
finds APIs by constructor but does NOT find a route mounted on another stack's API - which is exactly
how the two known problems below hid. A sufficient audit needs all of:

```bash
grep -rn "new apigateway.RestApi" backend/lib/stacks/     # APIs by constructor
grep -rn "addResource(" backend/lib/stacks/               # routes, incl. ones on another stack's API
grep -rn "apigatewayv2\|HttpApi\|WebSocketApi" backend/lib/stacks/
grep -rn "addFunctionUrl" backend/lib/stacks/             # Lambda URLs bypass API Gateway entirely
grep -rn "NodejsFunction" backend/lib/stacks/             # scheduled/event Lambdas own no route at all
```

The last one matters: a resource can be misplaced without being an API. Verify a move against the
SYNTHESIZED template, not the source - `grep -c <Resource> cdk.out/<Stack>.template.json` in both the
old and new stack proves it actually moved.

## Known problems (as-built)

| Problem | Detail |
|---|---|
| `/events` on the analytics API | Chat-client telemetry mounted on the ADMIN analytics API, so the public chat client must reach an admin-plane API. Cuts against the separate-admin-app boundary |
| `/admin/profiles` on the experiments API | Profile management is assistant configuration, not experimentation. They share a throttle and deploy unit |
| `admin-conversation-sync` in `CognitoAuth` | A scheduled Lambda with no identity relationship, in the identity stack |
| `user-management` is Cognito-coupled | Calls Cognito User Pool admin APIs directly, so it is the bundled-provider reference implementation rather than an abstraction. See `guides/user/IDENTITY-PROVIDER-GUIDE.md` Step 9 |

## Teardown

Data stacks use `RETAIN` on production and `DESTROY` elsewhere, so a non-production teardown removes
tables and buckets. Two things survive a naive destroy and block the next deploy: the fixed-name
messaging Kinesis stream (Amazon Chime SDK requires a `chime-messaging-` prefix, so it cannot be
auto-named) and anything with a fixed physical name. Both are handled by the removal policies in the
stacks; a manual teardown must purge them or the next `ResourceExistenceCheck` fails.
