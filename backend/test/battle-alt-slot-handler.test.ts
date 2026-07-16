/**
 * Alt-slot Lex fulfillment unit tests (battle relocation, AgentEchelonBattle).
 *
 * The alt-bot slots run on a battle-OWNED Lex (not the shared/per-tier one).
 * Their Lex fulfillment is `battle-alt-slot-handler.ts`, which MUST be silent:
 * real battle replies come from channel-flow → premium async-processor, so the
 * Lex hook is only the alt-slot's formal `InvokedBy` handle and must close every
 * intent with NO message (e.g. a silent join when channel-battle enable adds the
 * slot). These tests pin that contract: valid Lex V2 Close + Fulfilled + empty
 * messages, intent name echoed back, session attributes preserved.
 */

import { handler } from '../lambda/src/battle-alt-slot-handler';

describe('battle-alt-slot-handler (silent alt-slot Lex fulfillment)', () => {
  it('closes WelcomeIntent silently (Close + Fulfilled + no messages)', async () => {
    const res = await handler({
      sessionState: { intent: { name: 'WelcomeIntent' } },
    });

    expect(res.sessionState.dialogAction.type).toBe('Close');
    expect(res.sessionState.intent.state).toBe('Fulfilled');
    expect(res.sessionState.intent.name).toBe('WelcomeIntent');
    // The whole point: the alt-slot says nothing through Lex.
    expect(res.messages).toEqual([]);
  });

  it('echoes the incoming intent name (FallbackIntent) and stays silent', async () => {
    const res = await handler({
      sessionState: { intent: { name: 'FallbackIntent' } },
    });
    expect(res.sessionState.intent.name).toBe('FallbackIntent');
    expect(res.messages).toEqual([]);
  });

  it('defaults to FallbackIntent when no intent is present', async () => {
    const res = await handler({});
    expect(res.sessionState.intent.name).toBe('FallbackIntent');
    expect(res.sessionState.dialogAction.type).toBe('Close');
    expect(res.messages).toEqual([]);
  });

  it('preserves inbound session attributes (does not drop conversation state)', async () => {
    const res = await handler({
      sessionState: {
        intent: { name: 'WelcomeIntent' },
        sessionAttributes: { foo: 'bar' },
      },
    });
    expect(res.sessionState.sessionAttributes).toEqual({ foo: 'bar' });
  });
});
