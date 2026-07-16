# Demo setup and post-deploy validation

A runbook for standing up the **Stratum Technologies** demo and running the end-to-end validation
that exercises every tier flow with real (measured, recorded) conversations, then verifies the admin
dashboard. This is the POC surface: read it to understand how the platform behaves, and modify the
demo data / tests for your own use case. For the demo company design, see
[`SPEC-DEMO-COMPANY.md`](../../design/SPEC-DEMO-COMPANY.md).

## What gets validated

Real user-to-assistant messages only - nothing is faked. Each turn is measured (TTFF, total latency,
tokens, cost) and recorded to the archive/analytics, so the admin dashboard verification runs against
genuine data.

1. **Per-tier flows** - Basic / Standard / Premium each answer real questions; tiered context and the
   `load_company_context` IAM boundary behave per tier.
2. **Identity** - the credential exchange vends the caller's own chat and admin-plane identities.
3. **Mentions and drift** - targeting/sticky behavior and drift detection.
4. **`/battle`** - a real head-to-head duel (needs a battle-enabled deploy).
5. **Admin dashboard** - runs LAST, so every tab is verified against the real data produced above.

## Prerequisites

- A deployed stack (`npm run deploy` in `backend/`) and valid AWS creds
  (`aws sso login --profile <your-profile>`).
- The e2e test users, provisioned into the `agent-interface/test-credentials` secret
  (`npm run provision-test-users`). The e2e reads them via `tests/e2e/helpers/test-credentials.ts`.
- Optional demo persona at deploy: `-c assistantSystemPrompt=...` so the assistant speaks as Stratum.

## Steps

```bash
# 1. (optional) regenerate the project self-knowledge context from the repo docs
#    (+ public blog if you point at the vault). seed-demo uploads it for you, so this
#    is only needed if you changed the docs.
cd backend
AE_BLOG_VAULT_PATH="/path/to/mcharg-site/McHarg Site/Blog/Posts" npm run sync-knowledge   # blog path optional

# 2. seed the demo: 3 tier users + per-tier context (incl. the all-tier project knowledge)
AWS_PROFILE=<your-profile> npx ts-node scripts/seed-demo.ts

# 3. run the full post-deploy validation (seed -> user e2e -> battle -> admin e2e)
AWS_PROFILE=<your-profile> npm run validate
#    --skip-battle       skip the /battle phase (if not battle-enabled)
#    --only=admin        run one phase (knowledge | seed | user | battle | admin)
```

`npm run validate` is the orchestrator (`backend/scripts/validate.mjs`). It runs the phases in order
and fails loudly on the first failure; the admin phase is last on purpose so the dashboard has the
real conversation data to verify. The `/battle` phase is optional (skipped-with-a-warning if the
deploy is not battle-enabled).

## Modifying it for your own use (POC)

- **Company/context:** replace the JSON under `backend/demo/context/{basic,standard,premium}/` with
  your own tiered data. Files in a tier's folder plus every lower tier are readable by that tier
  (enforced by per-tier S3-prefix IAM); put all-tier content in `basic/`.
- **Assistant knowledge of the platform:** `npm run sync-knowledge` indexes `README.md` + `docs/*.md`
  (and public blog posts if `AE_BLOG_VAULT_PATH` is set) into `backend/demo/platform-knowledge/agentechelon-about.json`.
  This is **platform self-knowledge**, kept OUTSIDE the company `context/` tree and uploaded to the
  `platform-knowledge/` S3 prefix - so it is retrieved only by the separate `load_platform_info` tool
  when a user asks about AgentEchelon itself, and never bundled into a company-context load (which would
  otherwise crowd out the tiered business data). Any tier can read it (curated; works in both modes).
  On **Aurora**,
  add deep semantic Q&A over the full corpus by ingesting it into pgvector:
  ```bash
  AWS_PROFILE=<your-profile> npm run sync-knowledge -- --rag
  ```
  This uploads the full docs + public blog to `rag/agentechelon/basic/` (tier=basic = all tiers); the
  DocumentIngestion Lambda chunks + embeds + stores them (see [`RAG.md`](../developer/RAG.md)). Idempotent - safe
  to re-run after editing docs.
- **Tests:** the per-tier conversations live in `tests/e2e/agent-intents.spec.ts`; the dashboard
  checks in `tests/e2e/admin-dashboard.spec.ts`; the duel in `tests/e2e/battle.spec.ts`. Edit the
  questions/assertions to match your context.

## Related

- [`SPEC-DEMO-COMPANY.md`](../../design/SPEC-DEMO-COMPANY.md) - the demo company design and tiered context.
- [`ADMIN-GUIDE.md`](../admin/ADMIN-GUIDE.md) - the dashboard the admin phase verifies.
- [`GUIDE-AB-TESTING-AND-BATTLES.md`](../admin/GUIDE-AB-TESTING-AND-BATTLES.md) - the `/battle` feature.
