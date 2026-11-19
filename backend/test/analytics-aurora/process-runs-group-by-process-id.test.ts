/**
 * PROCESS RUNS GROUP BY PROCESS ID (SPEC-PROCESSES P8 to P10; DESIGN-PROCESSES section 6).
 *
 * What it proves: one query reads a process's runs from what the archive already holds, the process on each run message's
 * out-of-band record and on its run-ended fact, joined by run key, so a message archived before its record costs the run
 * nothing; it adds no table and no counter (D7); a team's route answers for its own assistants' runs only, by message and
 * by the run key a fact names; every row rides the one scoped row key; and the console reads each active version's
 * processes, their metrics and the edition the metrics are computed for, from the listing it already reads.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ASSISTANT_FILTERED_QUERIES, PROCESS_RUNS_CAP, capProcessRuns, processGroupRows, processRunRows } from '../../lambda/src/analytics-aurora/analytics-query';
import { eventWorkflowsListedOf } from '../../lambda/src/lib/profile-lifecycle';
import { type VersionProcess } from '../../lambda/src/lib/event-workflow';
import { processEditionOf } from '../../lambda/src/lib/process-start';

const src = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
const cte = src.slice(src.indexOf('const PROCESS_RUNS_CTE'), src.indexOf('async function getProcessRuns('));
const fn = src.slice(src.indexOf('async function getProcessRuns('), src.indexOf('export function processGroupRows('));

describe('one query over what the archive holds', () => {
  it('reads the process from the out-of-band record and the run-ended fact, joined by run key', () => {
    expect(cte).toMatch(/m\.metadata->'processRun'->>'processId'/);
    expect(cte).toMatch(/f\.event_type = 'AE_RUN_ENDED' AND f\.metadata \? 'processId'/);
    expect(cte).toMatch(/FULL OUTER JOIN ends e ON e\.run_key = m\.run_key/);
  });

  it('adds no table and no counter: it reads messages only', () => {
    const tables = [...(cte + fn).matchAll(/\bFROM\s+([a-z_]+)/gi)].map((m) => m[1]).filter((n) => !['runs', 'procs', 'msg_runs', 'ends', 'step_firsts', 'step_msgs', 'step_usage'].includes(n));
    expect(new Set(tables)).toEqual(new Set(['messages']));
    expect(cte + fn).not.toMatch(/INSERT|UPDATE\s|CREATE TABLE/i);
  });

  it('a team reads its own assistants\' runs: by message, and by the assistant a fact\'s run key ends with', () => {
    expect(ASSISTANT_FILTERED_QUERIES.has('process_runs')).toBe(true);
    expect(cte).toMatch(/\$3::varchar IS NULL OR m\.assistant = \$3/);
    expect(cte).toMatch(/\$3::varchar IS NULL OR f\.metadata->>'runKey' LIKE '%#' \|\| \$3/);
    expect(cte).toMatch(/\$5::text\[\] IS NULL OR f\.metadata->>'classification' = ANY\(\$5\)/);
  });

  it('every row, the runs included, rides the one scoped row key', () => {
    expect(fn).toMatch(/return success\(\{ data: \[\.\.\.processGroupRows\([^)]*\), \.\.\.processRunRows\([^)]*\)\], truncated \}\);/);
  });

  it('a window with more runs than the cap says it was cut: one row past the cap is read, and the runs past it are not sent', () => {
    expect(fn).toContain('LIMIT ${PROCESS_RUNS_CAP + 1}');
    const many = Array.from({ length: PROCESS_RUNS_CAP + 1 }, (_, i) => i);
    expect(capProcessRuns(many)).toEqual({ rows: many.slice(0, PROCESS_RUNS_CAP), truncated: true });
    const exact = many.slice(0, PROCESS_RUNS_CAP);
    expect(capProcessRuns(exact)).toEqual({ rows: exact, truncated: false });
  });

  it("each run's step times are the first message of each of its steps, its own or an asked turn's that names the step, read once over the window", () => {
    // A REQUEST TO ANOTHER ASSISTANT is answered under that assistant's own run (WT118), so its message names the asking step.
    expect(fn).toContain("COALESCE(s.metadata->'askedStep'->>'runKey', s.workflow_run_key) AS run_key");
    expect(fn).toContain("COALESCE(s.metadata->'askedStep'->>'step', s.workflow_step) AS step, s.created_at AS at");
    expect(fn).toContain('SELECT f.run_key, f.step, MIN(f.at) AS at');
    expect(fn).toContain('WHERE f.run_key IN (SELECT run_key FROM runs)');
    // READ ONCE: a materialized step list, not a scan per run.
    expect(fn).toContain('step_firsts AS MATERIALIZED (');
    expect(fn).toContain('AS step_times');
    expect(fn).toContain('($5::text[] IS NULL OR s.conversation_classification = ANY($5))');
  });

  it('one process id narrows every row, so the drill reads that process\'s own row (ended, succeeded) beside its runs', () => {
    expect(cte).toMatch(/AND \(\$6::varchar IS NULL OR COALESCE\(e\.process_id, m\.process_id\) = \$6\)/);
    expect(fn).toContain('conversationClassifications, params.processId || null];');
    // A PROCESS ENDS ONLY WHEN EVERY RUN CARRYING ITS ID HAS ENDED, so a run with no end keeps it open.
    expect(cte).toContain('BOOL_AND(ended_at IS NOT NULL) AS all_ended');
  });

  it('groups by process, workflow and team, and measures no hand-off', () => {
    expect([...fn.matchAll(/SELECT '([a-z]+)'/g)].map((m) => m[1])).toEqual(['process', 'workflow', 'team']);
    expect(cte + fn).not.toMatch(/handoff|run_trigger|refused/);
  });
});

describe('each run names where it ran and whose workflow it is, from the messages already read', () => {
  it('the conversation of the run\'s first message, or of its end fact where no message is in the window', () => {
    expect(cte).toContain('(ARRAY_AGG(m.channel_arn ORDER BY m.created_at))[1] AS channel_arn');
    expect(cte).toContain('f.created_at AS ended_at, f.channel_arn');
    expect(cte).toContain('COALESCE(m.channel_arn, e.channel_arn) AS channel_arn');
  });

  it('the assistant its run key names last (`<event>#<natural key>#<assistant>`), and both ride every run row', () => {
    expect(cte).toContain("SUBSTRING(COALESCE(m.run_key, e.run_key) FROM '#([^#]+)$') AS assistant");
    expect('conversation-opened#conv-1#ops-premium'.match(/#([^#]+)$/)?.[1]).toBe('ops-premium');
    expect(fn).toContain('r.channel_arn, r.assistant, r.started_at,');
    const [run] = processRunRows([{ process_id: 'p', workflow: 'ops-room', channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c', assistant: 'ops-premium', started_at: null, ended_at: null, process_started_at: null }]);
    expect(run).toMatchObject({ channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c', assistant: 'ops-premium' });
  });
});

describe('the rows as the console reads them', () => {
  it('counts and times as numbers', () => {
    expect(processGroupRows([{ dimension: 'process', process: 'incident-response', runs: '4', ended: '3', succeeded: '2', p50_ms: '3600000.4', p95_ms: null }]))
      .toEqual([{ dimension: 'process', process: 'incident-response', runs: 4, ended: 3, succeeded: 2, p50_ms: 3600000, p95_ms: null }]);
  });

  it('a run: references, its steps by name and outcome, and its times as epoch milliseconds', () => {
    const [run] = processRunRows([{ process_id: 'a1b2c3d4e5f6', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'task:success:acknowledged' }], started_at: '2026-11-16T10:00:00Z', ended_at: null, process_started_at: '2026-11-16T09:00:00Z' }]);
    expect(run).toEqual({ dimension: 'run', process_id: 'a1b2c3d4e5f6', workflow: 'ops-room', steps: [{ step: 'review', outcome: 'task:success:acknowledged' }], started_at: Date.parse('2026-11-16T10:00:00Z'), ended_at: null, process_started_at: Date.parse('2026-11-16T09:00:00Z'), step_times: [], step_costs: [] });
  });

  it('each step the run took, when it first said something, oldest first, as epoch milliseconds; a step with no time is left out', () => {
    const [run] = processRunRows([{ process_id: 'a1b2c3d4e5f6', workflow: 'ops-room', steps: [], started_at: '2026-11-16T10:00:00Z', ended_at: '2026-11-16T12:00:00Z', process_started_at: '2026-11-16T09:00:00Z',
      step_times: [{ step: 'review', at: '2026-11-16T11:30:00Z' }, { step: 'lead-task', at: '2026-11-16T10:00:05Z' }, { step: 'resolved', at: '2026-11-16T11:00:00Z' }, { step: 'x', at: null }, { step: '', at: '2026-11-16T10:00:00Z' }] }]);
    expect(run.step_times).toEqual([
      { step: 'lead-task', at: Date.parse('2026-11-16T10:00:05Z') },
      { step: 'resolved', at: Date.parse('2026-11-16T11:00:00Z') },
      { step: 'review', at: Date.parse('2026-11-16T11:30:00Z') },
    ]);
  });
});

describe('the declared metrics are read per edition from the listing (P10)', () => {
  it('each active process: its label, description, workflows, metrics and the edition they are computed for', () => {
    const process: VersionProcess = { label: 'Incident response', description: 'From the alarm to the review.', workflows: ['ops-room'], metrics: [{ id: 'review-2d', label: 'Review within 2 days', workflow: 'ops-room', step: 'review', within: 'P2D' }] };
    const listed = eventWorkflowsListedOf(JSON.stringify({ processes: { 'incident-response': process }, eventWorkflowsListed: [] }));
    expect(listed.activeProcesses).toEqual({ 'incident-response': { label: 'Incident response', description: 'From the alarm to the review.', edition: processEditionOf(process), workflows: ['ops-room'], metrics: process.metrics } });
  });
});

describe('each stage names who answered it and what it cost (SPEC-PROCESSES P9)', () => {
  const query = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
  it('reads the assistant and the model tokens of each step\'s messages, once per message, under the asking run\'s step', () => {
    const fn = query.slice(query.indexOf('step_msgs AS MATERIALIZED ('), query.indexOf('AS step_usage`'));
    expect(fn).toContain("AND s.event_type = 'CREATE_CHANNEL_MESSAGE' AND s.is_bot = true");
    // A TASK'S TURN NAMES THE ASKING STEP ON ITS ANSWER'S UPDATE, read by the id the update shares, through the update index.
    expect(fn).toContain("WHERE x.channel_arn = s.channel_arn AND x.event_type = 'UPDATE_CHANNEL_MESSAGE' AND x.base_message_id = s.message_id");
    expect(fn).toContain('SUM(m.input_tokens) AS tokens_in, SUM(m.output_tokens) AS tokens_out');
  });

  it('a task turn\'s tokens, folded on its placeholder\'s create, count under the run and step its answer edit names', () => {
    const fn = query.slice(query.indexOf('step_msgs AS MATERIALIZED ('), query.indexOf('AS step_usage`'));
    // THE EDIT'S OWN RUN AND STEP are read beside its asking step, from any edit that carries either.
    expect(fn).toContain('x.workflow_run_key AS run_key, x.workflow_step AS step');
    expect(fn).toContain("AND (x.metadata ? 'askedStep' OR x.workflow_run_key IS NOT NULL)");
    expect(fn).toContain("ORDER BY (x.metadata ? 'askedStep') DESC, x.created_at DESC");
    // EACH SOURCE IS A PAIR, in one order for the run and the step: own asking step, edit's asking step, edit's run, own run.
    const order = (col: string) => [...fn.slice(fn.indexOf(`CASE WHEN`, fn.indexOf(col === 'run' ? 'SELECT CASE' : 'END AS run_key'))).split(/END AS (?:run_key|step)/)[0].matchAll(/THEN ([^\n]+?)\n|ELSE ([^\s]+) /g)].map((m) => (m[1] ?? m[2]).trim());
    expect(order('run')).toEqual(["s.metadata->'askedStep'->>'runKey'", 'u.asked_run_key', 'u.run_key', 's.workflow_run_key']);
    expect(order('step')).toEqual(["s.metadata->'askedStep'->>'step'", 'u.asked_step', 'u.step', 's.workflow_step']);
    // So a request-started run's turn is priced under its step, not dropped: its usage row prices to more than nothing.
    const [row] = processRunRows([{ step_usage: [{ step: 'work', assistant: 'advisor-premium', model: 'us.anthropic.claude-sonnet-4-6', tokensIn: 12_000, tokensOut: 3_000 }] }]);
    expect((row.step_costs as Array<{ step: string; usd: number | null }>)[0]).toMatchObject({ step: 'work' });
    expect((row.step_costs as Array<{ usd: number }>)[0].usd).toBeGreaterThan(0);
  });

  it('an event run\'s turn, whose create names its run and step, is read as before', () => {
    const fn = query.slice(query.indexOf('step_msgs AS MATERIALIZED ('), query.indexOf('AS step_usage`'));
    // With no edit naming another, the create's own run and step stand (the ELSE of each pair).
    expect(fn).toContain('ELSE s.workflow_run_key END AS run_key');
    expect(fn).toContain('ELSE s.workflow_step END AS step');
    // STEP TIMES read every row of the run, its edits included, and each message by the step `step_msgs` resolves for it.
    const firsts = query.slice(query.indexOf('step_firsts AS MATERIALIZED ('), query.indexOf('step_usage AS MATERIALIZED ('));
    expect(firsts.length).toBeGreaterThan(0);
    expect(firsts.slice(0, firsts.indexOf('UNION ALL'))).not.toContain('event_type');
  });

  it('a task turn\'s step starts at its placeholder\'s create, the first message of the turn, not at its answer\'s edit', () => {
    const msgs = query.slice(query.indexOf('step_msgs AS MATERIALIZED ('), query.indexOf('step_firsts AS MATERIALIZED ('));
    expect(msgs).toContain('s.created_at AS at');
    const firsts = query.slice(query.indexOf('step_firsts AS MATERIALIZED ('), query.indexOf('step_usage AS MATERIALIZED ('));
    expect(firsts).toContain('UNION ALL');
    expect(firsts).toContain('SELECT m.run_key, m.step, m.at FROM step_msgs m WHERE m.step IS NOT NULL');
    // DEFINED AFTER what it reads, so the query is valid SQL.
    expect(query.indexOf('step_msgs AS MATERIALIZED (')).toBeLessThan(query.indexOf('step_firsts AS MATERIALIZED ('));
  });

  it('prices each step per model from the one rate table, and a model the table cannot price is counted, never read as free', () => {
    const [row] = processRunRows([{ step_usage: [
      { step: 'first-look', assistant: 'ops-assistant', model: 'us.anthropic.claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 0 },
      { step: 'first-look', assistant: 'ops-assistant', model: 'no-such-model', tokensIn: 10, tokensOut: 10 },
      { step: 'triage', assistant: 'ops-premium', model: null, tokensIn: null, tokensOut: null },
    ] }]);
    const costs = row.step_costs as Array<{ step: string; assistant: string; usd: number | null; unpriced: number }>;
    const look = costs.find((c) => c.step === 'first-look')!;
    expect(look.assistant).toBe('ops-assistant');
    expect(look.usd).toBeGreaterThan(0);
    expect(look.unpriced).toBe(1);
    expect(costs.find((c) => c.step === 'triage')).toEqual({ step: 'triage', assistant: 'ops-premium', usd: null, unpriced: 0 });
    expect(row.step_usage).toBeUndefined();
  });
});

describe('a stage worked as another assistant\'s task counts under the step that asked for it', () => {
  it('the task\'s turns name the asking run\'s step on their record, only for a process run, and the record keeps it', () => {
    const core = readFileSync(resolve(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    expect(core).toContain('...(params.taskContext?.task.askedBy?.process ? { askedStep: { runKey: params.taskContext.task.askedBy.runKey, step: params.taskContext.task.askedBy.step } } : {}),');
    const meta = readFileSync(resolve(__dirname, '../../lambda/src/lib/analytics-metadata.ts'), 'utf8');
    expect(meta).toContain('if (context.askedStep) metadata.askedStep = context.askedStep;');
    expect(meta.match(/askedStep\?: \{ runKey: string; step: string \};/g)).toHaveLength(2);
  });
});

describe('a run names the version it ran on', () => {
  it('each run row carries its origin version, so the console reads it against its own stages whatever is active', () => {
    const query = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
    expect(query).toContain('MAX(m.workflow_origin_config_id) AS origin_config_id');
    expect(query).toContain('e.disposition, e.steps, m.origin_config_id');
    expect(query).toContain('r.disposition, r.steps, r.origin_config_id,');
  });
});
