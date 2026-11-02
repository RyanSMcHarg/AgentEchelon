/**
 * THE NAMES AN ASSISTANT SESSION IS BUILT FROM, shared by the stack that writes the policy and the
 * Lambdas that mint and use the session.
 *
 * An assistant acts through one IAM role per classification, assumed per turn by the vend
 * (`assistant-vend.ts`) and tagged with WHICH assistant, in WHICH role, bearing WHICH bot. The policy
 * on that role compares those tags; nothing about a particular assistant is written into IAM, which is
 * what lets a classification hold any number of them (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * PURE ON PURPOSE: no CDK and no AWS SDK, because the stack cannot import a Lambda's SDK client and a
 * Lambda cannot import `aws-cdk-lib`, and both sides need these names to agree.
 */
import { botIdFromArn as parseBotId } from './person-arn.js';

/**
 * WHAT AN ASSISTANT TAKING A TURN MAY DO IN A CONVERSATION, and it is narrower than what the
 * classification boundary gates: the gated set carries moderation verbs (`RedactChannelMessage`,
 * `UpdateChannel`, `DeleteChannel`) that belong to a moderator, not to an assistant answering a turn.
 */
export const ASSISTANT_TURN_CHANNEL_ACTIONS = [
  'chime:SendChannelMessage',
  'chime:ListChannelMessages',
  'chime:GetChannelMessage',
  'chime:UpdateChannelMessage',
  'chime:DescribeChannel',
  'chime:ListChannelMemberships',
];

/**
 * THE SESSION TAG KEYS, and what each one decides.
 *
 * - `assistant`: which assistant this is. Per-assistant paths are written against it.
 * - `classification`: the boundary. The trust policy pins it to the role's own value.
 * - `role`: the assistant role (`primary`, `ops`, ...). Per-role reach is conditioned on it.
 * - `bot`: the AppInstanceBot id. The bearer resource is `.../bot/${aws:PrincipalTag/bot}`, so a
 *   session can act as exactly one identity - the same construction a person's credential uses with
 *   `.../user/${aws:PrincipalTag/person}`.
 */
export const SESSION_TAG = {
  assistant: 'assistant',
  classification: 'classification',
  role: 'role',
  bot: 'bot',
} as const;

/** The sid a reader greps for when asking which identity a session may act as. */
export const BEARER_SID = 'ActOnlyAsTheSessionsOwnBot';
/** The channel half; without it a session holds a bearer it can use nowhere. */
export const CHANNEL_SID = 'ActOnlyInThisClassificationsChannels';

/**
 * WHAT AN ASSISTANT ID MAY CONTAIN.
 *
 * The id is written into IAM resource paths through `${aws:PrincipalTag/assistant}`, so a value
 * carrying `*`, `?` or `/` could widen a path it is substituted into. The vend refuses anything else
 * before it tags a session, and the provisioner refuses it before it tags a bot.
 */
export const ASSISTANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The characters a bot id may carry before it is substituted into an IAM resource path. */
const BOT_ID_CHARS = /^[A-Za-z0-9-]+$/;

/**
 * The bot id is the last segment of an AppInstanceBot ARN (`.../app-instance/{id}/bot/{botId}`), read
 * by the one ARN helper. '' when the ARN names no bot or the id carries a character an IAM path must not.
 */
export function botIdFromArn(botArn: string): string {
  const id = parseBotId(botArn);
  return id && BOT_ID_CHARS.test(id) ? id : '';
}
