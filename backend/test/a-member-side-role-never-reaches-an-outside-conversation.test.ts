/**
 * A MEMBER-SIDE ROLE NEVER REACHES AN OUTSIDE CONVERSATION, BY A SECOND LAYER (tenet D3).
 *
 * The share, Battle Mode and invitations serve the deployment's own people in every conversation, so they reach
 * a channel by its `classification` tag being present rather than by a list (the classification-independence
 * plan, step 1). What keeps them off an outside classification's conversations, under the handler's own
 * refusal, is the channel's immutable `audience` tag:
 *
 *   - every creator stamps it in the same `CreateChannel` as the classification, and its grant requires the
 *     request to carry its own classification's declared audience (`createOwnClassificationOnly`), so a
 *     customer's creator creates `outside` conversations and a member classification's creates `members` ones;
 *   - every tag grant on a channel pins the requested audience to its classification's, and on an existing
 *     channel only where the channel carries that one or none (`tagOnCreateStatements`), so no grant moves it;
 *   - the member-side roles are denied their membership changes on a channel whose audience is `outside` and on
 *     one that carries no audience (`neverAnOutsideConversation`);
 *   - the admin plane is not: admins are across everything, outside classifications included;
 *   - conversation management serves a customer's own leave and the console's archive, so its removals and its
 *     archive carry no audience condition, and it is denied a membership add on an outside conversation and on
 *     one with no audience, which it never holds an allow for.
 *
 * Read from C7's synthesized templates (the guest issuer, `guest` and `customer` beside the member
 * classifications, Battle Mode, the share and invitations), so every role the rule names is in the set.
 */
import { configuration } from './deploy-matrix/configurations';
import { synthesize, SYNTH_TIMEOUT_MS, type Synthesized } from './deploy-matrix/matrix';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { validateProfilesConfig, DEFAULT_PROFILES_CONFIG } from '../lib/config/profiles';
import * as cdk from 'aws-cdk-lib';
import {
  membershipAsAssistantStatements, membershipAsServiceAdminStatements, neverAnOutsideConversation, createOwnClassificationOnly,
  EVERY_CLASSIFICATION,
} from '../lib/stacks/agent-classification-common';
import { CONVERSATION_MANAGEMENT_ADDS } from '../lib/stacks/conversations-stack';

type Statement = { Sid?: string; Effect?: string; Action?: unknown; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const AUDIENCE = 'aws:ResourceTag/audience';
const REQUESTED_AUDIENCE = 'aws:RequestTag/audience';

/** Every statement of every role in the app, with its stack and the logical id it is written on. */
function statementsOf(app: Synthesized): Array<{ stack: string; id: string; role: string; s: Statement }> {
  const out: Array<{ stack: string; id: string; role: string; s: Statement }> = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    for (const [id, r] of Object.entries(t.Resources ?? {})) {
      const p = (r.Properties ?? {}) as Record<string, any>;
      if (r.Type === 'AWS::IAM::Role') {
        for (const inline of list(p.Policies) as any[]) for (const s of list(inline.PolicyDocument?.Statement) as Statement[]) out.push({ stack, id, role: id, s });
      } else if (r.Type === 'AWS::IAM::Policy') {
        const roles = (list(p.Roles) as any[]).map((x) => x?.Ref ?? JSON.stringify(x));
        for (const s of list(p.PolicyDocument?.Statement) as Statement[]) for (const role of roles.length ? roles : [id]) out.push({ stack, id, role, s });
      }
    }
  }
  return out;
}
const actionsOf = (s: Statement): string[] => list(s.Action).map(String);

describe('a member-side role never reaches an outside conversation', () => {
  let app: Synthesized;
  let all: ReturnType<typeof statementsOf>;
  beforeAll(() => {
    app = synthesize(configuration('C7'), 'athena');
    all = statementsOf(app);
  }, SYNTH_TIMEOUT_MS);

  /** The roles in `stack` whose logical id starts with `prefix`, by the statements written on them. */
  const onRole = (stack: string, prefix: RegExp) => all.filter((x) => x.stack === stack && prefix.test(x.role));

  it('declares an outside classification beside the member ones, so the check is not vacuous', () => {
    expect(profiles.outsideClassificationValues().length).toBeGreaterThan(0);
    expect(Object.keys(app.templates)).toEqual(expect.arrayContaining(['Battle', 'Notifications', 'Conversations', 'Assistants-customer']));
  });

  it.each([
    ['the share', 'Notifications', /^ShareConversationRole/],
    ['Battle Mode', 'Battle', /^ChannelBattleRole/],
    ['invitations', 'Conversations', /^InvitationsFunctionServiceRole/],
  ])('%s is denied its membership changes on an outside conversation and on one with no audience', (_name, stack, role) => {
    const statements = onRole(stack, role);
    const allowedOnChannels = statements.filter(({ s }) => s.Effect === 'Allow' && list(s.Resource).some((r) => String(r).endsWith('/channel/*') || JSON.stringify(r).includes('/channel/*'))
      && actionsOf(s).some((a) => /ChannelMembership$/.test(a)));
    expect(allowedOnChannels.length).toBeGreaterThan(0);
    const outside = statements.filter(({ s }) => s.Effect === 'Deny' && s.Condition?.StringEquals?.[AUDIENCE] === 'outside');
    const absent = statements.filter(({ s }) => s.Effect === 'Deny' && s.Condition?.Null?.[AUDIENCE] === 'true');
    // Every membership change the role holds on a channel is covered by both denials.
    const denied = (ds: typeof outside) => new Set(ds.flatMap(({ s }) => actionsOf(s)));
    for (const { s } of allowedOnChannels) {
      for (const a of actionsOf(s).filter((x) => /ChannelMembership$/.test(x))) {
        expect(denied(outside).has(a)).toBe(true);
        expect(denied(absent).has(a)).toBe(true);
      }
    }
  });

  describe('conversation management: a customer\'s own leave and the console\'s archive work on an outside conversation, and an add never does', () => {
    const management = () => onRole('Conversations', /^ConversationManagementRole/);

    it('its removals, its moderator drop and its archive tag reach every conversation, with no audience condition', () => {
      const allows = management().filter(({ s }) => s.Effect === 'Allow');
      const held = new Set(allows.flatMap(({ s }) => actionsOf(s)));
      for (const a of ['chime:DeleteChannelMembership', 'chime:DeleteChannelModerator', 'chime:TagResource', 'chime:UpdateChannel']) expect(held.has(a)).toBe(true);
      expect(allows.filter(({ s }) => JSON.stringify(s.Condition ?? {}).includes('ResourceTag/audience'))).toEqual([]);
      // No denial covers what it does in an outside conversation.
      const denied = new Set(management().filter(({ s }) => s.Effect === 'Deny').flatMap(({ s }) => actionsOf(s)));
      for (const a of ['chime:DeleteChannelMembership', 'chime:DeleteChannelModerator', 'chime:TagResource', 'chime:UpdateChannel', 'chime:ListChannelModerators']) {
        expect(denied.has(a)).toBe(false);
      }
    });

    it('holds no membership add, and an add is denied on an outside conversation and on one with no audience', () => {
      const adds = [...CONVERSATION_MANAGEMENT_ADDS];
      const allowed = new Set(management().filter(({ s }) => s.Effect === 'Allow').flatMap(({ s }) => actionsOf(s)));
      expect(adds.filter((a) => allowed.has(a))).toEqual([]);
      const outside = management().filter(({ s }) => s.Effect === 'Deny' && s.Condition?.StringEquals?.[AUDIENCE] === 'outside');
      const absent = management().filter(({ s }) => s.Effect === 'Deny' && s.Condition?.Null?.[AUDIENCE] === 'true');
      expect(outside.flatMap(({ s }) => actionsOf(s)).sort()).toEqual([...adds].sort());
      expect(absent.flatMap(({ s }) => actionsOf(s)).sort()).toEqual([...adds].sort());
    });
  });

  it.each([
    ['offboarding', 'Identity', /^OffboardingRole/],
  ])('%s, on the admin plane, is never denied by audience, and narrows by it only to erase an upgrade source', (_name, stack, role) => {
    const statements = onRole(stack, role);
    expect(statements.length).toBeGreaterThan(0);
    const byAudience = statements.filter(({ s }) => JSON.stringify(s.Condition ?? {}).includes('ResourceTag/audience'));
    // The admin plane spans every classification, so no audience condition may take reach away from it.
    expect(byAudience.filter(({ s }) => s.Effect === 'Deny')).toEqual([]);
    // The one audience condition it carries NARROWS a grant: the erase that follows an upgrade only ever
    // targets the visitor conversation the person upgraded from, and a visitor conversation is outside.
    // The audience tag names that set without listing classifications, so adding one changes nothing here.
    expect(byAudience.map(({ s }) => ({ sid: s.Sid, effect: s.Effect, audience: s.Condition?.StringEquals?.[AUDIENCE] })))
      .toEqual([{ sid: 'UpgradeSourceEraseInOutsideConversations', effect: 'Allow', audience: 'outside' }]);
  });

  it('every create requires its own classification\'s audience in the request, outside for an outside classification', () => {
    const creates = all.filter(({ s }) => s.Effect === 'Allow' && actionsOf(s).includes('chime:CreateChannel'));
    expect(creates.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    const audiences = new Set<string>();
    for (const { stack, id, s } of creates) {
      const classifications = list(s.Condition?.StringEquals?.['aws:RequestTag/classification']).map(String);
      const requested = list(s.Condition?.StringEquals?.[REQUESTED_AUDIENCE]).map(String);
      const expected = [...new Set(classifications.map((c) => profiles.audienceOf(c)))];
      requested.forEach((a) => audiences.add(a));
      if (s.Condition?.Null?.[REQUESTED_AUDIENCE] !== 'false' || JSON.stringify(requested.sort()) !== JSON.stringify(expected.sort())) {
        wrong.push(`${stack}/${id} ${s.Sid ?? ''}: ${classifications.join(',')} requests ${requested.join(',') || 'no audience'}`);
      }
    }
    expect(wrong).toEqual([]);
    // The guest's and the customer's creators create outside conversations, and they still may.
    expect([...audiences].sort()).toEqual(['members', 'outside']);
  });

  it('every tag grant that stamps a classification on a channel stamps its audience and moves no channel\'s', () => {
    const stamps = all.filter(({ s }) => s.Effect === 'Allow' && actionsOf(s).includes('chime:TagResource')
      && list(s.Resource).some((r) => JSON.stringify(r).includes('/channel/*'))
      && s.Condition?.StringEquals?.['aws:RequestTag/classification'] !== undefined);
    expect(stamps.length).toBeGreaterThan(0);
    const wrong = stamps.filter(({ s }) => {
      const expected = [...new Set(list(s.Condition!.StringEquals!['aws:RequestTag/classification']).map((c) => profiles.audienceOf(String(c))))].sort();
      const requested = list(s.Condition?.StringEquals?.[REQUESTED_AUDIENCE]).map(String).sort();
      const existing = list(s.Condition?.StringEqualsIfExists?.[AUDIENCE]).map(String).sort();
      return JSON.stringify(requested) !== JSON.stringify(expected) || JSON.stringify(existing) !== JSON.stringify(expected);
    }).map(({ stack, id, s }) => `${stack}/${id} ${s.Sid ?? ''}`);
    expect(wrong).toEqual([]);
  });
});

describe('the audience rule refuses the shapes it names', () => {
  const stack = new cdk.Stack(new cdk.App(), 'S');
  const appInstance = `arn:aws:chime:us-east-1:${stack.account}:app-instance/x`;
  const json = (ss: { toStatementJson(): any }[]) => ss.map((s) => s.toStatementJson());

  it('a role serving every conversation carries both denials; a role of one classification carries none', () => {
    const shared = json(membershipAsAssistantStatements('S', appInstance, EVERY_CLASSIFICATION));
    expect(shared.filter((s) => s.Effect === 'Deny').map((s) => s.Sid)).toEqual(['SNeverAnOutsideConversation', 'SNeverAConversationWithNoAudience']);
    const own = json(membershipAsAssistantStatements('S', appInstance, ['basic']));
    expect(own.filter((s) => s.Effect === 'Deny')).toEqual([]);
    const asAdmin = json(membershipAsServiceAdminStatements('S', appInstance, EVERY_CLASSIFICATION, `${appInstance}/user/admin`));
    expect(asAdmin.filter((s) => s.Effect === 'Deny').length).toBe(2);
    expect(() => neverAnOutsideConversation('S', appInstance, [])).toThrow(/no action/);
  });

  it('a create requires the requested audience, and the audience is the classification\'s own', () => {
    expect(createOwnClassificationOnly('basic')).toEqual({
      StringEquals: { 'aws:RequestTag/classification': ['basic'], [REQUESTED_AUDIENCE]: ['members'] },
      Null: { 'aws:RequestTag/classification': 'false', [REQUESTED_AUDIENCE]: 'false' },
    });
    expect(createOwnClassificationOnly('customer').StringEquals[REQUESTED_AUDIENCE]).toEqual(['outside']);
    expect(profiles.audienceOf('admin')).toBe('members');
    expect(() => profiles.audienceOf('no-such-classification')).toThrow(/unknown classification/);
  });

  it('an outside classification may not declare Battle Mode, which never reaches it', () => {
    const config = {
      ...DEFAULT_PROFILES_CONFIG,
      classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'customer' ? { ...c, battleCapable: true } : c)),
    };
    expect(() => validateProfilesConfig(config)).toThrow(/outside classification 'customer' declares battleCapable/);
  });
});
