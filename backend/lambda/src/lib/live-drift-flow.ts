/**
 * Live drift flow — shared across the per-classification agent handlers.
 *
 * This is the USER-FACING drift feature (SPEC-DRIFT-CONVERGENCE.md): when a
 * conversation's latest message has semantically drifted from the established
 * thread (pgvector cosine over Titan v2 embeddings), the assistant offers to
 * spin the tangent into its own conversation, and — if the user confirms —
 * creates the new channel. It is distinct from the async/archival drift path
 * (`analytics-aurora/kinesis-archival.ts`), which is telemetry-only.
 *
 * Drift is **conversation-level + ALL-classification (basic/standard/premium) + ON BY
 * DEFAULT** in Aurora mode — NOT premium-only. This flow is shared so the
 * router (deployed per-classification, including basic) runs the identical drift flow
 * with no `isAdvancedTier` gate. See the handler-neutral design in
 * SPEC-DRIFT-CONVERGENCE §"runs on all AE tiers".
 *
 * Requires `analyticsMode=aurora` (pgvector + Titan). The wiring helper
 * `auroraDriftWiring` (lib/stacks/agent-classification-common.ts) VPC-attaches the
 * handler and sets DB_* + ENABLE_LIVE_DRIFT=true. In Athena mode the gate
 * (`ENABLE_LIVE_DRIFT && HAS_AURORA`) is false and this is a no-op.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';
// Drift's Aurora + Bedrock work runs in the VPC-attached data-plane Lambda
// (project decision 018); this flow runs in the non-VPC handler and invokes it
// via the client seam. Same signatures; only the import source changes. The
// Intent type is still sourced from drift-detection (import type => erased, so
// pg / db-client are not bundled into this non-VPC handler).
import {
  detectDrift,
  recordDriftFire,
  recordDriftOutcome,
  savePendingSuggestion,
  readPendingSuggestion,
  resolvePendingSuggestion,
} from './data-plane-client.js';
import type { Intent as DriftIntent } from '../analytics-aurora/drift-detection.js';
import {
  readRoutingFromSession,
  writeRoutingToSession,
  recordDecline,
  classifyConfirmDeclineReply,
} from './routing-state.js';
import { createConversationFromDrift } from './channel-creation.js';
import { isBattleEnabled } from './battle-state.js';
import {
  resolveConversationTypeKey,
  getConversationTypeConfig,
} from '../../../lib/config/conversation-types.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Live drift detection — feature-flagged. Set via CDK context enableLiveDrift,
// which the auroraDriftWiring helper turns into ENABLE_LIVE_DRIFT=true +
// AURORA_DATA_PLANE_ARN whenever Aurora is wired (on-by-default in Aurora mode;
// the deployer opts out). The embedding + pgvector work runs in the data-plane
// Lambda that ARN points at (project decision 018); this handler stays non-VPC.
//
// Drift requires Aurora mode. If ENABLE_LIVE_DRIFT is set but the data-plane ARN
// is not, the deployer has a misconfiguration: enableLiveDrift=true without
// analyticsMode=aurora. We log a warning at module load so it's visible in
// CloudWatch even before the first drift attempt; runtime drift calls just skip
// the signal (no crash).
const ENABLE_LIVE_DRIFT = process.env.ENABLE_LIVE_DRIFT === 'true';
const HAS_AURORA = !!process.env.AURORA_DATA_PLANE_ARN;
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';

if (ENABLE_LIVE_DRIFT && !HAS_AURORA) {
  console.warn(
    '[Drift][config] ENABLE_LIVE_DRIFT=true but AURORA_DATA_PLANE_ARN is unset. Live drift requires Aurora mode '
      + '(deploy with --context analyticsMode=aurora). Drift will be skipped every turn until this is fixed.',
  );
}

const ssmClient = new SSMClient({ region: AWS_REGION });

async function getSsmValue(paramName: string): Promise<string | null> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
    return resp.Parameter?.Value || null;
  } catch (err) {
    console.warn(`[Drift] SSM lookup failed for ${paramName}:`, err);
    return null;
  }
}

/** Minimal shape of the Lex fulfillment event the drift flow reads. The shared
 *  router-agent-handler event (every classification) satisfies it. */
export interface LiveDriftEvent {
  inputTranscript?: string;
  sessionState: {
    intent: { name: string; state?: string };
    sessionAttributes?: Record<string, string>;
  };
  requestAttributes?: Record<string, string>;
}

export interface LiveDriftFlowInput {
  /** The Lex event. The decline path MUTATES `sessionState.sessionAttributes`
   *  (to persist `declinedDistances`) so the caller's normal-flow fall-through
   *  response carries the recorded decline. */
  event: LiveDriftEvent;
  channelArn: string;
  userMessage: string;
  userSub: string;
  classification: 'basic' | 'standard' | 'premium';
  botArn: string;
  /** The classified intent (IntentType value). Uppercased for detectDrift. */
  intent: string;
  /**
   * Explicit conversation-type key for this channel (from metadata/tag), if the
   * caller has it. Drift on/off is a property of the conversation TYPE, not the
   * classification (lib/config/conversation-types.ts). Omitted ⇒ the type defaults to the
   * classification, so behavior is unchanged for un-migrated channels.
   */
  conversationType?: string;
}

/** A short-circuit response from the drift flow — the caller turns this into a
 *  Lex response (`formatLexResponse(event, messages, sessionAttributes)`) and
 *  returns immediately. `null` means "no drift action — continue normal flow"
 *  (the event's sessionAttributes may have been mutated by a decline). */
export interface LiveDriftResponse {
  messages: Array<{ contentType: string; content: string }>;
  sessionAttributes: Record<string, string>;
}

/**
 * Run the live drift flow for one user turn. Returns a {@link LiveDriftResponse}
 * to short-circuit (drift suggestion emitted, or a pending suggestion confirmed/
 * navigated) or `null` to fall through to the normal agent flow.
 *
 * Three branches (matching the original inline router logic):
 *  (a) Pending drift suggestion in session — user is replying yes/no
 *  (b) No pending (or just declined) — run detectDrift; if it fires, emit a suggestion
 *  (c) No pending and no drift — return null (caller continues)
 *
 * Gated on ENABLE_LIVE_DRIFT + HAS_AURORA + a real channel, and suppressed in
 * battle-enabled channels (battle is an intentionally divergent comparison mode;
 * drift suggestions would be constant false positives there — SPEC-BATTLE.md
 * "Drift Detection Interaction"). Runs on ALL tiers (no isAdvancedTier gate).
 */
export async function runLiveDriftFlow(input: LiveDriftFlowInput): Promise<LiveDriftResponse | null> {
  const { event, channelArn, userMessage, userSub, classification, botArn, intent } = input;

  // Infra gate: the Aurora hookup must be wired (auroraDriftWiring sets these).
  if (!ENABLE_LIVE_DRIFT || !HAS_AURORA || !channelArn) return null;

  // Policy gate: drift on/off is a property of the CONVERSATION TYPE, not the
  // classification. Resolve the type (explicit metadata type if present, else the classification)
  // and consult the registry. Today every shipped type has drift on, so this
  // is a no-op until a deployer turns it off for a type or adds a drift-off
  // type — at which point no handler code changes.
  const typeKey = resolveConversationTypeKey({ explicitType: input.conversationType, classification });
  const typeConfig = getConversationTypeConfig(typeKey);
  if (!typeConfig.driftEnabled) return null;

  // Suppressed entirely in battle-enabled channels.
  const battleActive = await isBattleEnabled(channelArn);
  if (battleActive) return null;

  const driftIntent = intent.toUpperCase() as DriftIntent;
  const routing = readRoutingFromSession(event.sessionState.sessionAttributes);

  // Resolve the in-flight suggestion. The Lex session is the fast path, but it
  // can be lost or the turn misrouted (a short "yes"/"no" that Lex tags as a
  // different intent). So when the session carries no pending AND this turn looks
  // like a yes/no reply, fall back to the durable task in Aurora
  // (conversation_creation_tasks) — the authoritative record opened at detect.
  // Gated on a non-ambiguous reply so a normal message never costs a data-plane
  // round-trip. See docs SPEC-DRIFT-CONVERGENCE.md "Live-Suggestion Flow".
  let pending = routing.pendingDriftSuggestion;
  if (!pending && classifyConfirmDeclineReply(userMessage) !== 'ambiguous') {
    const durable = await readPendingSuggestion({ userSub, channelArn });
    if (durable) {
      pending = {
        taskId: durable.taskId,
        channelArn: durable.channelArn,
        userSub: durable.userSub,
        kind: durable.kind,
        rivalConversationArn: durable.rivalConversationArn,
        originatingMessageId: durable.originatingMessageId,
        cosineDistance: durable.cosineDistance,
        correlationId: durable.correlationId,
        createdAt: durable.createdAt,
      };
    }
  }

  // Branch (a): in-flight pending suggestion (from session or the durable task)
  if (pending) {
    const reply = classifyConfirmDeclineReply(userMessage);

    if (reply === 'affirmative') {
      // User confirmed. Create the new channel or navigate.
      try {
        if (pending.kind === 'confirm') {
          const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
          const channelFlowArn = CHANNEL_FLOW_ARN_PARAM
            ? await getSsmValue(CHANNEL_FLOW_ARN_PARAM)
            : undefined;
          const created = await createConversationFromDrift({
            appInstanceArn: APP_INSTANCE_ARN,
            botArn,
            userArn: senderArn,
            // The spawned channel inherits the conversation type's security
            // classification (== the parent's classification today). IAM Layer-1 gates
            // the new channel on this tag, so it must match what the user can
            // reach.
            modelTier: typeConfig.classification,
            modelId: '',
            modelName: '',
            topicLabel: 'Drift Follow-up',
            channelFlowArn: channelFlowArn || undefined,
            parentChannelArn: channelArn,
            originatingMessageId: pending.originatingMessageId,
          });
          if (pending.driftEventId) {
            await recordDriftOutcome({
              eventId: pending.driftEventId,
              outcome: 'accepted',
              newChannelArn: created.channelArn,
            }).catch(() => undefined);
          }
          await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'confirmed' }).catch(() => undefined);
          const newSession = writeRoutingToSession(
            event.sessionState.sessionAttributes || {},
            { ...routing, pendingDriftSuggestion: undefined },
          );
          return {
            messages: [{
              contentType: 'PlainText',
              content: `Done — I've created a new conversation. NAVIGATE_CHANNEL:${created.channelArn}|Drift Follow-up`,
            }],
            sessionAttributes: newSession,
          };
        }

        if (pending.kind === 'redirect' && pending.rivalConversationArn) {
          if (pending.driftEventId) {
            await recordDriftOutcome({
              eventId: pending.driftEventId,
              outcome: 'accepted',
              newChannelArn: pending.rivalConversationArn,
            }).catch(() => undefined);
          }
          await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'confirmed' }).catch(() => undefined);
          const newSession = writeRoutingToSession(
            event.sessionState.sessionAttributes || {},
            { ...routing, pendingDriftSuggestion: undefined },
          );
          return {
            messages: [{
              contentType: 'PlainText',
              content: `Taking you there. NAVIGATE_CHANNEL:${pending.rivalConversationArn}|Existing conversation`,
            }],
            sessionAttributes: newSession,
          };
        }
      } catch (err) {
        console.error('[Drift] Failed to act on confirmation:', err);
        // Fall through to normal agent flow rather than blocking the user
      }
    }

    if (reply === 'negative') {
      // Record the decline and fall through to normal agent flow.
      if (pending.driftEventId) {
        await recordDriftOutcome({ eventId: pending.driftEventId, outcome: 'declined' }).catch(() => undefined);
      }
      await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'declined' }).catch(() => undefined);
      const updatedRouting = pending.cosineDistance != null
        ? recordDecline(routing, pending.cosineDistance)
        : { ...routing, pendingDriftSuggestion: undefined };
      // Mutate the event so the caller's normal-flow response carries the decline.
      event.sessionState.sessionAttributes = writeRoutingToSession(
        event.sessionState.sessionAttributes || {},
        updatedRouting,
      );
      // Fall through to normal agent flow with the decline recorded.
    }

    // 'ambiguous' or fallthrough from negative → carry on with the user's
    // original message via the normal agent flow. The pending suggestion stays
    // in routing state for one more turn; if the next reply is still ambiguous,
    // detectDrift below will re-evaluate.
  }

  // Branch (b): no pending, or pending was just declined — run detectDrift
  if (!pending || classifyConfirmDeclineReply(userMessage) === 'negative') {
    const driftResult = await detectDrift({
      channelArn,
      messageId: event.requestAttributes?.['CHIME.message.id'] || randomUUID(),
      latestMessage: userMessage,
      intent: driftIntent,
      userClearance: classification,
      declinedDistances: routing.declinedDistances,
    });

    if (driftResult.isDrift && driftResult.suggestionTemplate) {
      // Record the fire and persist pending state for the next turn.
      let driftEventId: string | undefined;
      try {
        driftEventId = await recordDriftFire({
          result: driftResult,
          channelArn,
          messageId: event.requestAttributes?.['CHIME.message.id'] || '',
          userSub,
          intent: driftIntent,
        });
      } catch (err) {
        console.warn('[Drift] recordDriftFire failed:', err);
      }

      let savedTaskId = '';
      try {
        const saved = await savePendingSuggestion({
          channelArn,
          userSub,
          kind: driftResult.suggestedAction === 'redirect' ? 'redirect' : 'confirm',
          rivalConversationArn: driftResult.rivalConversationArn,
          originatingMessageId: event.requestAttributes?.['CHIME.message.id'] || '',
          cosineDistance: Number.isFinite(driftResult.driftScore) ? driftResult.driftScore : undefined,
          correlationId: driftResult.correlationId,
        });
        savedTaskId = saved.taskId;
      } catch (err) {
        console.warn('[Drift] savePendingSuggestion failed:', err);
      }

      const newSession = writeRoutingToSession(
        event.sessionState.sessionAttributes || {},
        {
          ...routing,
          pendingDriftSuggestion: {
            taskId: savedTaskId,
            channelArn,
            userSub,
            kind: driftResult.suggestedAction === 'redirect' ? 'redirect' : 'confirm',
            rivalConversationArn: driftResult.rivalConversationArn,
            originatingMessageId: event.requestAttributes?.['CHIME.message.id'] || '',
            cosineDistance: Number.isFinite(driftResult.driftScore) ? driftResult.driftScore : undefined,
            correlationId: driftResult.correlationId,
            driftEventId,
            createdAt: new Date().toISOString(),
          },
        },
      );

      return {
        messages: [{
          contentType: 'PlainText',
          content: driftResult.suggestionTemplate,
        }],
        sessionAttributes: newSession,
      };
    }
  }

  // Branch (c): no drift action — continue normal flow.
  return null;
}
