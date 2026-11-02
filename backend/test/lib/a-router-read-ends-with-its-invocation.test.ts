/**
 * A READ THE ROUTER STARTS ENDS WITH THE INVOCATION THAT STARTED IT.
 *
 * An event run's mentions are rendered from the room's live roster. The roster is read on first use and awaited by the
 * mention that needs it, so a run that mentions nobody (a continuation onto `done`, an announce with no mention) reads
 * no roster at all, and no read is left in flight when the invocation returns. A read left in flight resumes when a
 * warm container thaws for a later invocation: after the session it was started under has ended, or inside another
 * invocation's.
 *
 * The router's end of every invocation is `releaseAfterHeldWork` (held work settles, then the session is released),
 * asserted by `a-turn-acts-as-the-assistant-it-was-routed-to.test.ts`.
 */
const mockMessagingSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  return { ...actual, ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })) };
});

import { eventRunDeps } from '../../lambda/src/router-agent-handler';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/conv-ops-1`;
const BOT = `${APP}/bot/advisor`;
const LEAD = `${APP}/user/lead-1`;

/** The roster reads sent on the router's conversation client. */
const rosterReads = () => mockMessagingSend.mock.calls.filter(([cmd]) => cmd?.constructor?.name === 'ListChannelMembershipsCommand');

beforeEach(() => {
  mockMessagingSend.mockReset();
  mockMessagingSend.mockResolvedValue({ ChannelMemberships: [{ Member: { Arn: LEAD, Name: 'Lee' } }, { Member: { Arn: BOT, Name: 'Advisor' } }] });
});

const depsFor = (event: string) => eventRunDeps('e2e-incident-watch', { event, channelArn: CHANNEL } as never,
  { botArn: BOT, assistant: 'advisor' }, `${event}#k#advisor`);

describe('an event run\'s roster', () => {
  it('a run that mentions nobody reads no roster, so nothing is left in flight when the invocation returns', async () => {
    depsFor('alarm-state-changed');
    await new Promise((r) => setImmediate(r));
    expect(rosterReads()).toHaveLength(0);
  });

  it('a mention reads the roster once, awaited by the mention, and names a member', async () => {
    const deps = depsFor('alarm-state-changed');
    expect(await deps.mentionName(LEAD, 'participantRole:lead' as never)).toBe('Lee');
    expect(await deps.mentionName(`${APP}/user/someone-else`, 'participantRole:lead' as never)).toBe('');
    expect(rosterReads()).toHaveLength(1);
    expect(rosterReads()[0][0].input).toMatchObject({ ChannelArn: CHANNEL, ChimeBearer: BOT });
  });
});
