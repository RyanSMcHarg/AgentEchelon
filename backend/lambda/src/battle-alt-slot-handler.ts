/**
 * battle-alt-slot-handler — Lex V2 fulfillment for the /battle alt-bot slots.
 *
 * Each alt-slot AppInstanceBot (AltSlot0, AltSlot1, …) is created with a Lex `WelcomeIntent` +
 * `FallbackIntent` whose code hook points here.
 *
 * IT USED TO BE SILENT BY DESIGN, and that design had an expiry date nobody noticed. The reasoning was:
 * "during an active battle, alt-slot replies are produced by the channel-flow processor direct-invoking
 * the premium async-processor, so Lex is NOT on the battle reply path". True while the only way a duel
 * side ever spoke was the fan-out. It stopped being true when answering a waiting side moved onto the
 * ORDINARY turn: a person's reply is `Target`-ed at the side that asked, Amazon Chime SDK routes it to
 * THAT bot's Lex, and for an alt slot that landed here - on a handler whose whole job was to close the
 * intent with no message. The reply was swallowed, the chain never resumed, and the empty envelope
 * Chime posted in its place is what the channel flow was then failing to drop.
 *
 * So a REAL TURN is now handed to the classification router, exactly as `@all` and the `/battle`
 * fan-out hand theirs, with this slot's own identity attached. The turn logic stays in the one place
 * that has it; this handler's only jobs are to say WHICH assistant is answering and to stay quiet on
 * join.
 *
 * WHY NOT JUST POINT THE ALIAS AT THE ROUTER. Amazon Chime SDK tells Lex the channel and the sender,
 * never which bot was addressed, so a router invoked directly would answer as its classification's own
 * bot - an alt side replying in the wrong identity. That is the same class of defect as an image duel
 * running as a text duel: it still answers, so nothing errors. A per-slot handler is what knows which
 * slot it is.
 *
 * WelcomeIntent stays silent. A battle announcement is sent separately by `channel-battle.ts` through
 * the channel's real per-classification bot, so an alt slot greeting on join would be a duplicate.
 *
 * Everything it needs is resolved at RUNTIME from SSM, not at deploy: AgentEchelonBattle cannot consume
 * a classification's ARNs at synth time without deadlocking the deploy order (premium already consumes
 * battle's SSM), which is the same constraint that produced the silent handler in the first place.
 */
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  ChimeSDKIdentityClient,
  DescribeAppInstanceBotCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { resolveChannelClassificationTag } from './lib/channel-classification.js';

const region = process.env.AWS_REGION || 'us-east-1';
const lambdaClient = new LambdaClient({ region });
const ssmClient = new SSMClient({ region });
const identityClient = new ChimeSDKIdentityClient({ region });
const messagingClient = new ChimeSDKMessagingClient({ region });

const INSTANCE_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ROSTER_PARAM = process.env.ALT_BOT_SLOTS_ROSTER_PARAM || `${INSTANCE_ROOT}/alt-bot-slots/roster`;
/**
 * A duel runs at the CHANNEL'S OWN classification, and so must the reply a person targets at an alt
 * slot. This used to hardwire the premium router (every other battle path routes by the channel's
 * classification tag precisely to avoid crossing IAM-enforced boundaries), so a targeted reply in a
 * below-premium duel ran on the premium router - premium model, premium guardrail, premium context
 * scope - silently, because the turn still answered. Battles are not premium-only by design (owner,
 * 2026-08-18); the router resolves per classification, cached per classification.
 */
const routerArnCacheByClassification = new Map<string, string>();
async function routerArnFor(classification: string): Promise<string | undefined> {
  const cached = routerArnCacheByClassification.get(classification);
  if (cached) return cached;
  const arn = await ssmValue(`${INSTANCE_ROOT}/assistant/${classification}/router-arn`);
  if (arn) routerArnCacheByClassification.set(classification, arn);
  return arn ?? undefined;
}

interface LexEvent {
  inputTranscript?: string;
  bot?: { id?: string; name?: string; aliasId?: string };
  sessionState?: {
    intent?: { name?: string };
    sessionAttributes?: Record<string, string>;
  };
  requestAttributes?: Record<string, string>;
}

interface LexResponse {
  sessionState: {
    dialogAction: { type: 'Close' };
    intent: { name: string; state: 'Fulfilled' };
    sessionAttributes?: Record<string, string>;
  };
  messages: Array<{ contentType: string; content: string }>;
}

/** Container-lifetime caches: the roster and the Lex-bot→slot mapping do not change per invocation. */
const selfArnByLexBotId = new Map<string, string>();

async function ssmValue(name: string): Promise<string | null> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: name }));
    return resp.Parameter?.Value || null;
  } catch (err) {
    console.warn('[BattleAltSlot] SSM lookup failed for', name, err);
    return null;
  }
}

/**
 * WHICH SLOT AM I. The Lex event names the Lex bot, the roster names the Chime bots, and the link
 * between them is the AppInstanceBot's own configured Lex alias — so it is read from the bots
 * themselves rather than kept as a second copy that could disagree with the wiring it describes.
 */
async function resolveSelfBotArn(lexBotId: string | undefined): Promise<string | null> {
  if (!lexBotId) return null;
  const cached = selfArnByLexBotId.get(lexBotId);
  if (cached) return cached;

  const rosterRaw = await ssmValue(ROSTER_PARAM);
  if (!rosterRaw) return null;
  let roster: Array<{ slotId?: string; botArn?: string }> = [];
  try {
    roster = JSON.parse(rosterRaw);
  } catch (err) {
    console.warn('[BattleAltSlot] alt-slot roster is not parseable JSON:', err);
    return null;
  }

  for (const slot of roster) {
    if (!slot?.botArn) continue;
    try {
      const bot = await identityClient.send(new DescribeAppInstanceBotCommand({
        AppInstanceBotArn: slot.botArn,
      }));
      const aliasArn = bot.AppInstanceBot?.Configuration?.Lex?.LexBotAliasArn || '';
      if (aliasArn.includes(lexBotId)) {
        selfArnByLexBotId.set(lexBotId, slot.botArn);
        return slot.botArn;
      }
    } catch (err) {
      console.warn('[BattleAltSlot] could not describe', slot.botArn, err);
    }
  }
  return null;
}

function silent(event: LexEvent, intentName: string): LexResponse {
  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: { name: intentName, state: 'Fulfilled' },
      sessionAttributes: event.sessionState?.sessionAttributes,
    },
    messages: [],
  };
}

export const handler = async (event: LexEvent): Promise<LexResponse> => {
  const lexIntentName = event.sessionState?.intent?.name || 'FallbackIntent';

  // Amazon Chime SDK delivers the transcript percent-encoded; the router encodes its own bypass entries
  // for the same round trip, so it is decoded once here and passed as text. GUARDED, same as the
  // router's decode of the same field: a malformed %-sequence in a user message must degrade to the
  // raw text, not throw a URIError out of the handler - which hands Lex a function error, shows the
  // user a visible failure, and leaves the waiting duel side unresumed.
  let transcript = '';
  if (event.inputTranscript) {
    try {
      transcript = decodeURIComponent(event.inputTranscript);
    } catch {
      transcript = event.inputTranscript;
    }
  }
  const channelArn = event.requestAttributes?.['CHIME.channel.arn'] || '';
  const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';

  // JOIN, not a turn. Silent, as before: the channel's own assistant does the announcing.
  if (lexIntentName === 'WelcomeIntent' || !transcript || !channelArn || !senderArn) {
    console.log('[BattleAltSlot] Closing intent silently', { intent: lexIntentName, hasTranscript: !!transcript });
    return silent(event, lexIntentName);
  }

  const selfBotArn = await resolveSelfBotArn(event.bot?.id);
  // The immutable tag is the authority, read with this slot's own identity as bearer - the same
  // fail-closed resolver every other turn path uses. An unreadable tag resolves to the fail-closed
  // floor there, never to premium.
  const classification = selfBotArn
    ? await resolveChannelClassificationTag(messagingClient, channelArn, '[BattleAltSlot]')
    : '';
  const routerArn = classification ? await routerArnFor(classification) : undefined;
  if (!selfBotArn || !routerArn) {
    // Silence is the honest degrade: answering as the wrong identity, or from a handler that cannot
    // name itself, is worse than not answering. Loud, because it means a real turn was dropped.
    console.error('[BattleAltSlot] cannot hand the turn over; dropping it', {
      lexBotId: event.bot?.id, resolvedSelf: !!selfBotArn, resolvedRouter: !!routerArn,
    });
    return silent(event, lexIntentName);
  }

  try {
    const result = await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({
        aeTurn: {
          channelArn,
          senderArn,
          userMessage: transcript,
          // THE POINT OF THIS HANDLER. The router validates it against the published alt-slot roster
          // plus its own bot, so a caller cannot post as an arbitrary identity.
          botArn: selfBotArn,
          ...(event.requestAttributes?.['CHIME.message.id']
            ? { userMessageId: event.requestAttributes['CHIME.message.id'] }
            : {}),
        },
      })),
    }));
    const payload = result.Payload ? JSON.parse(Buffer.from(result.Payload).toString()) : null;
    if (payload?.sessionState && Array.isArray(payload?.messages)) {
      console.log('[BattleAltSlot] turn handed to the router', {
        selfBotArn, messages: payload.messages.length,
      });
      return payload as LexResponse;
    }
    console.warn('[BattleAltSlot] router returned no usable Lex response; closing silently');
  } catch (err) {
    console.error('[BattleAltSlot] router invoke failed:', err);
  }
  return silent(event, lexIntentName);
};
