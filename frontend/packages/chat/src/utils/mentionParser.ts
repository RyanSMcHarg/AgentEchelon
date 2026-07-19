import type { ChannelMember } from '@ae/shared';

/** Validation outcome surfaced to the UI when the user typed something the
 *  Chime SDK can't deliver. We don't silently drop mentions — the user must
 *  decide whether to remove the extras or use @all instead. */
export type MentionValidationError =
  /** More than one distinct human was @-mentioned. `Target` is fixed-1 by the
   *  Chime API (see reference_chime_target_fixed_one); reaching multiple
   *  people requires N separate sends, which we don't build until we have a
   *  use case. */
  | 'multiple_humans'
  /** Multiple distinct bots were @-mentioned. CHIME.mentions itself is
   *  multi-entry but the resulting Target ambiguity + the cost of fanning
   *  out N bot replies isn't worth it; pick one assistant. */
  | 'multiple_bots'
  /** `@all` was combined with one or more explicit `@<member>` mentions.
   *  Broadcast and single-target visibility are mutually exclusive at the
   *  SendChannelMessage layer — Chime won't deliver both. Pick one. */
  | 'all_with_member';

export interface MentionParseResult {
  /** The ARN to set on SendChannelMessage Target. Undefined for @all or no mention. */
  targetArn?: string;
  /** The bot ARN to put in the CHIME.mentions message attribute, when the bot is mentioned. */
  mentionBotArn?: string;
  /** True if `@all` (or `@everyone`) appears — caller should bypass Target and let the channel-flow processor broadcast. */
  isAtAll: boolean;
  /** All ARNs the user mentioned, in text order. Used for UI display + the
   *  validation rules above; routing only ever uses `targetArn` /
   *  `mentionBotArn` derived from this list. */
  mentionedArns: string[];
  /** Set when the mention shape can't be delivered by Chime as-is. The
   *  caller (MessageInput) shows the message inline and blocks send. When
   *  `error` is set, `targetArn` and `mentionBotArn` are intentionally
   *  undefined — there's no safe fallback. */
  error?: MentionValidationError;
}

const AT_ALL_PATTERN = /(^|\s)@(all|everyone)\b/i;

/**
 * Parse `@<member>` mentions out of message text and decide what should
 * become the SendChannelMessage Target and CHIME.mentions attribute.
 *
 * Rules (single-target, enforced):
 *  - `@all` / `@everyone` → no Target, no CHIME.mentions. The channel-flow
 *    processor sees the broadcast intent and invokes the async processor.
 *  - `@all` combined with any `@<member>` → `error: 'all_with_member'`.
 *  - At most one human and at most one bot may be mentioned. The Chime
 *    SDK `SendChannelMessage.Target` field is fixed at 1 item by the AWS
 *    API (TS type is `Target[]` but the API enforces "Array Members:
 *    Fixed number of 1 item.") — see `reference_chime_target_fixed_one`.
 *  - More than one distinct human → `error: 'multiple_humans'`.
 *  - More than one distinct bot → `error: 'multiple_bots'`.
 *  - Exactly one human (and optionally one bot): Target = the human;
 *    CHIME.mentions = the bot (if any) so AUTO routes via MENTIONS while
 *    the human still gets visibility through Target.
 *  - Exactly one bot, no human: Target + CHIME.mentions = the bot. AUTO
 *    routes via Target and `TargetedMessages: ALL` produces the targeted
 *    reply.
 */
export function parseMentions(
  content: string,
  members: ChannelMember[],
  currentUserArn: string,
): MentionParseResult {
  const candidates = members.filter((m) => m.userArn !== currentUserArn && m.name);
  const lower = content.toLowerCase();

  const matched: Array<{ member: ChannelMember; index: number }> = [];
  for (const member of candidates) {
    const needle = `@${member.name.toLowerCase()}`;
    const index = lower.indexOf(needle);
    if (index === -1) continue;
    const charAfter = lower[index + needle.length];
    if (charAfter && /[\w]/.test(charAfter)) continue;
    matched.push({ member, index });
  }

  matched.sort((a, b) => a.index - b.index);
  const mentionedArns = matched.map((m) => m.member.userArn);

  const isAtAll = AT_ALL_PATTERN.test(content);

  if (isAtAll && matched.length > 0) {
    return { isAtAll: true, mentionedArns, error: 'all_with_member' };
  }

  if (isAtAll) {
    return { isAtAll: true, mentionedArns: [] };
  }

  const humans = matched.filter((m) => !m.member.isBot);
  const bots = matched.filter((m) => m.member.isBot);

  if (humans.length > 1) {
    return { isAtAll: false, mentionedArns, error: 'multiple_humans' };
  }
  if (bots.length > 1) {
    return { isAtAll: false, mentionedArns, error: 'multiple_bots' };
  }

  if (matched.length === 0) {
    return { isAtAll: false, mentionedArns: [] };
  }

  const humanMatch = humans[0];
  const botMatch = bots[0];

  if (humanMatch) {
    return {
      isAtAll: false,
      targetArn: humanMatch.member.userArn,
      mentionBotArn: botMatch?.member.userArn,
      mentionedArns,
    };
  }

  return {
    isAtAll: false,
    targetArn: botMatch!.member.userArn,
    mentionBotArn: botMatch!.member.userArn,
    mentionedArns,
  };
}

/** Human-readable copy for a validation error. Kept here so other surfaces
 *  (composer hint, error toast, etc.) render the same wording. */
export function mentionValidationMessage(error: MentionValidationError): string {
  switch (error) {
    case 'multiple_humans':
      return "Pick one person — direct messages can only target one member at a time. Use @all to address everyone.";
    case 'multiple_bots':
      return "Pick one assistant — only one can be mentioned per message.";
    case 'all_with_member':
      return "Use either @all or specific @-mentions, not both.";
  }
}
