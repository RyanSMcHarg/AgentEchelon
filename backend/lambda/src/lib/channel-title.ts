/**
 * Bot-driven conversation title auto-derive.
 *
 * On the first user turn into a channel whose name is still the
 * "New conversation" placeholder, we ask Haiku to produce a short
 * descriptive name from the user's message and write it back via
 * `UpdateChannel`. The bot is the channel creator+moderator, so it has
 * the permission to do this with its own ChimeBearer — we deliberately
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

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = new ChimeSDKMessagingClient({ region: AWS_REGION });
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

const PLACEHOLDER_TITLE = 'New conversation';
const MAX_TITLE_LENGTH = 40;

// Anthropic's Haiku 3 — cheapest model available everywhere. We're not
// reasoning, just summarising one short message into 3-6 words; even the
// smallest model handles this trivially.
const TITLE_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

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
  // Hard ceiling
  if (s.length > MAX_TITLE_LENGTH) {
    const cutAt = s.lastIndexOf(' ', MAX_TITLE_LENGTH);
    s = (cutAt > MAX_TITLE_LENGTH * 0.6 ? s.slice(0, cutAt) : s.slice(0, MAX_TITLE_LENGTH - 1)).replace(/\s+$/, '') + '…';
  }
  return s;
}

async function deriveTitleViaHaiku(userMessage: string): Promise<string | null> {
  const prompt = TITLE_PROMPT.replace('{{message}}', userMessage.slice(0, 2000));
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
 * derive a Haiku-summarised title and apply it via UpdateChannel.
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
    const trimmed = (userMessage || '').trim();
    if (!trimmed) return null;
    // Slash commands shouldn't seed the title - "/battle Compare X and Y"
    // is interesting, but "/help" or "/clear" isn't. Skip the whole
    // family rather than reason about which ones are good seeds.
    if (trimmed.startsWith('/')) return null;

    const desc = await messagingClient.send(new DescribeChannelCommand({
      ChannelArn: channelArn,
      ChimeBearer: botArn,
    }));
    const currentName = desc.Channel?.Name || '';
    if (currentName !== PLACEHOLDER_TITLE) {
      // Either the user already renamed manually, or a prior turn
      // already applied a derived title - either way we leave it alone.
      return null;
    }

    const newTitle = await deriveTitleViaHaiku(trimmed);
    if (!newTitle || newTitle === PLACEHOLDER_TITLE) return null;

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
    console.warn('[channel-title] Rename skipped (non-fatal):', err);
    return null;
  }
}
