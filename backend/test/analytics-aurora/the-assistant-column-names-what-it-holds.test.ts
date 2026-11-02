/**
 * THE ASSISTANT COLUMN NAMES WHAT IT HOLDS (ADR-051, migration 075, step one).
 *
 * `assistant` sits beside `agent_type` on every table that carries it, at the same width, kept equal by
 * one trigger whichever a writer sets, and backfilled in bounded batches. The code writes and reads
 * `assistant`; the only place that still names `agent_type` is a read of a view, which keeps that output
 * column until step two drops it.
 */
import * as fs from 'fs';
import * as path from 'path';

const AURORA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const TABLES = ['conversations', 'messages', 'exchanges', 'evaluation_results', 'intent_flows', 'agent_scores'];

/** Code lines only: comments describe the column's history and keep its old name. */
const codeOf = (src: string) => src.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l))
  .map((l) => l.replace(/\s(\/\/|--)\s.*$/, ''))
  .join('\n');

describe('migration 075', () => {
  const sql = codeOf(fs.readFileSync(path.join(AURORA, 'schema', '075-the-assistant-column-names-what-it-holds.sql'), 'utf8'));

  it('adds the column to every table that carries agent_type, at its width', () => {
    for (const t of TABLES) {
      expect({ t, added: new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS assistant VARCHAR\\(32\\)`).test(sql) }).toEqual({ t, added: true });
    }
  });

  it('keeps the two equal on every one of them, whichever a writer sets', () => {
    expect(sql).toMatch(/NEW\.assistant\s*:= COALESCE\(NEW\.assistant, NEW\.agent_type\)/);
    expect(sql).toMatch(/NEW\.agent_type\s*:= COALESCE\(NEW\.agent_type, NEW\.assistant\)/);
    for (const t of TABLES) {
      expect({ t, trigger: new RegExp(`BEFORE INSERT OR UPDATE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync\\(\\)`).test(sql) }).toEqual({ t, trigger: true });
    }
  });

  it('backfills in bounded batches, resumably, and replaces no view and drops nothing', () => {
    expect((sql.match(/LIMIT batch_size/g) || []).length).toBe(TABLES.length);
    expect(sql).toContain("'075-the-assistant-column-names-what-it-holds.sql'");
    expect(sql).not.toMatch(/CREATE OR REPLACE VIEW|DROP COLUMN|CONCURRENTLY/);
  });
});

describe('the code', () => {
  it('names agent_type nowhere but the one view read', () => {
    const hits: string[] = [];
    for (const f of fs.readdirSync(AURORA).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))) {
      codeOf(fs.readFileSync(path.join(AURORA, f), 'utf8')).split('\n').forEach((l, i) => {
        if (/\bagent_type\b/.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/analytics-query\.ts.*v\.agent_type\s+AS assistant/);
  });

  it('archival writes the assistant column on messages, conversations and exchanges', () => {
    const src = codeOf(fs.readFileSync(path.join(AURORA, 'kinesis-archival.ts'), 'utf8'));
    expect(src).toMatch(/'assistant',\s*'assistant_role',/);
    expect(src).toContain('INSERT INTO conversations (channel_arn, conversation_classification, assistant,');
    expect((src.match(/user_role, person_id, assistant,/g) || []).length).toBe(3);
  });
});
