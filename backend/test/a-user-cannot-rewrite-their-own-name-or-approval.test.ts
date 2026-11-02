/**
 * A SIGNED-IN USER CANNOT REWRITE THEIR OWN NAME OR APPROVAL (security review, 2026-09-15).
 *
 * An app client with no write list lets a user change every attribute on their own profile through
 * Cognito `UpdateUserAttributes` with their own access token. Two of those decide things for other people:
 *
 *  - `name`: the credential exchange copies it into the display name every member sees, so a member
 *    could take another member's name and have a private `.Name` message resolve to them.
 *  - `custom:approved`: the pre-authentication trigger gates sign-in on it.
 *
 * So each app client writes only what sign-up sends: `email`, and `custom:tier` as a requested tier
 * (authorization reads groups, which only the post-confirmation trigger and admins set).
 */
import { Template } from 'aws-cdk-lib/assertions';
import { adminServicesStacks } from './helpers/synth';

/**
 * Every app client on the pool, both in the Identity stack beside it: the chat client, and the admin
 * console's own client, which exists with the `admin` capability.
 */
function clients() {
  return [Template.fromStack(adminServicesStacks().identity)].flatMap((t) => Object.values(t.findResources('AWS::Cognito::UserPoolClient'))) as Array<{
    Properties: { ClientName?: string; WriteAttributes?: string[] };
  }>;
}

describe('what a user may write on their own profile', () => {
  it('the chat and admin clients allow exactly email and the requested tier', () => {
    const found = clients();
    // Non-vacuous: both clients are present.
    expect(found.map((c) => c.Properties.ClientName).sort()).toEqual(['admin-client', 'web-client']);
    for (const c of found) {
      expect({ client: c.Properties.ClientName, writes: [...(c.Properties.WriteAttributes || [])].sort() })
        .toEqual({ client: c.Properties.ClientName, writes: ['custom:tier', 'email'] });
    }
  });

  it('no client leaves the write list unset, which would make every attribute self-writable', () => {
    for (const c of clients()) {
      expect(c.Properties.WriteAttributes).toBeDefined();
      expect(c.Properties.WriteAttributes).not.toContain('name');
      expect(c.Properties.WriteAttributes).not.toContain('custom:approved');
    }
  });
});
