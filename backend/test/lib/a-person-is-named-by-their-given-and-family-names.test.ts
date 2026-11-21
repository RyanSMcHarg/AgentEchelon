/**
 * A PERSON IS NAMED BY WHAT THEIR IDENTITY PROVIDER GIVES (found 2026-11-19: CSMs whose records carry given and family names but
 * no `name` showed in meetings as `csm-maria`). The messaging identity's name is the token's `name`, else its given and family
 * names joined, and only then the email's local part, as the pool directory reads a record.
 */
import { displayNameOf, realNameOf } from '../../lambda/src/lib/vend';

describe('the name a sign-in carries', () => {
  it('is the name claim, else the given and family names', () => {
    expect(realNameOf({ name: 'James Okafor', given_name: 'J', family_name: 'O' })).toBe('James Okafor');
    expect(realNameOf({ given_name: 'Maria', family_name: 'Santos', email: 'csm-maria@example.com' })).toBe('Maria Santos');
    expect(realNameOf({ given_name: 'Maria' })).toBe('Maria');
    expect(realNameOf({ email: 'csm-maria@example.com' })).toBe('');
  });

  it('names the identity by it before the email\'s local part', () => {
    expect(displayNameOf({ given_name: 'Maria', family_name: 'Santos', email: 'csm-maria@example.com' })).toBe('Maria Santos');
    expect(displayNameOf({ email: 'csm-maria@example.com' })).toBe('csm-maria');
  });
});
