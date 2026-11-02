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
 * A duel side is waiting on the person (DESIGN-BATTLE, "A side parked on the person"). Set from the
 * `<!--battlewaiting:-->` marker the async processor puts on the message the side parks on: a clarifying
 * question (ADR-029) or a task step its chain needs input for (ADR-026). Drives the side's "Reply to this
 * side" control - distinct from `battle` (a round reply / scorecard).
 */
export interface BattleWaiting {
  battleId: string;
  botArn: string;
  /**
   * The AppInstanceUser id of the person who ran `/battle`, the only person whose answer resumes the
   * side. A display hint for who is offered the control; the router decides from the duel's own record.
   * Absent on a marker written without one.
   */
  ownerId?: string;
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
 * posts that envelope into the channel regardless, so it is the CLIENT that has to recognize it as
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
 * Does this message say it IS the answer, rather than a stand-in for one?
 *
 * The client decides "this is the async placeholder" from a `<!--corr:-->` marker, which was a
 * complete rule while the only marked messages were placeholders. A turn the handler answers itself
 * now carries the same marker so the pairing can be declared rather than guessed at, and it posts
 * once with no update to follow - so read as a placeholder, its timings are dropped and the turn
 * reports no answer at all.
 *
 * Mirrors `backend/lambda/src/lib/turn-declaration.ts`. The rule has to hold on both sides of the
 * wire and there is no shared module across that boundary; `message-markers.ts` says the same thing
 * about the marker set it mirrors.
 *
 * Content reaches a client in either form, so both are tested - the same reason the backend's Lex
 * envelope reader checks the percent-decoded form.
 */
export function declaresFinalAnswer(rawContent: string | undefined | null): boolean {
  if (!rawContent) return false;
  const decoded = (() => {
    try { return decodeURIComponent(rawContent); } catch { return rawContent; }
  })();
  for (const form of new Set([rawContent, decoded])) {
    // Bounded and character-classed exactly as the writer builds it, so a crafted marker in prose
    // cannot assert that somebody else's placeholder is finished.
    //
    // THE LAST DECLARATION WINS, which is the backend's rule and has to be this side's too. The
    // writer strips any declaration already present before appending its own, so the real one is
    // always last - and a crafted marker travelling in composed model text therefore sits BEFORE it.
    // Reading the first match handed that forged one the answer: a finished DIRECT turn read as an
    // unfinished placeholder, and its timings were dropped. Global match, last entry.
    const all = [...form.matchAll(/<!--turn:([A-Za-z0-9._;=-]{1,512})-->/g)];
    const declaration = all.length ? all[all.length - 1] : null;
    if (declaration && declaration[1].split(';').includes('phase=final')) return true;
  }
  return false;
}

/**
 * Parse message content to extract active task markers, drift-redirect
 * markers, and clean up internal markers.
 */
/**
 * MESSAGE TEXT AS A PERSON SHOULD READ IT, whatever form it arrived in.
 *
 * Content reaches a client percent-encoded on most paths and raw on some, and raw text may hold a bare
 * `%` ("usage down 30%"). `decodeURIComponent` throws on that, and two readers called it unguarded:
 * the live message handler and the history loader. The throw dropped the message - measured live
 * 2026-10-05, a duel prompt containing "30%" raised two uncaught "URI malformed" errors in the chat
 * page. Every other reader already fell back to the raw text; this is that fallback, once.
 */
export function decodeMessageText(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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

  // Extract <!--battlewaiting:battleId=X,botArn=Y,owner=Z--> - set by the async processor on the
  // message a duel side parks on (a clarifying question, or a task step that carries battlestats too).
  // Drives the side's reply control.
  const waitingMatch = content.match(BATTLEWAITING_MARKER_PATTERN);
  if (waitingMatch) {
    const f = parseBattleFields(waitingMatch[1]);
    if (f.battleId && f.botArn) {
      battleWaiting = { battleId: f.battleId, botArn: f.botArn, ...(f.owner ? { ownerId: f.owner } : {}) };
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
  // Battle correlation IDs include extra prefix segments (e.g. "battle-r1-Alt-premium-...")
  // so we widen the pattern to accept any UUID-ish or hyphen-delimited token.
  content = content.replace(/<!--corr:[^>]+-->/g, '');

  // Strip <!--turn:k=v;k=v--> declarations, which state what the turn answered and which phase it is.
  //
  // READ ABOVE, REMOVED HERE, and both are needed. `declaresFinalAnswer` takes the RAW content and so
  // still sees this; what a person reads must not. Every other marker in this function is stripped
  // because it is addressed to the platform rather than to the reader, and this one is no different.
  //
  // IT SURFACED ON THE HANDLER-ANSWERED PATH because that is the one where it survives. A placeholder
  // carrying a declaration is replaced by its own update, so the marker goes with it; a turn the
  // handler answers itself (`router-agent-handler.ts`, `withTurnDeclaration`) posts ONCE and is
  // already final, so nothing ever rewrites the content. A clarification answer is exactly that
  // shape, which is where it was seen.
  //
  // The pattern is the writer's, bounded and character-classed, so it cannot run away on crafted
  // input - the same rule `declaresFinalAnswer` matches with.
  content = content.replace(/<!--turn:[A-Za-z0-9._;=-]{1,512}-->/g, '');

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
  /** battlewaiting only: the duel owner's AppInstanceUser id, URI-encoded in the marker. */
  owner?: string;
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
      case 'owner':
        try {
          result.owner = decodeURIComponent(value);
        } catch {
          result.owner = value;
        }
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
