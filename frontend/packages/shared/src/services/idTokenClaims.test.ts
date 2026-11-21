/**
 * THE NAME THE CLIENT SHOWS FOR THE PERSON SIGNED IN: `name`, else the given and family names, as the directory reads them
 * (`cognito-pool-directory.ts`), so a person whose identity provider sends only those is never shown by email.
 */
import { describe, it, expect } from 'vitest';
import { idTokenDisplayClaims } from './idTokenClaims';

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

describe('the display name from the ID token', () => {
  it('is the name claim when there is one', () => {
    expect(idTokenDisplayClaims(token({ name: 'James Okafor', given_name: 'J', family_name: 'O', email: 'j@example.com' }))?.name).toBe('James Okafor');
  });

  it('is the given and family names when there is no name claim', () => {
    expect(idTokenDisplayClaims(token({ given_name: 'Maria', family_name: 'Santos', email: 'm@example.com' }))?.name).toBe('Maria Santos');
    expect(idTokenDisplayClaims(token({ given_name: 'Maria', email: 'm@example.com' }))?.name).toBe('Maria');
  });

  it('is absent with neither, so the email is what shows', () => {
    const claims = idTokenDisplayClaims(token({ email: 'm@example.com' }));
    expect(claims?.name).toBeUndefined();
    expect(claims?.email).toBe('m@example.com');
  });
});
