/**
 * WHETHER A PERSON MODERATES A CONVERSATION IS READ BY ONE CHECK (`personModeratesChannel`, `lib/channel-moderator.ts`):
 * `DescribeChannelModerator` for that person, with the person as their own bearer or, for a function that acts as the
 * app instance's service admin, with that bearer; every failure denies. The meeting decisions and the invitations route
 * read it, and neither sends the command on its own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { personModeratesChannel } from '../../lambda/src/lib/channel-moderator';

const CH = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/p1';
const ADMIN = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/user/service-admin';

const reader = (answer: (input: Record<string, string>) => unknown) => {
  const sent: Array<Record<string, string>> = [];
  return {
    sent,
    send: async (cmd: { input: Record<string, string> }) => { sent.push(cmd.input); return answer(cmd.input); },
  };
};

describe('the one moderator check', () => {
  it('asks for the person with the person as bearer, or with the service admin a function acts as', async () => {
    const r = reader(() => ({ ChannelModerator: {} }));
    expect(await personModeratesChannel(r, CH, PERSON)).toBe(true);
    expect(await personModeratesChannel(r, CH, PERSON, { bearer: ADMIN })).toBe(true);
    expect(r.sent).toEqual([
      { ChannelArn: CH, ChannelModeratorArn: PERSON, ChimeBearer: PERSON },
      { ChannelArn: CH, ChannelModeratorArn: PERSON, ChimeBearer: ADMIN },
    ]);
  });

  it('DENY: a person who does not moderate, and any failure to read it, is refused', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await personModeratesChannel(reader(() => { throw Object.assign(new Error('no'), { name: 'NotFoundException' }); }), CH, PERSON)).toBe(false);
    expect(await personModeratesChannel(reader(() => { throw Object.assign(new Error('x'), { name: 'ThrottledClientException' }); }), CH, PERSON, { bearer: ADMIN })).toBe(false);
  });

  it.each(['invitations.ts', 'lib/meeting-host.ts'])('%s reads it through the one check and sends no moderator read of its own', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', file), 'utf8');
    expect(src).toMatch(/personModeratesChannel/);
    expect(src).not.toMatch(/new DescribeChannelModeratorCommand\(/);
  });
});
