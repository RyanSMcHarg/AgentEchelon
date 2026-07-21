/**
 * A14 Scoped (tier-ceiling) — the pure classification-ceiling logic (lib/caller-scope.ts) + the
 * IAM sub extraction (lib/auth.ts iamCallerSub). `ceilingForRequest` resolves the caller's ceiling
 * from their assumed-role ARN against the CDK-supplied role -> ceiling map (no Cognito call).
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ceilingFromGroups, classificationAllowed, classificationRank, scopeAnalyticsRows, ceilingForRequest, __clearCeilingCache } from '../../lambda/src/lib/caller-scope';
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

describe('scopeAnalyticsRows', () => {
  it('null ceiling (Full) returns rows unchanged', () => {
    const rows = [{ tier: 'premium', n: 1 }];
    expect(scopeAnalyticsRows(rows, null)).toBe(rows);
  });
  it('drops rows whose tier dimension exceeds the ceiling', () => {
    const rows = [{ tier: 'basic' }, { tier: 'standard' }, { tier: 'premium' }];
    expect(scopeAnalyticsRows(rows, 'standard')).toEqual([{ tier: 'basic' }, { tier: 'standard' }]);
  });
  it('recognizes the classification-axis field names (user_type, channel_tier, modelTier)', () => {
    expect(scopeAnalyticsRows([{ user_type: 'premium' }], 'basic')).toEqual([]);
    expect(scopeAnalyticsRows([{ modelTier: 'basic' }], 'basic')).toEqual([{ modelTier: 'basic' }]);
  });
  it('does NOT treat a quality-grade `classification` (excellent/good) as a tier', () => {
    const rows = [{ classification: 'excellent', n: 5 }, { classification: 'good', n: 3 }];
    // No tier value present -> global aggregate, unfiltered.
    expect(scopeAnalyticsRows(rows, 'basic')).toEqual(rows);
  });
  it('passes through global aggregates with no tier column', () => {
    const rows = [{ date: '2026-07-01', total: 42 }];
    expect(scopeAnalyticsRows(rows, 'basic')).toEqual(rows);
  });
});

describe('ceilingForRequest — role-ARN resolution (fail-closed, no fail-open)', () => {
  const ADMIN_ROLE = 'arn:aws:iam::111122223333:role/App-AdminAuthenticatedRole-abc';
  const STD_ROLE = 'arn:aws:iam::111122223333:role/App-StandardRole-def';
  const assumed = (name: string) => `arn:aws:sts::111122223333:assumed-role/${name}/CognitoIdentityCredentials`;
  const roleEvent = (userArn: string | null): APIGatewayProxyEvent =>
    ({ requestContext: { identity: { userArn } } } as unknown as APIGatewayProxyEvent);

  beforeEach(() => {
    process.env.CLASSIFICATION_ROLE_CEILINGS = JSON.stringify([
      { role: ADMIN_ROLE, ceiling: 'full' },
      { role: STD_ROLE, ceiling: 'standard' },
    ]);
    __clearCeilingCache();
  });
  afterEach(() => {
    delete process.env.CLASSIFICATION_ROLE_CEILINGS;
    __clearCeilingCache();
  });

  it('an admin / full-access role => Full (null)', () => {
    expect(ceilingForRequest(roleEvent(assumed('App-AdminAuthenticatedRole-abc')))).toBeNull();
  });
  it('a per-classification role => that tier', () => {
    expect(ceilingForRequest(roleEvent(assumed('App-StandardRole-def')))).toBe('standard');
  });
  it('a role NOT in the map fails closed to the floor (never null/Full)', () => {
    expect(ceilingForRequest(roleEvent(assumed('App-SomeOtherRole-xyz')))).toBe('basic');
  });
  it('no resolvable role ARN fails closed to the floor', () => {
    expect(ceilingForRequest(roleEvent(null))).toBe('basic');
    expect(ceilingForRequest(roleEvent('garbage'))).toBe('basic');
  });
});

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
