/**
 * A COMMAND SENT PRIVATELY IN A ROOM IS ANSWERED BY THE LEX ENTRY, AND THE FLOW'S COPY STANDS DOWN.
 *
 * Measured 2026-09-15 on the private-stop e2e: a targeted `/stop` in a three-person room was dispatched
 * by the channel flow as an unaddressed command (the flow callback carries no `Target`), the Lex entry
 * stood down for a turn the flow owns, and the stop ran - so the refusal a private stop must get never
 * happened and the work was cancelled. See `lib/private-command.ts`.
 *
 * Pinned three ways: the decision each entry makes, the read that lets the flow's copy know, and that
 * exactly one entry answers each shape at every size.
 */
import { GetChannelMessageCommand } from '@aws-sdk/client-chime-sdk-messaging';
import * as fs from 'fs';
import * as path from 'path';
import { inboundWasTargeted, lexEntryAnswersCommand } from '../../lambda/src/lib/private-command';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';

const clientReturning = (...results: Array<unknown | Error>) => {
  const send = jest.fn();
  for (const r of results) {
    if (r instanceof Error) send.mockRejectedValueOnce(r);
    else send.mockResolvedValueOnce(r);
  }
  return { send } as never as { send: jest.Mock };
};

describe('which entry answers a command', () => {
  it('the Lex entry answers /stop in a room, because reaching it there means it was targeted', () => {
    expect(lexEntryAnswersCommand('/stop', false)).toBe(true);
  });

  it('but not in a 1:1, where the flow does not own the command at all', () => {
    expect(lexEntryAnswersCommand('/stop', true)).toBe(false);
  });

  it('and never /battle, which the flow runs itself at every size', () => {
    expect(lexEntryAnswersCommand('/battle', false)).toBe(false);
    expect(lexEntryAnswersCommand('@all', false)).toBe(false);
    expect(lexEntryAnswersCommand(null, false)).toBe(false);
  });
});

describe('reading whether the inbound message was targeted', () => {
  it('reads the stored message as the given bearer', async () => {
    const client = clientReturning({ ChannelMessage: { Target: [{ MemberArn: BOT }] } });
    await expect(inboundWasTargeted(client as never, CHANNEL, 'm-1', BOT, 0)).resolves.toBe(true);
    const cmd = client.send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(GetChannelMessageCommand);
    expect(cmd.input).toEqual({ ChannelArn: CHANNEL, MessageId: 'm-1', ChimeBearer: BOT });
  });

  it('a message with no Target is public', async () => {
    const client = clientReturning({ ChannelMessage: { Content: '/stop' } });
    await expect(inboundWasTargeted(client as never, CHANNEL, 'm-1', BOT, 0)).resolves.toBe(false);
  });

  it('retries a read that lands before the message is readable', async () => {
    const client = clientReturning(
      Object.assign(new Error('not yet'), { name: 'NotFoundException' }),
      { ChannelMessage: { Target: [{ MemberArn: BOT }] } },
    );
    await expect(inboundWasTargeted(client as never, CHANNEL, 'm-1', BOT, 0)).resolves.toBe(true);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('treats an unreadable message as public, so a public stop is never stood down on a failed read', async () => {
    const client = clientReturning(new Error('throttled'), new Error('throttled'));
    await expect(inboundWasTargeted(client as never, CHANNEL, 'm-1', BOT, 0)).resolves.toBe(false);
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});

describe('exactly one entry answers /stop, public or private, at every size', () => {
  // What each entry does, per its own code:
  //  - The flow dispatches a bare /stop in a room (it cannot see Target).
  //  - Amazon Chime SDK invokes Lex for it in a room only when it was targeted; in a 1:1, always.
  //  - The router's flow-entry copy stands down when the stored message was targeted.
  //  - The router's Lex entry answers in a room when `lexEntryAnswersCommand`, and in a 1:1 because the
  //    flow does not own the command there.
  for (const isOneToOne of [true, false]) {
    for (const targeted of [false, true]) {
      it(`${isOneToOne ? '1:1' : 'room'}, ${targeted ? 'private' : 'public'}`, () => {
        const flowDispatches = !isOneToOne;
        const flowCopyAnswers = flowDispatches && !targeted;
        const lexInvoked = isOneToOne || targeted;
        const lexAnswers = lexInvoked && (isOneToOne || lexEntryAnswersCommand('/stop', isOneToOne));
        expect((flowCopyAnswers ? 1 : 0) + (lexAnswers ? 1 : 0)).toBe(1);
        // And a private stop in a room is answered by the entry whose refusal is private.
        if (!isOneToOne && targeted) expect(lexAnswers).toBe(true);
      });
    }
  }
});

describe('a redelivered unaddressed command is claimed once', () => {
  it('the flow takes the delivery claim for a command it dispatches, as it does for @all and @<assistant>', () => {
    // Found by review: a bare `/stop` owned by the flow took no claim, so Amazon Chime SDK redelivering
    // it stopped the assistant twice and posted two acknowledgments.
    const flow = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'channel-flow-processor.ts'), 'utf8');
    const decl = flow.slice(flow.indexOf('const dispatchesATurn ='), flow.indexOf('if (dispatchesATurn && !(await claimCorrelation('));
    expect(decl).toContain("invokedCommand?.dispatch === 'primary'");
  });
});

describe('the router is wired to both decisions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');

  it('the Lex entry does not stand down for a command it answers', () => {
    expect(src).toMatch(/if \(flowAnswers && lexEntryAnswersCommand\(bypassToken, size\.isOneToOne\)\) \{/);
    expect(src).toMatch(/\} else if \(flowAnswers\) \{[\s\S]{0,300}return formatLexSilentResponse\(event\);/);
  });

  it('the flow-entry copy reads the stored message and stands down before any work', () => {
    const at = src.indexOf('await inboundWasTargeted(chimeClient, channelArn, flowMessageId, await getBotArn())');
    expect(at).toBeGreaterThan(-1);
    // WIDENED, BECAUSE THE STAND-DOWN IS NOW CONDITIONAL. It used to follow the read immediately;
    // it is now gated on `!isOneToOne`, the complement of `lexEntryAnswersCommand` - without that
    // gate both entries stood down in a 1:1 and a private `/stop` stopped nothing. The property this
    // case is about is unchanged: the stand-down happens HERE, before any work.
    expect(src.slice(at, at + 1600)).toContain('return formatLexSilentResponse(event);');
    expect(src.slice(at, at + 1600)).toContain('!commandSize.isOneToOne');
    // Before the lock is claimed and before the stop branch runs.
    expect(at).toBeLessThan(src.indexOf('let lockToRelease'));
    expect(at).toBeLessThan(src.indexOf('const parsedStop = parseStopCommand(userMessage);'));
  });
});
