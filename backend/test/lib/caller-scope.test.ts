/**
 * A14 Scoped (tier-ceiling) — the pure classification-ceiling logic
 * (lib/caller-scope.ts) + the IAM sub extraction (lib/auth.ts iamCallerSub).
 * The Cognito lookup itself is exercised on deploy; these pin the decision logic.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ceilingFromGroups, classificationAllowed, classificationRank } from '../../lambda/src/lib/caller-scope';
import { iamCallerSub } from '../../lambda/src/lib/auth';

describe('ceilingFromGroups', () => {
  it('full-access groups (admins / platform-admins) => null (Full, no cap)', () => {
    expect(ceilingFromGroups(['admins'])).toBeNull();
    expect(ceilingFromGroups(['platform-admins', 'standard'])).toBeNull();
  });
  it('caps to the highest classification group held', () => {
    expect(ceilingFromGroups(['standard'])).toBe('standard');
    expect(ceilingFromGroups(['basic', 'premium'])).toBe('premium');
    expect(ceilingFromGroups(['platform-devs', 'standard'])).toBe('standard');
  });
  it('a persona with NO classification group is fail-closed to the floor', () => {
    expect(ceilingFromGroups(['platform-devs'])).toBe('basic');
    expect(ceilingFromGroups([])).toBe('basic');
  });
});

describe('classificationAllowed', () => {
  it('null ceiling (Full) allows everything, incl. unknown', () => {
    expect(classificationAllowed('premium', null)).toBe(true);
    expect(classificationAllowed(undefined, null)).toBe(true);
  });
  it('allows at/below the ceiling, denies above', () => {
    expect(classificationAllowed('basic', 'standard')).toBe(true);
    expect(classificationAllowed('standard', 'standard')).toBe(true);
    expect(classificationAllowed('premium', 'standard')).toBe(false);
  });
  it('treats an untagged item as the floor (visible at any ceiling)', () => {
    expect(classificationAllowed(undefined, 'basic')).toBe(true);
    expect(classificationAllowed('', 'standard')).toBe(true);
  });
  it('rank ordering is basic < standard < premium', () => {
    expect(classificationRank('basic')).toBeLessThan(classificationRank('standard'));
    expect(classificationRank('standard')).toBeLessThan(classificationRank('premium'));
  });
});

function iamEvent(provider: string | null): APIGatewayProxyEvent {
  return { requestContext: { identity: { cognitoAuthenticationProvider: provider } } } as unknown as APIGatewayProxyEvent;
}

describe('iamCallerSub', () => {
  it('extracts the sub after the last :CognitoSignIn: segment', () => {
    const p = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC,cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC:CognitoSignIn:11111111-2222-3333-4444-555555555555';
    expect(iamCallerSub(iamEvent(p))).toBe('11111111-2222-3333-4444-555555555555');
  });
  it('returns null on a Cognito-JWT call (no provider) or unparseable string', () => {
    expect(iamCallerSub(iamEvent(null))).toBeNull();
    expect(iamCallerSub(iamEvent('not-a-cognito-provider'))).toBeNull();
  });
});
