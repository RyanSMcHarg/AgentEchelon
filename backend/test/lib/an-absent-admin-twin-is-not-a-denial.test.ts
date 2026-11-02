/**
 * AN ABSENT ADMIN TWIN IS NOT A DENIAL.
 *
 * Amazon Chime SDK answers ForbiddenException, not NotFoundException, to DescribeAppInstanceUser and to
 * ListTagsForResource on an AppInstanceUser that does not exist - to an administrator as well (measured,
 * 2026-10-21). An export of a person who never held a console session failed on it ("offboarding failed
 * (Unhandled)"). The twin lookup tells an absent twin from a denial by the owner, who exists: the owner
 * reads, so a Forbidden on the twin means no twin; a Forbidden on both is a real denial, which still
 * throws, so erasure never passes over a twin.
 */
import { DescribeAppInstanceUserCommand, ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-identity';
import { twinOf } from '../../lambda/src/lib/offboarding';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app';
const OWNER = `${APP}/user/0192f0e0-0000-7000-8000-000000000001`;
const TWIN = `${OWNER}-admin`;

/** Chime as it answers: a user that is not there is Forbidden on Describe and on ListTags alike. */
function chime(users: Record<string, Array<{ Key: string; Value: string }>>, opts: { denyAll?: boolean; denyTags?: boolean } = {}) {
  const named = (name: string) => Object.assign(new Error(name), { name });
  return {
    send: jest.fn(async (cmd: unknown) => {
      if (opts.denyAll) throw named('ForbiddenException');
      if (cmd instanceof DescribeAppInstanceUserCommand) {
        if (!users[cmd.input.AppInstanceUserArn!]) throw named('ForbiddenException');
        return { AppInstanceUser: { AppInstanceUserArn: cmd.input.AppInstanceUserArn } };
      }
      if (cmd instanceof ListTagsForResourceCommand) {
        if (opts.denyTags || !users[cmd.input.ResourceARN!]) throw named('ForbiddenException');
        return { Tags: users[cmd.input.ResourceARN!] };
      }
      throw new Error('unexpected command');
    }),
  };
}

describe('the admin twin lookup', () => {
  it('answers "no twin" for a person who never held a console session', async () => {
    expect(await twinOf(chime({ [OWNER]: [] }), TWIN, OWNER)).toBe(false);
  });

  it('finds a twin that names its owner', async () => {
    expect(await twinOf(chime({ [OWNER]: [], [TWIN]: [{ Key: 'owner', Value: OWNER }] }), TWIN, OWNER)).toBe(true);
  });

  it('throws a denial on every read, rather than reading it as "no twin"', async () => {
    await expect(twinOf(chime({}, { denyAll: true }), TWIN, OWNER)).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('still throws a denial on the tags of a twin that exists, so erasure never passes over it', async () => {
    await expect(twinOf(chime({ [OWNER]: [], [TWIN]: [] }, { denyTags: true }), TWIN, OWNER)).rejects.toMatchObject({ name: 'ForbiddenException' });
  });
});
