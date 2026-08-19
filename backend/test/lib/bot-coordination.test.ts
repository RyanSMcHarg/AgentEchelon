/**
 * The bot-to-bot loop guard.
 *
 * WHAT THIS IS PROTECTING. `TargetedMessages: ALL` routes a targeted message to the target bot's
 * Lex, and Chime materialises the reply targeted back at the sender. Two bots can therefore volley
 * indefinitely, each hop a Lex invocation and potentially a model call, in a channel where no human
 * can see any of it. No such message exists in the backend today - every targeted send addresses a
 * human - so these tests pin the guard BEFORE the first one is built.
 *
 * THE PROPERTY THAT MATTERS MOST is the last describe block: the guard terminates an exchange
 * WITHOUT relying on any handler behaving correctly. Every other rule here is defence in depth.
 */

import {
  evaluateBotToBot,
  parseCoordinationMarker,
  formatCoordinationMarker,
  MAX_COORDINATION_HOP,
} from '../../lambda/src/lib/bot-coordination';

const BOT_A = 'arn:aws:chime:us-east-1:1234:app-instance/abc/bot/alpha';
const BOT_B = 'arn:aws:chime:us-east-1:1234:app-instance/abc/bot/beta';
const HUMAN = 'arn:aws:chime:us-east-1:1234:app-instance/abc/user/carol';

const nudge = formatCoordinationMarker({ kind: 'nudge', hop: 1, ref: 'battle-xyz' });
const ack = formatCoordinationMarker({ kind: 'ack', hop: 2, ref: 'battle-xyz' });

describe('parseCoordinationMarker', () => {
  it('round-trips a formatted marker', () => {
    expect(parseCoordinationMarker(nudge)).toEqual({ kind: 'nudge', hop: 1, ref: 'battle-xyz' });
  });

  it('reads a marker out of percent-encoded content, as the flow receives it', () => {
    // Chime delivers content percent-encoded to the channel flow. A guard that only matched the
    // decoded form would see no marker and deny a legitimate nudge.
    expect(parseCoordinationMarker(encodeURIComponent(`One moment ${nudge}`)))
      .toEqual({ kind: 'nudge', hop: 1, ref: 'battle-xyz' });
  });

  it('returns null on a malformed escape rather than throwing', () => {
    // `decodeURIComponent` throws on a lone `%`. Throwing here would fail the whole invocation.
    expect(parseCoordinationMarker('%')).toBeNull();
  });

  it('rejects a marker carrying a value outside the character class', () => {
    expect(parseCoordinationMarker('<!--aecoord:kind=nudge,hop=1,ref=a b-->')).toBeNull();
    expect(parseCoordinationMarker('<!--aecoord:kind=sabotage,hop=1,ref=x-->')).toBeNull();
  });

  it('returns null for ordinary content and for nothing', () => {
    expect(parseCoordinationMarker('just an answer')).toBeNull();
    expect(parseCoordinationMarker(undefined)).toBeNull();
  });
});

describe('evaluateBotToBot: what it does NOT touch', () => {
  it('waves through a human message even when it targets a bot and forges a marker', () => {
    // The marker lives in content, which a user can type. It is only consulted for a BOT sender,
    // and Chime stamps the sender ARN, so this is the line a forged marker cannot cross.
    const v = evaluateBotToBot({ senderArn: HUMAN, targetBotArns: [BOT_B], content: `hi ${nudge}` });
    expect(v).toMatchObject({ action: 'allow', reason: 'not-bot-sender' });
  });

  it('waves through an ordinary untargeted bot answer', () => {
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [], content: 'here is the answer' });
    expect(v).toMatchObject({ action: 'allow', reason: 'not-bot-targeted' });
  });

  it('waves through a bot message targeted at a HUMAN', () => {
    // The clarification question and every flow notice are this shape. extractTargetedBotArns
    // filters humans out, so they arrive here with an empty bot-target list.
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [], content: 'which did you mean?' });
    expect(v.action).toBe('allow');
  });
});

describe('evaluateBotToBot: the bounded exchange', () => {
  it('allows a well-formed nudge', () => {
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [BOT_B], content: `go ${nudge}` });
    expect(v).toMatchObject({ action: 'allow', reason: 'coordination', anomalous: false });
    expect(v.marker).toEqual({ kind: 'nudge', hop: 1, ref: 'battle-xyz' });
  });

  it('allows the ack that answers it', () => {
    const v = evaluateBotToBot({ senderArn: BOT_B, targetBotArns: [BOT_A], content: `ok ${ack}` });
    expect(v).toMatchObject({ action: 'allow', reason: 'coordination', anomalous: false });
  });

  it('denies a bot addressing itself, however well-formed the marker', () => {
    // A self-target is a guaranteed self-loop, so it is checked before the marker is even read.
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [BOT_A], content: `go ${nudge}` });
    expect(v).toMatchObject({ action: 'deny', reason: 'self-targeted', anomalous: true });
  });

  it('denies a third hop', () => {
    const hop3 = formatCoordinationMarker({ kind: 'ack', hop: 3, ref: 'battle-xyz' });
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [BOT_B], content: hop3 });
    expect(v).toMatchObject({ action: 'deny', reason: 'hop-exceeded', anomalous: true });
    expect(MAX_COORDINATION_HOP).toBe(2);
  });

  it('denies a second nudge inside one exchange', () => {
    // A nudge at hop 2 is the shape a buggy handler would emit when it answers a nudge with a nudge.
    // That is the loop, wearing a valid marker, so kind and hop have to agree.
    const v = evaluateBotToBot({
      senderArn: BOT_B,
      targetBotArns: [BOT_A],
      content: formatCoordinationMarker({ kind: 'nudge', hop: 2, ref: 'battle-xyz' }),
    });
    expect(v).toMatchObject({ action: 'deny', reason: 'wrong-hop-for-kind', anomalous: true });
  });

  it('denies an ack posing as the opening hop', () => {
    const v = evaluateBotToBot({
      senderArn: BOT_A,
      targetBotArns: [BOT_B],
      content: formatCoordinationMarker({ kind: 'ack', hop: 1, ref: 'battle-xyz' }),
    });
    expect(v).toMatchObject({ action: 'deny', reason: 'wrong-hop-for-kind' });
  });
});

describe('the guard terminates an exchange without help from any handler', () => {
  it('denies the empty envelope that ends a healthy exchange, and stays quiet about it', () => {
    // THE LOAD-BEARING CASE. A handler that wants to say nothing returns `messages: []`, and Chime
    // materialises a message from it anyway - content empty, so no marker is possible. Default-deny
    // on an unmarked bot-to-bot message is therefore what actually stops the cycle, and it holds
    // even if every handler rule above it is wrong.
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [BOT_B], content: '' });
    expect(v).toMatchObject({ action: 'deny', reason: 'unmarked' });
    // Not anomalous: this fires on every healthy duel, and the e2e guard fails a run on ERROR.
    expect(v.anomalous).toBe(false);
  });

  it('denies unmarked bot-to-bot chatter of any content', () => {
    const v = evaluateBotToBot({ senderArn: BOT_A, targetBotArns: [BOT_B], content: 'what do you think?' });
    expect(v).toMatchObject({ action: 'deny', reason: 'unmarked' });
  });

  it('bounds the volley: no sequence of allowed messages exceeds two hops', () => {
    // Walk the exchange the way the channel flow would, and assert it cannot continue. This is the
    // property in one test: hop 1 allowed, hop 2 allowed, anything after it denied.
    const exchange = [
      { from: BOT_A, to: BOT_B, content: nudge },
      { from: BOT_B, to: BOT_A, content: ack },
      { from: BOT_A, to: BOT_B, content: '' },
    ];
    const verdicts = exchange.map((m) =>
      evaluateBotToBot({ senderArn: m.from, targetBotArns: [m.to], content: m.content }));
    expect(verdicts.map((v) => v.action)).toEqual(['allow', 'allow', 'deny']);
    expect(verdicts.filter((v) => v.action === 'allow')).toHaveLength(MAX_COORDINATION_HOP);
  });
});
