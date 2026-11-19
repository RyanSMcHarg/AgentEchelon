/**
 * A TEAM ROOM STANDS ON A DEPLOYMENT WITHOUT THE ASSISTANT IT ADDS WHERE DECLARED (`optionalAgents`, ADR-061 decision 2).
 *
 * The operations team room adds the ops assistant where the deployment declares it, which then owns the room's workflows;
 * where the deployment declares no ops assistant, the room is created with the classification's primary, which owns them,
 * so the room and the triggers attached to it work there too. An ops incident room still requires the ops assistant.
 */
process.env.CLASSIFICATION = 'premium';
const mockLive = jest.fn();
jest.mock('../../lambda/src/lib/default-agents', () => {
  const actual = jest.requireActual('../../lambda/src/lib/default-agents');
  return {
    ...actual,
    liveAssistantsByHandleOrThrow: (...a: unknown[]) => mockLive(...a),
    resolveDefaultAgents: async (_c: string, handles: string[]) => {
      const live = await mockLive();
      return handles.map((h) => { const a = live.get(h); if (!a) throw new Error(`no live assignment record: ${h}`); return a; });
    },
  };
});

import { typeAgents } from '../../lambda/src/typed-conversation-from-event';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const advisor = { handle: 'advisor', role: 'primary', botArn: `${APP}/bot/advisor` };
const ops = { handle: 'ops-premium', role: 'ops', botArn: `${APP}/bot/ops` };
const live = (...a: Array<typeof advisor>) => mockLive.mockResolvedValue(new Map(a.map((x) => [x.handle, x])));

describe('the team room\'s assistants', () => {
  it('are the primary alone where the deployment declares no ops assistant', async () => {
    live(advisor);
    expect((await typeAgents('ops-team')).map((a) => a.handle)).toEqual(['advisor']);
  });

  it('add the ops assistant where the deployment declares it', async () => {
    live(advisor, ops);
    expect((await typeAgents('ops-team')).map((a) => a.handle)).toEqual(['advisor', 'ops-premium']);
  });

  it('are never created short of an optional one because the assignments could not be read', async () => {
    mockLive.mockRejectedValue(new Error('ThrottlingException'));
    await expect(typeAgents('ops-team')).rejects.toThrow('ThrottlingException');
  });

  it('an ops incident room still requires the ops assistant', async () => {
    live(advisor);
    await expect(typeAgents('ops')).rejects.toThrow(/ops-premium/);
  });
});
