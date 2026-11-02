/**
 * A DEPLOYMENT BRINGS ITS OWN GOLDEN ENTRIES (ADR-065 decisions 7 and 8, SPEC-EVALUATION FR27, FR30).
 *
 * What it proves:
 *  - the file (`readGoldenUpload`): JSON Lines and CSV with the same columns, each line checked and every bad one named by
 *    its line, so one bad line refuses the whole file; an intent the assistant does not serve, a preference outside the
 *    registry and a duplicate are refused; no more lines than the set holds; the sample files read as their README says;
 *  - the write (`importGoldenEntries`): de-identified by the clean copy's detector before it is written, never the raw text
 *    in place of a detector that failed, and a throttle retried then reported busy, never as a bad line; one insert of
 *    capability entries marked uploaded with their upload id, never a request the set already holds; refused past the
 *    set's capacity; a batch whose capability entries are live writes nothing again; only inside its own classification;
 *  - the batch: run in the background under a row that reports how it ended, a second start while it runs doing nothing,
 *    an upload's entries read only from its own classification's and assistant's hand-over;
 *  - the routes: a file is checked at once, then handed over as an object (never in the event) and run as an Event; an
 *    upload is named by its content; a team route acts only for its own assistant; retiring is by kind of batch;
 *  - generation: the model told only the intent's own words, its answer read strictly, the whole generation refused for
 *    an intent with nothing usable, the least covered intents taken when none are named, as many as there is room for;
 *  - the console is told an id, a kind and a status when a run or a batch ends, and nothing for anything else;
 *  - a minimum the set could never hold is refused; the grants.
 */
import * as fs from 'fs';
import * as path from 'path';
import { generationPrompt, requestsFromAnswer, GENERATE_MAX_INTENTS } from '../../lambda/src/lib/golden-generate';
import { DEFAULT_INTENT_PACK } from '../../lambda/src/lib/intent-pack';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { ADMIN_CAPABILITIES } from '../../lib/config/admin-capabilities';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { edgeContext } from '../helpers/edge-context';
import {
  readGoldenUpload, parseCsv, GOLDEN_UPLOAD_MAX_LINES, GOLDEN_UPLOAD_MAX_BYTES, GOLDEN_SET_CAPACITY, type UploadedEntry,
} from '../../lambda/src/lib/golden-upload';
import { consoleEventOf, consoleChannel } from '../../lambda/src/console-events-publisher';

// S3 as the hand-over sees it: a put is kept and versioned; a get reads nothing (the test never gets that far).
const mockS3 = { put: [] as Array<Record<string, unknown>>, got: [] as string[] };
jest.mock('@aws-sdk/client-s3', () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  class PutObjectCommand extends Cmd {}
  class GetObjectCommand extends Cmd {}
  class DeleteObjectCommand extends Cmd {}
  class S3Client {
    async send(cmd: Cmd): Promise<unknown> {
      if (cmd instanceof PutObjectCommand && String(cmd.input.Key).startsWith('golden-uploads/')) {
        mockS3.put.push(cmd.input);
        return { VersionId: 'v-1' };
      }
      if (cmd instanceof GetObjectCommand) mockS3.got.push(String(cmd.input.Key));
      throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command: class {} };
});
const mockStore: { current: ReturnType<typeof fakeSsmStore> | null } = { current: null };
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: (cmd: unknown) => mockStore.current!.client.send(cmd as never) })) };
});
// The classification's GoldenRun function, as manage-profiles calls it: each payload and how it was invoked are kept.
const mockInvoked: Array<Record<string, unknown>> = [];
const mockInvocationTypes: string[] = [];
const mockAnswer: { current: (p: Record<string, unknown>) => unknown } = { current: () => ({}) };
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  class LambdaClient {
    async send(cmd: { input: { Payload: Uint8Array; InvocationType?: string } }): Promise<unknown> {
      const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString('utf8'));
      mockInvoked.push(payload);
      if (cmd.input.InvocationType === 'Event') {
        mockInvocationTypes.push('Event');
        return { StatusCode: 202 };
      }
      return { Payload: Buffer.from(JSON.stringify(mockAnswer.current(payload))) };
    }
  }
  return { ...actual, LambdaClient };
});
const mockScope = jest.fn();
jest.mock('../../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../../lambda/src/lib/assistant-scope');
  return { ...actual, requireOwnedAssistant: (...a: unknown[]) => mockScope(...a) };
});
const mockClientQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => {
  const actual = jest.requireActual('../../lambda/src/analytics-aurora/classification-boundary');
  return {
    ...actual,
    withReaderRole: (_c: string, fn: (client: unknown) => unknown) => fn({ query: mockClientQuery }),
    withWriterRole: (fn: (client: unknown) => unknown) => fn({ query: mockClientQuery }),
  };
});
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  ...jest.requireActual('../../lambda/src/analytics-aurora/db-client'),
  ensureSchema: jest.fn().mockResolvedValue(undefined),
}));

import { handler } from '../../lambda/src/manage-profiles';
import {
  importGoldenEntries, deIdentifyEntries, generateGoldenEntries, retireGoldenUpload, inBatch, readBatch,
} from '../../lambda/src/analytics-aurora/golden-run';
import { goldenSetReachErrors } from '../../lambda/src/lib/profile-lifecycle';

const ROOT = '/agent-echelon';
const GOLDEN_ROOT = '/agent-echelon/golden-run-test';
const INTENTS = new Set(['report_generation', 'data_extraction']);

const jsonl = (...rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');

describe('readGoldenUpload: the file', () => {
  it('reads JSON Lines, skipping blank lines and keeping each entry\'s line', () => {
    const read = readGoldenUpload('jsonl', jsonl(
      { intent: 'report_generation', request: 'Summarize Q3 travel spend', reference: 'Q3 travel spend was flat.' },
      '',
      {
        intent: 'data_extraction', request: 'And by region?',
        precedingTurns: [{ role: 'user', text: 'Show Q3 spend' }, { role: 'assistant', text: 'Here it is.' }],
        replyPreferences: { answerStyle: 'brief' },
      },
    ), INTENTS);
    expect(read).toEqual({
      ok: true,
      entries: [
        { line: 1, intent: 'report_generation', request: 'Summarize Q3 travel spend', reference: 'Q3 travel spend was flat.', precedingTurns: [], replyPreferences: null },
        {
          line: 3, intent: 'data_extraction', request: 'And by region?', reference: null,
          precedingTurns: [{ role: 'user', text: 'Show Q3 spend' }, { role: 'assistant', text: 'Here it is.' }],
          replyPreferences: { answerStyle: 'brief' },
        },
      ],
    });
  });

  it('reads CSV with the same columns, a quoted cell holding commas, quotes and a line break, and JSON cells', () => {
    const csv = [
      'intent,request,reference,precedingTurns,replyPreferences',
      'report_generation,"Summarize Q3, by team","He said ""flat"".\nThen stopped.",,',
      'data_extraction,And by region?,,"[{""role"":""user"",""text"":""Show Q3""}]","{""answerStyle"":""brief""}"',
    ].join('\r\n');
    const read = readGoldenUpload('csv', `﻿${csv}`, INTENTS);
    expect(read.ok).toBe(true);
    const entries = (read as { entries: UploadedEntry[] }).entries;
    expect(entries.map((e) => e.line)).toEqual([2, 4]);
    expect(entries[0]).toMatchObject({ request: 'Summarize Q3, by team', reference: 'He said "flat".\nThen stopped.' });
    expect(entries[1]).toMatchObject({ precedingTurns: [{ role: 'user', text: 'Show Q3' }], replyPreferences: { answerStyle: 'brief' } });
  });

  it('refuses the whole file when any line is not an entry, naming every line and what is wrong', () => {
    const read = readGoldenUpload('jsonl', jsonl(
      { intent: 'report_generation', request: 'A good one' },
      '{ not json',
      ['an', 'array'],
      { intent: 'report_generation', request: 'Typo', refrence: 'x' },
      { intent: 'report_generation' },
      { intent: 'weather_forecast', request: 'Will it rain?' },
      { intent: 'report_generation', request: 'Turns', precedingTurns: [{ role: 'system', text: 'x' }] },
      { intent: 'report_generation', request: 'Prefs', replyPreferences: { answerStyle: 'shouty' } },
      { intent: 'report_generation', request: 42 },
      { intent: 'report_generation', request: 'x'.repeat(8001) },
      { intent: 'report_generation', request: '  a GOOD one ' },
    ), INTENTS);
    expect(read).toMatchObject({ ok: false, code: 'INVALID_LINES', params: { count: 10, lines: 11 } });
    expect((read as { problems: unknown[] }).problems).toEqual([
      { line: 2, code: 'NOT_JSON' },
      { line: 3, code: 'NOT_AN_OBJECT' },
      { line: 4, code: 'UNKNOWN_FIELD', field: 'refrence' },
      { line: 5, code: 'MISSING_FIELD', field: 'request' },
      { line: 6, code: 'UNKNOWN_INTENT', field: 'intent' },
      { line: 7, code: 'BAD_TURNS', field: 'precedingTurns' },
      { line: 8, code: 'UNKNOWN_PREFERENCE', field: 'replyPreferences' },
      { line: 9, code: 'NOT_TEXT', field: 'request' },
      { line: 10, code: 'TOO_LONG', field: 'request' },
      { line: 11, code: 'DUPLICATE', field: 'request' },
    ]);
  });

  it('refuses a CSV whose header is not the upload\'s columns, and a row with the wrong number of cells', () => {
    expect(readGoldenUpload('csv', 'intent,question\nreport_generation,hi', INTENTS)).toMatchObject({ ok: false, code: 'BAD_HEADER' });
    expect(readGoldenUpload('csv', 'request,reference\nhi,there', INTENTS)).toMatchObject({ ok: false, code: 'BAD_HEADER' });
    expect(readGoldenUpload('csv', 'intent,request\nreport_generation,hi,extra', INTENTS)).toMatchObject({
      ok: false, code: 'INVALID_LINES', problems: [{ line: 2, code: 'WRONG_CELL_COUNT' }],
    });
  });

  it('holds its bounds: format, empty, size and lines', () => {
    expect(readGoldenUpload('xlsx', 'x', INTENTS)).toMatchObject({ ok: false, code: 'BAD_FORMAT' });
    expect(readGoldenUpload('jsonl', '\n\n', INTENTS)).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(readGoldenUpload('jsonl', undefined, INTENTS)).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(readGoldenUpload('jsonl', 'x'.repeat(GOLDEN_UPLOAD_MAX_BYTES + 1), INTENTS)).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    const many = Array.from({ length: GOLDEN_UPLOAD_MAX_LINES + 1 }, (_, i) => ({ intent: 'report_generation', request: `q${i}` }));
    expect(readGoldenUpload('jsonl', jsonl(...many), INTENTS)).toMatchObject({ ok: false, code: 'TOO_MANY_LINES', params: { lines: GOLDEN_UPLOAD_MAX_LINES + 1 } });
  });

  it('parses CSV records with the line each starts on', () => {
    expect(parseCsv('a,b\n"1\n2",3\n4,5')).toEqual([
      { line: 1, cells: ['a', 'b'] }, { line: 2, cells: ['1\n2', '3'] }, { line: 4, cells: ['4', '5'] },
    ]);
  });
});

describe('the sample files read as their README says', () => {
  const dir = path.join(__dirname, '../../demo/golden-set');
  const ANALYST = new Set(['greeting', 'directory_lookup', 'process_lookup', 'data_extraction', 'report_generation', 'guided_troubleshooting']);
  const read = (f: string, format: 'jsonl' | 'csv') => readGoldenUpload(format, fs.readFileSync(path.join(dir, f), 'utf8'), ANALYST);

  it('the valid file is seven entries across four intents', () => {
    const r = read('analyst-valid.jsonl', 'jsonl') as { ok: true; entries: UploadedEntry[] };
    expect(r.ok).toBe(true);
    expect(r.entries).toHaveLength(7);
    expect(new Set(r.entries.map((e) => e.intent)).size).toBe(4);
  });

  it('the invalid file names eight bad lines of nine', () => {
    expect(read('analyst-invalid.jsonl', 'jsonl')).toMatchObject({ ok: false, code: 'INVALID_LINES', params: { count: 8, lines: 9 } });
  });

  it('the incomplete-coverage file is four valid entries for two intents', () => {
    const r = read('analyst-incomplete-coverage.csv', 'csv') as { ok: true; entries: UploadedEntry[] };
    expect(r.entries).toHaveLength(4);
    expect([...new Set(r.entries.map((e) => e.intent))].sort()).toEqual(['data_extraction', 'report_generation']);
  });
});

const entry = (line: number, over: Partial<UploadedEntry> = {}): UploadedEntry => ({
  line, intent: 'report_generation', request: `Email jo@example.com about item ${line}`, reference: null, precedingTurns: [], replyPreferences: null, ...over,
});
const mask = async (texts: string[]) => texts.map((t) => t.replace(/\S+@\S+/g, '[an email address removed]'));
const insertCalls = () => mockClientQuery.mock.calls.filter(([q]) => String(q).includes('INSERT INTO golden_set_entries'));
/** The set as the run function reads it: its live size, and the live capability entries of the batch being written. */
const theSet = (live: number, batch = 0) => mockClientQuery.mockImplementation(async (sql: string) => (
  String(sql).includes('AS batch') ? { rows: [{ live: String(live), batch: String(batch) }] }
    : String(sql).includes('GROUP BY') ? { rows: [] }
      : String(sql).includes('INSERT INTO golden_set_entries') ? { rows: [], rowCount: 2 }
        : { rows: [], rowCount: 1 }));

describe('importGoldenEntries: the write, inside the classification', () => {
  const detector = { name: 'test', anonymize: jest.fn(mask) };
  const input = (entries: UploadedEntry[]) => ({
    op: 'import' as const, classification: 'standard', assistant: 'analyst', uploadId: 'up-1', uploadedBy: 'person-1', entries,
  });

  beforeEach(() => {
    process.env.GOLDEN_RUN_CLASSIFICATION = 'standard';
    mockClientQuery.mockReset();
    theSet(3);
    detector.anonymize.mockClear();
    detector.anonymize.mockImplementation(mask);
  });

  it('writes de-identified capability entries in one insert, marked uploaded with their upload id, under a lock on the set', async () => {
    expect(await importGoldenEntries(input([
      entry(1, { reference: 'Sent to jo@example.com', precedingTurns: [{ role: 'user', text: 'I am jo@example.com' }], replyPreferences: { answerStyle: 'brief' } }),
      entry(2),
    ]), detector)).toEqual({ imported: 2, uploadId: 'up-1' });
    expect(mockClientQuery.mock.calls.some(([q]) => String(q).includes('pg_advisory_xact_lock'))).toBe(true);
    expect(insertCalls()).toHaveLength(1);
    const [sql, p] = insertCalls()[0] as [string, unknown[]];
    expect(sql).toContain("'capability'");
    // A request the set already holds live for the intent is not added twice.
    expect(sql).toContain('NOT EXISTS');
    expect(p.slice(0, 5)).toEqual(['standard', 'analyst', 'person-1', 'uploaded', 'up-1']);
    expect(p[6]).toEqual(['Email [an email address removed] about item 1', 'Email [an email address removed] about item 2']);
    expect(p[7]).toEqual(['Sent to [an email address removed]', null]);
    expect(p[8]).toEqual([JSON.stringify({ answerStyle: 'brief' }), null]);
    expect(p[9]).toEqual([JSON.stringify([{ role: 'user', text: 'I am [an email address removed]' }]), null]);
    expect(JSON.stringify(insertCalls())).not.toContain('jo@example.com');
  });

  it('refuses an upload past the set\'s capacity, before the detector is called', async () => {
    theSet(GOLDEN_SET_CAPACITY - 1);
    expect(await importGoldenEntries(input([entry(1), entry(2)]), detector)).toEqual({
      refused: true, code: 'GOLDEN_SET_FULL', params: { live: GOLDEN_SET_CAPACITY - 1, adding: 2, capacity: GOLDEN_SET_CAPACITY },
    });
    expect(detector.anonymize).not.toHaveBeenCalled();
    expect(insertCalls()).toEqual([]);
  });

  it('writes nothing for a batch whose capability entries are still live, and spends no detector call on it', async () => {
    theSet(3, 2);
    expect(await importGoldenEntries(input([entry(1), entry(2)]), detector)).toEqual({ imported: 2, uploadId: 'up-1', already: true });
    expect(detector.anonymize).not.toHaveBeenCalled();
    expect(insertCalls()).toEqual([]);
    // Counted as this batch only while capability, of this source, by this id.
    const [sql, params] = mockClientQuery.mock.calls.find(([q]) => String(q).includes('AS batch'))!;
    expect(String(sql)).toContain("source = $4 AND purpose = 'capability'");
    expect(params).toEqual(['standard', 'analyst', 'up-1', 'uploaded']);
  });

  it('stores nothing where no detector is wired', async () => {
    expect(await importGoldenEntries(input([entry(1)]), null)).toMatchObject({ refused: true, code: 'DETECTOR_UNAVAILABLE' });
    expect(insertCalls()).toEqual([]);
  });

  it('names the lines the detector cannot process, and never stores the raw text in their place', async () => {
    detector.anonymize.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes('item 2'))) throw Object.assign(new Error('cannot'), { name: 'ValidationException' });
      return mask(texts);
    });
    expect(await importGoldenEntries(input([entry(1), entry(2), entry(3)]), detector)).toEqual({
      refused: true, code: 'DETECTOR_FAILED', params: { count: 1 }, lines: [2],
    });
    expect(insertCalls()).toEqual([]);
  });

  it('a detector that stays throttled is busy, never a bad line', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      detector.anonymize.mockImplementation(async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); });
      const pending = importGoldenEntries(input([entry(1)]), detector);
      await jest.runAllTimersAsync();
      expect(await pending).toEqual({ refused: true, code: 'DETECTOR_BUSY', params: {} });
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a throttled detector call before giving up on it', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let calls = 0;
      detector.anonymize.mockImplementation(async (texts: string[]) => {
        if (++calls === 1) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
        return mask(texts);
      });
      const pending = importGoldenEntries(input([entry(1)]), detector);
      await jest.runAllTimersAsync();
      expect(await pending).toMatchObject({ imported: 2 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps once two requests the detector made the same', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => (String(sql).includes('AS batch') ? { rows: [{ live: '0', batch: '0' }] } : { rows: [], rowCount: 1 }));
    await importGoldenEntries(input([
      entry(1, { request: 'Email alice@x.com about Q3' }), entry(2, { request: 'Email bob@y.com about Q3' }),
    ]), detector);
    const [, p] = insertCalls()[0] as [string, unknown[]];
    expect(p[6]).toEqual(['Email [an email address removed] about Q3']);
  });

  it('keeps each entry\'s texts with it when the detector answers per entry', async () => {
    let calls = 0;
    const flaky = jest.fn(async (texts: string[]) => {
      if (++calls === 1) throw new Error('batch refused');
      return mask(texts);
    });
    expect(await deIdentifyEntries([entry(1, { reference: 'ref jo@example.com' }), entry(2)], flaky)).toEqual({ entries: [
      entry(1, { request: 'Email [an email address removed] about item 1', reference: 'ref [an email address removed]' }),
      entry(2, { request: 'Email [an email address removed] about item 2' }),
    ] });
  });

  it('retires only the capability entries of the named kind of batch, by the indexed column', async () => {
    await retireGoldenUpload({ op: 'retire-upload', classification: 'standard', assistant: 'analyst', uploadId: 'up-1', retiredBy: 'p', source: 'generated' });
    const [sql, params] = mockClientQuery.mock.calls.find(([q]) => String(q).includes('UPDATE golden_set_entries'))!;
    expect(String(sql)).toContain("purpose = 'capability'");
    expect(String(sql)).toContain('upload_id = $3::uuid');
    expect(params).toEqual(['standard', 'analyst', 'up-1', 'p', 'generated']);
  });

  it('refuses an upload for another classification', async () => {
    await expect(importGoldenEntries({ ...input([entry(1)]), classification: 'premium' }, detector)).rejects.toThrow(/runs standard runs only/);
  });
});

describe('a batch runs in the background, and its row is the report', () => {
  beforeEach(() => {
    process.env.GOLDEN_RUN_CLASSIFICATION = 'standard';
    mockClientQuery.mockReset();
  });

  it('records complete or refused by what the work answered, and failed on a throw, without throwing', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: 'b' }], rowCount: 1 });
    expect(await inBatch('standard', 'analyst', 'b-1', 'upload', 'p', async () => ({ imported: 2 }))).toEqual({ batchId: 'b-1', kind: 'upload', status: 'complete' });
    expect(await inBatch('standard', 'analyst', 'b-2', 'upload', 'p', async () => ({ refused: true, code: 'GOLDEN_SET_FULL' }))).toMatchObject({ status: 'refused' });
    expect(await inBatch('standard', 'analyst', 'b-3', 'generation', 'p', async () => { throw new Error('boom'); })).toMatchObject({ status: 'failed' });
    const finished = mockClientQuery.mock.calls.filter(([q]) => String(q).includes('UPDATE golden_batches')).map(([, p]) => (p as unknown[])[1]);
    expect(finished).toEqual(['complete', 'refused', 'failed']);
  });

  it('a second start of a batch that is running does nothing', async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const work = jest.fn();
    expect(await inBatch('standard', 'analyst', 'b-1', 'upload', 'p', work)).toEqual({ batchId: 'b-1', kind: 'upload', status: 'running' });
    expect(work).not.toHaveBeenCalled();
    // The row is taken over only when it ended or overran its deadline, and only for the same assistant and kind.
    const [sql] = mockClientQuery.mock.calls[0];
    expect(String(sql)).toContain("golden_batches.status <> 'running' OR golden_batches.started_at < NOW()");
    expect(String(sql)).toContain('golden_batches.kind = EXCLUDED.kind');
  });

  it('a batch past its deadline reads as failed', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: 'b-1', kind: 'upload', status: 'running', result: null, requested_by: 'p', started_at: new Date(0), completed_at: null }] });
    expect(await readBatch({ op: 'batch', classification: 'standard', assistant: 'analyst', batchId: 'b-1' })).toMatchObject({ status: 'failed', result: { error: 'deadline' } });
  });

  it('an upload\'s entries are read only from its own classification\'s and assistant\'s hand-over', async () => {
    const { handler: runHandler } = await import('../../lambda/src/analytics-aurora/golden-run-handler');
    mockClientQuery.mockResolvedValue({ rows: [{ id: 'b' }], rowCount: 1 });
    const out = await runHandler({
      op: 'import', classification: 'standard', assistant: 'analyst', uploadId: 'b-9', uploadedBy: 'p',
      entriesKey: 'golden-uploads/premium/analyst/b-9.json',
    } as never);
    expect(out).toMatchObject({ status: 'failed' });
    expect(mockS3.got).toEqual([]);
  });
});

describe('generation: entries written from the intent pack', () => {
  const intent = { key: 'process_lookup', description: 'User asks about a runbook or SLA', summary: 'the steps in order', keywords: ['runbook', 'sla'] };
  const detector = { name: 'test', anonymize: jest.fn(mask) };

  beforeEach(() => {
    process.env.GOLDEN_RUN_CLASSIFICATION = 'standard';
    mockClientQuery.mockReset();
    theSet(0);
    detector.anonymize.mockClear();
  });

  it('tells the model only what the intent says it covers, and how many to write', () => {
    const prompt = generationPrompt(intent, 3);
    expect(prompt).toContain('Write 3 different requests');
    expect(prompt).toContain('Intent: process_lookup');
    expect(prompt).toContain('User asks about a runbook or SLA');
    expect(prompt).toContain('runbook, sla');
    expect(prompt).toMatch(/no names of people, email addresses/);
  });

  it('reads the answer strictly: the first array of strings, trimmed, each once, at most the count', () => {
    expect(requestsFromAnswer('Here you go:\n["What is the SLA?", " what is the sla? ", "", 4, "Where is the runbook?", "x"]', 2))
      .toEqual(['What is the SLA?', 'Where is the runbook?']);
    expect(requestsFromAnswer('I cannot help with that.', 3)).toBeNull();
    expect(requestsFromAnswer('[1, 2]', 3)).toBeNull();
    expect(requestsFromAnswer('[' + JSON.stringify('x'.repeat(1001)) + ']', 3)).toBeNull();
    // The first array, not the first bracket to the last: a note after it does not join it.
    expect(requestsFromAnswer('["Who leads Core?", "What is [the] SLA?"]\n\nNote: placeholders like [name] were avoided.', 3))
      .toEqual(['Who leads Core?', 'What is [the] SLA?']);
    expect(requestsFromAnswer('Options [a] and [b]: ["Where is the runbook?"]', 3)).toEqual(['Where is the runbook?']);
  });

  const input = (intents: Array<{ key: string; description: string }> = [intent, { key: 'directory_lookup', description: 'Who leads a team' }]) => ({
    op: 'generate' as const, classification: 'standard', assistant: 'analyst', generationId: 'gen-1', generatedBy: 'person-1', intents, perIntent: 2,
  });

  it('stores de-identified capability entries marked generated, under one generation id', async () => {
    const answer = jest.fn(async (prompt: string) => (prompt.includes('process_lookup')
      ? '["What is the Sev-1 escalation path?", "Mail ops@example.com the runbook?"]'
      : '["Who leads Platform Core?", "Who owns billing?"]'));
    mockClientQuery.mockImplementation(async (sql: string) => (String(sql).includes('AS batch') ? { rows: [{ live: '0', batch: '0' }] }
      : String(sql).includes('INSERT INTO golden_set_entries') ? { rows: [], rowCount: 4 } : { rows: [], rowCount: 1 }));
    expect(await generateGoldenEntries(input(), answer, detector)).toEqual({ generated: 4, generationId: 'gen-1', byIntent: { process_lookup: 2, directory_lookup: 2 } });
    const [, p] = insertCalls()[0] as [string, unknown[]];
    expect(p.slice(3, 5)).toEqual(['generated', 'gen-1']);
    expect(p[5]).toEqual(['process_lookup', 'process_lookup', 'directory_lookup', 'directory_lookup']);
    expect((p[6] as string[])[1]).toBe('Mail [an email address removed] the runbook?');
  });

  it('refuses the whole generation, naming each intent the model gave nothing usable for', async () => {
    const answer = jest.fn(async (prompt: string) => (prompt.includes('process_lookup') ? 'Sorry.' : '["Who leads Platform Core?"]'));
    expect(await generateGoldenEntries(input(), answer, detector)).toEqual({
      refused: true, code: 'GENERATION_FAILED', params: { count: 1, intents: 'process_lookup' },
    });
    expect(insertCalls()).toEqual([]);
  });

  it('spends no model call on a generation already written', async () => {
    theSet(4, 4);
    const answer = jest.fn();
    expect(await generateGoldenEntries(input(), answer, detector)).toEqual({ generated: 4, generationId: 'gen-1', byIntent: {}, already: true });
    expect(answer).not.toHaveBeenCalled();
  });

  it('with no intents named, takes the least covered intents, only as many as the set has room for', async () => {
    const many = Array.from({ length: GENERATE_MAX_INTENTS + 2 }, (_, i) => ({ key: `intent_${i}`, description: `d${i}` }));
    mockClientQuery.mockImplementation(async (sql: string) => (String(sql).includes('GROUP BY')
      ? { rows: [{ intent: 'intent_0', n: '5' }, { intent: 'intent_1', n: '2' }] }
      : String(sql).includes('AS batch') ? { rows: [{ live: '0', batch: '0' }] }
        : String(sql).includes('COUNT(*)') ? { rows: [{ n: '0' }] } : { rows: [], rowCount: 1 }));
    const asked: string[] = [];
    const answer = jest.fn(async (prompt: string) => {
      asked.push(/Intent: (\S+)/.exec(prompt)![1]);
      return '["A request"]';
    });
    await generateGoldenEntries({ ...input(many), perIntent: 1, leastCovered: true }, answer, detector);
    expect(asked).toHaveLength(GENERATE_MAX_INTENTS);
    expect(asked).not.toContain('intent_0');
    expect(asked).not.toContain('intent_1');

    // With room for three at one each, three: the least covered first.
    asked.length = 0;
    mockClientQuery.mockImplementation(async (sql: string) => (String(sql).includes('GROUP BY')
      ? { rows: many.slice(3).map((m) => ({ intent: m.key, n: '8' })) }
      : String(sql).includes('AS batch') ? { rows: [{ live: String(GOLDEN_SET_CAPACITY - 3), batch: '0' }] }
        : String(sql).includes('COUNT(*)') ? { rows: [{ n: String(GOLDEN_SET_CAPACITY - 3) }] } : { rows: [], rowCount: 1 }));
    await generateGoldenEntries({ ...input(many), generationId: 'gen-2', perIntent: 1, leastCovered: true }, answer, detector);
    expect(asked.sort()).toEqual(['intent_0', 'intent_1', 'intent_2']);
  });

  it('refuses before spending a model call when the set cannot hold what would be generated', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => ({ rows: [String(sql).includes('AS batch') ? { live: String(GOLDEN_SET_CAPACITY - 3), batch: '0' } : { n: String(GOLDEN_SET_CAPACITY - 3) }] }));
    const answer = jest.fn();
    expect(await generateGoldenEntries(input(), answer, detector)).toMatchObject({ refused: true, code: 'GOLDEN_SET_FULL', params: { adding: 4 } });
    expect(answer).not.toHaveBeenCalled();
  });
});

function evt(route: string, body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: route,
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'u-1', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}
const parse = (r: { body: string }) => JSON.parse(r.body);

describe('the routes start a batch and answer at once', () => {
  const ROUTE = '/admin/profiles/golden-set-import';
  const GEN = '/admin/profiles/golden-set-generate';

  beforeEach(async () => {
    process.env.GOLDEN_RUN_PARAM_ROOT = GOLDEN_ROOT;
    process.env.PROFILE_BODY_BUCKET = 'bodies';
    mockInvoked.length = 0;
    mockInvocationTypes.length = 0;
    mockS3.put.length = 0;
    mockAnswer.current = () => ({});
    mockScope.mockReset();
    mockScope.mockResolvedValue(null);
    mockStore.current = fakeSsmStore();
    for (const cls of ['basic', 'standard', 'premium']) {
      await mockStore.current.client.send(new PutParameterCommand({ Name: `${GOLDEN_ROOT}/${cls}/golden-run-arn`, Value: `arn:aws:lambda:us-east-1:1:function:${cls}-GoldenRun`, Type: 'String' }));
    }
  });

  it('hands a checked upload over as an object, never in the event, and invokes the run function as an Event', async () => {
    const res = await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content: jsonl(
      { intent: 'report_generation', request: 'Summarize Q3 for jo@example.com' },
      { intent: 'data_extraction', request: 'The roster as a table' },
    ) }));
    expect([res.statusCode, parse(res)]).toEqual([202, { profileName: 'advisor', batchId: expect.any(String), kind: 'upload', status: 'running', entries: 2, startedAfter: expect.any(String) }]);
    const { batchId } = parse(res);
    expect(mockS3.put).toEqual([expect.objectContaining({ Bucket: 'bodies', Key: expect.stringMatching(new RegExp(`^golden-uploads/[a-z]+/advisor/${batchId}\\.json$`)) })]);
    expect(JSON.parse(mockS3.put[0].Body as string)).toHaveLength(2);
    // The batch is read first (one already running is not started again), then the import is invoked as an Event.
    expect(mockInvoked).toEqual([
      expect.objectContaining({ op: 'batch', assistant: 'advisor', batchId }),
      expect.objectContaining({ op: 'import', assistant: 'advisor', uploadId: batchId, entriesKey: mockS3.put[0].Key, entriesVersion: 'v-1' }),
    ]);
    expect(mockInvocationTypes).toEqual(['Event']);
    expect(JSON.stringify(mockInvoked)).not.toContain('jo@example.com');
  });

  it('does not start a batch of the same file again while it runs, and names when that one started', async () => {
    mockAnswer.current = (p) => (p.op === 'batch' ? { status: 'running', startedAt: '2026-11-01T09:00:00.000Z' } : {});
    const res = await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content: jsonl({ intent: 'report_generation', request: 'Q3' }) }));
    expect(parse(res)).toMatchObject({ status: 'running', startedAfter: '2026-11-01T09:00:00.000Z' });
    expect(mockInvoked.map((p) => p.op)).toEqual(['batch']);
    expect(mockS3.put).toEqual([]);
  });

  it('takes only the intents of the pack, the ones coverage counts: a universal intent is not measured here', async () => {
    const res = await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content: jsonl({ intent: 'greeting', request: 'Hi there' }) }));
    expect(parse(res)).toMatchObject({ code: 'INVALID_LINES', problems: [{ line: 1, code: 'UNKNOWN_INTENT' }] });
  });

  it('refuses a file naming an intent the assistant does not serve at once, and nothing is handed over', async () => {
    const res = await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content: jsonl({ intent: 'weather_forecast', request: 'Rain?' }) }));
    expect(res.statusCode).toBe(400);
    expect(parse(res)).toMatchObject({ code: 'INVALID_LINES', problems: [{ line: 1, code: 'UNKNOWN_INTENT', field: 'intent' }] });
    expect(mockInvoked).toEqual([]);
    expect(mockS3.put).toEqual([]);
  });

  it('names an upload by its content, so the same file sent again is the same batch', async () => {
    const content = jsonl({ intent: 'report_generation', request: 'Summarize Q3' });
    const first = parse(await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content })));
    const again = parse(await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content })));
    expect(again.batchId).toBe(first.batchId);
    expect(first.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    const other = parse(await handler(evt(ROUTE, { profileName: 'advisor', format: 'jsonl', content: `${content}\n${jsonl({ intent: 'report_generation', request: 'Q4' })}` })));
    expect(other.batchId).not.toBe(first.batchId);
  });

  it('reads how a batch ended, for the assistant in the request', async () => {
    const batchId = '3b6f1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    mockAnswer.current = (p) => (p.op === 'batch' ? { batchId, kind: 'upload', status: 'complete', result: { imported: 2 } } : {});
    const res = await handler(evt('/admin/profiles/golden-set-batch', { profileName: 'advisor', batchId }));
    expect(parse(res)).toEqual({ profileName: 'advisor', batch: expect.objectContaining({ status: 'complete' }) });
    expect(mockInvoked.at(-1)).toMatchObject({ op: 'batch', assistant: 'advisor', batchId });
    mockAnswer.current = () => null;
    expect((await handler(evt('/admin/profiles/golden-set-batch', { profileName: 'advisor', batchId }))).statusCode).toBe(404);
  });

  it('DENIED: a team route uploads only for the assistant it names', async () => {
    mockScope.mockResolvedValue({ assistant: 'advisor', bots: [] });
    const res = await handler(evt('/admin/assistants/advisor/profiles/golden-set-import', { profileName: 'analyst', format: 'jsonl', content: '{}' }));
    expect(res.statusCode).toBe(403);
    expect(parse(res).code).toBe('ASSISTANT_MISMATCH');
    expect(mockInvoked).toEqual([]);
  });

  it('retires an upload and a generation each on its own route, as its own kind', async () => {
    const uploadId = '0b6f1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    mockAnswer.current = () => ({ retired: 4 });
    expect(parse(await handler(evt('/admin/profiles/golden-set-retire-upload', { profileName: 'advisor', uploadId })))).toEqual({ profileName: 'advisor', uploadId, retired: 4 });
    expect(mockInvoked.at(-1)).toMatchObject({ op: 'retire-upload', source: 'uploaded' });
    await handler(evt('/admin/profiles/golden-set-retire-generation', { profileName: 'advisor', uploadId }));
    expect(mockInvoked.at(-1)).toMatchObject({ op: 'retire-upload', source: 'generated' });
    expect((await handler(evt('/admin/profiles/golden-set-retire-upload', { profileName: 'advisor', uploadId: "x' OR 1=1" }))).statusCode).toBe(400);
  });

  it('starts a generation for the named intents, in the pack\'s own words, under the caller\'s id', async () => {
    const generationId = '1b6f1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    const res = await handler(evt(GEN, { profileName: 'advisor', intents: ['report_generation', 'data_extraction'], perIntent: 2, generationId }));
    expect([res.statusCode, parse(res)]).toEqual([202, { profileName: 'advisor', batchId: generationId, kind: 'generation', status: 'running', startedAfter: expect.any(String) }]);
    expect(mockInvoked).toEqual([expect.objectContaining({
      op: 'generate', assistant: 'advisor', perIntent: 2, generationId,
      intents: [expect.objectContaining({ key: 'data_extraction', description: expect.any(String) }), expect.objectContaining({ key: 'report_generation' })],
    })]);
    expect(mockInvocationTypes).toEqual(['Event']);
  });

  it('refuses an unknown intent, a count out of bounds and too many named intents; with none named, the least covered', async () => {
    expect(parse(await handler(evt(GEN, { profileName: 'advisor', intents: ['weather'] })))).toMatchObject({ code: 'UNKNOWN_INTENT', params: { intents: 'weather' } });
    expect(parse(await handler(evt(GEN, { profileName: 'advisor', intents: ['report_generation'], perIntent: 9 })))).toMatchObject({ code: 'BAD_PER_INTENT' });
    const tooMany = DEFAULT_INTENT_PACK.intents.slice(0, GENERATE_MAX_INTENTS + 1).map((d) => d.key);
    if (tooMany.length > GENERATE_MAX_INTENTS) expect(parse(await handler(evt(GEN, { profileName: 'advisor', intents: tooMany })))).toMatchObject({ code: 'TOO_MANY_INTENTS' });
    expect(mockInvoked).toEqual([]);
    await handler(evt(GEN, { profileName: 'advisor' }));
    expect(mockInvoked.at(-1)).toMatchObject({ op: 'generate', leastCovered: true });
    expect((mockInvoked.at(-1)!.intents as unknown[]).length).toBe(DEFAULT_INTENT_PACK.intents.length);
  });
});

describe('a run\'s input is handed over as an object', () => {
  beforeEach(() => {
    process.env.GOLDEN_RUN_CLASSIFICATION = 'standard';
    mockS3.got.length = 0;
  });

  it('is read only from its own classification\'s and assistant\'s hand-over', async () => {
    const { handler: runHandler } = await import('../../lambda/src/analytics-aurora/golden-run-handler');
    await expect(runHandler({
      op: 'start', runId: 'r-1', classification: 'standard', assistant: 'analyst', startedBy: 'p',
      inputKey: 'golden-uploads/premium/analyst/runs/r-1.json',
    } as never)).rejects.toThrow(/hand-over is under golden-uploads\/standard\/analyst\//);
    expect(mockS3.got).toEqual([]);
  });
});

describe('the console is told when a run or a batch ends', () => {
  const rec = (detailType: string, requestPayload: Record<string, unknown>, responsePayload: unknown) =>
    ({ 'detail-type': detailType, detail: { requestPayload, responsePayload } }) as never;
  const ID = '4b6f1e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
  const OK = 'Lambda Function Invocation Result - Success';

  it('publishes an id, a kind and a status for a run, an upload and a generation, and nothing else', () => {
    expect(consoleEventOf(rec(OK, { op: 'start', runId: ID }, { status: 'complete', result: { refused: true } }))).toEqual({ id: ID, kind: 'run', status: 'complete' });
    expect(consoleEventOf(rec(OK, { op: 'import', uploadId: ID, entriesKey: 'k' }, { batchId: ID, kind: 'upload', status: 'refused' }))).toEqual({ id: ID, kind: 'upload', status: 'refused' });
    expect(consoleEventOf(rec('Lambda Function Invocation Result - Failure', { op: 'generate', generationId: ID }, null))).toEqual({ id: ID, kind: 'generation', status: 'failed' });
    expect(consoleChannel(ID)).toBe(`/console/batch/${ID}`);
  });

  it('publishes nothing for a read, a batch still running, or an id that is not one', () => {
    expect(consoleEventOf(rec(OK, { op: 'gate' }, {}))).toBeNull();
    expect(consoleEventOf(rec(OK, { op: 'import', uploadId: ID }, { status: 'running' }))).toBeNull();
    expect(consoleEventOf(rec(OK, { op: 'start', runId: '../*' }, { status: 'complete' }))).toBeNull();
  });
});

describe('a minimum the set could never hold', () => {
  it('the console\'s gate read says so rather than failing when the active version cannot be read', async () => {
    process.env.GOLDEN_RUN_PARAM_ROOT = GOLDEN_ROOT;
    mockStore.current = fakeSsmStore();
    await mockStore.current.client.send(new PutParameterCommand({ Name: `${GOLDEN_ROOT}/standard/golden-run-arn`, Value: 'arn:aws:lambda:us-east-1:1:function:standard-GoldenRun', Type: 'String' }));
    const { createDraft } = await import('../../lambda/src/lib/profile-lifecycle');
    await createDraft(mockStore.current.client, ROOT, 'advisor', 'admin-sub');
    mockAnswer.current = () => ({ entries: 0, regressionEntries: 0, run: null });
    const real = mockStore.current.client.send.bind(mockStore.current.client);
    // The active label's read fails (throttled); the draft and the pack still read.
    (mockStore.current.client as { send: unknown }).send = async (cmd: { input?: { Name?: string } }) => {
      if (String(cmd.input?.Name ?? '').endsWith(':active')) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      return real(cmd as never);
    };
    const res = await handler(evt('/admin/profiles/golden-gate', { profileName: 'advisor' }));
    expect(res.statusCode).toBe(200);
    expect(parse(res).gate).toMatchObject({ minUnread: true });
    const refused = await handler(evt('/admin/profiles/activate', { profileName: 'advisor' }));
    expect(refused.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('is refused where the version is checked', async () => {
    mockStore.current = fakeSsmStore();
    const pack = { intents: Array.from({ length: 6 }, (_, i) => ({ key: `i${i}`, description: 'd', keywords: [], delivery: 'DIRECT' })) };
    expect(await goldenSetReachErrors({ goldenSet: { minRegressionPerIntent: 20 }, intentPack: pack } as never, mockStore.current.client, ROOT, 'advisor'))
      .toEqual([expect.stringContaining('needs 120 regression entries')]);
    expect(await goldenSetReachErrors({ goldenSet: { minRegressionPerIntent: 16 }, intentPack: pack } as never, mockStore.current.client, ROOT, 'advisor')).toEqual([]);
    expect(await goldenSetReachErrors({ intentPack: pack } as never, mockStore.current.client, ROOT, 'advisor')).toEqual([]);
  });
});

describe('the grants', () => {
  it('upload is its own capability, held by both roles, with a team route per assistant', () => {
    const cap = ADMIN_CAPABILITIES['import-golden-set'];
    expect(cap.resources.map((r) => r.path)).toEqual(['admin/profiles/golden-set-import', 'admin/profiles/golden-set-retire-upload']);
    expect(cap.teamResources!.map((r) => r.path)).toEqual([
      'admin/assistants/{assistant}/profiles/golden-set-import', 'admin/assistants/{assistant}/profiles/golden-set-retire-upload',
    ]);
    const others = Object.values(ADMIN_CAPABILITIES).filter((c) => c.key !== 'import-golden-set');
    expect(others.flatMap((c) => [...c.resources, ...(c.teamResources ?? [])]).map((r) => r.path)
      .filter((p) => p.includes('golden-set-import') || p.includes('golden-set-retire-upload'))).toEqual([]);
  });

  it('generating and retiring a generation are edit-profiles routes, and reading a batch is view-profiles', () => {
    const edit = ADMIN_CAPABILITIES['edit-profiles'];
    expect(edit.resources.map((r) => r.path)).toEqual(expect.arrayContaining(['admin/profiles/golden-set-generate', 'admin/profiles/golden-set-retire-generation']));
    expect(edit.teamResources!.map((r) => r.path)).toEqual(expect.arrayContaining([
      'admin/assistants/{assistant}/profiles/golden-set-generate', 'admin/assistants/{assistant}/profiles/golden-set-retire-generation',
    ]));
    const view = ADMIN_CAPABILITIES['view-profiles'];
    expect(view.resources.map((r) => r.path)).toContain('admin/profiles/golden-set-batch');
    expect(view.teamResources!.map((r) => r.path)).toContain('admin/assistants/{assistant}/profiles/golden-set-batch');
  });
});
