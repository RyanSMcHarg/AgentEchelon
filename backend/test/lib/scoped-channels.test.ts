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

afterEach(() => jest.restoreAllMocks());

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

  it('searches AS THE ASSISTANT, whose own ARN is already a filter value', async () => {
    // This once asserted a HUMAN bearer, on the reading that `BadRequestException: AppInstanceUser
    // must include its own ARN for MEMBERS field` meant a bot cannot bear. Measured against the live
    // API 2026-09-30: a bot bears `SearchChannels` and AND-filters identically. That error is about
    // the BEARER needing its own ARN among the values, which the assistant satisfies by being an
    // intersection term. Counted to exhaustion, bot-bearer and human-bearer returned the same 265.
    prime([userArn('a'), userArn('b')], [CHANNEL]);
    await call();

    const list = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'ListMemberships');
    const search = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__type === 'Search');
    expect(list.input.ChimeBearer).toBe(BOT);
    expect(search.input.ChimeBearer).toBe(BOT);
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

  it('stops at the page cap and keeps only conversations that matched the full filter', async () => {
    // A history shared with the assistant costs one search per 50 conversations. 597 measured 12
    // sequential searches a turn and was throttled under a burst; the cap bounds that. Stopping early
    // keeps pages that each satisfied the WHOLE filter, so the scope can only narrow.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MAX_SCOPE_PAGES } = require('../../lambda/src/lib/scoped-channels');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let searchPage = 0;
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd.__type === 'ListMemberships') return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }] };
      searchPage++;
      return { Channels: [{ ChannelArn: `${APP}/channel/p${searchPage}` }], NextToken: `s${searchPage + 1}` };
    });

    const arns = await call();

    expect(searchPage).toBe(MAX_SCOPE_PAGES);
    expect(arns).toEqual(Array.from({ length: MAX_SCOPE_PAGES }, (_, i) => `${APP}/channel/p${i + 1}`));
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`stopped at ${MAX_SCOPE_PAGES} pages`))).toBe(true);
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
      // And it BEARS the search too, so the term and the bearer are the same principal.
      expect(search.input.ChimeBearer).toBe(BOT);
    });

    it('leaves room for the assistant in the filter cap', async () => {
      // 10 humans + the assistant would be 11 values. The cap is on HUMANS for that reason.
      prime(Array.from({ length: 10 }, (_, i) => userArn(`u${i}`)), [CHANNEL]);
      expect(await call()).toEqual([]);
      expect(mockSend.mock.calls.map((c) => c[0]).some((c) => c.__type === 'Search')).toBe(false);
    });
  });

  describe('when the ASSISTANT exceeds the channel-membership limit', () => {
    // Measured on this deployment: the search refuses at 1038 channels for the bearer, and the
    // assistant sat at 388 when it took over the bearing (2026-09-30). It is the principal that
    // grows fastest - one membership per conversation of its classification - so it is the one that
    // will cross first. Rotation is gone with the human bearer, so there is nothing to fall back to
    // and EVERY conversation loses drift at once. Owner accepted that risk; the requirement here is
    // that it is not silent. Live error text, 2026-08-08.
    const limitError = Object.assign(
      new Error('Primary search user arn:...:user/x exceeds channel membership limit to perform search.'),
      { name: 'BadRequestException' },
    );

    it('fails CLOSED and says the ASSISTANT is the one over the limit', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }, { Member: { Arn: userArn('b') } }] };
        }
        throw limitError;
      });
      expect(await call()).toEqual([]);
      // A deployment-wide outage of the feature must not read as 'no suggestion today'. The old
      // per-person limit was a warning because another member could answer; this one cannot be.
      const said = err.mock.calls.flat().join(' ');
      expect(said).toMatch(/SERVING ASSISTANT IS OVER THE CHANNEL MEMBERSHIP LIMIT/);
    });

    it('falls back to a HUMAN bearer, asking the IDENTICAL filter', async () => {
      // The fallback that was rejected intersected each member's own channel list and could not carry
      // the assistant term, so it answered a WIDER question. Changing the bearer changes only who asks:
      // measured 2026-09-30, human bearer with [human, bot] returned the same 265 as bot bearer with
      // [human, bot]. So this must re-ask with the values UNCHANGED, which is what the last assertion pins.
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }, { Member: { Arn: userArn('b') } }] };
        }
        if (cmd.input.ChimeBearer === BOT) throw limitError;
        return { Channels: [{ ChannelArn: CHANNEL }] };
      });

      expect(await call()).toEqual([CHANNEL]);
      const searches = mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__type === 'Search');
      expect(searches.map((x: any) => x.input.ChimeBearer)).toEqual([BOT, userArn('a')]);
      // The assistant term must survive the handover, or the fallback would widen the scope.
      expect(searches[1].input.Fields[0].Values).toEqual(searches[0].input.Fields[0].Values);
      expect(searches[1].input.Fields[0].Values).toContain(BOT);
    });

    it('tries the next human when one of them is over the limit too', async () => {
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('heavy') } }, { Member: { Arn: userArn('light') } }] };
        }
        if (cmd.input.ChimeBearer === userArn('light')) return { Channels: [{ ChannelArn: CHANNEL }] };
        throw limitError;
      });
      expect(await call()).toEqual([CHANNEL]);
      const bearers = mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__type === 'Search')
        .map((x: any) => x.input.ChimeBearer);
      expect(bearers).toEqual([BOT, userArn('heavy'), userArn('light')]);
    });

    it('fails CLOSED, and says so as an ERROR, when the assistant AND every human are over', async () => {
      // The assistant being over the limit is a deployment-wide condition: every conversation it serves
      // then depends on a human under the limit. That is worth an error, because the symptom is silence.
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockSend.mockImplementation(async (cmd: any) => {
        if (cmd.__type === 'ListMemberships') {
          return { ChannelMemberships: [{ Member: { Arn: userArn('a') } }, { Member: { Arn: userArn('b') } }] };
        }
        throw limitError;
      });
      expect(await call()).toEqual([]);
      expect(err.mock.calls.flat().join(' ')).toMatch(/OVER THE CHANNEL MEMBERSHIP LIMIT and so is every/);
    });

    it('does NOT fall back for an unrelated BadRequestException', async () => {
      // Anything other than the membership limit is about the REQUEST and would fail identically for
      // every bearer, so a fallback would multiply one failure instead of answering it. It must also
      // not borrow the deployment-wide wording, which would send the reader after a capacity problem
      // they do not have.
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
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
      expect(err.mock.calls.flat().join(' ')).not.toMatch(/OVER THE CHANNEL MEMBERSHIP LIMIT/);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/channel search failed/);
    });
  });
});
