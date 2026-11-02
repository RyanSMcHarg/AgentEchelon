/**
 * THE ADMIN CLASSIFICATION IS NOT ADMIN ACCESS (SPEC-ADMIN-IDENTITY FR1, the two-identity split).
 *
 * The `admin` classification is the classification of admin conversations: holding it (the `admins` group)
 * clears a person's CHAT identity for admin conversations and for no member conversation. Reach across every
 * conversation, the archive and every admin capability is admin access: an issuer declaring `admin: true`, its
 * admin groups, the console session and the separate `${personId}-admin` identity. Never the chat token.
 *
 * Each case below fails on the superset model, where `admin` granted every member classification, its chat vend
 * role was `channel/*` with no tag condition, and the console role was read from the chat token.
 */
import * as cdk from 'aws-cdk-lib';
import { defaultProfileRegistry as profiles, ADMIN_PLANE_SESSION_TAG } from '../../lib/profile-registry';
import { exchangeVendStatements, vendTagPin } from '../../lib/constructs/exchange-role';
import { holderOfClaims, type TrustedIssuer } from '../../lib/config/issuers';
import { consoleRoleFor } from '../../lambda/src/lib/vend';

const APP = 'arn:aws:chime:us-east-1:111111111111:app-instance/abc';
const CHANNELS = `${APP}/channel/*`;

const self = (extra: Partial<TrustedIssuer> = {}): TrustedIssuer => ({
  id: 'deployment', kind: 'cognito-pool', pool: 'self',
  clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups', ...extra,
} as unknown as TrustedIssuer);

type Json = { Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, unknown>> };
const statementsOf = (token: string): Json[] => {
  // A statement resolves its tokens against a stack; none is needed for these literals.
  new cdk.App();
  return exchangeVendStatements(APP, token as never).map((s) => s.toJSON() as Json);
};
const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
/** The Allow statements on channels that carry a message action (the leave statement is membership-only). */
const channelMessageAllows = (token: string): Json[] => statementsOf(token)
  .filter((s) => s.Effect === 'Allow' && list(s.Resource).includes(CHANNELS) && list(s.Action).includes('chime:SendChannelMessage'));

describe('the admin classification reaches admin conversations and nothing else', () => {
  it('grants itself alone', () => {
    expect(profiles.grantsFor('admin')).toEqual(['admin']);
    for (const v of profiles.classificationValues()) if (v !== 'admin') expect(profiles.grantsFor(v)).not.toContain('admin');
  });

  it('vends an admins + premium person the premium token, with the admin plane beside it', () => {
    const holder = holderOfClaims(self(), { 'cognito:groups': ['admins', 'premium'] }, profiles);
    expect(holder).toEqual({ token: 'premium', adminPlane: true });
    expect(profiles.reachOf(holder)).toEqual(['basic', 'standard', 'premium', 'admin']);
  });

  it('vends an admins-only person the admin token, which reaches admin conversations only', () => {
    const holder = holderOfClaims(self(), { 'cognito:groups': ['admins'] }, profiles);
    expect(holder).toEqual({ token: 'admin', adminPlane: true });
    expect(profiles.reachOf(holder)).toEqual(['admin']);
    expect(profiles.holderReaches(holder, 'premium')).toBe(false);
  });

  it('vends a premium person no admin plane', () => {
    expect(holderOfClaims(self(), { 'cognito:groups': ['premium'] }, profiles)).toEqual({ token: 'premium', adminPlane: false });
  });
});

describe('the admin plane\'s chat vend role is tag-gated like every other', () => {
  it('has no unconditioned channel/* message grant: every one is gated on the admin plane\'s classification', () => {
    const allows = channelMessageAllows('admin');
    expect(allows.length).toBeGreaterThan(0);
    for (const s of allows) {
      expect(s.Condition?.StringEquals?.['aws:ResourceTag/classification']).toEqual(['admin']);
    }
  });
});

describe('a member vend role reaches admin-plane channels only with the adminPlane principal tag', () => {
  it('carries one admin-plane statement, conditioned on the admin plane\'s tag and the adminPlane session tag', () => {
    const allows = channelMessageAllows('premium');
    const plane = allows.filter((s) => list(s.Condition?.StringEquals?.['aws:ResourceTag/classification'] as string[]).includes('admin'));
    expect(plane).toHaveLength(1);
    expect(plane[0].Condition?.StringEquals).toEqual({
      'aws:ResourceTag/classification': ['admin'],
      [`aws:PrincipalTag/${ADMIN_PLANE_SESSION_TAG}`]: 'true',
    });
    // The member grant itself never names the admin plane.
    const member = allows.filter((s) => s !== plane[0]);
    for (const s of member) expect(s.Condition?.StringEquals?.['aws:ResourceTag/classification']).not.toContain('admin');
  });

  it('gives an outside classification\'s role no admin-plane statement', () => {
    if (!profiles.classificationValues().includes('customer')) return;
    const plane = channelMessageAllows('customer')
      .filter((s) => list(s.Condition?.StringEquals?.['aws:ResourceTag/classification'] as string[]).includes('admin'));
    expect(plane).toEqual([]);
  });

  it('lets the exchange assert adminPlane on a vend role only as true, and no other tag key', () => {
    const pin = vendTagPin('premium');
    expect(pin.StringEqualsIfExists).toEqual({ [`aws:RequestTag/${ADMIN_PLANE_SESSION_TAG}`]: 'true' });
    expect(pin['ForAllValues:StringEquals']).toEqual({ 'aws:TagKeys': ['person', 'classification', ADMIN_PLANE_SESSION_TAG] });
  });
});

describe('the console role is admin access, read from the issuer and its admin groups, never the chat token', () => {
  it('gives an admins member of an admin: true issuer the admins console role', () => {
    expect(consoleRoleFor(self(), ['admins'])).toBe('admins');
    expect(consoleRoleFor(self(), ['admins', 'premium'])).toBe('admins');
  });

  it('gives an issuer that does not declare admin: true no console, whatever its groups', () => {
    expect(consoleRoleFor(self({ admin: false }), ['admins'])).toBeNull();
  });

  it('reads the issuer\'s own admin groups', () => {
    expect(consoleRoleFor(self({ adminGroups: ['ops'] }), ['ops'])).toBe('admins');
    expect(consoleRoleFor(self({ adminGroups: ['ops'] }), ['admins'])).toBeNull();
  });

  it('gives a premium person no console role', () => {
    expect(consoleRoleFor(self(), ['premium'])).toBeNull();
    expect(consoleRoleFor(self(), ['team-members', 'premium'])).toBe('team-members');
  });
});
