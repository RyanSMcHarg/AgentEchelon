/**
 * TTFF less the router's own span used to be one remainder. The channel flow now records when it
 * received a standard-path message, the instant rides the turn to the ledger, and the latency query
 * splits the remainder into reaching the flow, the flow handing to the router, and what is left.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ledgerRowsFor } from '../../lambda/src/analytics-aurora/turn-events-live';
import { buildAnalyticsMetadata } from '../../lambda/src/lib/analytics-metadata';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/premium';
const T0 = Date.parse('2026-10-26T00:00:01.000Z');

const rec = (over: Record<string, unknown> = {}) => ({
  event_type: 'CREATE_CHANNEL_MESSAGE',
  message_id: 'm-1',
  channel_arn: CHANNEL,
  sender_arn: BOT,
  is_bot: true,
  created_at: '2026-10-26T00:00:02.000Z',
  last_updated_at: null,
  resp_phase: null,
  content: 'One moment<!--corr:turn-abc-->',
  task_id: null,
  task_state: null,
  router_steps: [{ step: 'entry', at: T0 + 80 }, { step: 'dispatched', at: T0 + 600 }],
  flow_received_at: T0,
  ...over,
} as any);

const flowRows = (over: Record<string, unknown> = {}) =>
  ledgerRowsFor([rec(over)]).filter((r) => r.kind === 'flow_received');

describe('the flow receipt reaches the ledger', () => {
  it('as one server-clock row on the response, at the instant the flow took', () => {
    const rows = flowRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ response_id: 'm-1', clock: 'server', auditable: false, step_name: null });
    expect(Date.parse(rows[0].occurred_at)).toBe(T0);
  });

  it('beside the router steps, not among them, so the router span stays its own', () => {
    const steps = ledgerRowsFor([rec()]).filter((r) => r.kind === 'router_step').map((r) => r.step_name);
    expect(steps).toEqual(['entry', 'dispatched']);
  });

  it('even on a turn that recorded no router steps', () => {
    expect(flowRows({ router_steps: null })).toHaveLength(1);
  });

  it('only where the record establishes a response, as the router steps are', () => {
    expect(flowRows({ content: 'no marker here' })).toHaveLength(0);
    expect(flowRows({ is_bot: false })).toHaveLength(0);
  });

  it('nothing for a Lex-entered turn, which never crossed the flow', () => {
    expect(flowRows({ flow_received_at: null })).toHaveLength(0);
  });
});

describe('the instant rides the turn from the flow to the archive', () => {
  it('the worker writes it on the analytics record', () => {
    expect(buildAnalyticsMetadata({ flowReceivedAt: T0 } as never)).toMatchObject({ flowReceivedAt: T0 });
    expect(buildAnalyticsMetadata({} as never)).not.toHaveProperty('flowReceivedAt');
  });

  it('the flow stamps it per invocation and puts it on the turn it hands to the router (source)', () => {
    const flow = src('channel-flow-processor.ts');
    expect(flow).toMatch(/flowReceipt\.run\(Date\.now\(\), \(\) => handleFlowEvent\(event\)\)/);
    expect(flow).toMatch(/const aeTurn: TurnRequest = \{[\s\S]{0,200}flowReceivedAt/);
  });

  it('the router carries it with its own timing on every dispatch, outside its step log (source)', () => {
    const router = src('router-agent-handler.ts');
    expect(router).toMatch(/\[BYPASS_FLOW_RECEIVED_ATTR\]: String\(req\.flowReceivedAt\)/);
    expect(router).toMatch(/return \{ routerMs: at - routerStart, routerSteps, \.\.\.\(flowReceivedAt && \{ flowReceivedAt \}\) \}/);
  });

  it('the worker forwards it and the archive hands it to the ledger (source)', () => {
    expect(src('lib/async-processor-core.ts')).toMatch(/flowReceivedAt: event\.flowReceivedAt/);
    expect(src('analytics-aurora/kinesis-archival.ts')).toMatch(/flow_received_at: r\.flow_received_at/);
  });

  it('one instant per response, arbitrated by the database (migration 090)', () => {
    const sql = src('analytics-aurora/schema/090-the-channel-flow-records-when-it-received-a-message.sql');
    expect(sql).toMatch(/ON turn_events \(source_message_id, kind\)\s+WHERE kind = 'flow_received'/);
  });
});

describe('the latency query splits the remainder', () => {
  const q = src('analytics-aurora/analytics-query.ts');
  it('reads the flow receipt and the router entry off the same response', () => {
    expect(q).toMatch(/MIN\(te\.occurred_at\) FILTER \(WHERE te\.kind = 'flow_received'\) AS flow_at/);
    expect(q).toMatch(/te\.kind = 'router_step' AND te\.step_name = 'entry'\) AS router_entry_at/);
  });

  it('returns the three parts and the turns they are taken over', () => {
    for (const col of ['avg_to_flow_ms', 'avg_flow_to_router_ms', 'avg_placeholder_return_ms', 'flow_split_count']) {
      expect(q).toContain(`'${col}'`);
    }
  });
});
