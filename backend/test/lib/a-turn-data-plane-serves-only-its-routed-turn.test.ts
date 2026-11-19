/**
 * A CLASSIFICATION'S TURN DATA PLANE SERVES ONLY A TURN ROUTED TO THAT CLASSIFICATION
 * (`turn-data-plane-binding.ts`).
 *
 * A Lambda invoke carries no caller identity, so the data plane used to run whatever classification and
 * conversation the payload named. Each classification now has its own turn data plane, pinned by
 * environment, and this is the code half of that pin: the classification is the function's, the turn
 * must be routed in its table, and a channel-keyed read is served only for the conversation the record
 * names.
 */
jest.unmock('../../lambda/src/lib/turn-routing');

import { bindTurnRequest, TurnBindingRefused, TURN_OPS } from '../../lambda/src/analytics-aurora/turn-data-plane-binding';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const OTHER = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c2';
const env = { DATA_PLANE_CLASSIFICATION: 'standard', TURN_ROUTING_TABLE: 'ae-turn-routing-standard' } as NodeJS.ProcessEnv;

/** A routing table holding at most one record, as GetItem returns it. */
function table(record?: { classification: string; channelArn?: string; threadRelatives?: string[]; expiresAt?: number }) {
  return {
    send: jest.fn(async () => ({
      Item: record ? {
        correlationId: { S: 'route-1' },
        botArn: { S: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b' },
        classification: { S: record.classification },
        ...(record.channelArn ? { channelArn: { S: record.channelArn } } : {}),
        ...(record.threadRelatives?.length ? { threadRelatives: { SS: record.threadRelatives } } : {}),
        expiresAt: { N: String(record.expiresAt ?? Math.floor(Date.now() / 1000) + 3600) },
      } : undefined,
    })),
  };
}

describe('the shared data plane is unchanged', () => {
  it('passes a request through when the function is pinned to no classification', async () => {
    const req = { op: 'adminListMessages', input: { channelArn: CHANNEL } };
    await expect(bindTurnRequest(req, { env: {} as NodeJS.ProcessEnv, ddb: table() })).resolves.toBe(req);
  });
});

describe('a classification\'s turn data plane', () => {
  it('refuses anything that is not a turn operation', async () => {
    await expect(bindTurnRequest({ op: 'adminListMessages', input: {}, routeId: 'route-1' }, { env, ddb: table({ classification: 'standard' }) }))
      .rejects.toBeInstanceOf(TurnBindingRefused);
    expect(TURN_OPS.has('adminListMessages')).toBe(false);
  });

  it('refuses a call that names no routed turn', async () => {
    await expect(bindTurnRequest({ op: 'getSummary', input: { channelArn: CHANNEL } }, { env, ddb: table({ classification: 'standard', channelArn: CHANNEL }) }))
      .rejects.toThrow('no routing record');
  });

  it('refuses a turn that is not in its routing table', async () => {
    await expect(bindTurnRequest({ op: 'getSummary', input: { channelArn: CHANNEL }, routeId: 'route-1' }, { env, ddb: table() }))
      .rejects.toThrow('not routed');
  });

  it('refuses a turn routed to another classification', async () => {
    await expect(bindTurnRequest({ op: 'retrieve', input: {}, routeId: 'route-1' }, { env, ddb: table({ classification: 'premium' }) }))
      .rejects.toThrow('another classification');
  });

  it('refuses another conversation than the one the turn was routed in', async () => {
    await expect(bindTurnRequest({ op: 'getSummary', input: { channelArn: OTHER }, routeId: 'route-1' }, { env, ddb: table({ classification: 'standard', channelArn: CHANNEL }) }))
      .rejects.toThrow('not the one the turn was routed in');
  });

  it('refuses a channel read when the record names no conversation at all', async () => {
    await expect(bindTurnRequest({ op: 'getSummary', input: { channelArn: CHANNEL }, routeId: 'route-1' }, { env, ddb: table({ classification: 'standard' }) }))
      .rejects.toBeInstanceOf(TurnBindingRefused);
  });

  it('refuses an expired record', async () => {
    await expect(bindTurnRequest({ op: 'retrieve', input: {}, routeId: 'route-1' }, { env, ddb: table({ classification: 'standard', expiresAt: 1 }) }))
      .rejects.toThrow('not routed');
  });

  it('runs at its own classification and scope whatever the payload claims', async () => {
    const bound = await bindTurnRequest(
      { op: 'retrieve', input: { query: 'q', classification: 'premium', classificationScope: ['basic', 'standard', 'premium'] }, routeId: 'route-1' },
      { env, ddb: table({ classification: 'standard', channelArn: CHANNEL }) },
    );
    const input = bound.input as { classification: string; classificationScope: string[] };
    expect(input.classification).toBe('standard');
    expect(input.classificationScope).toEqual(profiles.grantsFor('standard' as never));
    expect(input.classificationScope).not.toContain('premium');
  });

  it('serves the conversation the turn was routed in', async () => {
    const bound = await bindTurnRequest({ op: 'getSummary', input: { channelArn: CHANNEL }, routeId: 'route-1' }, { env, ddb: table({ classification: 'standard', channelArn: CHANNEL }) });
    expect((bound.input as { channelArn: string }).channelArn).toBe(CHANNEL);
  });
});

describe('a drift outcome is recorded only on a drift event of the routed conversation', () => {
  const routed = table({ classification: 'standard', channelArn: CHANNEL });
  const events = new Map<string, string>([['evt-here', CHANNEL], ['evt-there', OTHER]]);
  const driftEventChannel = jest.fn(async (eventId: string) => events.get(eventId) ?? null);
  const outcome = (input: Record<string, unknown>, record = routed) =>
    bindTurnRequest({ op: 'recordDriftOutcome', input, routeId: 'route-1' }, { env, ddb: record, driftEventChannel });

  it('records an outcome on an event of the conversation the turn was routed in', async () => {
    const bound = await outcome({ eventId: 'evt-here', outcome: 'declined' });
    expect((bound.input as { eventId: string }).eventId).toBe('evt-here');
    expect(driftEventChannel).toHaveBeenCalledWith('evt-here');
  });

  it('DENY: an event of another conversation is refused', async () => {
    await expect(outcome({ eventId: 'evt-there', outcome: 'accepted' })).rejects.toThrow('drift event is not one of the conversation');
  });

  it('DENY: an event that does not exist is refused', async () => {
    await expect(outcome({ eventId: 'evt-missing', outcome: 'declined' })).rejects.toBeInstanceOf(TurnBindingRefused);
  });

  it('DENY: a call naming no event is refused', async () => {
    await expect(outcome({ outcome: 'declined' })).rejects.toThrow('no drift event named');
  });

  it('DENY: a turn routed in no conversation is refused', async () => {
    await expect(outcome({ eventId: 'evt-here', outcome: 'declined' }, table({ classification: 'standard' }))).rejects.toBeInstanceOf(TurnBindingRefused);
  });

  it('DENY: a failed event read refuses rather than records', async () => {
    await expect(bindTurnRequest(
      { op: 'recordDriftOutcome', input: { eventId: 'evt-here', outcome: 'declined' }, routeId: 'route-1' },
      { env, ddb: routed, driftEventChannel: async () => { throw new Error('database unavailable'); } },
    )).rejects.toThrow('database unavailable');
  });
});

describe('a thread relative is read across conversations by its summary alone', () => {
  const routed = { classification: 'standard', channelArn: CHANNEL, threadRelatives: [OTHER] };
  const NOT_NAMED = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c3';

  it('admits a relative\'s getSummary when the routing record names that relative', async () => {
    const bound = await bindTurnRequest({ op: 'getSummary', input: { channelArn: OTHER }, routeId: 'route-1' }, { env, ddb: table(routed) });
    expect((bound.input as { channelArn: string }).channelArn).toBe(OTHER);
  });

  it('DENY: a getSummary for a conversation the record does not name is refused', async () => {
    await expect(bindTurnRequest({ op: 'getSummary', input: { channelArn: NOT_NAMED }, routeId: 'route-1' }, { env, ddb: table(routed) }))
      .rejects.toThrow('not the one the turn was routed in');
  });

  it('DENY: a getSummary naming a relative is refused when the record names no relatives', async () => {
    await expect(bindTurnRequest({ op: 'getSummary', input: { channelArn: OTHER }, routeId: 'route-1' }, { env, ddb: table({ classification: 'standard', channelArn: CHANNEL }) }))
      .rejects.toThrow('not the one the turn was routed in');
  });

  it.each([...TURN_OPS].filter((op) => op !== 'getSummary'))('DENY: %s naming a relative is refused', async (op) => {
    await expect(bindTurnRequest({ op, input: { channelArn: OTHER }, routeId: 'route-1' }, { env, ddb: table(routed) }))
      .rejects.toThrow('not the one the turn was routed in');
  });
});
