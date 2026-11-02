/**
 * OFFBOARDING SOMEONE ALREADY REMOVED ANSWERS NOT FOUND. Amazon Chime SDK answers ForbiddenException, not
 * NotFoundException, to DescribeAppInstanceUser on a user that does not exist, so a repeated offboarding
 * read "absent" and "denied" as the same error and failed. The acting person is the control: they exist,
 * so a Forbidden on the subject while the actor reads is an absent subject (`found: false`, the route's
 * 404), and a Forbidden on both is a denial, which still throws.
 */
import { APP, ISS, offboardingWorld } from '../setup/offboarding-world';
import { offboardPerson } from '../../lambda/src/lib/offboarding';

jest.mock('../../lambda/src/lib/event-archive', () => ({
  ...jest.requireActual('../../lambda/src/lib/event-archive'),
  appendServerEvent: jest.fn(async () => undefined),
}));

const kind = (cmd: unknown) => (cmd as { constructor: { name: string } }).constructor.name;
const forbidden = () => Object.assign(new Error('You are not allowed to make this request.'), { name: 'ForbiddenException' });

/** A Chime that answers Forbidden, as the live service does, for a user that does not exist. */
function forbiddenForAbsent(w: ReturnType<typeof offboardingWorld>, alsoDeny: string[] = []) {
  const real = w.chime.send.getMockImplementation()!;
  w.chime.send.mockImplementation(async (cmd: unknown) => {
    const i = (cmd as { input?: Record<string, string> }).input ?? {};
    const arn = i.AppInstanceUserArn ?? i.ResourceARN;
    if (['DescribeAppInstanceUserCommand', 'ListTagsForResourceCommand'].includes(kind(cmd))
      && (!w.users.has(arn) || alsoDeny.includes(arn))) throw forbidden();
    return real(cmd);
  });
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('offboarding someone already removed', () => {
  it('answers found: false when the actor reads and the subject does not', async () => {
    const w = offboardingWorld();
    const actor = w.seedPerson('admin-1', [{ issuer: ISS, subject: 'admin-sub' }]);
    forbiddenForAbsent(w);
    const res = await offboardPerson(`${APP}/user/gone-1`, { arn: actor }, w.deps);
    expect(res.found).toBe(false);
  });

  it('throws when the actor is denied too, so a denial is never read as absent', async () => {
    const w = offboardingWorld();
    const actor = w.seedPerson('admin-1', [{ issuer: ISS, subject: 'admin-sub' }]);
    forbiddenForAbsent(w, [actor]);
    await expect(offboardPerson(`${APP}/user/gone-1`, { arn: actor }, w.deps)).rejects.toMatchObject({ name: 'ForbiddenException' });
  });

  it('throws when the actor is the platform rather than a person, which cannot serve as the control', async () => {
    const w = offboardingWorld();
    forbiddenForAbsent(w);
    await expect(offboardPerson(`${APP}/user/gone-1`, { arn: 'sweep' }, w.deps)).rejects.toMatchObject({ name: 'ForbiddenException' });
  });
});
