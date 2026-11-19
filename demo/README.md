# Demos

Each demo runs on your own deployment of AgentEchelon and lives in a folder of its own: what it shows, how to set it up, and a walkthrough to follow. Every demo uses the same fictional company, Stratum Technologies, whose data and assistants are in [`stratum-company/`](stratum-company/README.md).

| Demo | What it shows | Start here |
|---|---|---|
| [Portable assistants: review, approve, implement](portable-assistants/README.md) | Managing an existing assistant, adding a second assistant to a classification through review and a deploy, the two working in one conversation, and an AWS alarm opening an incident from the operations team's room | [`portable-assistants/`](portable-assistants/README.md) |
| [Measure, compare, promote](measure-and-promote/README.md) | How an assistant performs, a change tested on real traffic, the same change settled head to head, and the winner promoted | [`measure-and-promote/`](measure-and-promote/README.md) |

## Before any demo

1. Deploy the platform: `cd backend && npm run deploy` (see the repository [README](../README.md) for `deploy.config.json`).
2. Seed the company: `AWS_PROFILE=<your-profile> npm run validate -- --only=seed` from `backend/`. It writes each classification's assistant from [`stratum-company/`](stratum-company/README.md) and uploads the company's documents.
3. Follow the demo's own README for the rest.

The demos are configuration, never part of the product: the platform's code imports nothing from this folder (`backend/test/demo-config-boundary.test.ts`), so replacing a demo's files with your own company's is how you try the platform on your own data.
