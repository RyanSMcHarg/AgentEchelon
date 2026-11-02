/**
 * A14 Scoped (classification scope) — the pure classification logic (lib/caller-scope.ts) + the
 * the IAM caller (lib/auth.ts callerPersonId). `scopeForRequest` resolves the caller's scope
 * from their assumed-role ARN against the CDK-supplied role -> scope map (no Cognito call).
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { scopeFromGroups, classificationAllowed, scopeAnalyticsRows, scopeForRequest, __clearScopeCache } from '../../lambda/src/lib/caller-scope';
import { callerPersonId } from '../../lambda/src/lib/auth';

describe('scopeFromGroups', () => {
  it('full-access groups (admins / platform-admins) => null (Full, no cap)', () => {
    expect(scopeFromGroups(['admins'])).toBeNull();
    expect(scopeFromGroups(['platform-admins', 'standard'])).toBeNull();
  });
  it('caps to the highest classification group held', () => {
    expect(scopeFromGroups(['standard'])).toBe('standard');
    expect(scopeFromGroups(['basic', 'premium'])).toBe('premium');
    expect(scopeFromGroups(['platform-devs', 'standard'])).toBe('standard');
  });
  it('a persona with NO classification group gets no scope and sees nothing', () => {
    expect(scopeFromGroups(['platform-devs'])).toBeUndefined();
    expect(scopeFromGroups([])).toBeUndefined();
  });
});

describe('classificationAllowed', () => {
  it('null scope (Full) allows everything, incl. unknown', () => {
    expect(classificationAllowed('premium', null)).toBe(true);
    expect(classificationAllowed(undefined, null)).toBe(true);
  });
  it('allows what the scope grants, denies the rest', () => {
    expect(classificationAllowed('basic', 'standard')).toBe(true);
    expect(classificationAllowed('standard', 'standard')).toBe(true);
    expect(classificationAllowed('premium', 'standard')).toBe(false);
  });
  it('REFUSES an untagged item rather than treating it as the floor', () => {
    // THE REVERSAL. An absent classification used to read as the floor, so an
    // untagged row was visible to every caller - "permissive, and deliberate", said the comment it
    // replaced. With classifications as peers there is no floor to read it as, and an item nobody
    // classified is an item whose audience nobody established.
    expect(classificationAllowed(undefined, 'basic')).toBe(false);
    expect(classificationAllowed('', 'standard')).toBe(false);
  });
  it('admits by REACH, not by an ordering', () => {
    // What replaced `classificationRank`. The default config is a ladder, so reach still reads like
    // one - but it is read from `grants`, which a legal/finance deployment can express.
    expect(classificationAllowed('basic', 'standard')).toBe(true);
    expect(classificationAllowed('standard', 'premium')).toBe(true);
    expect(classificationAllowed('premium', 'basic')).toBe(false);
    expect(classificationAllowed('standard', 'basic')).toBe(false);
  });
});

function iamEvent(provider: string | null): APIGatewayProxyEvent {
  return { requestContext: { identity: { cognitoAuthenticationProvider: provider } } } as unknown as APIGatewayProxyEvent;
}

describe('scopeAnalyticsRows', () => {
  it('null scope (Full) returns rows unchanged', () => {
    const rows = [{ tier: 'premium', n: 1 }];
    expect(scopeAnalyticsRows(rows, null)).toBe(rows);
  });
  it('drops rows whose classification dimension the scope does not grant', () => {
    const rows = [{ tier: 'basic' }, { tier: 'standard' }, { tier: 'premium' }];
    expect(scopeAnalyticsRows(rows, 'standard')).toEqual([{ tier: 'basic' }, { tier: 'standard' }]);
  });
  it('recognizes the classification-axis field names (conversation_classification, user_type, modelTier)', () => {
    expect(scopeAnalyticsRows([{ conversation_classification: 'premium' }], 'basic')).toEqual([]);
    // A row minted before migration 050 carries only the deprecated column and stays narrowed by it.
    expect(scopeAnalyticsRows([{ conversation_classification: null, user_type: 'premium' }], 'basic')).toEqual([]);
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

describe('scopeForRequest — role-ARN resolution (fail-closed, no fail-open)', () => {
  const ADMIN_ROLE = 'arn:aws:iam::111122223333:role/App-AdminAuthenticatedRole-abc';
  const STD_ROLE = 'arn:aws:iam::111122223333:role/App-StandardRole-def';
  const assumed = (name: string) => `arn:aws:sts::111122223333:assumed-role/${name}/CognitoIdentityCredentials`;
  const roleEvent = (userArn: string | null): APIGatewayProxyEvent =>
    ({ requestContext: { identity: { userArn } } } as unknown as APIGatewayProxyEvent);

  beforeEach(() => {
    process.env.CLASSIFICATION_ROLE_SCOPES = JSON.stringify([
      { role: ADMIN_ROLE, scope: 'full' },
      { role: STD_ROLE, scope: 'standard' },
    ]);
    __clearScopeCache();
  });
  afterEach(() => {
    delete process.env.CLASSIFICATION_ROLE_SCOPES;
    __clearScopeCache();
  });

  it('an admin / full-access role => Full (null)', () => {
    expect(scopeForRequest(roleEvent(assumed('App-AdminAuthenticatedRole-abc')))).toBeNull();
  });
  it('a per-classification role => that tier', () => {
    expect(scopeForRequest(roleEvent(assumed('App-StandardRole-def')))).toBe('standard');
  });
  it('a role NOT in the map gets no scope (never null/Full)', () => {
    expect(scopeForRequest(roleEvent(assumed('App-SomeOtherRole-xyz')))).toBeUndefined();
  });
  it('no resolvable role ARN gets no scope', () => {
    expect(scopeForRequest(roleEvent(null))).toBeUndefined();
    expect(scopeForRequest(roleEvent('garbage'))).toBeUndefined();
  });

  describe('a vend role of a person, resolved from its name and the registry', () => {
    beforeEach(() => { process.env.EXCHANGE_ROLE_NAME_PREFIX = 'agent-echelon-exchange-'; });
    afterEach(() => { delete process.env.EXCHANGE_ROLE_NAME_PREFIX; });

    it('reads a declared classification as its scope, with no list naming it', () => {
      expect(scopeForRequest(roleEvent(assumed('agent-echelon-exchange-basic')))).toBe('basic');
      expect(scopeForRequest(roleEvent(assumed('agent-echelon-exchange-premium')))).toBe('premium');
    });
    it('reads the admin plane\'s CHAT vend role as the admin plane, never Full: Full is admin access', () => {
      // SPEC-ADMIN-IDENTITY FR1: a chat credential never acquires cross-classification reach.
      expect(scopeForRequest(roleEvent(assumed('agent-echelon-exchange-admin')))).toBe('admin');
    });
    it('gives no scope to an undeclared classification, or to the role of another instance', () => {
      expect(scopeForRequest(roleEvent(assumed('agent-echelon-exchange-nonesuch')))).toBeUndefined();
      expect(scopeForRequest(roleEvent(assumed('other-instance-exchange-basic')))).toBeUndefined();
    });
  });
});

describe('callerPersonId on an Identity-Pool call', () => {
  // THE DEPLOYMENT HAS NO IDENTITY POOL: a person's credentials come from the exchange alone, so a principal
  // signed through one names nobody here, whichever pool its provider string names.
  const savedPool = process.env.USER_POOL_ID;
  beforeAll(() => { process.env.USER_POOL_ID = 'us-east-1_ABC'; });
  afterAll(() => { if (savedPool === undefined) delete process.env.USER_POOL_ID; else process.env.USER_POOL_ID = savedPool; });

  it('names nobody, even for this deployment\'s own pool', async () => {
    const p = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC,cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC:CognitoSignIn:11111111-2222-3333-4444-555555555555';
    expect(await callerPersonId(iamEvent(p))).toBeNull();
  });
  it('names nobody for a pool the registry does not declare', async () => {
    const p = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_Other:CognitoSignIn:11111111-2222-3333-4444-555555555555';
    expect(await callerPersonId(iamEvent(p))).toBeNull();
  });
  it('returns null on a Cognito-JWT call (no provider) or unparseable string', async () => {
    expect(await callerPersonId(iamEvent(null))).toBeNull();
    expect(await callerPersonId(iamEvent('not-a-cognito-provider'))).toBeNull();
  });
});

/**
 * THE LADDER COMES FROM THE REGISTRY, AND A DECLARED CLASSIFICATION IS NEVER RANKED 0.
 *
 * This module kept `{ basic: 1, standard: 2, premium: 3 }` and returned 0 for anything else. That is
 * deployment config copied into a module, frozen at the moment it was written, and the day an `admin`
 * classification was declared above the ordinary tiers the copy was wrong in BOTH directions at once:
 *
 *   - an `admin`-classified ROW ranked 0, so `item <= scope` held for every caller and it leaked
 *     downward to every tier;
 *   - an `admin` SCOPE also ranked 0, so every ordinary row failed the same test and an
 *     administrator's console went blank - the one role meant to read everything reading nothing.
 *
 * A hardcoded ladder cannot fail safe, because it does not know which end it is missing.
 */
describe('reach is read from the profile registry, not copied into this module', () => {
  it('admits EVERY declared classification, including one outside the ordinary tiers', () => {
    // Containment is what matters, and it is read from the registry rather than copied here.
    expect(classificationAllowed('basic', 'standard')).toBe(true);
    expect(classificationAllowed('standard', 'premium')).toBe(true);
    expect(classificationAllowed('admin', 'admin')).toBe(true);
    // And the direction that used to be a rank comparison.
    expect(classificationAllowed('admin', 'premium')).toBe(false);
  });

  it('does not leak an admin-classified row to a scope that does not grant it', () => {
    // The leak direction. With `admin` unranked this was TRUE for every scope in the deployment.
    expect(classificationAllowed('admin', 'premium')).toBe(false);
    expect(classificationAllowed('admin', 'basic')).toBe(false);
  });

  it('lets an admin scope read what it grants, which is the admin plane alone', () => {
    // The admin classification grants itself alone (SPEC-ADMIN-IDENTITY FR1); reading every classification is
    // a Full scope, which only admin access (the console session, the admin twin's role) resolves to.
    expect(classificationAllowed('admin', 'admin')).toBe(true);
    expect(classificationAllowed('premium', 'admin')).toBe(false);
    expect(classificationAllowed('premium', null)).toBe(true);
  });

  it('ranks an UNDECLARED value 0, which narrows a scope and does NOT hide an item', () => {
    // Pinned because the asymmetry is easy to assume away, and this test caught the assumption being
    // written into the fix's own comment. The comparison is `itemRank <= scopeRank`, so a 0:
    //   - as a SCOPE admits nothing (fail-closed, correct for a scope);
    //   - as an ITEM is now REFUSED rather than visible everywhere. It used to read as the floor and
    //     pass every scope, which this file called "how this module already reads an unclassified
    //     row". That reading is gone with the floor.
    expect(classificationAllowed('not-a-classification', 'premium')).toBe(false);
    expect(classificationAllowed('basic', 'not-a-classification')).toBe(false);
  });
});
