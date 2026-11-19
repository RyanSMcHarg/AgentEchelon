/**
 * A PERSON REMOVED FROM THEIR CONSOLE ROLE IS VENDED NOTHING MORE (DESIGN-REVOCATION-WINDOWS R6).
 *
 * A console session names the role its holder's groups gave at sign-in, and an admin vend does not take the session's
 * word for it: the role is read from the groups the person's admin issuers hold now (`refuseLapsedConsoleRole`). The
 * open session itself stays until it expires; what stops at once is every further per-capability credential.
 */
import { refuseLapsedConsoleRole } from '../../lambda/src/lib/vend';

const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/user/person-1';
const ADMIN_ISSUER = { id: 'deployment', kind: 'cognito-pool', admin: true } as never;
const issuers = () => [ADMIN_ISSUER];
const event = { headers: {} };
const directory = (answer: () => Promise<string[] | null>) => ({ groupsFor: jest.fn(answer) });

describe('refuseLapsedConsoleRole', () => {
  it('lets the vend go on while the role is still held', async () => {
    await expect(refuseLapsedConsoleRole(event, PERSON, 'admins', directory(async () => ['admins']), issuers)).resolves.toBeNull();
    await expect(refuseLapsedConsoleRole(event, PERSON, 'team-members', directory(async () => ['team-members']), issuers)).resolves.toBeNull();
  });

  it('refuses an admin removed from admins since the session was issued', async () => {
    const res = await refuseLapsedConsoleRole(event, PERSON, 'admins', directory(async () => ['standard']), issuers);
    expect(res?.statusCode).toBe(403);
    expect(JSON.parse(res!.body)).toMatchObject({ code: 'CONSOLE_ROLE_LAPSED' });
  });

  it('refuses a team member removed from the team group', async () => {
    const res = await refuseLapsedConsoleRole(event, PERSON, 'team-members', directory(async () => []), issuers);
    expect(res?.statusCode).toBe(403);
  });

  it('refuses, as an outage, when the groups cannot be read', async () => {
    const res = await refuseLapsedConsoleRole(event, PERSON, 'admins', directory(async () => { throw new Error('throttled'); }), issuers);
    expect(res?.statusCode).toBe(503);
    expect(JSON.parse(res!.body)).toMatchObject({ code: 'DIRECTORY_UNAVAILABLE' });
  });

  it('leaves a person whose issuer keeps no groups to the session\'s own lifetime', async () => {
    await expect(refuseLapsedConsoleRole(event, PERSON, 'admins', directory(async () => null), issuers)).resolves.toBeNull();
  });

  it('reads the role only from issuers that declare admin', async () => {
    const res = await refuseLapsedConsoleRole(event, PERSON, 'admins', directory(async () => ['admins']), () => []);
    expect(res?.statusCode).toBe(403);
  });
});
