/**
 * THE UPGRADE PATHS AND THE SECOND ISSUER, AS SYNTHESIZED (B6, B7, P-11, P-12).
 *
 * With a guest issuer and a customers' pool declared:
 *  - the exchange may delete a guest-issuer `Identities` row and no other issuer's (path A's bind), and
 *    query the `byPerson` index (B7's check of the issuers a person already holds);
 *  - the exchange verifies a second issuer's token against `LINK_ISSUERS`, which carries every issuer
 *    the edge verifies except a guest and a host;
 *  - the customer classification has its own exchange role, in its own stack, because a signed-in issuer reaches it,
 *    and the guest classification's stack builds none;
 *  - path B's function writes the `registration` and `claim` kinds of `Tokens` and no other, and invokes
 *    the customer classification's creator and no other;
 *  - offboarding may read a channel's tags and delete messages only in a conversation for outside people, bearing the
 *    service admin (the channel it erases in is the visitor's, which `upgradedFrom` names, tagged audience `outside`);
 *  - the exchange continues a bound visit only through a creator its classification's own stack tags `bindTarget`.
 * Without a guest issuer none of the guest-only grants exist.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { conversationsTemplate, identityTemplate, CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { assistantsOf } from './helpers/assistants';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const SELF = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true };
const GUEST = { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] } };
const CUSTOMERS = { id: 'customers', kind: 'cognito-pool', pool: 'us-east-1_Customers', audience: 'customers-client', clearance: { fixed: ['customer'], classifications: ['customer'] } };
const WITH = { issuers: [SELF, GUEST, CUSTOMERS] };
const WITHOUT = { issuers: [SELF] };

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const actions = (st: Statement) => list(st.Action).map(String);
const text = (v: unknown) => JSON.stringify(v);

function statementsOf(t: Template, roleId: string): Statement[] {
  const out: Statement[] = [];
  const role = t.findResources('AWS::IAM::Role')[roleId] as any;
  for (const p of role?.Properties?.Policies ?? []) out.push(...p.PolicyDocument.Statement);
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    if ((p.Properties.Roles ?? []).some((r: any) => r.Ref === roleId)) out.push(...p.Properties.PolicyDocument.Statement);
  }
  return out;
}
const idOf = (t: Template, type: string, prefix: string): string | undefined => Object.keys(t.findResources(type)).find((k) => k.startsWith(prefix));

describe('Identity', () => {
  const t = identityTemplate(WITH);
  const exchange = statementsOf(t, idOf(t, 'AWS::IAM::Role', 'CredentialExchangeRole')!);

  it('lets the exchange delete a guest-issuer row and no other, for the bind', () => {
    const deletes = exchange.filter((s) => actions(s).includes('dynamodb:DeleteItem'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Sid).toBe('BindRemovesTheGuestRow');
    expect(deletes[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['guest|*'] } });
  });

  it('lets the exchange query the byPerson index, and verify a linked token against every issuer but a guest', () => {
    const query = exchange.filter((s) => actions(s).includes('dynamodb:Query'));
    expect(query.map((s) => s.Sid)).toEqual(['LinkReadsThePersonsSubjects']);
    expect(text(query[0].Resource)).toContain('/index/byPerson');
    const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.Environment?.Variables?.LINK_ISSUERS) as any;
    const linkIssuers = text(fn.Properties.Environment.Variables.LINK_ISSUERS);
    expect(linkIssuers).toContain('customers');
    expect(linkIssuers).not.toContain('\\"kind\\":\\"guest\\"');
  });

  it('gives the customer classification an exchange role in its own stack, and the guest none', () => {
    const stackOf = (c: string) => Template.fromStack(assistantsOf(c)(new cdk.App({ context: WITH }), `Assistants-${c}`, CLASSIFICATION_TEST_PROPS as never));
    expect(idOf(stackOf('customer'), 'AWS::IAM::Role', 'ExchangeRole')).toBeDefined();
    expect(idOf(stackOf('guest'), 'AWS::IAM::Role', 'ExchangeRole')).toBeUndefined();
    // And nothing in Identity is either's.
    expect(Object.keys(t.findResources('AWS::IAM::Role')).filter((k) => /^ExchangeRole(Customer|Guest)/.test(k))).toEqual([]);
  });

  it('lets offboarding delete messages only in a conversation for outside people, bearing the service admin', () => {
    const offboarding = statementsOf(t, idOf(t, 'AWS::IAM::Role', 'OffboardingRole')!);
    const erase = offboarding.filter((s) => actions(s).includes('chime:DeleteChannelMessage'));
    expect(erase.map((s) => s.Sid).sort()).toEqual(['UpgradeSourceEraseAsItsBearer', 'UpgradeSourceEraseInOutsideConversations']);
    const channelLeg = erase.find((s) => text(s.Resource).includes('/channel/'))!;
    expect(channelLeg.Condition).toEqual({
      StringEquals: { 'aws:ResourceTag/audience': 'outside' },
      Null: { 'aws:ResourceTag/classification': 'false' },
    });
    const bearerLeg = erase.find((s) => !text(s.Resource).includes('/channel/'))!;
    expect(text(bearerLeg.Resource)).not.toContain('*');
    expect(statementsOf(identityTemplate(WITHOUT), idOf(identityTemplate(WITHOUT), 'AWS::IAM::Role', 'OffboardingRole')!)
      .filter((s) => actions(s).includes('chime:DeleteChannelMessage'))).toEqual([]);
  });

  it('holds none of the bind grants without a guest issuer', () => {
    const none = identityTemplate(WITHOUT);
    const ex = statementsOf(none, idOf(none, 'AWS::IAM::Role', 'CredentialExchangeRole')!);
    expect(ex.some((s) => actions(s).includes('dynamodb:DeleteItem'))).toBe(false);
  });
});

describe('Conversations', () => {
  const t = conversationsTemplate(WITH);
  const fnId = idOf(t, 'AWS::Lambda::Function', 'GuestUpgradeFunction');

  it('serves path B from one function, writing its own two token kinds and no other', () => {
    expect(fnId).toBeDefined();
    const fn = t.findResources('AWS::Lambda::Function')[fnId!] as any;
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    const st = statementsOf(t, roleId);
    const tokenWrites = st.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:Put') || a.startsWith('dynamodb:Update')));
    expect(tokenWrites).toHaveLength(1);
    expect(tokenWrites[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['registration#*', 'claim#*'] } });
    // The one creator it opens a conversation through; and, for the funnel's stages (B12), this instance's
    // archive data plane alone, bounded by its Instance tag, which is the archive's writer and no creator.
    const invokes = st.filter((s) => actions(s).includes('lambda:InvokeFunction'));
    const archive = invokes.filter((s) => s.Sid === 'UpgradeFunnelDataPlane');
    expect(archive).toHaveLength(1);
    expect(text(archive[0].Resource)).toMatch(/Archive\*DataPlaneLambda\*/);
    expect(archive[0].Condition).toEqual({ StringEquals: { 'aws:ResourceTag/Instance': expect.any(String) } });
    // The claim target's creator, which opens the conversation; and the visitor's own classification's creator,
    // which assesses the visit and retires it once the seed is written (FR26), each its own statement.
    const creators = invokes.filter((s) => s.Sid !== 'UpgradeFunnelDataPlane');
    expect(creators.map((s) => s.Sid).sort()).toEqual(['AssessAndRetireTheVisit', 'OpenTheClaimedConversation']);
    // Each by the creators' name pattern and the one classification it may ask.
    const askedOf = (sid: string) => (creators.find((s) => s.Sid === sid)!.Condition as any).StringEquals['aws:ResourceTag/classification'];
    expect(askedOf('OpenTheClaimedConversation')).toBe('customer');
    expect(askedOf('AssessAndRetireTheVisit')).toBe('guest');
    for (const s of creators) expect(text(s.Resource)).toContain('Assistants-*-ConversationCreator');
  });

  it('lets only the visitors\' creator read and delete a visit, of its own classification, bearing the service admin', () => {
    // The creators are their classifications' own stacks'; this stack holds none, and no function in it deletes a channel.
    const inConversations = [
      ...Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement as Statement[]),
      ...Object.values(t.findResources('AWS::IAM::Role')).flatMap((r: any) => (r.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement as Statement[])),
    ];
    expect(inConversations.filter((s) => actions(s).includes('chime:DeleteChannel'))).toEqual([]);
    const statementsIn = (c: string) => {
      const tpl = Template.fromStack(assistantsOf(c)(new cdk.App({ context: WITH }), `Assistants-${c}`, CLASSIFICATION_TEST_PROPS as never));
      return [
        ...Object.values(tpl.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement as Statement[]),
        ...Object.values(tpl.findResources('AWS::IAM::Role')).flatMap((r: any) => (r.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement as Statement[])),
      ];
    };
    expect(statementsIn('customer').filter((s) => actions(s).includes('chime:DeleteChannel'))).toEqual([]);
    const all = statementsIn('guest');
    const channel = all.filter((s) => s.Sid === 'VisitReadAndRetireOwnClassificationChannel');
    expect(channel).toHaveLength(1);
    expect(actions(channel[0]).sort()).toEqual(['chime:DeleteChannel', 'chime:ListChannelMessages']);
    expect(channel[0].Condition).toEqual({ StringEquals: { 'aws:ResourceTag/classification': 'guest' } });
    expect(all.filter((s) => s.Sid === 'VisitAssessedOnTheAssistantsModel')).toHaveLength(1);
    // No other grant in the visitors' stack may delete a channel.
    const deleters = all.filter((s) => actions(s).includes('chime:DeleteChannel'));
    expect(deleters.map((s) => s.Sid).sort()).toEqual(['VisitReadAndRetireAsTheServiceAdmin', 'VisitReadAndRetireOwnClassificationChannel']);
  });

  it('lets the exchange continue a bound visit only through a creator tagged bindTarget, and read a registration and no other kind', () => {
    const all = Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement as Statement[]);
    const bind = all.filter((s) => s.Sid === 'BindContinuesTheVisit');
    expect(bind).toHaveLength(1);
    expect(actions(bind[0])).toEqual(['lambda:InvokeFunction']);
    // A creator its own stack tags as a bind target, by the creators' name pattern: no list of classifications.
    expect(text(bind[0].Resource)).toContain('Assistants-*-ConversationCreator');
    expect(bind[0].Condition).toEqual({
      Null: { 'aws:ResourceTag/classification': 'false' },
      StringEquals: { 'aws:ResourceTag/bindTarget': 'true', 'aws:ResourceTag/Instance': expect.any(String) },
    });
    const registration = all.filter((s) => s.Sid === 'TokenKindsregistration' && actions(s).includes('dynamodb:GetItem'));
    expect(registration).toHaveLength(1);
    expect(actions(registration[0])).toEqual(['dynamodb:GetItem']);
    expect(registration[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['registration#*'] } });
  });

  it('tags a creator bindTarget in its own stack exactly when a visit continues at its classification', () => {
    const tagsOfCreator = (c: string) => {
      const tpl = Template.fromStack(assistantsOf(c)(new cdk.App({ context: WITH }), `Assistants-${c}`, CLASSIFICATION_TEST_PROPS as never));
      const fn = Object.entries(tpl.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('ConversationCreator'))![1] as any;
      return Object.fromEntries((fn.Properties.Tags ?? []).map((t: { Key: string; Value: string }) => [t.Key, t.Value]));
    };
    expect(tagsOfCreator('basic').bindTarget).toBe('true');
    expect(tagsOfCreator('customer').bindTarget).toBe('true');
    expect(tagsOfCreator('guest').bindTarget).toBeUndefined();
  });

  it('has no path B without a guest issuer', () => {
    expect(idOf(conversationsTemplate(WITHOUT), 'AWS::Lambda::Function', 'GuestUpgradeFunction')).toBeUndefined();
  });
});
