/**
 * A GROUP-SOURCED PARTICIPANT ROLE IS RECONCILED NARROWLY (DESIGN-CONVERSATION-TYPES section 6.1, tenet P4).
 *
 * Synthesized with a type that declares a group-sourced role at `premium` only: the classification's membership
 * reconcile holds the three grants keeping that role needs, and no more, and a classification no such type permits
 * holds none of them (deny test):
 *
 *  - the context row's `participantRoles` attribute alone, read and written, never another field;
 *  - `chime:CreateChannelModerator` in this classification's conversations only, bearing its own assistant;
 *  - invoking this classification's router alone, to name `person-joined` for a holder the role adds.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CONVERSATION_TYPES, type ConversationTypeConfig } from '../lib/config/conversation-types';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => JSON.stringify(v);

const types = CONVERSATION_TYPES as Record<string, ConversationTypeConfig>;
beforeAll(() => {
  types['test-oncall'] = {
    classifications: ['premium'],
    driftEnabled: false,
    participants: { participantRoles: { 'on-call:ops': { from: [{ group: 'ops' }], adds: true, confers: { moderator: true } } } },
  };
});
afterAll(() => { delete types['test-oncall']; });

function reconcileStatements(classification: string): Statement[] {
  const app = new cdk.App({ context: {} });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  const t = Template.fromStack(stack);
  const out: Statement[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    if (text(p.Properties.Roles).includes('GroupMembershipReconcileRole')) out.push(...p.Properties.PolicyDocument.Statement);
  }
  return out;
}

describe('the reconcile of a classification a group-sourced role\'s type permits', () => {
  let st: Statement[];
  beforeAll(() => { st = reconcileStatements('premium'); });

  it('reads and writes the participantRoles attribute of the context row, and no other', () => {
    const holdings = st.filter((s) => s.Sid === 'ReconcileParticipantRoleHoldings');
    expect(holdings).toHaveLength(1);
    expect(list(holdings[0].Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    expect(holdings[0].Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes']).toEqual(['channelArn', 'participantRoles']);
    expect(text(holdings[0].Resource)).not.toContain('/index/');
    const onTheRow = (s: Statement) => text(s.Resource).toLowerCase().includes('channelcontext') && !text(s.Resource).includes('/index/');
    expect(onTheRow(holdings[0])).toBe(true);
    const otherWrites = st.filter((s) => s.Sid !== 'ReconcileParticipantRoleHoldings' && onTheRow(s) && list(s.Action).some((a) => /dynamodb:(Put|Update|Delete|GetItem)/.test(String(a))));
    expect(otherWrites).toEqual([]);
  });

  it('makes a moderator only in its own classification\'s conversations, bearing its own assistant', () => {
    const moderate = st.filter((s) => list(s.Action).includes('chime:CreateChannelModerator') && s.Effect !== 'Deny');
    expect(moderate.length).toBeGreaterThan(0);
    for (const s of moderate) expect(text(s.Condition)).toContain('premium');
    expect(text(moderate)).not.toContain('"standard"');
  });

  it('names person-joined to its own router alone', () => {
    const invoke = st.filter((s) => list(s.Action).includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    expect(text(invoke[0].Resource)).toMatch(/-AgentHandler\*/);
    const tagged = Object.entries(invoke[0].Condition?.StringEquals ?? {}).filter(([k]) => k !== 'aws:ResourceTag/Instance').map(([, v]) => v);
    expect(list(tagged[0])).toEqual(['premium']);
  });
});

describe('a classification no such type permits (deny test)', () => {
  it('holds none of the three', () => {
    const st = reconcileStatements('standard');
    expect(st.filter((s) => s.Sid === 'ReconcileParticipantRoleHoldings')).toEqual([]);
    expect(st.filter((s) => list(s.Action).includes('chime:CreateChannelModerator'))).toEqual([]);
    expect(st.filter((s) => list(s.Action).includes('lambda:InvokeFunction'))).toEqual([]);
  });
});
