/**
 * The admin assistant's Lex fulfillment, and it deliberately says nothing.
 *
 * The admin assistant exists to OWN the admin notification channel and to be the sender identity for
 * admin alerts (DESIGN-ADMIN-AGENT-NOTIFICATIONS). It has no conversational role yet, so there is
 * nothing for a turn to do here.
 *
 * IT STILL NEEDS TO EXIST. `CreateAppInstanceBot` takes a `Configuration.Lex` block and there is no
 * form of the call without one, so an AppInstanceBot cannot be created without a Lex bot behind it,
 * and a Lex bot cannot be built without a fulfillment hook. This is that hook. The alternative -
 * pointing the admin assistant at some classification's Lex - would tie the admin-plane identity to a
 * classification and make a user-plane router reachable from an admin channel, which is precisely
 * the boundary §5.1 of the design draws.
 *
 * SILENT, NOT BROKEN. Returning a message here would post it into the admin channel as the admin
 * assistant, so any accidental invocation becomes visible noise in the one room operators watch for
 * alerts. `Close` with no message is how an assistant's own Lex bot handles the same situation, and it is
 * reached only if something invokes this - which today nothing does: the bot's `WelcomeIntent` is
 * omitted at creation, so being added to a channel does not invoke it.
 *
 * WHEN THE ADMIN ASSISTANT GAINS A CONVERSATIONAL ROLE, this is where it starts, and the rule it must
 * keep is in §5 of the design: it answers only inside admin channels, only for an authenticated
 * admin, and only under that admin's own entitlement - a deputy, never an amplifier.
 */

/** The Lex V2 event shape, narrowed to what a close needs. */
interface LexEvent {
  sessionState?: { intent?: { name?: string } };
  inputTranscript?: string;
}

export const handler = async (event: LexEvent) => {
  // Logged rather than ignored: nothing should reach this today, so an invocation is a wiring fact
  // worth seeing. It is not an error - the bot is legitimately a channel member and Amazon Chime SDK
  // may route to it - so it does not throw.
  console.log('[admin-agent] Lex fulfillment reached; closing silently', {
    intent: event?.sessionState?.intent?.name,
    hasTranscript: Boolean(event?.inputTranscript),
  });

  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: {
        name: event?.sessionState?.intent?.name || 'FallbackIntent',
        state: 'Fulfilled',
      },
    },
    // NO `messages`. An empty array is what Amazon Chime SDK reads as "this bot has nothing to say",
    // and is what keeps the admin channel free of anything the operators did not ask for.
    messages: [],
  };
};
