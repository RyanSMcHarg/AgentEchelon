/**
 * Battle Orchestrator Lambda
 *
 * Coordinates round-2 fan-out after both bots reach round-1 terminal state.
 * Invoked asynchronously by the async processor whose terminal-state write
 * was the last one (or by either writer concurrently — the
 * tryClaimOrchestratorFire sentinel makes the actual fan-out exactly-once).
 *
 * Per SPEC-BATTLE.md "Fan-Out — Round 2 (Rebuttals, Bot Opt-In)":
 *   1. Read the BattleStateTable partition for the battleId.
 *   2. Verify all bot rows are in a terminal state. (If not — e.g. one
 *      writer raced ahead — return; the late writer will fire when its
 *      transition lands.)
 *   3. tryClaimOrchestratorFire — exactly-one wins; the rest no-op.
 *   4. For each bot: send a round-2 placeholder, invoke the premium async
 *      processor with battleContext.round=2 + the rival's round-1 reply.
 *   5. The async processor may emit NO_REBUTTAL to skip its rebuttal; on
 *      receipt the processor deletes its own placeholder.
 *
 * Failure modes:
 *  - Async processor failed in round 1 (state=FAILED on a row): we still
 *    fire round 2. The "rival reply" for that bot is the FAILED row's
 *    correlation log; the surviving bot's round 2 sees no rival content
 *    (the system prompt acknowledges this and asks them to respond
 *    independently).
 *  - Async processor crashes mid-round-1: row never transitions → TTL
 *    expires it after 10 min. Orchestrator never fires for that battle.
 *    Round 1 messages stay in the channel; users see partial output.
 */

import {
  ChimeSDKMessagingClient,
  SendChannelMessageCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  readBattleRows,
  allBotsTerminal,
  tryClaimOrchestratorFire,
  botRowsOnly,
  type BattleStateRow,
} from './lib/battle-state.js';

const messagingClient = new ChimeSDKMessagingClient({});
const lambdaClient = new LambdaClient({});
const ssmClient = new SSMClient({});

// The premium tier processor ARN is resolved at RUNTIME from SSM (the
// AgentEchelonTier-Premium stack publishes it). Resolving here — not at deploy via
// valueForStringParameter — keeps this orchestrator decoupled from the premium
// tier stack at deploy time (no fresh-deploy ordering cycle). A literal env
// override is honored first for tests / special wiring.
const PREMIUM_PROCESSOR_ARN_PARAM = process.env.PREMIUM_PROCESSOR_ARN_PARAM;
const PREMIUM_ASYNC_PROCESSOR_ARN_ENV = process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
let cachedPremiumArn: string | null = null;

async function getPremiumProcessorArn(): Promise<string> {
  if (cachedPremiumArn) return cachedPremiumArn;
  if (PREMIUM_ASYNC_PROCESSOR_ARN_ENV) {
    cachedPremiumArn = PREMIUM_ASYNC_PROCESSOR_ARN_ENV;
    return cachedPremiumArn;
  }
  if (PREMIUM_PROCESSOR_ARN_PARAM) {
    try {
      const resp = await ssmClient.send(new GetParameterCommand({ Name: PREMIUM_PROCESSOR_ARN_PARAM }));
      cachedPremiumArn = resp.Parameter?.Value || '';
      return cachedPremiumArn;
    } catch (err) {
      console.error('[BattleOrchestrator] failed to resolve premium processor ARN from SSM', err);
    }
  }
  return '';
}

export interface BattleOrchestratorEvent {
  battleId: string;
  channelArn: string;
  /** Original /battle user message text — fed to round-2 invocations so the
   *  rebuttal LLM call has the original prompt for grounding. */
  userMessage: string;
  /** Sender of the original /battle message — used for targeted replies. */
  senderArn?: string;
  /** Originating message id — referenced (never copied) in round-2 prompts. */
  originatingMessageId: string;
}

export async function handler(event: BattleOrchestratorEvent): Promise<void> {
  const { battleId, channelArn, userMessage, originatingMessageId } = event;
  console.log('[BattleOrchestrator] Invoked', { battleId, channelArn });

  const premiumProcessorArn = await getPremiumProcessorArn();
  if (!premiumProcessorArn) {
    console.error('[BattleOrchestrator] premium processor ARN unresolved (set PREMIUM_PROCESSOR_ARN_PARAM or PREMIUM_ASYNC_PROCESSOR_ARN)');
    return;
  }

  // 1. Read the partition.
  const rows = await readBattleRows(battleId);
  const bots = botRowsOnly(rows);
  if (bots.length === 0) {
    console.warn('[BattleOrchestrator] no bot rows for battleId', battleId);
    return;
  }

  // 2. All terminal? If not, defer — the late writer will fire.
  if (!allBotsTerminal(rows)) {
    console.log('[BattleOrchestrator] Not all bots terminal yet, deferring', {
      battleId,
      states: bots.map((r) => ({ bot: r.botArn, state: r.state })),
    });
    return;
  }

  // 3. Exactly-once claim.
  const claimed = await tryClaimOrchestratorFire(battleId);
  if (!claimed) {
    console.log('[BattleOrchestrator] Another invocation already claimed the fire', { battleId });
    return;
  }
  console.log('[BattleOrchestrator] Claimed orchestrator fire — proceeding to round 2', {
    battleId,
    bots: bots.length,
  });

  // 4. For each bot, send round-2 placeholder + invoke async with rival reply.
  await Promise.all(
    bots.map(async (selfRow) => {
      const rivalRow = bots.find((r) => r.botArn !== selfRow.botArn);
      const rivalReply = rivalRow?.round1Reply || '';
      const rivalReplyMsgId = rivalRow?.round1MessageId;

      const correlationId = `battle-r2-${selfRow.botArn.split('/').pop()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        await sendPlaceholder({
          channelArn,
          botArn: selfRow.botArn,
          correlationId,
          battleId,
          rivalArn: rivalRow?.botArn || '',
          rivalReplyMsgId,
        });
      } catch (err) {
        console.warn('[BattleOrchestrator] placeholder send failed for', selfRow.botArn, err);
        return;
      }

      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: premiumProcessorArn,
            InvocationType: InvocationType.Event,
            Payload: Buffer.from(JSON.stringify({
              channelArn,
              correlationId,
              userMessage,
              userType: 'premium',
              botArn: selfRow.botArn,
              senderArn: event.senderArn,
              intent: 'general',
              deliveryOption: 'PLACEHOLDER_UPDATE',
              battleContext: {
                battleId,
                round: 2,
                totalRounds: 2,
                selfBotArn: selfRow.botArn,
                rivalBotArn: rivalRow?.botArn || '',
                rivalReply,
                rivalReplyMsgId,
                originatingMessageId,
              },
            })),
          }),
        );
      } catch (err) {
        console.error('[BattleOrchestrator] async-processor invoke failed for', selfRow.botArn, err);
      }
    }),
  );

  console.log('[BattleOrchestrator] Round 2 fan-out complete', { battleId });
}

async function sendPlaceholder(args: {
  channelArn: string;
  botArn: string;
  correlationId: string;
  battleId: string;
  rivalArn: string;
  rivalReplyMsgId?: string;
}): Promise<void> {
  const rivalRef = args.rivalReplyMsgId ? `,rivalReplyMsgId=${args.rivalReplyMsgId}` : '';
  await messagingClient.send(
    new SendChannelMessageCommand({
      ChannelArn: args.channelArn,
      Content: `One moment... <!--corr:${args.correlationId}--><!--battle:battleId=${args.battleId},round=2,total=2,rivalArn=${args.rivalArn}${rivalRef}-->`,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: args.botArn,
    }),
  );
}

// Export for the unit tests so they can call orchestrator pieces in isolation.
export type { BattleStateRow };
