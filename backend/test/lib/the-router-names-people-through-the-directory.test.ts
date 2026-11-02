/**
 * THE ROUTER NAMES PEOPLE, AND READS THEIR CLEARANCE, THROUGH THE DIRECTORY.
 *
 * It greets the sender and grounds the prompt on the room's members by name. Both read the pool before:
 * the sender with `AdminGetUser` in this deployment's pool, on the assumption that every sender was
 * "always native", and a member through a stored issuer hint for a derived `fed_` id. A person is their
 * AppInstanceUser now, with an opaque id, so both ask `Directory.displayNameFor`, which finds the person's
 * subject through `Identities` in whichever trusted pool holds it. The sender's clearance is read by
 * person too, and a person of another issuer is answered at the conversation's classification because
 * their issuer holds no clearance groups, never because of their id's shape.
 *
 * `resolveUserName` and `resolveMemberName` are module-local to the router, so they are guarded at the
 * source, the way the router's other internal helpers are; the directory they call is tested on its own
 * (`a-person-is-asked-of-the-directory-by-person.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from '../helpers/strip-comments';

const router = stripComments(fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8'));
const fn = (name: string) => {
  const at = router.indexOf(`async function ${name}(`);
  return at === -1 ? '' : router.slice(at, router.indexOf('\n}\n', at));
};

describe('the router\'s names come from the directory', () => {
  it('names the sender by person', () => {
    expect(fn('resolveUserName')).toMatch(/defaultDirectory\(\)\.displayNameFor\(personArn\)/);
  });

  it('names a member by person, with no issuer hint', () => {
    const member = fn('resolveMemberName');
    expect(member).toMatch(/defaultDirectory\(\)\.displayNameFor\(memberArn\)/);
    expect(member).not.toMatch(/hint|rawSub|iss\b/);
  });

  it('asks for the sender by the ARN the message carries, never by a pool username or sub', () => {
    expect(router).toMatch(/resolveUserName\(event\.requestAttributes\?\.\['CHIME\.sender\.arn'\] \|\| ''\)/);
    expect(router).not.toMatch(/AdminGetUserCommand|CognitoIdentityProviderClient|poolIdFromIssuer|TRUSTED_NAME_POOL_IDS/);
  });

  it('reads the sender\'s clearance by person, and branches on no id\'s shape', () => {
    expect(router).toMatch(/resolveUserClearance\(senderPersonArn\)/);
    expect(router).toMatch(/const scopedByIssuer = !resolvedClearance\.fromIssuer;/);
    expect(router).not.toMatch(/fed_/);
  });
});
