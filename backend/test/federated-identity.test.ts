import {
  deriveFederatedSub,
  isFederatedSub,
  resolveFederatedClearance,
  classificationCeiling,
  type Classification,
} from '../lambda/src/lib/federated-identity';

describe('deriveFederatedSub', () => {
  const iss = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_partnerpool';

  it('is deterministic for the same (issuer, subject)', () => {
    expect(deriveFederatedSub(iss, 'abc-123')).toBe(deriveFederatedSub(iss, 'abc-123'));
  });

  it('differs by subject and by issuer', () => {
    expect(deriveFederatedSub(iss, 'a')).not.toBe(deriveFederatedSub(iss, 'b'));
    expect(deriveFederatedSub(iss, 'a')).not.toBe(deriveFederatedSub('https://other', 'a'));
  });

  it('is charset-safe and fed_-prefixed (disjoint from native subs)', () => {
    const id = deriveFederatedSub(iss, 'abc-123');
    expect(id).toMatch(/^fed_[0-9a-f]{40}$/);
    expect(isFederatedSub(id)).toBe(true);
    // A native Cognito sub (a UUID) is never mistaken for a federated id.
    expect(isFederatedSub('1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809')).toBe(false);
  });

  it('throws on missing issuer or subject', () => {
    expect(() => deriveFederatedSub('', 's')).toThrow();
    expect(() => deriveFederatedSub(iss, '')).toThrow();
  });
});

describe('resolveFederatedClearance (fail-closed)', () => {
  const map: Record<string, Classification> = { 'partner-premium': 'premium', 'partner-basic': 'basic' };

  it('maps a known group', () => {
    expect(resolveFederatedClearance('partner-premium', map)).toBe('premium');
  });

  it('falls closed to the lowest clearance on absent/unknown group', () => {
    expect(resolveFederatedClearance(undefined, map)).toBe('basic');
    expect(resolveFederatedClearance('not-a-group', map)).toBe('basic');
    expect(resolveFederatedClearance('x', map, 'basic')).toBe('basic');
  });
});

describe('classificationCeiling', () => {
  it('returns the lower of idp clearance and channel classification', () => {
    expect(classificationCeiling('premium', 'basic')).toBe('basic');
    expect(classificationCeiling('basic', 'premium')).toBe('basic');
    expect(classificationCeiling('standard', 'standard')).toBe('standard');
    expect(classificationCeiling('admin', 'premium')).toBe('premium');
  });
});
