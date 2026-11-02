/**
 * Bot-driven conversation title auto-derive.
 *
 * On the first user turn into a channel whose name is still the
 * "New conversation" placeholder, we ask Haiku to produce a short
 * descriptive name from the user's message and write it back via
 * `UpdateChannel`. The bot is the channel's moderator (and its creator, unless
 * the service admin created it), so it has the permission to do this with its
 * own ChimeBearer — we deliberately
 * do NOT use an admin service user as a workaround for not granting the
 * bot UpdateChannel; AE grants the bot the permission properly so the
 * blast radius stays narrow.
 *
 * Best-effort: any failure here is logged and swallowed. The user's
 * actual reply is the critical path and must not be blocked or rolled
 * back because we couldn't pick a nicer title.
 */
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  UpdateChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { UTILITY_MODEL_ID } from '../../../lib/config/model-strategy.js';
import { renderPrompt } from './render-prompt.js';
import { sessionClient } from './assistant-session.js';
import { PLACEHOLDER_TITLE, namingSeed } from './conversation-name.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = sessionClient(ChimeSDKMessagingClient, { region: AWS_REGION });
const bedrockClient = sessionClient(BedrockRuntimeClient, { region: AWS_REGION });

export { PLACEHOLDER_TITLE };
const MAX_TITLE_LENGTH = 40;

// Anthropic's Haiku 3 — cheapest model available everywhere. We're not
// reasoning, just summarizing one short message into 3-6 words; even the
// smallest model handles this trivially.
const TITLE_MODEL_ID = UTILITY_MODEL_ID;

const TITLE_PROMPT = `You name conversations.

Given the user's first message below, output a short title for the
conversation (3-6 words, max ${MAX_TITLE_LENGTH} characters, no quotes,
no trailing punctuation, no emoji, Title Case). The title should
describe the substance of what the user wants help with, not be a
restatement of the message verbatim.

If the message is empty, an attachment, a greeting like "hi", or just a
slash command, output exactly: General chat

Respond with ONLY the title - no preamble, no explanation, no quotes.

User message:
{{message}}`;

function sanitizeTitle(raw: string): string | null {
  let s = (raw || '').trim();
  // Drop wrapping quotes
  s = s.replace(/^["'`\s]+|["'`\s]+$/g, '');
  // Strip trailing punctuation
  s = s.replace(/[.,;:!?]+$/g, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ');
  if (!s) return null;
  // Reject obvious refusals / model self-talk
  if (/^(i (am|'m)|here (is|are)|sorry|as an)/i.test(s)) return null;
  // Hard limit
  if (s.length > MAX_TITLE_LENGTH) {
    const cutAt = s.lastIndexOf(' ', MAX_TITLE_LENGTH);
    s = (cutAt > MAX_TITLE_LENGTH * 0.6 ? s.slice(0, cutAt) : s.slice(0, MAX_TITLE_LENGTH - 1)).replace(/\s+$/, '') + '…';
  }
  return s;
}

async function deriveTitleViaHaiku(userMessage: string): Promise<string | null> {
  // The message is the person's own text, so it goes through the renderer rather than a raw
  // `.replace`: a string replacement expands `$&` and `` $` ``, which would splice the surrounding
  // instruction into the title prompt for anyone whose message happens to contain them. See
  // `render-prompt.ts` for the two defects that shape closes.
  const prompt = renderPrompt(TITLE_PROMPT, { message: userMessage.slice(0, 2000) });
  try {
    const resp = await bedrockClient.send(new InvokeModelCommand({
      modelId: TITLE_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        // Title is at most ~10 tokens; cap generously to keep cost flat.
        max_tokens: 32,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(resp.body));
    const text = body?.content?.[0]?.text || '';
    return sanitizeTitle(text);
  } catch (err) {
    console.warn('[channel-title] Haiku derivation failed:', err);
    return null;
  }
}

/**
 * If the channel is still named "New conversation" and the incoming
 * message is a substantive user turn (not a slash command, not empty),
 * derive a Haiku-summarized title and apply it via UpdateChannel.
 *
 * Returns the new title that was applied, or null if no rename
 * happened (placeholder mismatch, already renamed, slash command,
 * derivation failed, Chime rejected the update, etc.).
 */
export async function maybeDeriveAndRenameChannel(
  channelArn: string,
  userMessage: string,
  botArn: string,
): Promise<string | null> {
  try {
    // ── EVERY PATH OUT OF HERE SAYS WHY (2026-09-09) ─────────────────────────────────────────
    //
    // This logged only on SUCCESS or on a thrown error. All five `return null` paths were silent, so
    // a conversation that was never named left no trace of which one it took - and when the rename
    // stopped happening for a completely different reason (the caller's ordinal gate, see
    // `async-processor-core`), the absence of any log was itself the only symptom. Diagnosing it
    // needed a channel describe and a history read to rule the paths out one at a time.
    //
    // `debug` rather than `warn`: not naming a channel is the ordinary case on nearly every turn.
    // WHAT NAMES THE ROOM (`namingSeed`): the message without `/md` or `/battle`, and nothing for an empty message or
    // any other slash command, since "/help" or "/clear" is not a subject. The router asks the room's primary to name a
    // room by the same rule, so a message this would refuse never claims the room's one naming.
    const withoutFormatting = namingSeed(userMessage);
    if (withoutFormatting === null) {
      console.debug('[channel-title] no rename: the message is empty or a slash command');
      return null;
    }

    const desc = await messagingClient.send(new DescribeChannelCommand({
      ChannelArn: channelArn,
      ChimeBearer: botArn,
    }));
    const currentName = desc.Channel?.Name || '';
    if (currentName !== PLACEHOLDER_TITLE) {
      // Either the user already renamed manually, or a prior turn
      // already applied a derived title - either way we leave it alone.
      console.debug('[channel-title] no rename: already named');
      return null;
    }

    // ── ONLY THE CHANNEL'S CREATOR MAY RENAME IT, AND A DUEL'S ALT IS NOT IT ──────────────────
    //
    // This module's header explains why the rename works at all: the bot is the channel's
    // creator and moderator, so `UpdateChannel` with its own bearer is permitted. That is true of the
    // PRIMARY assistant and false of the alt, which joins a battle-enabled channel as an ordinary
    // member and leaves when the duel ends.
    //
    // So a duel turn answered by the alt reached `UpdateChannel` and got `ForbiddenException`, caught
    // by the swallow below and logged as "Rename skipped (non-fatal)". Non-fatal it is; silent it was
    // not meant to be, and it reads as a permissions regression in a feature that had been working -
    // because on every non-battle turn the answering bot IS the creator.
    //
    // CHECKED BEFORE THE DERIVATION, not after: asking Haiku for a title we are not allowed to apply
    // spends a model call on every duel turn to produce a string we then throw away.
    //
    // NOT FIXED BY GRANTING THE ALT `UpdateChannel`. The alt is a transient member of somebody
    // else's conversation; letting it rename the room would widen what a duel can do to the
    // conversation hosting it, which is the opposite of what a battle is allowed to be.
    //
    // A ROOM THE SERVICE ADMIN CREATED IS NOT ANOTHER ASSISTANT'S ROOM. Person-created conversations are
    // created by the service admin (CREATOR_BEARER_ARN in channel-creation.ts, so no assistant is a member
    // before the flow is attached), and the assistant is then added as a member and moderator. Refusing
    // every creator that is not this bot left every one of those conversations named "New conversation".
    // So only a room another ASSISTANT created is refused here; in an admin-created room the moderator
    // check is Amazon Chime SDK's own, on UpdateChannel below.
    const creatorArn = desc.Channel?.CreatedBy?.Arn;
    if (creatorArn && creatorArn !== botArn && creatorArn.includes('/bot/')) {
      console.debug('[channel-title] no rename: another assistant created the channel', {
        actingBot: botArn.split('/').pop(), creator: creatorArn.split('/').pop(),
      });
      return null;
    }

    // The message without its rendering command: the title is about what was said, not how it is
    // displayed, and "/md" in a conversation name would read as a typo.
    const newTitle = await deriveTitleViaHaiku(withoutFormatting);
    if (!newTitle || newTitle === PLACEHOLDER_TITLE) {
      // LOUDER than the others: the channel WAS eligible and the derivation is what failed, so this
      // is the one no-rename that means something is wrong rather than something is ordinary.
      console.warn('[channel-title] no rename: the derivation produced no usable title', {
        derived: newTitle ?? null,
      });
      return null;
    }

    // Preserve existing Metadata + Mode so we don't trample fields
    // other subsystems set (modelTier, battle config flag, etc.).
    await messagingClient.send(new UpdateChannelCommand({
      ChannelArn: channelArn,
      Name: newTitle,
      Mode: desc.Channel?.Mode,
      Metadata: desc.Channel?.Metadata,
      ChimeBearer: botArn,
    }));

    console.log(`[channel-title] Renamed channel ${channelArn.split('/').pop()} -> "${newTitle}"`);
    return newTitle;
  } catch (err) {
    // Forbidden in an admin-created room means this assistant is a member and not a moderator (an
    // assistant addressed in another's room): the ordinary no-rename case, not a fault.
    if ((err as { name?: string })?.name === 'ForbiddenException') {
      console.debug('[channel-title] no rename: this assistant does not moderate the channel');
      return null;
    }
    console.warn('[channel-title] Rename skipped (non-fatal):', err);
    return null;
  }
}
