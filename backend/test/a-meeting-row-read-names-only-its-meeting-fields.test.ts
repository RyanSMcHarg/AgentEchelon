/**
 * A READ OF A CONVERSATION'S MEETING FIELDS READS THOSE FIELDS ALONE (SPEC-ASSISTANT-MEETINGS FR42; tenets D4, D13).
 *
 * The proposals function (`add_to_meeting`) reads a context row's meeting attributes by `GetItem`; the assistant's session
 * reads none (a turn's meeting place is read by its own router, `handleMeetingPlaceRead`). `ForAllValues` on `dynamodb:Attributes` holds vacuously for a request that names no
 * attribute, and a `GetItem` with no projection names none and returns the whole row, so each grant also requires the
 * attribute list present (`Null`), `SPECIFIC_ATTRIBUTES` where a `Select` is sent, and a key that is a channel of this
 * app instance. This evaluates the conditions as IAM does for each request a caller could make.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS, TEST_APP_INSTANCE_ARN } from './helpers/synth';
import { meetingRowReadConditions, SHARED_SSM } from '../lib/stacks/agent-classification-common';

interface Request { key: string; attributes?: string[]; select?: string }

/** Whether a condition block admits a request: the operators these grants use, as IAM evaluates them. */
function admits(conditions: Record<string, Record<string, unknown>>, r: Request): boolean {
  const values: Record<string, string[] | undefined> = {
    'dynamodb:Attributes': r.attributes, 'dynamodb:LeadingKeys': [r.key], 'dynamodb:Select': r.select ? [r.select] : undefined,
  };
  const glob = (p: string, v: string) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(v);
  for (const [op, kv] of Object.entries(conditions)) {
    for (const [key, raw] of Object.entries(kv)) {
      const want = (Array.isArray(raw) ? raw : [raw]).map(String);
      const got = values[key];
      if (op === 'ForAllValues:StringEquals' && !(got ?? []).every((v) => want.includes(v))) return false;
      if (op === 'ForAllValues:StringLike' && !(got ?? []).every((v) => want.some((w) => glob(w, v)))) return false;
      if (op === 'StringEqualsIfExists' && got && !got.every((v) => want.includes(v))) return false;
      if (op === 'Null' && (want[0] === 'false') !== (got !== undefined)) return false;
    }
  }
  return true;
}

const ROW = `${TEST_APP_INSTANCE_ARN}/channel/room-1`;
const PROJECTED = ['channelArn', 'conversationType', 'participantRoles', 'meetingOf', 'meetingConversation', 'activeMeeting'];
const c = meetingRowReadConditions(TEST_APP_INSTANCE_ARN);

describe('a meeting-row read', () => {
  it('admits a read projected to the meeting fields, of a channel of this app instance', () => {
    expect(admits(c, { key: ROW, attributes: PROJECTED })).toBe(true);
    expect(admits(c, { key: ROW, attributes: ['conversationType', 'participantRoles'], select: 'SPECIFIC_ATTRIBUTES' })).toBe(true);
  });

  it('REFUSED: a read with no projection, which would return the whole row', () => {
    expect(admits(c, { key: ROW })).toBe(false);
    expect(admits(c, { key: ROW, select: 'ALL_ATTRIBUTES' })).toBe(false);
  });

  it('REFUSED: a projection naming any other attribute, or a key outside this app instance\'s channels', () => {
    expect(admits(c, { key: ROW, attributes: [...PROJECTED, 'lastMeeting'] })).toBe(false);
    expect(admits(c, { key: ROW, attributes: PROJECTED, select: 'ALL_ATTRIBUTES' })).toBe(false);
    expect(admits(c, { key: 'arn:aws:chime:us-east-1:123456789012:app-instance/other/channel/x', attributes: PROJECTED })).toBe(false);
    expect(admits(c, { key: 'person#u-1', attributes: PROJECTED })).toBe(false);
  });
});

describe('who reads a meeting row', () => {
  it("REFUSED: the acting role holds no read of the context table, so a turn's session reads no conversation's meeting (tenets D1, D12)", () => {
    const app = new cdk.App({ context: {} });
    const stack = assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', { ...CLASSIFICATION_TEST_PROPS, capabilities: ['meetings'] } as never);
    const json = Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties?: any }>; Parameters?: Record<string, { Default?: string }> };
    const resources = json.Resources;
    // The context table's ARN, as the stack reads it: the shared parameter it resolves at deploy.
    const [tableParam] = Object.entries(json.Parameters ?? {}).find(([, v]) => v.Default === SHARED_SSM.channelContextArn)!;
    const [actingId, acting] = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && /AssistantActingRole/.test(id))!;
    const onActing = (r: { Properties?: any }) => JSON.stringify(r.Properties?.Roles ?? []).includes(`"${actingId}"`);
    const statements = [
      ...((acting.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: unknown[] } }>).flatMap((p) => p.PolicyDocument.Statement),
      ...Object.values(resources).filter((r) => (r.Type === 'AWS::IAM::ManagedPolicy' || r.Type === 'AWS::IAM::Policy') && onActing(r))
        .flatMap((r) => r.Properties.PolicyDocument.Statement as unknown[]),
    ] as Array<{ Action?: string | string[]; Resource?: unknown }>;
    expect(statements.length).toBeGreaterThan(0);
    const reads = statements.filter((s) => ([] as string[]).concat(s.Action ?? []).some((a) => /^dynamodb:(GetItem|BatchGetItem|Query|Scan|\*)$/.test(a) || a === '*')
      && (JSON.stringify(s.Resource ?? '').includes(`{"Ref":"${tableParam}"}`) || JSON.stringify(s.Resource ?? '') === '"*"'));
    expect(reads).toEqual([]);
    // The grant this replaced is gone, and the processor is not told the table.
    expect(JSON.stringify(resources)).not.toContain('AssistantMeetingRead');
    const processor = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::Lambda::Function' && /^AsyncProcessor[0-9A-F]{8}$/.test(id));
    expect(processor).toBeDefined();
    expect(Object.keys(processor![1].Properties.Environment.Variables)).not.toContain('CHANNEL_CONTEXT_TABLE');
  });

  it("an invitee's name is read on the processor's own role, never on the acting role or a session edge (tenet D1)", () => {
    const app = new cdk.App({ context: {} });
    const stack = assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', { ...CLASSIFICATION_TEST_PROPS, capabilities: ['meetings'] } as never);
    const resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties?: any }> }).Resources;
    const [actingId] = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && /AssistantActingRole/.test(id))!;
    const names = (s: { Action?: string | string[] }) => ([] as string[]).concat(s.Action ?? []).includes('chime:DescribeAppInstanceUser');
    const holders = Object.entries(resources).filter(([, r]) => (r.Type === 'AWS::IAM::ManagedPolicy' || r.Type === 'AWS::IAM::Policy')
      && (r.Properties.PolicyDocument.Statement as Array<{ Action?: string | string[] }>).some(names));
    const policy = holders.find(([id]) => /ProcessorMeetingInviteeNames/.test(id));
    expect(policy).toBeDefined();
    expect(JSON.stringify(policy![1].Properties.Roles)).not.toContain(actingId);
    for (const [, r] of holders) {
      expect(JSON.stringify(r.Properties.Roles ?? [])).not.toContain(`"${actingId}"`);
      expect(String(r.Properties.ManagedPolicyName ?? '')).not.toMatch(/AssistantGrant-/);
    }
    const acting = resources[actingId].Properties;
    for (const p of acting.Policies ?? []) expect((p.PolicyDocument.Statement as Array<{ Action?: string | string[] }>).some(names)).toBe(false);
  });

  it("the proposals function's read (ReadTheParticipantRoleHoldings)", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stacks', 'conversations-stack.ts'), 'utf8');
    const at = src.indexOf("sid: 'ReadTheParticipantRoleHoldings'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toContain('conditions: meetingRowReadConditions(props.appInstanceArn)');
  });
});
