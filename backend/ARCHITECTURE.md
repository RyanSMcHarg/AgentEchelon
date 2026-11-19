# Backend

This directory is the AWS CDK app and the Lambda code it deploys. The system-level picture lives in [`docs/overview/ARCHITECTURE.md`](../docs/overview/ARCHITECTURE.md), the stack inventory in [`docs/overview/STACKS.md`](../docs/overview/STACKS.md), and the message path end to end in [`docs/guides/developer/MESSAGE-FLOW.md`](../docs/guides/developer/MESSAGE-FLOW.md). This page is a map of the directory and of how a turn enters it.

## What the directory holds

| Path | Contents |
|---|---|
| `bin/backend.ts` | The CDK app entry point. |
| `lib/stacks/` | One file per stack (see STACKS.md). |
| `lib/constructs/`, `lib/config/` | Shared constructs and the deploy-time configuration they read (profiles, issuers, capabilities). |
| `lambda/src/` | Lambda handlers, one file per function, with shared code under `lambda/src/lib/`. |
| `demo/` | Demo content: personas, intent packs, onboarding, welcomes and the golden set. |
| `scripts/` | Deploy, test-runner, backfill and deny-test scripts. |
| `test/` | The Jest suite. |

## How a turn enters

Every assistant identity is built with `StandardMessages: NONE` and `TargetedMessages: ALL` (`assistantBotConfiguration` in `lambda/src/lib/assistant-identity.ts`), so a message reaches an assistant's handler by one of two entries ([ADR-036](../docs/design/decisions/036-why-turns-enter-through-amazon-lex.md), [ADR-041](../docs/design/decisions/041-simplifying-how-a-message-reaches-an-assistant.md)):

- **Untargeted messages, every 1:1 included, enter through the channel flow.** `channel-flow-processor.ts` decides the flow owns the turn (`flowOwnsTheTurn`, `lambda/src/lib/flow-bypass.ts`) and invokes the classification's router directly with an `aeTurn` request (`invokeRouterTurn`).
- **Targeted messages and the room's welcome enter through Amazon Lex.** Amazon Chime SDK invokes the assistant's Amazon Lex bot, whose fulfillment is the same router.

Both entries run the same turn in `lambda/src/router-agent-handler.ts` (`handleTurn`, then `runTurn`), which dispatches the work to the classification's async processor (`assistant-async-processor.ts`). What differs is how the router's own reply reaches the room:

- **Lex entry:** `replyThroughLex` returns the reply as the Amazon Lex response, which Amazon Chime SDK posts. A reply longer than the 1000 characters Amazon Lex carries (`LEX_MESSAGE_MAX`) is posted as the assistant in parts instead, addressed to the person who spoke.
- **Flow entry:** `postAsAssistant` posts the reply in the channel as the assistant.

The async processor runs the model and posts or updates the answer in the channel as the assistant.

## Building, testing and deploying

`AGENTS.md` at the repository root holds the commands. Tests run one shard at a time (`npm run test:shards`), and deploys go through `npm run deploy` or `npm run deploy:stack -- <Stack>`, never a raw `cdk deploy`.
