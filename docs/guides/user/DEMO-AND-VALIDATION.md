# Demo setup and post-deploy validation

A runbook for standing up the **Stratum Technologies** demo and running the end-to-end validation that exercises every tier flow with real (measured, recorded) conversations, then verifies the admin dashboard. This is the POC surface: read it to understand how the platform behaves, and modify the demo data / tests for your own use case. For the demo company design, see [`SPEC-DEMO-COMPANY.md`](../../specs/demos/SPEC-DEMO-COMPANY.md).

> **Cost.** The validation drives REAL conversations, so it is not free: every tier flow and the `/battle` run is a billed **Amazon Bedrock** model invocation (per token), and the battle image-generation test calls a **paid external image-gen provider** (OpenAI / FAL) when configured. A full run is on the order of a few dollars of inference. Run it to validate a deployment and to seed realistic data; do not leave it looping.

## What gets validated

Real user-to-assistant messages only - nothing is faked. Each turn is measured (TTFF, total latency, tokens, cost) and recorded to the archive/analytics, so the admin dashboard verification runs against genuine data. `npm run validate` runs ALL of the phases below in order (the admin phase runs after every data-producing phase on purpose). Several are optional: an optional phase that fails is named in the PHASE SUMMARY and the run continues. Under `npm run validate` a spec that states a skip fails its phase, because the script sets `E2E_REQUIRE_ALL=1` by default (`E2E_ALLOW_SKIPS=1` opts out, for a deployment that genuinely lacks an optional dependency).

1. **Per-tier flows** - Basic / Standard / Premium each answer real questions; tiered context and the `load_company_context` IAM boundary behave per tier. Note these are general-heavy by design (factual and "explain X" questions, which classify as `general`).
2. **Identity** - the credential exchange vends the caller's own chat and admin-plane identities.
3. **Mentions and drift** - targeting/sticky behavior and drift detection.
4. **Data-producing phases (what fills the admin console with variety)** - these drive the DOMAIN intents and multi-step work the general questions above do NOT, so the admin console shows real breadth instead of an all-`general` bar:
   - **tasks** - a report request opens a tracked task in each classification that offers a report (standard and premium, `TIER_CASES` in `tests/e2e/tasks.spec.ts`), and premium drives a report and a data extraction to downloaded deliverables whose content is validated, the report against the template its delivery record names (the task drill of **Performance > Overview**, Aurora mode).
   - **experiments** - creates an A/B experiment and runs a turn (Experiments tab / `experiment_results`).
   - **feedback** - a thumbs rating persists (feedback data).
   - **welcome** - a new conversation opens with the seeded tier-aware orientation.
   - **image-gen** - real external image providers return persistable PNGs (needs keys).
   - **evaluate** - scores the exchanges/flows just produced so Effectiveness verifies against real relevance/completion (Aurora only).
5. **`/battle`** - a real head-to-head battle (needs a battle-enabled deploy).
5b. **`ops-role`** - runs after the admin phase, among the behavioral suites (step 6), with `ops-rollout` just before it. Two assistants in ONE classification, one of which reaches this deployment's own Amazon CloudWatch metrics while the other is refused them. Needs the Ops assistant declared: `ops-premium` in `profiles` in `backend/deploy.config.json` (`npm run add-assistant-role` adds it and deploys `Assistants-premium`, whose seed asks the provisioner for `ops-premium` once, ADR-048 amended 2026-10-23). An Ops assistant retired in the console stays retired: a deploy does not recreate it and says so, and the specs skip as if it were not declared. To have it again, `npm run add-assistant-role -- --remove` withdraws the role, which removes the retired assistant, and `npm run add-assistant-role` seeds a fresh one. Without it the specs skip by name, which under `npm run validate` fails this optional phase and names it in the PHASE SUMMARY (`E2E_ALLOW_SKIPS=1` lets the skip pass).

   It asserts the governance claim rather than the feature: the decisions come from simulating the DEPLOYED assistant roles, so the demo shows that the premium PRIMARY *could not* have answered the telemetry question, which watching the ops assistant answer it does not establish. It also checks the two failure modes that look like success - a condition key that matches nothing denies everyone including ops, and a missing condition grants the reach to every assistant in the classification - which is why the allowed direction is asserted beside the denied ones.

   **OPEN**: the specs simulate the classification's acting role (`assistantActingRole`), and no recorded run of this phase has been made against a deployment that carries that role, so the phase is not evidence for the acting role until such a run exists.

   To see it conversationally as well: add the `Ops` assistant to a premium conversation and ask "what is the platform error rate in the last hour?". It answers from live metrics, and its opening line, its model and its tools come from its own profile version, editable in the console with no deploy.
6. **Admin dashboard** - runs AFTER steps 1 to 5, so every tab is verified against the real data produced above. Further behavioral suites (auth, governance, latency, and more) follow it.

> **All-`general` intents.** If you run the Playwright suite directly (or only the per-tier flows), you exercise the general-heavy conversations and NONE of the data-producing phases, so the admin intent breakdown is all `general` - an accurate reflection of that traffic, not a broken classifier. Run the full `npm run validate` to get domain intents (`report_generation`, `data_extraction`, `guided_troubleshooting`) and multi-step task data across every tier.

### Rich-data prerequisites

The data-producing phases reach the LIVE app the same way the frontend does, via URLs emitted as CDK outputs. `validate.mjs` auto-resolves them and prints a **DATA READINESS** block at the start plus a **PHASE SUMMARY** at the end. A phase whose dependency is `MISS` produces none of its data, so that admin tab stays empty, and under `npm run validate` its specs' stated skips fail the phase. To get a full console:

- Generate the per-package env files `frontend/packages/chat/.env` and `frontend/packages/admin/.env` from CDK outputs (`gen-frontend-env`) so `VITE_PERSON_API_URL` and, for the admin console, `VITE_ADMIN_API_URL` resolve (tasks, experiments and feedback are routes on those two APIs). There is no root `frontend/.env`.
- Deploy the **admin** frontend so `E2E_ADMIN_BASE_URL` resolves (battle, experiments, admin arm on that origin).
- **Aurora mode** for the evaluate phase and the task reads (`EVAL_LAMBDA_NAME`, analytics API).
- A **battle-enabled** deploy for the `battle` and `experiment-battles` phases (else pass `--skip-battle`, which drops those two). The `image-gen` phase needs the external providers' keys, not battle.
- A **test inbox** for the `notifications` and `demo-cast-mail` phases to read delivered email (README, "Test inbox"). Either declare an inbox you already receive into in `deploy.config.json` (`testInboxDomain`, `testInboxBucket`, `testInboxPrefix`; `TEST_EMAIL_DOMAIN`, `TEST_INBOX_BUCKET` and `TEST_INBOX_PREFIX` override it for one run) or deploy the opt-in `TestInbox` stack (`testInboxDomain` alone), then re-run `provision-test-users`, which puts the test users on the inbox's domain, and `provision-test-users -- --cast ops-demo`, which does the same for the demo cast. Without one DATA READINESS shows the inbox as `MISS`, and the delivery tests state their skip, which under `npm run validate` fails those optional phases.

Read the DATA READINESS lines before assuming a full run - `MISS` there tells you exactly which admin data will be absent and why.

`validate.mjs` resolves every stack it reads from this deployment's CloudFormation stack-name prefix, and prints that prefix on its first line. The prefix is the PascalCase form of the instance name (`agent-echelon` gives `AgentEchelon`, `acme` gives `Acme`), and it follows the same overrides the rest of the tooling takes: `AE_STACK_PREFIX`, `STACK_PREFIX`, `AE_INSTANCE_NAME`. Set one of those if your stacks are named differently, or the frontend lookup fails the run rather than guessing.

A lookup that FAILS is reported differently from a stack that is absent. An expired SSO session, absent credentials, a denied call and a throttle all make `describe-stacks` exit non-zero, and none of them says anything about the deployment: those read as `the lookup itself failed`, and the fix is `aws sso login --profile <your-profile>`, not a redeploy.

## Prerequisites

- A deployed stack (`npm run deploy` in `backend/`) and valid AWS creds (`aws sso login --profile <your-profile>`).
- The e2e test users, provisioned into the `agent-interface/test-credentials` secret (`npm run provision-test-users`). The e2e reads them via `tests/e2e/helpers/test-credentials.ts`. Each run generates a fresh random password and writes it to that secret BEFORE rotating any user to it, so an interrupted run leaves nothing holding a credential nobody recorded: fix the cause and re-run the same command.
- The standard-tier persona is seeded for you by `seed-demo.ts` (below), so the assistant speaks as Stratum out of the box - no deploy flag required. To use your own, edit the persona on the standard assistant's (`analyst`) profile version in the console (**Assistants**) and activate it. A `-c assistantSystemPrompt=...` at deploy does not replace it: the seed writes the Stratum persona onto the assistant's active profile version, which the processor prefers over that parameter.

## Steps

```bash
# Setup AND validation are one command. Its first four phases are the setup -
# self-knowledge, the platform-docs ingestion, the CloudTrail audit-trail check,
# then the demo seed - so a fresh deployment needs nothing run by hand beforehand.
cd backend
AWS_PROFILE=<your-profile> npm run validate
#    --skip-battle       skip the battle and experiment-battles phases (if not battle-enabled)
#    --only=seed         run one phase (e.g. seed, tasks, evaluate, admin). An
#                        invalid --only value makes the script print the full
#                        valid id set; the PHASES list in validate.mjs is the
#                        authority.

# Optional: point at a blog vault so the self-knowledge includes public posts. Read
# by the `knowledge` and `knowledge-rag` phases, so set it on the same command.
AE_BLOG_VAULT_PATH="/path/to/your/blog-vault" AWS_PROFILE=<your-profile> npm run validate
```

> **The platform self-knowledge has two halves, and the run does both.** The CURATED half - a title plus a ~400-character summary per doc, read through the `load_platform_info` tool - is generated by the `knowledge` phase and uploaded by `seed-demo`. The RAG half - the full text of every doc, chunked and embedded into pgvector - is the `knowledge-rag` phase, and it is what answers "how does X work?" from the documentation instead of from summaries.
>
> `knowledge-rag` is **Aurora-only** and drops out of the phase list when no Aurora stack resolves (Athena mode has no vector store, and the curated half is the whole story there). It is also **optional**, so a transient failure warns and is named in the PHASE SUMMARY rather than stopping the run before `seed` - which would leave a deployment with no users and no context.
>
> Re-run it whenever the docs change (`npm run sync-knowledge:rag`, or `--only=knowledge-rag`). Skipping it is silent by nature: the assistant still answers platform questions, just from summaries, so the symptom is a thin answer rather than an error.

`npm run validate` is the orchestrator (`backend/scripts/validate.mjs`). It runs every phase in order - the setup phases (`knowledge -> knowledge-rag -> audit-trail -> seed`) first, then the user flows and data-producing phases, then the admin dashboard phase after them (on purpose, so the dashboard has the real data to verify), then further behavioral suites (auth, governance, latency, and more) - and fails loudly on the first REQUIRED-phase failure. The `PHASES` list in `validate.mjs` is the authority on the current phase ids and their order. The data-producing phases (battle, image-gen, feedback, experiments, tasks, welcome, evaluate) are optional: a failure, including a stated skip under `E2E_REQUIRE_ALL=1`, is named in the PHASE SUMMARY and the run continues. With `E2E_ALLOW_SKIPS=1` a phase can report `passed` over skipped specs, so watch the **DATA READINESS** preflight and the end-of-run **PHASE SUMMARY** to confirm the rich data actually landed.

**Confirm the admin console is populated.** After a full run, open the admin dashboard: the intent breakdown (**Operations > Overview**, **Models > Models**) should show `report_generation`, `data_extraction`, and `guided_troubleshooting` alongside `general`; the task drill of **Performance > Overview** should list the report and extraction runs; Experiments should show the A/B run. If any is empty, re-check the DATA READINESS block for a `MISS`.

## Ops event trigger

The new-assistant demo's Act 3.2 opens an `ops` conversation because something happened, and the trigger is a real event on the bus. The `ops` conversation type declares that the platform's ops event opens it (`openedBy` in `backend/lib/config/conversation-types.ts`; the declaration shape is `backend/lib/config/event-openers.ts`): source `ae.ops`, detail type `Incident opened`, on the default event bus, for this deployment's instance. The premium classification stack builds the EventBridge rule that hands the event to its typed-conversation creator, with a dead-letter queue and an alarm on it.

**Before it can open anything:** the Ops assistant is deployed (`ops-premium` in `profiles`, `npm run add-assistant-role`), the person the room is for is premium-cleared and in the `ops` group, and the operations team's standing room (`ops-team`) exists, because an `ops` room concerns another conversation. The standing room is opened once by a direct invoke of the creator (`TypedConversationFromEventFunctionName` in the `Assistants-premium` stack outputs) with `{"detail":{"conversationType":"ops-team","forUserArn":"<person ARN>","topicLabel":"Platform on-call"}}`; keep the channel ARN it returns. Its people are welcomed and emailed the same way the event's room's are.

**Fire it:**

```bash
cd backend
AWS_PROFILE=<your-profile> npm run send-ops-event -- --concerns <the standing room's channel ARN> --dry-run   # prints the entry, sends nothing
AWS_PROFILE=<your-profile> npm run send-ops-event -- --concerns <the standing room's channel ARN> \
  --title "Report latency" --summary "Report generation is running slow."
```

`--for` names the person by email address or AppInstanceUser ARN; without it the script reads the demo cast's on-call lead from the demo secret. The event carries the person, the label, the summary and the concerned room, and no classification or type: the rule names the type, and the creator creates at the classification it was deployed with.

**What happens:** within seconds an `ops` room named for the label opens, with the person as its moderator, the `ops` group's members, and both assistants the type names, Advisor and Ops, each welcoming the room in its own voice. Nothing is posted in the standing room. The person and each group member are welcomed into the new room privately by Advisor, and each welcome is emailed: the subject is the room's label, the body links into the new room, and the sender is the room's assistant. The demo cast's mail lands in the test inbox (an SES receipt rule into S3), not in a personal mailbox, so read it there or let the `demo-cast-mail` phase read it.

**If nothing opens:** the creator's log names a refusal (the person is not in `ops`, the Ops assistant is not deployed, the concerned room is at another classification, or the address finds nobody in the pool). An event that never reached the creator, or a creation that failed outright, is kept in the rule's dead-letter queue, and its alarm says so.

**Validated by:** the `demo-cast-mail` phase (`npm run validate -- --only=demo-cast-mail`), which puts the same event for the demo cast's on-call lead (in `ops` for the run only) and asserts the email the lead receives in the test inbox: the recipient, the subject, the link into the new room, and the room's assistant as sender and signature.

## Modifying it for your own use (POC)

- **Company/context:** replace the JSON under `backend/demo/context/{basic,standard,premium}/` with your own tiered data. A classification reads the folder of every classification its declared grants include (the classifications `grantsFor` returns), enforced by per-classification S3-prefix IAM (`contextPrefixesGranted` in `backend/lib/profile-registry.ts`). In the shipped sample config every classification's grants include `basic`, so content meant for all three goes in `basic/`.
- **Welcome orientation (what a first-time user sees):** the assistant opens each new conversation with a config-driven orientation - the company, the signed-in user's access level, a few grounded example prompts, and a pointer to learn about the platform. It is not hardcoded: `seed-demo.ts` (`writeWelcomeOrientation`) writes a per-tier JSON to the SSM param `${SSM_ROOT}/assistant/{tier}/welcome-orientation`, and the router reads it on the WelcomeIntent path (`backend/lambda/src/lib/welcome-orientation.ts`). Edit the `WELCOME_ORIENTATION` map in `seed-demo.ts` (or write the param directly) to change it. The schema is `{ companyName, companyBlurb, accessBlurb, examples[], platformNote }`; absent the param, the assistant falls back to a generic welcome. This is the smallest end-to-end customization example - one config value, no code change.
- **Standard-tier persona (how the assistant answers):** `standard` is the one tier whose persona is per-deployment (basic and premium ship a built-in one). `seed-demo.ts` (`writeStandardAssistantConfig`) writes a Stratum-grounded persona + the intent pack to `${SSM_ROOT}/assistant/standard/assistant-system-prompt` and `.../assistant-intent-pack`, so standard answers as Stratum's internal assistant and grounds in the seeded company context (names people from the directory, gives detailed answers). The parameter write is **write-if-absent**, so a `-c assistantSystemPrompt=...` parameter is left as it is, but the seed also writes `STANDARD_PERSONA` onto the `analyst` profile's active version (`seedAllProfileDefinitions`), and the processor prefers the version's persona over the parameter. To serve your own persona, edit it on that profile version in **Assistants** and activate it. Edit the `STANDARD_PERSONA` constant in `backend/demo/personas.ts` (imported by `seed-demo.ts`) to change it. Absent both, the assistant falls back to a generic persona (off-brand, terse on Sonnet) - which the deploy warns about at synth.
- **Task examples and deliverables:** the demo showcases the platform task types. `report_generation` and `data_extraction` hand back a real downloadable document (a Markdown report or a data table). Both first state what they are taking from the request and ask you to confirm it, and an extraction shows its records for checking before it formats them; the file is the document the model declares when the workflow reaches its delivering step (`produces: 'document'` in `backend/lambda/src/lib/task-state-machines.ts`), and the reply beside it is chat. A report follows a document template: standard's in the platform's `report` template (a title, a summary, the findings, optional recommendations and the sources), and premium's in the one the person chooses, a quarterly account review (the default) or a one-page executive summary, which the requirements step offers ([SPEC-DOCUMENT-TEMPLATES](../../specs/interaction/conversation/SPEC-DOCUMENT-TEMPLATES.md)). Ground the examples in your own data by editing the seeded `context/` files and the `examples` in the welcome orientation. To add a task type, add an intent to the pack (`backend/lambda/src/lib/intent-pack.ts`, or per-deployment via `ASSISTANT_INTENT_PACK`) and its state machine (`backend/lambda/src/lib/task-state-machines.ts`). To add or change classifications, see [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).
- **Assistant knowledge of the platform:** `npm run sync-knowledge` indexes `README.md` + `docs/*.md` (and public blog posts if `AE_BLOG_VAULT_PATH` is set) and writes two files: `backend/demo/platform-knowledge/standard/agentechelon-about.json` (the full index) and `backend/demo/platform-knowledge/basic/agentechelon-about.json` (a public overview only: project, license, author, repository, purpose and overview, with no document index). This is **platform self-knowledge**, kept OUTSIDE the company `context/` tree and uploaded by `seed-demo` to `platform-knowledge/{classification}/` - so it is retrieved only by the separate `load_platform_info` tool when a user asks about AgentEchelon itself, and never bundled into a company-context load (which would otherwise crowd out the tiered business data). A classification reads the `platform-knowledge/` folder of each classification its grants include, enforced by IAM on the acting role and on the vended session: basic reads the public overview, and standard and premium also read the full index (curated; works in both modes). The platform's documentation is internal material, so the external classification learns what the platform does and nothing of how it is built. On **Aurora**, add deep semantic Q&A over the full corpus by ingesting it into pgvector:
  ```bash
  AWS_PROFILE=<your-profile> npm run sync-knowledge -- --rag
  ```
  This uploads the full docs + public blog to `rag/agentechelon/standard/`; the DocumentIngestion Lambda chunks + embeds + stores them tagged `standard`, so only a classification whose grants include `standard` retrieves them (see [`RAG.md`](../developer/RAG.md)). It then deletes every key under the retired `rag/agentechelon/basic/` prefix, and each delete removes that object's chunks. Idempotent - safe to re-run after editing docs.
- **Tests:** the per-tier conversations live in `tests/e2e/agent-intents.spec.ts`; the task deliverables (a report and a data extraction are driven to a downloaded file and their CONTENT is validated) in `tests/e2e/tasks.spec.ts`; the welcome orientation in `tests/e2e/welcome.spec.ts`; the dashboard checks in `tests/e2e/admin-dashboard.spec.ts`; the battle in `tests/e2e/battle.spec.ts`. Edit the questions/assertions to match your context. `npm run validate` runs them as gated phases.

## Related

- [`SPEC-DEMO-COMPANY.md`](../../specs/demos/SPEC-DEMO-COMPANY.md) - the demo company design and tiered context.
- [`ADMIN-GUIDE.md`](../admin/ADMIN-GUIDE.md) - the dashboard the admin phase verifies.
- [`GUIDE-AB-TESTING-AND-BATTLES.md`](../admin/GUIDE-AB-TESTING-AND-BATTLES.md) - the `/battle` feature.
