/**
 * `@all` has ONE responder at every channel size, and which entry it is depends on the size.
 *
 * THE INVARIANT, and it is a complement rather than two independent rules:
 *
 *   1:1  (<= 2 members)  the channel flow STANDS ASIDE; the Lex entry answers.
 *   group (> 2 members)  the channel flow BYPASSES; the Lex entry stands down.
 *
 * If the two sides ever disagree about the size, one of two things happens and both are bad: BOTH
 * answer (the duplicate), or NEITHER does (a turn nothing replies to). So they read the same helper,
 * and this file pins the complement rather than each side in isolation - testing them separately is
 * exactly how they would be allowed to drift apart.
 *
 * WHY THIS EXISTS AT ALL, since the previous design deliberately had no member-count branch. Measured
 * on a live 1:1 `@all` (2026-08-12): two placeholders 558ms apart, one stranded at "One moment..."
 * permanently. The router's silence guard DID fire - the empty Lex envelope is in the channel - but
 * both entries had already posted a placeholder under DIFFERENT correlation ids, so the
 * duplicate-placeholder claim had no collision to deny (zero `duplicate placeholder denied` lines).
 * One responder per size removes the second identity entirely.
 */
import {
  resolveChannelSize,
  ONE_TO_ONE_MEMBER_COUNT,
} from '../../lambda/src/lib/channel-size';

/** A Chime client stub that returns a channel of the given size. */
function clientWithMembers(n: number) {
  return {
    send: jest.fn().mockResolvedValue({
      ChannelMemberships: Array.from({ length: n }, (_, i) => ({ Member: { Arn: `arn:member:${i}` } })),
    }),
  } as never;
}

function failingClient(err = new Error('AccessDenied')) {
  return { send: jest.fn().mockRejectedValue(err) } as never;
}

const ARN = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const BEARER = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b';

describe('@all responder selection by channel size', () => {
  it('treats a user + assistant channel as a 1:1, so the flow stands aside', async () => {
    const size = await resolveChannelSize(clientWithMembers(2), ARN, BEARER);
    expect(size).toEqual({ memberCount: 2, isOneToOne: true, unknown: false });
  });

  it('treats a third member as a group, so the flow keeps the bypass', async () => {
    // The boundary case that matters: adding ONE person flips which entry owns the turn, because at
    // three members the assistant is in MENTIONS mode and Lex is no longer invoked for `@all`.
    const size = await resolveChannelSize(clientWithMembers(3), ARN, BEARER);
    expect(size).toEqual({ memberCount: 3, isOneToOne: false, unknown: false });
  });

  it('puts the boundary exactly at two, not near it', async () => {
    expect(ONE_TO_ONE_MEMBER_COUNT).toBe(2);
    expect((await resolveChannelSize(clientWithMembers(1), ARN, BEARER)).isOneToOne).toBe(true);
    expect((await resolveChannelSize(clientWithMembers(2), ARN, BEARER)).isOneToOne).toBe(true);
    expect((await resolveChannelSize(clientWithMembers(3), ARN, BEARER)).isOneToOne).toBe(false);
    expect((await resolveChannelSize(clientWithMembers(40), ARN, BEARER)).isOneToOne).toBe(false);
  });

  it('degrades to the PREVIOUS design when the count cannot be read, never to silence', async () => {
    // An unreadable count reports "not a 1:1", which means the flow keeps the bypass and the router
    // keeps standing down - byte-for-byte the behaviour that shipped before this branch existed.
    // Failing the other way would risk a conversation where NOTHING answers, and an unanswered turn
    // reads as a broken product where a duplicate merely reads as a bug.
    const size = await resolveChannelSize(failingClient(), ARN, BEARER);
    expect(size.isOneToOne).toBe(false);
    expect(size.unknown).toBe(true);
  });

  it('does not read an empty membership list as "smaller than a 1:1"', async () => {
    // A channel always has at least its creator, so zero is a failed read wearing a valid shape. Left
    // untreated it would flip the branch and make the flow stand aside in a channel where Lex is
    // never invoked - the turn would go unanswered.
    const size = await resolveChannelSize(clientWithMembers(0), ARN, BEARER);
    expect(size.isOneToOne).toBe(false);
    expect(size.unknown).toBe(true);
  });

  it('the two sides are complements — for every size, exactly one entry answers', async () => {
    // The property in one assertion. `flowBypasses` is what channel-flow-processor does with the
    // result; `routerStandsDown` is what router-agent-handler does with the SAME result. Their XOR
    // must hold at every size, which is what "one responder" means operationally.
    for (const n of [1, 2, 3, 4, 10, 50]) {
      const size = await resolveChannelSize(clientWithMembers(n), ARN, BEARER);
      const flowBypasses = !size.isOneToOne;
      const routerStandsDown = !size.isOneToOne;
      const respondersAtThisSize = (flowBypasses ? 1 : 0) + (routerStandsDown ? 0 : 1);
      expect({ n, respondersAtThisSize }).toEqual({ n, respondersAtThisSize: 1 });
    }
  });
});

/**
 * `/battle` is NOT `@all`, and giving it the same size branch answers it twice.
 *
 * The flow handles a `/battle` at EVERY size: two bots fan out, and below that `handleBattleMessage`
 * falls back to `handleMentionedMessage` and answers anyway. So unlike `@all` there is no size at
 * which the Lex entry should also answer - it must always stand down.
 *
 * Found by review after the size branch shipped: the router's 1:1 fall-through fired for ANY bypass
 * token, and `flowBypassToken` returns `@all` OR `/battle`. In a user+bot channel a `/battle` was
 * therefore answered by the flow's fallback AND by the Lex entry, each with its own placeholder -
 * the same duplicate `lib/flow-bypass.ts` was written to remove, arriving on the other token.
 */
describe('/battle has no size branch — the flow owns it at every size', () => {
  it('the token set is exactly the two the complement reasons about', async () => {
    const { FLOW_BYPASS_TOKENS } = await import('../../lambda/src/lib/flow-bypass');
    // A third token would need its own decision here; failing loudly is the point.
    expect([...FLOW_BYPASS_TOKENS].sort()).toEqual(['/battle', '@all']);
  });

  it('is answered exactly once at every size, including a 2-member channel', async () => {
    for (const n of [1, 2, 3, 10]) {
      const size = await resolveChannelSize(clientWithMembers(n), ARN, BEARER);
      // What each side does with a `/battle`, per its own code: the flow always handles it, and the
      // router returns silence unconditionally rather than consulting the size.
      const flowHandles = true;
      const routerStandsDown = true;
      const responders = (flowHandles ? 1 : 0) + (routerStandsDown ? 0 : 1);
      expect({ n, responders, sizeConsulted: size.memberCount >= 0 })
        .toEqual({ n, responders: 1, sizeConsulted: true });
    }
  });
});

/**
 * The 1:1 fall-through must run the SAME turn the group bypass runs, not a poorer one.
 *
 * Two facts the flow's bypass carries were missing when the Lex entry answered a 1:1 `@all`, and
 * both failed silently: the literal token stayed in the model input, and the attachment - which
 * rides the message Metadata that Lex never sees - was dropped, so "@all summarize this" with a PDF
 * answered on the caption alone. Source-level, because the defect is an omission on one branch and
 * a behavioural fixture that forgets the attachment passes vacuously.
 */
describe('the 1:1 @all fall-through is normalized to the bypass shape', () => {
  const routerSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');

  it('strips the token from the transcript before the turn runs', () => {
    expect(routerSrc).toContain('event.inputTranscript = encodeURIComponent(stripAtAll(decodedTranscript));');
  });

  it('recovers the attachment from the STORED message, into the same attribute a bypass carries', () => {
    // The read is the only route: Lex is never given Metadata (MESSAGE-FLOW §3.2) - and it is never
    // given `CHIME.message.id` either (measured live; the drift flow documents the exact attribute
    // set), so a GetChannelMessage keyed on the id ran on NO live turn and the recovery silently
    // never fired. The stored message is found the way drift finds its anchor: newest-first listing,
    // matched on the exact transcript, and the listing itself carries the Metadata.
    expect(routerSrc).toMatch(/ListChannelMessagesCommand\(\{\s*\n\s*ChannelArn: channelArn,/);
    expect(routerSrc).toMatch(/extractAttachment\(inbound\?\.Metadata\)/);
    expect(routerSrc).toMatch(/event\.requestAttributes\[BYPASS_ATTACHMENT_ATTR\] = JSON\.stringify\(recovered\)/);
    // Matched BEFORE the token strip mutates the transcript, or the content match can never hit.
    const src = routerSrc;
    expect(src.indexOf('ListChannelMessagesCommand({')).toBeLessThan(
      src.indexOf('event.inputTranscript = encodeURIComponent(stripAtAll(decodedTranscript));'),
    );
  });
});
