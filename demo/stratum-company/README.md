# Stratum Technologies

A fictional enterprise SaaS company (workflow automation, about 280 people, based in Austin) that every demo runs on. Its full description, people and data are specified in [SPEC-DEMO-COMPANY](../../docs/specs/demos/SPEC-DEMO-COMPANY.md).

## What is here

| File | What it is |
|---|---|
| `personas.ts` | One persona per assistant, each scoped to the documents its classification reaches |
| `intent-packs.ts` | The kinds of request each assistant recognizes, and the workflow and model each one uses |
| `onboarding.ts` | How each assistant introduces itself |
| `boundaries.ts` | What each assistant does not reach, written rather than derived |
| `context/<classification>/` | The company's documents, one folder per classification: public company information for basic, the directory, roadmap and processes for standard, financials, accounts, board notes, competitive intelligence and team metrics for premium |
| `context-digest-manifest.json` | The curated source each classification's document digest is built from |
| `golden-set/` | Sample golden entries a deployment uploads to check a draft before it is activated |
| `templates/` | The report templates the premium assistant offers |
| `platform-knowledge/` | The platform's own description, which assistants read when asked about AgentEchelon: a public overview for basic and the full index for standard and premium |

## How it reaches a deployment

`npm run validate -- --only=seed` (from `backend/`) writes each classification's assistant from these files and uploads `context/` and `platform-knowledge/` to the deployment's company bucket, each under its classification's prefix, which IAM scopes per classification. `npm run sync-knowledge` regenerates `platform-knowledge/` from the repository's documentation.

## Using your own company

Replace these files with your own: your documents under `context/<classification>/`, your personas, and the kinds of request your assistants should recognize. Nothing outside `demo/` changes.
