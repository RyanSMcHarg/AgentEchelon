import type { ActiveTask } from '../types';

export interface NavigateChannel {
  channelArn: string;
  channelName: string;
}

export interface BattleMarker {
  battleId: string;
  round: 1 | 2;
  totalRounds: number;
  rivalArn?: string;
  rivalReplyMsgId?: string;
  // Compact per-variant round summary (emission wiring #1). Set from
  // the <!--battlestats:--> marker the async processor appends to the
  // updated reply Content (NOT the ≤1KB Metadata). The chime provider
  // merges these into the placeholder's battle. Absent → scorecard "—".
  responseMs?: number;
  estCostUsd?: number | null;
  steps?: Array<{ stepLabel: string; modelId: string; durationMs?: number }>;
  /** Resolved variant displayName for this reply ("Atlas" / "Echo"),
   *  from the <!--battlestats:--> `name=` field. The scorecard +
   *  variant chip prefer this over the bot's generic Chime
   *  AppInstanceUser name. Absent → fall back to sender.name. */
  label?: string;
  /** Underlying model's provider (e.g. 'anthropic', 'amazon') — for tooltip / inspector. */
  provider?: string;
  /** Underlying model's human-readable label (e.g. 'Claude Sonnet 4.6',
   *  'Amazon Nova Canvas') — rendered as subtitle under the variant name
   *  so 'Atlas' / 'Pixel' aren't opaque aliases. */
  modelLabel?: string;
  /** Bedrock prompt-tokens-in (text battles). Used for cost breakdown. */
  tokensIn?: number;
  /** Bedrock output-tokens-out (text battles). Used for cost breakdown. */
  tokensOut?: number;
  /** Generation-out: number of images produced; used for cost breakdown. */
  imageCount?: number;
}

/**
 * A bot is blocked on the user mid-battle (SPEC-BATTLE.md
 * "Clarification Routing"). Set from the `<!--battlewaiting:-->` marker
 * the async processor puts on the placeholder it shows the channel in
 * place of the (privately, targeted) clarifying question. Drives the
 * composer's "Replying to:" affordance — distinct from `battle` (a
 * completed round reply / scorecard).
 */
export interface BattleWaiting {
  battleId: string;
  botArn: string;
}

// Generation-out has NO marker here by design: a generated image is delivered as a message
// ATTACHMENT and rendered by AttachmentDisplay, which fetches a fresh presigned URL on demand.
// The inline `<!--battleimage:{urls}-->` marker this file used to parse embedded a presigned URL in
// the content, so it expired with the STS token and did not render; nothing has emitted it since.

interface ParsedMessage {
  content: string;
  activeTask: ActiveTask | null;
  navigateChannel: NavigateChannel | null;
  battle: BattleMarker | null;
  battleWaiting: BattleWaiting | null;
}

const NAVIGATE_CHANNEL_PATTERN = /NAVIGATE_CHANNEL:([^|\s]+)\|([^\n]+)/;
const BATTLE_MARKER_PATTERN = /<!--battle:([^>]+)-->/;
const BATTLESTATS_MARKER_PATTERN = /<!--battlestats:([^>]+)-->/;
const BATTLEWAITING_MARKER_PATTERN = /<!--battlewaiting:([^>]+)-->/;

/**
 * ContentType Chime stamps on a bot's Lex-fulfillment reply. This is the
 * RELIABLE signal that a message is a Lex envelope — gating on it means we
 * never touch a coding answer that legitimately contains JSON (e.g. a fenced
 * `{"Messages": …}` code block); only Lex's own envelope is unwrapped.
 */
const LEX_MSGS_CONTENT_TYPE = 'application/amz-chime-lex-msgs';

/**
 * Unwrap a Lex fulfillment JSON envelope to the human-readable text.
 *
 * Chime posts a bot's Lex-fulfillment reply (e.g. the on-add WelcomeIntent
 * greeting) as `{"Messages":[{"Content":"…","ContentType":"PlainText"}]}` rather
 * than the bare text — so without unwrapping, users would see raw JSON. Normal
 * answers are posted clean (async processor → UpdateChannelMessage) with an
 * ordinary ContentType, so they pass through untouched. The ingestion pattern:
 * unwrap BEFORE decoding (in the listMessages map), take `Messages[0].Content`.
 * Apply at every raw-Content
 * ingestion point (REST list + realtime WS) so no rendering path surfaces it.
 *
 * Gated on the Lex ContentType: a coding response may contain `{"Messages":…}`
 * JSON in a code block, and that must render verbatim — only Lex's envelope is
 * unwrapped.
 */
/**
 * Is this a Lex envelope carrying NO messages, i.e. nothing the user should see?
 *
 * The router returns `messages: []` to suppress a retried fulfillment (ADR-022). Amazon Chime SDK
 * posts that envelope into the channel regardless, so it is the CLIENT that has to recognise it as
 * nothing - otherwise the user sees raw JSON, which is worse than the duplicate the suppression exists
 * to prevent.
 *
 * Shared because both ingestion paths need the identical rule: the REST history load
 * (`chimeService.listMessages`) and the realtime websocket (`MessagingProvider.parseMessagePayload`).
 * They previously each carried their own copy, which is two places for the rule to drift and only one
 * of them visible in any given bug report - a message dropped live but present on reload, or the
 * reverse.
 *
 * Gated on the Lex ContentType for the same reason as `unwrapLexEnvelope`: a coding answer may
 * legitimately contain `{"Messages":[]}` in a fenced block and must render verbatim.
 */
export function isEmptyLexEnvelope(rawContent: string, contentType?: string): boolean {
  if (contentType !== LEX_MSGS_CONTENT_TYPE) return false;
  try {
    const lex = JSON.parse(rawContent);
    return Array.isArray(lex?.Messages) && lex.Messages.length === 0;
  } catch {
    // Marked as a Lex envelope but unparseable. Not provably empty, so keep it rather than silently
    // dropping a message we failed to understand.
    return false;
  }
}

export function unwrapLexEnvelope(rawContent: string, contentType?: string): string {
  if (contentType !== LEX_MSGS_CONTENT_TYPE) return rawContent;
  try {
    const lex = JSON.parse(rawContent);
    if (Array.isArray(lex?.Messages) && lex.Messages.length > 0) {
      return lex.Messages[0]?.Content ?? rawContent;
    }
  } catch {
    // Marked as a Lex envelope but unparseable — leave as-is.
  }
  return rawContent;
}

/**
 * Parse message content to extract active task markers, drift-redirect
 * markers, and clean up internal markers.
 */
export function parseMessageContent(rawContent: string): ParsedMessage {
  let content = rawContent;
  let activeTask: ActiveTask | null = null;
  let navigateChannel: NavigateChannel | null = null;
  let battle: BattleMarker | null = null;
  let battleWaiting: BattleWaiting | null = null;

  // Extract <!--ACTIVE_TASK:{JSON}--> markers
  const taskMatch = content.match(/<!--ACTIVE_TASK:(.*?)-->/s);
  if (taskMatch) {
    try {
      activeTask = JSON.parse(taskMatch[1]);
    } catch {
      // Ignore parse errors
    }
    content = content.replace(/<!--ACTIVE_TASK:.*?-->/gs, '');
  }

  // Extract <!--battle:battleId=X,round=N,total=2,rivalArn=Y[,rivalReplyMsgId=Z]-->
  // The marker is set by the channel-flow processor and battle-orchestrator
  // on per-bot placeholders + round-2 replies.
  const battleMatch = content.match(BATTLE_MARKER_PATTERN);
  if (battleMatch) {
    const fields = parseBattleFields(battleMatch[1]);
    if (fields.battleId && (fields.round === 1 || fields.round === 2)) {
      battle = {
        battleId: fields.battleId,
        round: fields.round,
        totalRounds: fields.total || 2,
        rivalArn: fields.rivalArn,
        rivalReplyMsgId: fields.rivalReplyMsgId,
        // A: the fan-out emits name= on the placeholder marker so the
        // frontend can show a working-state ("<name> is drafting...")
        // immediately, without waiting for the round-1 battlestats.
        ...(fields.name ? { label: fields.name } : {}),
      };
    }
    content = content.replace(BATTLE_MARKER_PATTERN, '');
  }

  // Extract <!--battlestats:battleId=X,round=N,responseMs=..,estCostUsd=..,modelId=..-->
  // Appended by the async processor to the UPDATED reply Content (the
  // placeholder's <!--battle:--> marker is gone by then). Carries the
  // compact per-variant scorecard summary. The chime provider merges
  // this into the placeholder-derived battle, so a battlestats-only
  // object must NOT set rivalArn/round-less keys it doesn't have.
  const statsMatch = content.match(BATTLESTATS_MARKER_PATTERN);
  if (statsMatch) {
    const f = parseBattleFields(statsMatch[1]);
    if (f.battleId && (f.round === 1 || f.round === 2)) {
      const steps =
        f.responseMs != null
          ? [
              {
                stepLabel: f.round === 2 ? 'round2-rebuttal' : 'round1-generate',
                modelId: f.modelId || '',
                durationMs: f.responseMs,
                ...(f.modelLabel ? { modelLabel: f.modelLabel } : {}),
                ...(f.provider ? { provider: f.provider } : {}),
              },
            ]
          : undefined;
      const summary = {
        responseMs: f.responseMs,
        estCostUsd: f.estCostUsd,
        steps,
        // Only set fields when present so the merge onto the
        // placeholder-derived battle never clobbers them with undefined.
        ...(f.name ? { label: f.name } : {}),
        ...(f.provider ? { provider: f.provider } : {}),
        ...(f.modelLabel ? { modelLabel: f.modelLabel } : {}),
        ...(f.tokensIn != null ? { tokensIn: f.tokensIn } : {}),
        ...(f.tokensOut != null ? { tokensOut: f.tokensOut } : {}),
        ...(f.imageCount != null ? { imageCount: f.imageCount } : {}),
      };
      battle = battle
        ? { ...battle, ...summary }
        : {
            battleId: f.battleId,
            round: f.round,
            totalRounds: f.total || 2,
            ...summary,
          };
    }
    content = content.replace(BATTLESTATS_MARKER_PATTERN, '');
  }

  // Extract <!--battlewaiting:battleId=X,botArn=Y--> — set by the async
  // processor on the placeholder shown to the channel in place of the
  // (privately targeted) clarifying question. Standalone (no battle/
  // battlestats marker on a waiting placeholder); drives the composer.
  const waitingMatch = content.match(BATTLEWAITING_MARKER_PATTERN);
  if (waitingMatch) {
    const f = parseBattleFields(waitingMatch[1]);
    if (f.battleId && f.botArn) {
      battleWaiting = { battleId: f.battleId, botArn: f.botArn };
    }
    content = content.replace(BATTLEWAITING_MARKER_PATTERN, '');
  }

  // Extract NAVIGATE_CHANNEL:<arn>|<name> markers (drift confirm redirect)
  const navMatch = content.match(NAVIGATE_CHANNEL_PATTERN);
  if (navMatch) {
    navigateChannel = {
      channelArn: navMatch[1].trim(),
      channelName: navMatch[2].trim(),
    };
    content = content.replace(NAVIGATE_CHANNEL_PATTERN, '').trim();
  }

  // Strip <!--corr:uuid--> correlation ID markers
  // Battle correlation IDs include extra prefix segments (e.g. "battle-r1-slot-0-...")
  // so we widen the pattern to accept any UUID-ish or hyphen-delimited token.
  content = content.replace(/<!--corr:[^>]+-->/g, '');

  // Strip the guardrail MASK TOKEN, which is what Amazon Bedrock Guardrails leaves where it masked
  // one of the markers above: an ANONYMIZE match is replaced by the literal `{FILTER_NAME}`, so a
  // leaked ACTIVE_TASK/corr marker comes back as `{MetadataMarkerFilter}` rather than as the marker.
  //
  // THE BACKEND STRIP DOES NOT COVER THIS SURFACE. It removes the token at the guardrail boundary,
  // which protects everything written from that point on, and its marker patterns cover every
  // backend READER of stored text. Neither reaches a message already persisted in Amazon Chime SDK,
  // and this parser is what the person re-opening that conversation sees. The reported leak
  // ("...in this condensed 1-2 page report format.{MetadataMarkerFilter}") is exactly such a message.
  //
  // The filter NAME is the backend's (`backend/lib/config/guardrail-masks.ts`), duplicated here
  // because a browser bundle cannot import from the CDK/Lambda tree. `guardrail-mask-parity.test.ts`
  // reads that file and fails if the two ever disagree, which is the same shape the correlation-id
  // pattern uses for its own copies.
  //
  // PII entity masks (`{EMAIL}`, `{PHONE}`) are deliberately NOT stripped: there the mask is the
  // intended output and removing it would hide that a redaction happened.
  content = content.replace(/\{MetadataMarkerFilter\}/g, '');

  // Clean up leading/trailing whitespace from stripping
  content = content.trim();

  return { content, activeTask, navigateChannel, battle, battleWaiting };
}

interface BattleFields {
  battleId?: string;
  round?: 1 | 2;
  total?: number;
  rivalArn?: string;
  rivalReplyMsgId?: string;
  botArn?: string;
  // battlestats-only fields
  responseMs?: number;
  estCostUsd?: number | null;
  modelId?: string;
  /** URI-encoded in the marker (admin-controlled, may contain the
   *  marker's own delimiters); decoded here. */
  name?: string;
  provider?: string;
  /** URI-encoded (may contain spaces). */
  modelLabel?: string;
  tokensIn?: number;
  tokensOut?: number;
  imageCount?: number;
}

function parseBattleFields(raw: string): BattleFields {
  const result: BattleFields = {};
  for (const part of raw.split(',')) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=').trim();
    const k = key.trim();
    switch (k) {
      case 'battleId':
        result.battleId = value;
        break;
      case 'round': {
        const n = Number(value);
        if (n === 1 || n === 2) result.round = n;
        break;
      }
      case 'total':
        result.total = Number(value) || 2;
        break;
      case 'rivalArn':
        result.rivalArn = value;
        break;
      case 'rivalReplyMsgId':
        result.rivalReplyMsgId = value;
        break;
      case 'botArn':
        result.botArn = value;
        break;
      case 'responseMs': {
        const n = Number(value);
        if (Number.isFinite(n)) result.responseMs = n;
        break;
      }
      case 'estCostUsd':
        // Empty value = honest "no estimate" (rate table returned null).
        result.estCostUsd = value === '' ? null : Number(value);
        break;
      case 'modelId':
        result.modelId = value;
        break;
      case 'name':
        // URI-encoded by the async processor (displayName is
        // admin-controlled and may contain `,`/`=`/`>`).
        try {
          result.name = decodeURIComponent(value);
        } catch {
          result.name = value; // malformed % escape — use raw
        }
        break;
      case 'provider':
        result.provider = value;
        break;
      case 'modelLabel':
        try {
          result.modelLabel = decodeURIComponent(value);
        } catch {
          result.modelLabel = value;
        }
        break;
      case 'tokensIn': {
        const n = Number(value);
        if (Number.isFinite(n)) result.tokensIn = n;
        break;
      }
      case 'tokensOut': {
        const n = Number(value);
        if (Number.isFinite(n)) result.tokensOut = n;
        break;
      }
      case 'imageCount': {
        const n = Number(value);
        if (Number.isFinite(n)) result.imageCount = n;
        break;
      }
    }
  }
  return result;
}

/**
 * Parse active task from Chime message Metadata JSON field.
 */
export function parseActiveTaskFromMetadata(metadata: Record<string, unknown>): ActiveTask | null {
  if (!metadata) return null;

  const task = metadata.activeTask as Record<string, string> | undefined;
  if (!task || !task.type || !task.status || !task.label) return null;

  return {
    type: task.type,
    status: task.status,
    label: task.label,
  };
}

export function parseMessageFeedbackFromMetadata(metadata: Record<string, unknown>): 'up' | 'down' | null {
  const feedback = metadata.feedback;
  return feedback === 'up' || feedback === 'down' ? feedback : null;
}
