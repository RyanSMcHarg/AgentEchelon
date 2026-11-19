# Measure, compare, promote

How Advisor performs and where each number comes from, a change to it tested on real traffic, the same change settled head to head in a battle, and the winner promoted into Advisor's version. It runs on the same company as every demo and needs no files of its own: the change it tests is made in the admin console during the walkthrough.

The walkthrough is [WALKTHROUGH.md](WALKTHROUGH.md).

## Setup

From `backend/`, with `AWS_PROFILE=<your-profile>` on each command:

1. Deploy with `experiments` and `battle` in `capabilities` in `deploy.config.json`, then `npm run deploy`.
2. Seed the company: `npm run validate -- --only=seed`.
3. Give the console data to read: `npm run validate -- --only=experiments`, `npm run validate -- --only=experiment-battles` and `npm run validate -- --only=battle`.
4. Wait for archival. Experiment results and battle picks reach the console once each turn is archived and the analytics rollup has run.
5. Create the experiment the walkthrough measures a day ahead, so both sides have traffic: send 10 to 20 premium questions across a few conversations.

## Reset

An experiment ends when you stop or promote it in the console, and a promotion is a new version of Advisor, which `npm run assistant -- rollback advisor --version <n>` undoes.
