/**
 * Auth-helper contract tests. The load-bearing case is `parseGroups` on a
 * MULTI-group `cognito:groups` claim: API Gateway serializes it bracketed and
 * space-separated (`"[admins premium]"`), and an earlier comma-only split
 * silently denied additive-admin users (a `premium`+`admins` operator failed the
 * console gate). These pin all three claim shapes and the admin gate that rides
 * on them. See docs/IDENTITY-AND-ACCESS-MODEL.md §4/§8.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { parseGroups, extractClaims, callerIsAdmin } from '../../lambda/src/lib/auth';

const eventWithGroups = (groups: unknown): APIGatewayProxyEvent =>
  ({ requestContext: { authorizer: { claims: { sub: 'u-1', 'cognito:groups': groups } } } } as unknown as APIGatewayProxyEvent);

describe('parseGroups — claim shapes', () => {
  it('parses a JSON array', () => {
    expect(parseGroups(['admins', 'premium'])).toEqual(['admins', 'premium']);
  });

  it('parses a comma-separated string (raw JWT)', () => {
    expect(parseGroups('admins,premium')).toEqual(['admins', 'premium']);
  });

  it('parses the bracketed space-separated multi-group string (API Gateway)', () => {
    expect(parseGroups('[admins premium]')).toEqual(['admins', 'premium']);
  });

  it('parses a single-group bracketed string', () => {
    expect(parseGroups('[premium]')).toEqual(['premium']);
  });

  it('parses a bare single group', () => {
    expect(parseGroups('premium')).toEqual(['premium']);
  });

  it('returns [] for absent/non-string/non-array', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups(42)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
  });
});

describe('extractClaims — tier from most-privileged group', () => {
  it('picks admins over a tier when both are held (bracketed form)', () => {
    const claims = extractClaims(eventWithGroups('[admins premium]'));
    expect(claims?.clearance).toBe('admins');
    expect(claims?.groups).toEqual(['admins', 'premium']);
  });

  it('picks the tier when no admin group is held', () => {
    expect(extractClaims(eventWithGroups('standard'))?.clearance).toBe('standard');
  });
});

describe('callerIsAdmin — additive admin must pass', () => {
  it('grants a multi-group admin (bracketed form)', () => {
    expect(callerIsAdmin(eventWithGroups('[admins premium]'))).toBe(true);
  });

  it('grants a comma-separated admin', () => {
    expect(callerIsAdmin(eventWithGroups('premium,admins'))).toBe(true);
  });

  it('denies a non-admin tier', () => {
    expect(callerIsAdmin(eventWithGroups('[standard basic]'))).toBe(false);
  });

  it('denies when no claims are present', () => {
    expect(callerIsAdmin({ requestContext: {} } as unknown as APIGatewayProxyEvent)).toBe(false);
  });
});
