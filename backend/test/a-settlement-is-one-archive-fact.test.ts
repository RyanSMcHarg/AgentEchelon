/**
 * A SETTLEMENT NO TURN RECORDS IS ONE ARCHIVE FACT (ADR-067 decision 6, WT61; tenets D7, P4).
 *
 * What it proves: the fact carries references only and is put on the stream the archive reads, keyed by conversation;
 * the archive's consumer reads it as a row of the platform's own event type, filed against the person it names and
 * sent by nobody, and refuses one without its conversation or id; a stream that cannot be written leaves the settlement
 * standing; and only the task service may put to the stream, on that one stream, with no read (deny tests).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { ANALYTICS_PREFIX } from '../lib/stacks/agent-classification-common';
import { factRecord, putTaskSettledFact, type TaskSettledFact } from '../lambda/src/lib/archive-facts';

const FACT: TaskSettledFact = {
  factId: 't1#card#approved#2026-11-06T00:00:00.000Z', channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
  taskId: 't1', taskType: 'acknowledgement', fromState: 'asked', toState: 'approved', terminal: 'success', cause: 'card',
  personId: 'person-1', classification: 'premium', originMachineHash: 'abc123def456', runKey: 'r1', workflow: 'w', at: '2026-11-06T00:00:00.000Z',
};

describe('the fact', () => {
  afterEach(() => { delete process.env.FACT_STREAM_NAME; });

  it('is the archive\'s record shape, of the platform\'s own event type, with references only', () => {
    const rec = factRecord(FACT);
    expect(rec.EventType).toBe('AE_TASK_SETTLED');
    expect(Object.keys(rec.Payload).sort()).toEqual(Object.keys(FACT).sort());
    expect(JSON.stringify(rec)).not.toMatch(/content|text|requirement/i);
  });

  it('is put on the named stream, keyed by its conversation, and a failed put leaves the settlement standing', async () => {
    process.env.FACT_STREAM_NAME = 'chime-messaging-x';
    const sent: Array<{ input: { StreamName: string; PartitionKey: string; Data: Uint8Array } }> = [];
    await expect(putTaskSettledFact(FACT, { send: async (cmd) => { sent.push(cmd as never); } })).resolves.toBe(true);
    expect(sent[0].input.StreamName).toBe('chime-messaging-x');
    expect(sent[0].input.PartitionKey).toBe(FACT.channelArn);
    expect(JSON.parse(Buffer.from(sent[0].input.Data).toString('utf8'))).toEqual(factRecord(FACT));
    await expect(putTaskSettledFact(FACT, { send: async () => { throw new Error('throttled'); } })).resolves.toBe(false);
  });

  it('a deployment with no stream named puts nothing', async () => {
    const send = jest.fn();
    await expect(putTaskSettledFact(FACT, { send })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the archive reads it', () => {
  it('as a row of its own type, filed against the person it names, sent by nobody', async () => {
    const { transformToMessageRecord } = await import('../lambda/src/analytics-aurora/kinesis-archival');
    const row = await transformToMessageRecord(factRecord(FACT) as never);
    expect(row).toMatchObject({
      event_type: 'AE_TASK_SETTLED', message_id: `AE_TASK_SETTLED-${FACT.factId}`, channel_arn: FACT.channelArn,
      content: null, sender_arn: null, person_id: 'person-1', conversation_classification: 'premium', created_at: FACT.at,
    });
    expect(row!.metadata).toMatchObject({ taskId: 't1', toState: 'approved', cause: 'card' });
  });

  it('with an id that always fits its column, and two long ids stay two rows', async () => {
    const { transformToMessageRecord } = await import('../lambda/src/analytics-aurora/kinesis-archival');
    const schema = readFileSync(resolve(__dirname, '../lambda/src/analytics-aurora/schema/001-initial.sql'), 'utf8');
    const limit = Number(schema.match(/message_id VARCHAR\((\d+)\) NOT NULL/)![1]);
    // A request's run: its key names the run that asked, the step that asked and the assistant answering.
    const runKey = (stamp: string): string => `intent#alarm-state-changed#alarm-1793000000000-AgentEchelon-e2e-incident-watch-${stamp}#advisor#recheck#ops-premium`;
    const rowOf = (id: string) => transformToMessageRecord({ EventType: 'AE_RUN_ENDED', Payload: { factId: id, channelArn: FACT.channelArn, runKey: id, at: FACT.at } } as never);
    const one = (await rowOf(`${runKey('aaaaaaaa')}#end`))!.message_id;
    const other = (await rowOf(`${runKey('bbbbbbbb')}#end`))!.message_id;
    const tail = (await rowOf(`${runKey('aaaaaaaa')}#en2`))!.message_id;
    for (const id of [one, other, tail]) expect(id.length).toBeLessThanOrEqual(limit);
    expect(new Set([one, other, tail]).size).toBe(3);
    // A replay lands on the row it already wrote.
    expect((await rowOf(`${runKey('aaaaaaaa')}#end`))!.message_id).toBe(one);
    // The full key stays on the record, whatever the row's id.
    expect((await rowOf(`${runKey('aaaaaaaa')}#end`))!.metadata).toMatchObject({ runKey: `${runKey('aaaaaaaa')}#end` });
    // One that fits keeps the id it always had, so a replay of an earlier fact lands on its row.
    expect((await rowOf('short#end'))!.message_id).toBe('AE_RUN_ENDED-short#end');
  });

  it('and refuses one without its conversation or its id', async () => {
    const { transformToMessageRecord } = await import('../lambda/src/analytics-aurora/kinesis-archival');
    const { channelArn: _c, ...noChannel } = FACT;
    await expect(transformToMessageRecord({ EventType: 'AE_TASK_SETTLED', Payload: noChannel } as never)).resolves.toBeNull();
  });
});

describe('the task service records a press and a deadline', () => {
  it('both put the fact once the move is written, and never before it', () => {
    const src = readFileSync(resolve(__dirname, '../lambda/src/task-service.ts'), 'utf8');
    expect(src).toMatch(/updateTaskStatus\(task\.taskId, task\.channelArn, result\.terminal[\s\S]{0,400}putTaskSettledFact\(settledFact\(task, 'card'/);
    expect(src).toMatch(/TASK_DEADLINE_ENDING\);[\s\S]{0,200}putTaskSettledFact\(settledFact\(task, 'deadline'/);
  });
});

describe('only the task service may put to the stream (deny tests)', () => {
  type Statement = { Effect?: string; Action: unknown; Resource: unknown };
  type Resource = { Type: string; Properties?: Record<string, any> };
  const app = new cdk.App();
  const stack = assistantsOf('premium')(app, 'AgentEchelonAssistants-premium', CLASSIFICATION_TEST_PROPS as never);
  const r = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
  /** Each role's statements, inline or attached by policy. */
  const byRole = new Map<string, Statement[]>();
  for (const [id, x] of Object.entries(r)) {
    if (x.Type === 'AWS::IAM::Role') byRole.set(id, (x.Properties?.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement));
  }
  for (const x of Object.values(r)) {
    if (x.Type !== 'AWS::IAM::Policy' && x.Type !== 'AWS::IAM::ManagedPolicy') continue;
    for (const ref of list(x.Properties?.Roles)) {
      const id = (ref as { Ref?: string })?.Ref;
      if (id && byRole.has(id)) byRole.get(id)!.push(...(x.Properties?.PolicyDocument?.Statement ?? []));
    }
  }
  const kinesisAllows = (st: Statement[]) => st.filter((s) => s.Effect !== 'Deny' && list(s.Action).some((a) => /^kinesis:/.test(String(a)) || a === '*'));

  it('DENY: no role of the classification but the task service holds a Kinesis action', () => {
    const holders = [...byRole.entries()].filter(([, st]) => kinesisAllows(st).length).map(([id]) => id);
    expect(holders.length).toBe(1);
    expect(holders[0]).toMatch(/^TaskServiceRole[0-9A-F]{8}$/);
  });

  it('DENY: the task service puts records, reads none, and only on the stream the archive reads', () => {
    const role = [...byRole.keys()].find((id) => /^TaskServiceRole[0-9A-F]{8}$/.test(id))!;
    const allows = kinesisAllows(byRole.get(role)!);
    expect(allows).toHaveLength(1);
    expect(list(allows[0].Action)).toEqual(['kinesis:PutRecord']);
    expect(JSON.stringify(allows[0].Resource)).toContain(`:stream/chime-messaging-${ANALYTICS_PREFIX}`);
    expect(JSON.stringify(allows[0].Resource)).not.toMatch(/stream\/\*|"\*"/);
  });
});

describe('a run\'s end is one archive fact (WT62)', () => {
  afterEach(() => { delete process.env.FACT_STREAM_NAME; });

  it('is put once per run, references only, and the archive files it against the person who asked', async () => {
    process.env.FACT_STREAM_NAME = 'chime-messaging-x';
    const { putRunEndedFact } = await import('../lambda/src/lib/archive-facts');
    const sent: Array<{ input: { Data: Uint8Array } }> = [];
    const fact = {
      factId: 'intent#corr-1#advisor#end', channelArn: FACT.channelArn, runKey: 'intent#corr-1#advisor', workflow: 'report_generation',
      trigger: 'intent', disposition: 'success' as const, classification: 'premium', steps: [{ step: 'work', outcome: 'opened' }],
      personId: 'person-1', at: '2026-11-06T00:00:00.000Z',
    };
    await expect(putRunEndedFact(fact, { send: async (cmd) => { sent.push(cmd as never); } })).resolves.toBe(true);
    const rec = JSON.parse(Buffer.from(sent[0].input.Data).toString('utf8'));
    expect(rec.EventType).toBe('AE_RUN_ENDED');
    const { transformToMessageRecord } = await import('../lambda/src/analytics-aurora/kinesis-archival');
    const row = await transformToMessageRecord(rec);
    expect(row).toMatchObject({ event_type: 'AE_RUN_ENDED', message_id: 'AE_RUN_ENDED-intent#corr-1#advisor#end', person_id: 'person-1', content: null });
  });

  it('the runner names its end once, through the claim that ends the run', async () => {
    const { runEventWorkflow } = await import('../lambda/src/lib/event-workflow');
    const ended: string[] = [];
    const claims = new Set<string>();
    const wf = { on: 'assistant-joined', initial: 'done', states: { done: { disposition: 'success' } } } as never;
    const deps = {
      claimRun: async () => true, claimStep: async (s: string) => !claims.has(s) && !!claims.add(s),
      mentionName: async () => '', send: async () => true, dispatchAgent: async () => true,
      ended: async (d: string) => { ended.push(d); },
    };
    await runEventWorkflow('w', wf, { event: 'assistant-joined', channelArn: 'c', values: {} }, deps as never);
    await runEventWorkflow('w', wf, { event: 'assistant-joined', channelArn: 'c', values: {} }, { ...deps, claimRun: async () => true } as never);
    expect(ended).toEqual(['success']);
  });
});
