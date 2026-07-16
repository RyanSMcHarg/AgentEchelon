/**
 * battle-alt-slot-handler — Lex V2 fulfillment for the /battle alt-bot slots.
 *
 * Each alt-slot AppInstanceBot (AltSlot0, AltSlot1, …) is created with a Lex
 * `WelcomeIntent` + `FallbackIntent` whose code hook points here. This handler
 * exists ONLY so the alt-slot has a valid Lex fulfillment — it is intentionally
 * a no-op that closes the intent with NO message.
 *
 * Why a dedicated, silent handler (rather than reusing a tier router):
 *   - During an active battle, alt-slot replies are produced by the channel-flow
 *     processor direct-invoking the PREMIUM async-processor. Lex is NOT on the
 *     battle reply path; it is only the alt-slot's formal `InvokedBy` handle,
 *     fired when the bot is added to a channel (WelcomeIntent).
 *   - A battle announcement is sent separately by `channel-battle.ts` via the
 *     channel's real per-tier bot, so the alt-slot must stay silent on join to
 *     avoid a duplicate/confusing greeting.
 *   - Keeping this handler inside AgentEchelonBattle (not the premium tier stack)
 *     lets the alt-slots run on a battle-OWNED Lex, independent of any tier's Lex.
 */

interface LexEvent {
  sessionState?: {
    intent?: { name?: string };
    sessionAttributes?: Record<string, string>;
  };
}

interface LexResponse {
  sessionState: {
    dialogAction: { type: 'Close' };
    intent: { name: string; state: 'Fulfilled' };
    sessionAttributes?: Record<string, string>;
  };
  messages: Array<{ contentType: string; content: string }>;
}

export const handler = async (event: LexEvent): Promise<LexResponse> => {
  const lexIntentName = event.sessionState?.intent?.name || 'FallbackIntent';
  console.log('[BattleAltSlot] Closing intent silently', { intent: lexIntentName });

  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: { name: lexIntentName, state: 'Fulfilled' },
      sessionAttributes: event.sessionState?.sessionAttributes,
    },
    // No messages: the alt-slot says nothing through Lex. Battle messaging is
    // driven by the channel-flow processor → premium async-processor.
    messages: [],
  };
};
