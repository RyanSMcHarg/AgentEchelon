# Demo setup and post-deploy validation

A runbook for standing up the **Stratum Technologies** demo and running the end-to-end validation that exercises every tier flow with real (measured, recorded) conversations, then verifies the admin dashboard. This is the POC surface: read it to understand how the platform behaves, and modify the demo data / tests for your own use case. For the demo company design, see [`SPEC-DEMO-COMPANY.md`](../../specs/applications/SPEC-DEMO-COMPANY.md).

> **⚠️ Running this costs money.** The validation drives REAL conversations, so it is not free: every
> tier flow and the `/battle` duel is a billed **Amazon Bedrock** model invocation (per token), and the
> battle image-generation test calls a **paid external image-gen provider** (OpenAI / FAL) when
> configured. A full run is on the order of a few dollars of inference. Run it to validate a deployment
> and to seed realistic data; do not leave it looping.

## What gets validated

Real user-to-assistant messages only - nothing is faked. Each turn is measured (TTFF, total latency, tokens, cost) and recorded to the archive/analytics, so the admin dashboard verification runs against genuine data. `npm run validate` runs ALL of the phases below in order (the admin phase is last on purpose); several are optional and self-skip when their deployed dependency is absent.

1. **Per-tier flows** - Basic / Standard / Premium each answer real questions; tiered context and the `load_company_context` IAM boundary behave per tier. Note these are general-heavy by design (factual and "explain X" questions, which classify as `general`).
2. **Identity** - the credential exchange vends the caller's own chat and admin-plane identities.
3. **Mentions and drift** - targeting/sticky behavior and drift detection.
4. **Data-producing phases (what fills the admin console with variety)** - these drive the DOMAIN intents and multi-step work the general questions above do NOT, so the admin console shows real breadth instead of an all-`general` bar:
   - **tasks** - report generation, data extraction, and troubleshooting driven across ALL THREE tiers to real task rows + downloaded deliverables (Tasks / Flows tabs).
   - **experiments** - creates an A/B experiment and runs a turn (Experiments tab / `experiment_results`).
   - **feedback** - a thumbs rating persists (feedback data).
   - **welcome** - a new conversation opens with the seeded tier-aware orientation.
   - **image-gen** - real external image providers return persistable PNGs (needs keys).
   - **evaluate** - scores the exchanges/flows just produced so Effectiveness verifies against real relevance/completion (Aurora only).
5. **`/battle`** - a real head-to-head duel (needs a battle-enabled deploy).
6. **Admin dashboard** - runs LAST, so every tab is verified against the real data produced above.

> **Why an earlier run may have looked all-`general`.** If you run the Playwright suite directly (or only the per-tier flows), you exercise the general-heavy conversations and NONE of the data-producing phases, so the admin intent breakdown is all `general` - an accurate reflection of that traffic, not a broken classifier. Run the full `npm run validate` to get domain intents (`report_generation`, `data_extraction`, `guided_troubleshooting`) and multi-step task data across every tier.

### Prerequisites for the rich data (so nothing self-skips)

The data-producing phases reach the LIVE app the same way the frontend does, via URLs emitted as CDK outputs. `validate.mjs` auto-resolves them and prints a **DATA READINESS** block at the start plus a **PHASE SUMMARY** at the end; a phase whose dependency is `MISS` self-skips (exits 0) and leaves that admin tab empty. To get a full console:

- Generate `frontend/.env` from CDK outputs (`gen-frontend-env`) so `VITE_ANALYTICS_API_URL` / `VITE_EXPERIMENTS_API_URL` / `VITE_USER_FEEDBACK_API_URL` resolve (tasks / experiments / feedback).
- Deploy the **admin** frontend so `E2E_ADMIN_BASE_URL` resolves (battle, experiments, admin arm on that origin).
- **Aurora mode** for the evaluate phase and the Tasks/Flows reads (`EVAL_LAMBDA_NAME`, analytics API).
- A **battle-enabled** deploy for the battle and image-gen phases (else pass `--skip-battle`).

Read the DATA READINESS lines before assuming a full run - `MISS` there tells you exactly which admin data will be absent and why.

## Prerequisites

- A deployed stack (`npm run deploy` in `backend/`) and valid AWS creds (`aws sso login --profile <your-profile>`).
- The e2e test users, provisioned into the `agent-interface/test-credentials` secret (`npm run provision-test-users`). The e2e reads them via `tests/e2e/helpers/test-credentials.ts`.
- The standard-tier persona is seeded for you by `seed-demo.ts` (below), so the assistant speaks as Stratum out of the box - no deploy flag required. To use your own instead, pass `-c assistantSystemPrompt=...` at deploy (the seed leaves an operator-provided persona untouched).

## Steps

```bash
# 1. (optional) regenerate the project self-knowledge context from the repo docs
#    (+ public blog if you point at the vault). seed-demo uploads it for you, so this
#    is only needed if you changed the docs.
cd backend
AE_BLOG_VAULT_PATH="/path/to/your/blog-vault" npm run sync-knowledge   # blog path optional

# 2. seed the demo: 3 tier users + per-tier context (incl. the all-tier project knowledge)
AWS_PROFILE=<your-profile> npx ts-node scripts/seed-demo.ts

# 3. run the FULL post-deploy validation (all phases, incl. the data-producing ones)
AWS_PROFILE=<your-profile> npm run validate
#    --skip-battle       skip the /battle phase (if not battle-enabled)
#    --only=tasks        run one phase. Valid ids:
#                        knowledge seed user battle image-gen feedback experiments tasks welcome evaluate admin
```

`npm run validate` is the orchestrator (`backend/scripts/validate.mjs`). It runs every phase in order (`knowledge -> seed -> user -> battle -> image-gen -> feedback -> experiments -> tasks -> welcome -> evaluate -> admin`) and fails loudly on the first REQUIRED-phase failure; the admin phase is last on purpose so the dashboard has the real data to verify. The data-producing phases (battle, image-gen, feedback, experiments, tasks, welcome, evaluate) are optional: each self-skips (or continues-with-a-warning) when its deployed dependency is absent. Watch the **DATA READINESS** preflight and the end-of-run **PHASE SUMMARY** to confirm the rich data actually landed - a phase can report `passed` yet have self-skipped.

**Confirm the admin console is populated.** After a full run, open the admin dashboard: the intent breakdown (Overview / Models) should show `report_generation`, `data_extraction`, and `guided_troubleshooting` alongside `general`; Tasks / Flows should list the report and extraction runs; Experiments should show the A/B run. If any is empty, re-check the DATA READINESS block for a `MISS`.

## Modifying it for your own use (POC)

- **Company/context:** replace the JSON under `backend/demo/context/{basic,standard,premium}/` with your own tiered data. Files in a tier's folder plus every lower tier are readable by that tier (enforced by per-tier S3-prefix IAM); put all-tier content in `basic/`.
- **Welcome orientation (what a first-time user sees):** the assistant opens each new conversation with a config-driven orientation - the company, the signed-in user's access level, a few grounded example prompts, and a pointer to learn about the platform. It is not hardcoded: `seed-demo.ts` (`writeWelcomeOrientation`) writes a per-tier JSON to the SSM param `${SSM_ROOT}/assistant/{tier}/welcome-orientation`, and the router reads it on the WelcomeIntent path (`backend/lambda/src/lib/welcome-orientation.ts`). Edit the `WELCOME_ORIENTATION` map in `seed-demo.ts` (or write the param directly) to change it. The schema is `{ companyName, companyBlurb, accessBlurb, examples[], platformNote }`; absent the param, the assistant falls back to a generic welcome. This is the smallest end-to-end customization example - one config value, no code change.
- **Standard-tier persona (how the assistant answers):** `standard` is the one tier whose persona is per-deployment (basic and premium ship a built-in one). `seed-demo.ts` (`writeStandardAssistantConfig`) writes a Stratum-grounded persona + the intent pack to `${SSM_ROOT}/assistant/standard/assistant-system-prompt` and `.../assistant-intent-pack`, so standard answers as Stratum's internal assistant and grounds in the seeded company context (names people from the directory, gives detailed answers). It is **write-if-absent**: pass `-c assistantSystemPrompt=...` at deploy to use your own and the seed leaves it untouched. Edit the `STANDARD_PERSONA` constant in `seed-demo.ts` to change it. Absent both, the assistant falls back to a generic persona (off-brand, terse on Sonnet) - which the deploy warns about at synth.
- **Task examples and deliverables:** the demo showcases the platform task types. `report_generation` and `data_extraction` hand back a real downloadable document (a Markdown report or a data table); delivery is gated on the model actually producing a substantial, structured document (`isDeliverableDocument` in `backend/lambda/src/lib/async-processor-core.ts`), not a brittle state-machine step, so it is reliable. Ground the examples in your own data by editing the seeded `context/` files and the `examples` in the welcome orientation. To add a task type, add an intent to the pack (`backend/lambda/src/lib/intent-pack.ts`, or per-deployment via `ASSISTANT_INTENT_PACK`) and its state machine (`backend/lambda/src/lib/task-state-machines.ts`). To add or reorder tiers, see [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).
- **Assistant knowledge of the platform:** `npm run sync-knowledge` indexes `README.md` + `docs/*.md` (and public blog posts if `AE_BLOG_VAULT_PATH` is set) into `backend/demo/platform-knowledge/agentechelon-about.json`. This is **platform self-knowledge**, kept OUTSIDE the company `context/` tree and uploaded to the `platform-knowledge/` S3 prefix - so it is retrieved only by the separate `load_platform_info` tool when a user asks about AgentEchelon itself, and never bundled into a company-context load (which would otherwise crowd out the tiered business data). Any tier can read it (curated; works in both modes). On **Aurora**, add deep semantic Q&A over the full corpus by ingesting it into pgvector:
  ```bash
  AWS_PROFILE=<your-profile> npm run sync-knowledge -- --rag
  ```
 This uploads the full docs + public blog to `rag/agentechelon/basic/` (tier=basic = all tiers); the DocumentIngestion Lambda chunks + embeds + stores them (see [`RAG.md`](../developer/RAG.md)). Idempotent - safe to re-run after editing docs.
- **Tests:** the per-tier conversations live in `tests/e2e/agent-intents.spec.ts`; the task deliverables (a report and a data extraction are driven to a downloaded file and their CONTENT is validated) in `tests/e2e/tasks.spec.ts`; the welcome orientation in `tests/e2e/welcome.spec.ts`; the dashboard checks in `tests/e2e/admin-dashboard.spec.ts`; the duel in `tests/e2e/battle.spec.ts`. Edit the questions/assertions to match your context. `npm run validate` runs them as gated phases.

## Related

- [`SPEC-DEMO-COMPANY.md`](../../specs/applications/SPEC-DEMO-COMPANY.md) - the demo company design and tiered context.
- [`ADMIN-GUIDE.md`](../admin/ADMIN-GUIDE.md) - the dashboard the admin phase verifies.
- [`GUIDE-AB-TESTING-AND-BATTLES.md`](../admin/GUIDE-AB-TESTING-AND-BATTLES.md) - the `/battle` feature.
