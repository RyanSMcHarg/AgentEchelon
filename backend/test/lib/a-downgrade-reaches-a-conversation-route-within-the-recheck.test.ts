/**
 * A DOWNGRADE REACHES A CONVERSATION ROUTE WITHIN THE RECHECK, NOT AT THE TOKEN'S RENEWAL (DESIGN-REVOCATION-WINDOWS R4).
 *
 * The caller's token carries the clearance it was issued with. On a function wired for it, the shared conversation
 * check also reads the person's clearance from their directory now, at most `CLEARANCE_RECHECK_SECONDS` old: the live
 * answer only narrows the token's, a directory that cannot be read refuses, and a person whose issuer keeps no groups
 * is held to the token.
 */
const mockCaller = { personId: 'person-1', token: 'premium' as string | undefined };

jest.mock('../../lambda/src/lib/auth.js', () => ({
  callerPerson: async () => ({ personId: mockCaller.personId, source: 'edge' }),
  callerHolderToken: () => mockCaller.token,
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { loadProfileRegistry } from '../../lib/profile-registry';
import {
  callerReachesConversation, CLEARANCE_RECHECK_SECONDS, __clearLiveClearance,
} from '../../lambda/src/lib/conversation-access';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/c0ffee00-1111-2222-3333-444455556666`;
const PERSON = `${APP}/user/person-1`;

const client = {
  send: async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'ListTagsForResourceCommand') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    return {};
  },
};

const directoryAnswering = (answer: () => Promise<string[] | null>) => ({ clearedByGroups: jest.fn(answer) });
const event = {} as APIGatewayProxyEvent;
const check = (directory: { clearedByGroups: jest.Mock }) =>
  callerReachesConversation(event, CHANNEL, { appInstanceArn: APP, client: client as never, liveTags: true, directory });

beforeAll(() => loadProfileRegistry());
beforeEach(() => {
  __clearLiveClearance();
  mockCaller.token = 'premium';
});

describe('the live clearance recheck', () => {
  it('admits a member the token and the directory both clear', async () => {
    const directory = directoryAnswering(async () => ['premium']);
    await expect(check(directory)).resolves.toMatchObject({ ok: true });
    expect(directory.clearedByGroups).toHaveBeenCalledWith(PERSON);
  });

  it('refuses a member downgraded at the directory while the token still claims the conversation', async () => {
    const directory = directoryAnswering(async () => ['basic']);
    await expect(check(directory)).resolves.toMatchObject({ ok: false, status: 403, code: 'NOT_CLEARED' });
  });

  it('refuses a member the directory clears for nothing', async () => {
    await expect(check(directoryAnswering(async () => []))).resolves.toMatchObject({ ok: false, code: 'NOT_CLEARED' });
  });

  it('never widens the token: a token that does not reach is refused whatever the directory says', async () => {
    mockCaller.token = 'basic';
    await expect(check(directoryAnswering(async () => ['premium']))).resolves.toMatchObject({ ok: false, code: 'NOT_CLEARED' });
  });

  it('refuses, as an outage, when the directory cannot be read', async () => {
    const directory = directoryAnswering(async () => { throw Object.assign(new Error('x'), { name: 'ThrottlingException' }); });
    await expect(check(directory)).resolves.toMatchObject({ ok: false, status: 503, code: 'UNAVAILABLE' });
  });

  it('holds a person whose issuer keeps no groups to the token', async () => {
    await expect(check(directoryAnswering(async () => null))).resolves.toMatchObject({ ok: true });
  });

  it('reads the directory at most once per recheck window, then reads it again', async () => {
    const now = jest.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    try {
      let groups = ['premium'];
      const directory = directoryAnswering(async () => groups);
      await expect(check(directory)).resolves.toMatchObject({ ok: true });
      groups = ['basic'];
      await expect(check(directory)).resolves.toMatchObject({ ok: true });
      expect(directory.clearedByGroups).toHaveBeenCalledTimes(1);
      t += CLEARANCE_RECHECK_SECONDS * 1000 + 1;
      await expect(check(directory)).resolves.toMatchObject({ ok: false, code: 'NOT_CLEARED' });
      expect(directory.clearedByGroups).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});
