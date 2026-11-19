/**
 * EVERY MODEL TURN IS AN EXCHANGE, WHOEVER STARTED IT (SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR43, migration 106).
 *
 * "Even turns that aren't started by a person, people in a new meeting in a new conversation are expecting something and
 * what they get should be fast, of high quality, and for the business given a cost, score, etc."
 *
 * A turn the platform starts answers no person's message, so the pairers gave it no exchange and every view built on
 * exchanges (Effectiveness, the message flow, model effectiveness, the judge) never saw it. In order: the turn records its
 * model, tokens and what its step asked; archival mints it an exchange; the judge reads it against the step's ask; the
 * overview counts it as a path of its own.
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
const judge = read('lambda/src/analytics-aurora/evaluation-runner.ts');
const processor = read('lambda/src/assistant-async-processor.ts');
const overview = read('../frontend/packages/admin/src/components/admin/PerformanceTab.tsx');
const m106 = read('lambda/src/analytics-aurora/schema/106-every-model-turn-is-an-exchange.sql');

const code = (s: string) => s.replace(/--[^\n]*/g, '');
const flat = (s: string) => code(s).replace(/\s+/g, ' ');
const fn = (src: string, start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

describe('a platform turn records what served it and what it was asked', () => {
  const helper = fn(processor, 'function platformTurnAnalytics(', '\n}\n');

  it('its model, tokens and model time, and its step\'s prompt capped, on the out-of-band record a meeting summary uses', () => {
    expect(helper).toContain('bedrockModel: c.modelUsed');
    expect(helper).toContain('inputTokens: c.inputTokens');
    expect(helper).toContain('outputTokens: c.outputTokens');
    expect(helper).toContain('latencyMs: c.bedrockTime');
    expect(helper).toContain('stepAsk: turn.ask.slice(0, STEP_ASK_CAP)');
    expect(processor).toContain('const STEP_ASK_CAP = 2000;');
  });

  it('for a workflow or event step, an asked turn, a voiced send and a welcome: each keeps its call and writes it with what it posted', () => {
    expect(processor).toContain('const call = await (narrowed');
    expect(processor).toContain('stepTurn.call = call; return call;');
    expect(processor).toContain('if (asked) await recordAskedStep(sent, event.channelArn, req, turn);');
    expect(processor).toContain('else await recordRunMessageProcess(sent, event.channelArn, req.process, turn);');
    expect(processor).toMatch(/voiceTurn\.call = call;[\s\S]*?recordRunMessageProcess\(sent, event\.channelArn, req\.process, voiceTurn\.call \?/);
    expect(processor).toMatch(/welcomeTurn\.call = call;[\s\S]*?await recordRunMessageProcess\(sent, event\.channelArn, undefined, \{ \.\.\.welcomeTurn/);
  });

  it('one record per message: the process and the asked step ride on the same write, never a second write that replaces it', () => {
    const run = fn(processor, 'async function recordRunMessageProcess(', '\n}\n');
    const asked = fn(processor, 'async function recordAskedStep(', '\n}\n');
    for (const f of [run, asked]) {
      expect(f.match(/writeMessageAnalytics\(/g)).toHaveLength(1);
      expect(f).toContain('...(turn ? platformTurnAnalytics(turn) : {}),');
    }
  });
});

describe('archival mints one exchange per model-served platform answer (migration 106)', () => {
  const mint = flat(fn(archival, 'async function createPlatformExchanges(', '\n}\n'));

  it('takes a final, model-served answer whose entry is platform and that no exchange holds; never a receipt, a queue notice or a duel', () => {
    expect(mint).toContain("COALESCE(am_upd.turn_entry, am.turn_entry) = 'platform'");
    expect(mint).toContain('AND am.agent_final_at IS NOT NULL');
    expect(mint).toContain('COALESCE(am_upd.bedrock_model, am.bedrock_model) IS NOT NULL');
    expect(mint).toContain("NOT IN ('receipt', 'queue_ack')");
    expect(mint).toContain('COALESCE(am_upd.battle_id, am.battle_id) IS NULL');
    expect(mint).toContain('NOT EXISTS (SELECT 1 FROM exchanges x WHERE x.agent_message_id = am.id)');
  });

  it('has no person message, is timed from its dispatch, says how it was paired, and is unique on its answer', () => {
    expect(mint).toContain('SELECT c.id, NULL, p.agent_id,');
    expect(mint).toContain('COALESCE(p.trigger_at, p.agent_created_at),');
    expect(mint).toContain("'platform',");
    expect(mint).toContain('ON CONFLICT DO NOTHING');
    expect(flat(m106)).toContain('CREATE UNIQUE INDEX IF NOT EXISTS exchanges_platform_agent_message_uniq ON exchanges (agent_message_id) WHERE user_message_id IS NULL;');
  });

  it('counts under its intent, else its workflow, else its kind, so Effectiveness ranks it by name beside the intents', () => {
    expect(mint).toContain("LEFT(COALESCE(am_upd.metadata->>'intent', am.metadata->>'intent', am_upd.metadata->'eventStep'->>'workflow', am.metadata->'eventStep'->>'workflow', am_upd.turn_kind, am.turn_kind");
  });

  it('runs with every batch, after the update fold brings the model onto the row', () => {
    expect(archival.indexOf('await createPlatformExchanges(touchedChannels)')).toBeGreaterThan(archival.indexOf('await createQueuedExchanges(touchedChannels)'));
  });
});

describe('the judge reads a platform turn against what its step asked', () => {
  it('every read that pairs a request with its answer keeps a platform exchange, whose request is its step\'s ask', () => {
    expect(judge).not.toMatch(/\n\s*JOIN messages mu ON e\.user_message_id = mu\.id/);
    expect(judge.match(/LEFT JOIN messages mu ON e\.user_message_id = mu\.id/g)).toHaveLength(3);
    expect(judge.match(/'stepAsk'\) AS user_message,/g)).toHaveLength(3);
    expect(judge).toContain("AND COALESCE(mu.content, ma_upd.metadata->>'stepAsk', ma.metadata->>'stepAsk') IS NOT NULL");
  });
});

describe('the overview counts it as a path of its own', () => {
  it('platform is one of the paths, with its own colour and its count on the turns card', () => {
    expect(overview).toContain("const PATHS = ['flow', 'lex', 'platform', 'unknown'] as const;");
    expect(overview).toMatch(/platform: '#[0-9A-F]{6}'/);
    expect(overview).toContain("platformPath: fmt(sum(byPath('platform'), 'turns'))");
  });
});

describe('the flow times a platform turn from its own exchange, where no ledger span exists', () => {
  const query = read('lambda/src/analytics-aurora/analytics-query.ts');
  it('end to end is the ledger span, else the platform exchange span, in the flow, its turns and its turn', () => {
    expect(query).toContain("const FLOW_E2E_SQL = `COALESCE(vl.e2e_ms, CASE WHEN e.paired_by = 'platform' THEN e.e2e_ms END)`;");
    expect(query).toContain('ROUND(AVG(${FLOW_E2E_SQL}))::int AS avg_e2e_ms, COUNT(${FLOW_E2E_SQL})::int AS e2e_n,');
    expect(query.match(/vl\.ttff_ms, \$\{FLOW_E2E_SQL\} AS e2e_ms,/g)).toHaveLength(2);
  });
});

describe('the judge always reads a platform turn', () => {
  it('a platform exchange is drawn every time and recorded as the always stratum, never as a sample', () => {
    const unscored = judge.slice(judge.indexOf('async function getUnscoredExchanges('), judge.indexOf('\n}\n', judge.indexOf('async function getUnscoredExchanges(')));
    expect(unscored).toContain("CASE WHEN e.intent_confidence = 'low' OR hf.message_id IS NOT NULL OR e.paired_by = 'platform' OR");
    expect(code(unscored)).toMatch(/OR hf\.message_id IS NOT NULL\s+OR e\.paired_by = 'platform'\s+OR \$\{HAS_SAFETY_FINDING_SQL\}/);
  });
});
