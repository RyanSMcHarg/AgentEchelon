/**
 * ADR-012 drift scoping: a related conversation may be suggested only if EVERY current human member
 * of this one already has access to it.
 *
 * This is the highest-risk surface in drift detection — a bug here surfaces one person's conversation
 * to another — and it used to be computed from the Aurora `channel_membership` archive, which the
 * Kinesis path fills asynchronously. Both lag directions leak, and they leak precisely when
 * membership has just changed:
 *
 *   - a member who JOINED but is not projected yet is left out of the intersection ⇒ the scope comes
 *     out WIDER than the people in the room;
 *   - a channel someone was REMOVED from that is still projected stays in their set ⇒ the
 *     intersection can include a conversation they can no longer open.
 *
 * So the tests below are mostly about what it REFUSES to answer. Every unanswerable case must return
 * an empty scope (suggest nothing) and none of them may fall back to the archive.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class {
    send = mockSend;
  },
  ListChannelMembershipsCommand: class {
    constructor(public input: Record<string, unknown>) { (this as any).__type = 'ListMemberships'; }
  },
  SearchChannelsCommand: class {
    constructor(public input: Record<string, unknown>) { (this as any).__type = 'Search'; }
  },
  ListChannelMembershipsForAppInstanceUserCommand: class {
    constructor(public input: Record<string, unknown>) { (this as any).__type = 'ListForUser'; }
  },
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveScopedChannelArns } = require('../../lambda/src/lib/scoped-channels');

const APP = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CHANNEL = `${APP}/channel/current`;
const BOT = `${APP}/bot/premium`;

const userArn = (s: string) => `${APP}/user/${s}`;

/** Membership reply then search reply, matched by command type rather than call order. */
function prime(members: string[], channels: string[]) {
  mockSend.mockImplementation(async (cmd: any) => {
    if (cmd.__type === 'ListMemberships') {
      return { ChannelMemberships: members.map((m) => ({ Member: { Arn: m } })) };
    }
    if (cmd.__type === 'Search') {
      return { Channels: channels.map((c) => ({ ChannelArn: c })) };
    }
    return {};
  });
}

const call = () => resolveScopedChannelArns({ currentChannelArn: CHANNEL, bearerArn: BOT, client: { send: mockSend } });

beforeEach(() => mockSend.mockReset());

describe('resolveScopedChannelArns', () => {
  it('asks the messaging service for the channels ALL human members share', async () => {
    prime([userArn('a'), userArn('b'), `${APP}/bot/premium`], [CHANNEL, `${APP}/channel/other`]);

    const arns = await call();

    expect(arns).toEqual([CHANNEL, `${APP}/channel/other`]);
    const search = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Search');
    // MEMBERS…INCLUDES with several values is an AND: channels containing ALL of them. That IS the
    // ADR-012 intersection, answered by the service that owns membership.
    expect(search.input.Fields).toEqual([
      { Key: 'MEMBERS', Values: [userArn('a'), userArn('b'), BOT], Operator: 'INCLUDES' },
    ]);
    // Other bots in the channel are NOT intersection seeds — one bot's membership says nothing about
    // who may see what. The SERVING assistant is the exception and is added deliberately: the scope is
    // this assistant's read authority, so it must not include a conversation the assistant is not in.
    expect(search.input.Fields[0].Values.filter((v: string) => v.includes('/bot/'))).toEqual([BOT]);
  });

  it('searches AS A MEMBER, because the service rejects any other bearer', async () => {
    // Verified against the live API: searching as the assistant's bot returns
    // `BadRequestException: AppInstanceUser must include its own ARN for MEMBERS field`. The bearer
    // has to be one of the people in the filter — which also bounds the search to channels that
    // member already belongs to. The membership read keeps the bot bearer, where it works.
    prime([userArn('a'), userArn('b')], [CHANNEL]);
    await call();

    const list = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'ListMemberships');
    const search = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Search');
    expect(list.input.ChimeBearer).toBe(BOT);
    expect(search.input.ChimeBearer).toBe(userArn('a'));
    // The constraint the service enforces: the bearer's own ARN is in the MEMBERS values.
    expect(search.input.Fields[0].Values).toContain(search.input.ChimeBearer);
  });

  it('suggests NOTHING when the membership read fails', async () => {
    // Fail closed. The alternative — answering from the archive — is the lag this exists to remove,
    // and it would do it silently on the path where the consequence is disclosure.
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await call()).toEqual([]);
  });

  it('suggests NOTHING when the channel search fails', async () => {
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd.__type === 'ListMemberships') return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }] };
      throw new Error('throttled');
    });
    expect(await call()).toEqual([]);
  });

  it('suggests NOTHING for a channel with no human members', async () => {
    prime([`${APP}/bot/premium`], [CHANNEL]);
    expect(await call()).toEqual([]);
  });

  it('suggests NOTHING rather than scoping on a SUBSET of a large room', async () => {
    // Beyond what one MEMBERS filter can express, the intersection cannot be asked for in a single
    // query. Scoping on the first N members would silently answer a different, wider question.
    prime(Array.from({ length: 11 }, (_, i) => userArn(`u${i}`)), [CHANNEL]);
    expect(await call()).toEqual([]);
    expect(mockSend.mock.calls.map((c) => c[0]).some((c) => c.__type === 'Search')).toBe(false);
  });

  it('pages through both calls, so a long list is not silently truncated', async () => {
    let memberPage = 0;
    let searchPage = 0;
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd.__type === 'ListMemberships') {
        memberPage++;
        return memberPage === 1
          ? { ChannelMemberships: [{ Member: { Arn: userArn('a') } }], NextToken: 'm2' }
          : { ChannelMemberships: [{ Member: { Arn: userArn('b') } }] };
      }
      searchPage++;
      return searchPage === 1
        ? { Channels: [{ ChannelArn: `${APP}/channel/one` }], NextToken: 's2' }
        : { Channels: [{ ChannelArn: `${APP}/channel/two` }] };
    });

    const arns = await call();

    expect(arns).toEqual([`${APP}/channel/one`, `${APP}/channel/two`]);
    const search = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Search');
    expect(search.input.Fields[0].Values).toEqual([userArn('a'), userArn('b'), BOT]);
  });

  describe('the serving assistant is part of the intersection', () => {
    // Without the assistant in the filter, the scope is "channels every human shares" - which can
    // include a conversation THIS assistant was never added to. The related-conversation lookup reads
    // summaries straight from Aurora, where no Chime membership check applies, so the scope IS the
    // access control and the assistant could surface a conversation it is not in.
    it('sends the assistant ARN as a MEMBERS value alongside the humans', async () => {
      prime([userArn('a'), userArn('b')], [CHANNEL]);
      await call();
      const search = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Search');
      expect(search.input.Fields[0].Values).toEqual([userArn('a'), userArn('b'), BOT]);
      // The bearer stays a HUMAN: a bot is not an AppInstanceUser and the service refuses it.
      expect(search.input.ChimeBearer).toBe(userArn('a'));
    });

    it('leaves room for the assistant in the filter cap', async () => {
      // 10 humans + the assistant would be 11 values. The cap is on HUMANS for that reason.
      prime(Array.from({ length: 10 }, (_, i) => userArn(`u${i}`)), [CHANNEL]);
      expect(await call()).toEqual([]);
      expect(mockSend.mock.calls.map((c) => c[0]).some((c) => c.__type === 'Search')).toBe(false);
    });
  });

  describe('when a search bearer exceeds the channel-membership limit', () => {
    // Measured on this deployment: the search refuses at 1038 channels for the bearer. The limit is a
    // property of the PERSON, and only the BEARER is checked - so another member can answer the same
    // question. Live error text, 2026-08-08.
    const limitError = Object.assign(
      new Error('Primary search user arn:...:user/x exceeds channel membership limit to perform search.'),
      { name: 'BadRequestException' },
    );

    it('retries with a DIFFERENT human, because the answer is bearer-independent', async () => {
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('heavy') } }, { Member: { Arn: userArn('light') } }] };
        }
        if (cmd.input.ChimeBearer === userArn('heavy')) throw limitError;
        return { Channels: [{ ChannelArn: CHANNEL }] };
      });

      expect(await call()).toEqual([CHANNEL]);
      const searches = mockSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'Search');
      expect(searches.map((s: any) => s.input.ChimeBearer)).toEqual([userArn('heavy'), userArn('light')]);
      // The retry asks the SAME question - the assistant term must survive it.
      expect(searches[1].input.Fields[0].Values).toContain(BOT);
    });

    it('fails CLOSED when EVERY human is over the limit', async () => {
      // The per-member-list fallback is deliberately not used here: it cannot apply the assistant
      // term, so it would answer a WIDER question than the primary path on exactly the heaviest
      // accounts. A fallback less safe than the path it backs up is worse than none.
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }, { Member: { Arn: userArn('b') } }] };
        }
        throw limitError;
      });
      expect(await call()).toEqual([]);
    });

    it('does NOT retry another bearer for an unrelated BadRequestException', async () => {
      // Anything other than the membership limit is about the REQUEST, and would fail identically for
      // every member; retrying would just multiply the same failure.
      let searches = 0;
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }, { Member: { Arn: userArn('b') } }] };
        }
        searches++;
        throw Object.assign(new Error('An invalid ARN was supplied for the input parameter.'), { name: 'BadRequestException' });
      });
      expect(await call()).toEqual([]);
      expect(searches).toBe(1);
    });
  });
});
