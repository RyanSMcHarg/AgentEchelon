/**
 * AN ASSISTANT'S AMAZON CHIME SDK IDENTITY, for the provisioner's one build path (`assistant-provisioner.ts`):
 * how Amazon Chime SDK hands the bot a message, and which tag says the provisioner owns it.
 */
import type { Configuration } from '@aws-sdk/client-chime-sdk-identity';

export type StandardMessages = 'ALL' | 'AUTO' | 'MENTIONS' | 'NONE';

/**
 * The bot's Lex configuration.
 *
 * `StandardMessages` is `NONE` for every shipped assistant: the channel flow takes every untargeted turn
 * (ADR-041). `TargetedMessages` stays `ALL`, because `InvokedBy` with both members `NONE` is refused by
 * the service (`Either RespondsTo or InvokedBy must be set`, measured 2026-09-16, ADR-041). So a
 * targeted message always reaches Amazon Lex, which is why each assistant has a Lex bot of its own.
 *
 * `WelcomeIntent` fires when the assistant is added to a channel. Omitted for an assistant that must
 * stay silent on join (an alt), whose silent fulfillment would otherwise make Amazon Chime SDK post
 * `{"Code":500}`.
 */
export function assistantBotConfiguration(args: {
  lexBotAliasArn: string;
  welcomeIntent?: string;
  standardMessages?: StandardMessages;
}): Configuration {
  return {
    Lex: {
      LexBotAliasArn: args.lexBotAliasArn,
      LocaleId: 'en_US',
      ...(args.welcomeIntent ? { WelcomeIntent: args.welcomeIntent } : {}),
      InvokedBy: { StandardMessages: args.standardMessages ?? 'NONE', TargetedMessages: 'ALL' },
    },
  };
}

/** The tag a runtime provisioner stamps on what it creates, and the only thing its grant may reach. */
export const PROVISIONER_TAG = 'provisioner';
export const RUNTIME_PROVISIONER = 'runtime';
