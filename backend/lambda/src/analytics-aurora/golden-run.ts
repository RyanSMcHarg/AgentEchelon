/**
 * A DRAFT ANSWERS THE GOLDEN SET BEFORE IT IS ACTIVATED (ADR-065 Option A, SPEC-EVALUATION FR17).
 *
 * One run answers every live entry of one assistant's set k times with the draft and k times with the active version,
 * posting nothing, and records each attempt. The gate's rule is `lib/promotion-gate.ts`: a regression entry the draft
 * fails on any attempt (an error, an empty answer, a guardrail intervention, a rule the platform checks without a judge)
 * refuses Activate; the judged paired difference informs and never refuses.
 *
 * ── ONE CLASSIFICATION PER FUNCTION, ON ITS OWN ROLE (tenet D12) ──────────────────────────────────────────────────
 *
 * The run executes on its classification's GoldenRun function (`classification-archive-functions.ts`), pinned by
 * `GOLDEN_RUN_CLASSIFICATION`, whose role invokes only that classification's models and guardrails, reads only the
 * assistants' version bodies, and holds no Amazon Chime SDK permission, no vend invoke and no routing table. A function
 * refuses a run of any other classification, so a payload cannot widen what it reaches. Entries are read as the
 * classification's reader role and attempts written as the write role, stamped with the function's own classification.
 *
 * ── WHAT IT IS GIVEN, AND WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────
 *
 * The archive's VPC has no route to SSM, so the starter (`manage-profiles`, outside it) sends both versions' stored
 * definitions; their offloaded bodies are read here from S3 through the gateway endpoint. Each attempt is composed by
 * the composer a live turn uses (`lib/answer-prompt.ts`), under `goldenRunContext`: the entry's recorded reply
 * preferences and preceding turns, and nothing about a person. No tools: an entry whose answer used a tool is answered
 * and recorded as not exercised. No catalog context sources: they are read for a person, and a run has none.
 */

import { randomUUID } from 'crypto';
import { withReaderRole, withWriterRole } from './classification-boundary.js';
import { judgeRelevance } from './evaluation-runner.js';
import { gateResult, type GateEntry, type GateResult } from '../lib/promotion-gate.js';
import { composeAnswerPrompt, goldenRunContext } from '../lib/answer-prompt.js';
import { runMessages, judgeTranscript } from '../lib/golden-entry.js';
import { intentDefFor, answerShapeIssues } from '../lib/intent-answer.js';
import { parseIntentPack, type IntentPack } from '../lib/intent-pack.js';
import { resolveFromDefinition, rememberRuntimeSeed, buildIntentStrategy, platformRoutesServedOn } from '../lib/active-profile.js';
import { hydrateBodies } from '../lib/profile-bodies.js';
import { invokeBedrockWithFallback } from '../lib/bedrock-resilience.js';
import { outputGuardrailVerdict } from '../lib/async-processor-core.js';
import { resolveModelForIntent } from '../lib/model-resolver.js';
import { getModelCatalog, INTENT_ROUTE_STRATEGY, UTILITY_MODEL_ID, type Classification } from '../../../lib/config/model-strategy.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import type { ProfileDefinition } from '../lib/active-profile.js';
import type { AssistantProfile } from '../../../lib/config/profiles.js';
import { guardrailDetector, type PiiDetector } from '../lib/pii-detector.js';
import { GOLDEN_SET_CAPACITY, textsOf, withTexts, type UploadedEntry } from '../lib/golden-upload.js';
import type { IntentCoverage } from '../lib/golden-gate.js';
import { generationPrompt, requestsFromAnswer, GENERATE_MAX_INTENTS, type GenerationIntent } from '../lib/golden-generate.js';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/** Attempts per entry per side (ADR-065 decision 2). */
export const GOLDEN_RUN_K = 3;
/** Entries answered at once; each is 2k model calls and 2k judge calls. */
const ENTRY_CONCURRENCY = 3;
/**
 * How long a run may say it is running. The function stops at 15 minutes and cannot record that it did, so a run still
 * `running` past this ended without finishing, and is read as failed: a run that will never complete must not hold
 * Activate shut.
 */
export const RUN_DEADLINE_MS = 16 * 60 * 1000;
/** The error an overdue run reads with. */
export const RUN_DEADLINE_ERROR = 'deadline';
/** The answer budget, the same for both sides so the comparison is of versions, not budgets. */
const RUN_MAX_TOKENS = 2048;

const ownClassification = (): string => (process.env.GOLDEN_RUN_CLASSIFICATION || '').trim();

/** Refuse a run this function may not execute: a different classification, or none at all. */
export function assertOwnClassification(classification: string | null | undefined): string {
  const own = ownClassification();
  if (!own) throw new Error('[golden-run] this function serves no classification (GOLDEN_RUN_CLASSIFICATION is unset)');
  if (classification !== own) {
    throw new Error(`[golden-run] this function runs ${own} runs only; the run is for ${classification || 'no classification'}`);
  }
  return own;
}

export interface GoldenRunSide {
  configId: string;
  /** The version's stored definition as SSM holds it: bodies by pointer, hydrated here. */
  definition: ProfileDefinition;
}

export interface StartGoldenRun {
  op: 'start';
  runId: string;
  classification: string;
  assistant: string;
  startedBy: string;
  k?: number;
  draft: GoldenRunSide;
  active: GoldenRunSide;
  /** A runtime assistant's seed, which the function cannot read from the directory (no SSM route). */
  seed?: AssistantProfile;
  /** The persona a version without one answers with, resolved by the starter as a live turn resolves it. */
  fallbackPersona: string;
  /**
   * The deployment's intent pack as stored, for a version carrying none of its own: the function has no SSM route, and
   * its compiled default is not this deployment's taxonomy. Absent means the deployment has none, so the default is right.
   */
  deploymentPackRaw?: string;
}

export interface GoldenGateQuery {
  op: 'gate';
  classification: string;
  assistant: string;
  configId: string;
  /** The intents of the draft's pack, which coverage is reported against (ADR-065 decision 6). */
  intents?: string[];
}

export type { IntentCoverage };

/** What the gate at Activate reads, and what the console shows beside Validate. */
export interface GoldenGate {
  /** Live regression entries in this assistant's set; with none, no run is required. */
  regressionEntries: number;
  /** Live entries of either purpose. */
  entries: number;
  /** Live regression entries the latest run has no attempt for: nominated after it, so it never answered them. */
  uncoveredRegression: number;
  run: GoldenRunRecord | null;
  /** Per intent of the draft's pack, in the pack's order; absent when the read named no intents. */
  coverage?: IntentCoverage[];
  /** Live entries whose intent the draft's pack does not declare, by intent: counted, not checked against a minimum. */
  outsidePack?: Array<{ intent: string; entries: number }>;
}

export interface GoldenRunRecord {
  runId: string;
  draftConfigId: string;
  k: number;
  entriesTotal: number;
  entriesDone: number;
  status: 'running' | 'complete' | 'failed';
  result: GateResult | null;
  error: string | null;
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
}

interface EntryRow {
  id: string;
  purpose: 'regression' | 'capability';
  intent: string | null;
  request_text: string;
  reference_text: string | null;
  used_tools: string[] | null;
  reply_preferences: Record<string, string> | null;
  preceding_turns: unknown;
}

/** One side, resolved as a turn would serve it. */
interface ServedSide {
  persona: string;
  addendum?: string;
  pack: IntentPack;
  guardrailId?: string;
  models: Parameters<typeof buildIntentStrategy>[0];
  modelKey: string;
}

async function serve(side: GoldenRunSide, assistant: string, fallbackPersona: string, deploymentPack: IntentPack): Promise<ServedSide> {
  const resolved = resolveFromDefinition(await hydrateBodies(side.definition), assistant);
  return {
    persona: resolved.persona?.trim() || fallbackPersona,
    addendum: resolved.systemPromptAddendum,
    // A version without a pack of its own answers against the deployment's taxonomy, as a turn does.
    pack: resolved.intentPack ?? deploymentPack,
    guardrailId: resolved.guardrailId,
    models: resolved.models,
    modelKey: resolved.profile.modelKey,
  };
}

/** The model the side serves this entry's intent on, by the rule a turn's route uses. */
function modelFor(side: ServedSide, intent: string, classification: string) {
  const catalog = getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '');
  const selection = defaultProfileRegistry.modelsOf(classification);
  const models = selection && (catalog as Record<string, unknown>)[side.modelKey] && selection.selected.includes(side.modelKey)
    ? { ...selection, default: side.modelKey }
    : selection;
  const strategy = buildIntentStrategy(side.models)
    ?? buildIntentStrategy({ byIntent: platformRoutesServedOn(side.modelKey) })
    ?? INTENT_ROUTE_STRATEGY;
  return resolveModelForIntent(intent || undefined, classification as Classification, catalog, strategy, models);
}

export interface AttemptRecord {
  ok: boolean;
  empty: boolean;
  blocked: boolean;
  breaches: string[];
  score: number | null;
  model: string | null;
  answer: string | null;
  error: string | null;
}

/** Answer one entry once, as one side, and judge it. Never throws: a failure is the attempt's record. */
async function attempt(side: ServedSide, entry: EntryRow, classification: string, assistant: string): Promise<AttemptRecord> {
  const intent = entry.intent || '';
  const messages = runMessages(entry.preceding_turns, entry.request_text);
  const { systemPrompt, cacheablePrefixLength } = composeAnswerPrompt({
    persona: side.persona,
    addendum: side.addendum,
    hostSections: [],
    intent,
    pack: side.pack,
    transcript: messages,
    context: goldenRunContext(entry.reply_preferences),
  });
  let model: string | null = null;
  try {
    const route = modelFor(side, intent, classification);
    model = route.primaryModelKey;
    const res = await invokeBedrockWithFallback(
      systemPrompt,
      messages,
      { model: route.primaryModelId, maxTokens: RUN_MAX_TOKENS, userType: classification, guardrailId: side.guardrailId },
      route.fallbackModelId,
      { cacheableSystemPrefixLength: cacheablePrefixLength, enableCompanyContextTool: false, enableEditTools: false },
    );
    model = res.modelUsed || model;
    if (res.inputGuardBlocked) {
      return { ok: true, empty: false, blocked: true, breaches: [], score: null, model, answer: res.response, error: null };
    }
    const raw = (res.response || '').trim();
    // A BLOCK, NOT A MASK. A policy that anonymizes a detail echoed from the request still returns the answer, and that
    // is not a failure; only a policy whose action is BLOCKED is. Read from this call's own assessment.
    const verdict = await outputGuardrailVerdict(raw, side.guardrailId);
    const guarded = verdict.text;
    const intervened = verdict.blocked;
    const breaches = answerShapeIssues(intentDefFor(intent, side.pack)?.answer, guarded).map((i) => `answer-shape.${i.kind}`);
    let score: number | null = null;
    if (guarded && !intervened) {
      const judged = await judgeRelevance({
        agentType: assistant,
        conversationClassification: classification,
        taskContext: '',
        conversationContext: judgeTranscript(entry.preceding_turns),
        userMessage: entry.request_text,
        agentResponse: guarded,
      }).catch(() => null);
      score = judged ? judged.relevanceScore : null;
    }
    return { ok: true, empty: !intervened && !guarded, blocked: intervened, breaches, score, model, answer: guarded, error: null };
  } catch (err) {
    return { ok: false, empty: true, blocked: false, breaches: [], score: null, model, answer: null, error: String((err as Error)?.message ?? err).slice(0, 500) };
  }
}

async function mapLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

/** The live entries of one assistant's set, read as the classification's own reader. */
async function liveEntries(classification: string, assistant: string): Promise<EntryRow[]> {
  const res = await withReaderRole(classification, (client) => client.query<EntryRow>(
    `SELECT id, purpose, intent, request_text, reference_text, used_tools, reply_preferences, preceding_turns
       FROM golden_set_entries
      WHERE retired_at IS NULL AND classification = $1 AND assistant = $2
      ORDER BY nominated_at`,
    [classification, assistant],
  ));
  return res.rows;
}

/**
 * Run a draft against its assistant's set and record every attempt. The run row is opened first, under the id the
 * starter minted and returned, so the console reads "running" from the moment the person started it.
 */
export async function executeGoldenRun(input: StartGoldenRun): Promise<GoldenRunRecord> {
  const classification = assertOwnClassification(input.classification);
  const k = Math.max(1, Math.min(10, Math.floor(input.k ?? GOLDEN_RUN_K)));
  if (input.seed) rememberRuntimeSeed(input.seed);
  // The row first, so anything that fails after it is recorded on the run the console reads.
  await withWriterRole((client) => client.query(
    `INSERT INTO golden_runs (id, classification, assistant, draft_config_id, active_config_id, k, status, started_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)`,
    [input.runId, classification, input.assistant, input.draft.configId, input.active.configId, k, input.startedBy],
  ));
  try {
    const entries = await liveEntries(classification, input.assistant);
    await withWriterRole((client) => client.query(
      `UPDATE golden_runs SET entries_total = $2 WHERE id = $1`, [input.runId, entries.length],
    ));
    const deploymentPack = parseIntentPack(input.deploymentPackRaw);
    const draft = await serve(input.draft, input.assistant, input.fallbackPersona, deploymentPack);
    const active = await serve(input.active, input.assistant, input.fallbackPersona, deploymentPack);
    await mapLimited(entries, ENTRY_CONCURRENCY, async (entry) => {
      // AN ENTRY THE RUN CANNOT EXERCISE IS RECORDED, NOT ANSWERED: the gate sets its attempts aside, so answering it
      // would spend model calls and run time on nothing.
      const notExercised = entry.used_tools?.length ? 'tools' : null;
      // ONE ENTRY'S 2k ATTEMPTS AT ONCE. They are independent, and answering them one after another made a run's length
      // grow past the function's 15 minutes at a modest set size.
      const jobs = (['draft', 'active'] as const).flatMap((sideName) => Array.from({ length: k }, (_, n) => ({ sideName, i: n + 1 })));
      await Promise.all(jobs.map(async ({ sideName, i }) => {
          const a: AttemptRecord = notExercised
            ? { ok: true, empty: false, blocked: false, breaches: [], score: null, model: null, answer: null, error: null }
            : await attempt(sideName === 'draft' ? draft : active, entry, classification, input.assistant);
          await withWriterRole((client) => client.query(
            `INSERT INTO golden_run_attempts
               (run_id, classification, entry_id, side, attempt, ok, empty, blocked, breaches, score, not_exercised, model, answer_text, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (run_id, entry_id, side, attempt) DO NOTHING`,
            [input.runId, classification, entry.id, sideName, i, a.ok, a.empty, a.blocked, a.breaches, a.score,
             notExercised, a.model, a.answer, a.error],
          ));
      }));
      await withWriterRole((client) => client.query(
        `UPDATE golden_runs SET entries_done = entries_done + 1 WHERE id = $1`, [input.runId],
      ));
    });
    const result = await resultOf(input.runId, classification);
    await withWriterRole((client) => client.query(
      `UPDATE golden_runs SET status = 'complete', result = $2, completed_at = NOW() WHERE id = $1`,
      [input.runId, JSON.stringify(result)],
    ));
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 1000);
    await withWriterRole((client) => client.query(
      `UPDATE golden_runs SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`, [input.runId, message],
    ));
  }
  return (await readRun(input.runId, classification))!;
}

/** The gate's decision over a run's recorded attempts. */
async function resultOf(runId: string, classification: string): Promise<GateResult> {
  const res = await withReaderRole(classification, (client) => client.query<{
    entry_id: string; purpose: 'regression' | 'capability'; side: 'draft' | 'active'; attempt: number;
    ok: boolean; empty: boolean; blocked: boolean; breaches: string[]; score: number | null; not_exercised: string | null;
  }>(
    `SELECT a.entry_id, e.purpose, a.side, a.attempt, a.ok, a.empty, a.blocked, a.breaches, a.score, a.not_exercised
       FROM golden_run_attempts a JOIN golden_set_entries e ON e.id = a.entry_id
      WHERE a.run_id = $1
      ORDER BY a.entry_id, a.side, a.attempt`,
    [runId],
  ));
  return gateResult(gateEntriesOf(res.rows));
}

/** Recorded attempts, one row each, as the gate's entries. Pure, so the grouping is pinned by a unit test. */
export function gateEntriesOf(rows: Array<{
  entry_id: string; purpose: 'regression' | 'capability'; side: 'draft' | 'active';
  ok: boolean; empty: boolean; blocked: boolean; breaches: string[] | null; score: number | null; not_exercised: string | null;
}>): GateEntry[] {
  const byEntry = new Map<string, GateEntry>();
  for (const r of rows) {
    const e = byEntry.get(r.entry_id) ?? {
      entryId: r.entry_id, purpose: r.purpose, candidate: [], baseline: [],
      ...(r.not_exercised === 'tools' ? { notExercised: 'tools' as const } : {}),
    };
    (r.side === 'draft' ? e.candidate : e.baseline).push({
      ok: r.ok, empty: r.empty, blocked: r.blocked, breaches: r.breaches ?? [], score: r.score,
    });
    byEntry.set(r.entry_id, e);
  }
  return [...byEntry.values()];
}

async function readRun(runId: string, classification: string): Promise<GoldenRunRecord | null> {
  const res = await withReaderRole(classification, (client) => client.query(
    `SELECT id, draft_config_id, k, entries_total, entries_done, status, result, error, started_by, started_at, completed_at
       FROM golden_runs WHERE id = $1`,
    [runId],
  ));
  return res.rows[0] ? recordOf(res.rows[0]) : null;
}

export function recordOf(r: Record<string, unknown>, now = Date.now()): GoldenRunRecord {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  const started = Date.parse(iso(r.started_at) ?? '');
  const overdue = r.status === 'running' && Number.isFinite(started) && now - started > RUN_DEADLINE_MS;
  return {
    runId: String(r.id),
    draftConfigId: String(r.draft_config_id),
    k: Number(r.k),
    entriesTotal: Number(r.entries_total),
    entriesDone: Number(r.entries_done),
    status: overdue ? 'failed' : r.status as GoldenRunRecord['status'],
    result: (r.result as GateResult | null) ?? null,
    // A code, which the console words from the locale file: the function cannot record its own timeout.
    error: overdue ? RUN_DEADLINE_ERROR : (r.error as string | null) ?? null,
    startedBy: String(r.started_by),
    startedAt: iso(r.started_at) ?? '',
    completedAt: iso(r.completed_at),
  };
}

/** The set's size and the latest run for a draft's configId: what Activate's gate and the console read. */
export async function readGoldenGate(q: GoldenGateQuery): Promise<GoldenGate> {
  const classification = assertOwnClassification(q.classification);
  return withReaderRole(classification, async (client) => {
    const counts = await client.query<{ entries: string; regression: string }>(
      `SELECT COUNT(*)::text AS entries, COUNT(*) FILTER (WHERE purpose = 'regression')::text AS regression
         FROM golden_set_entries
        WHERE retired_at IS NULL AND classification = $1 AND assistant = $2`,
      [classification, q.assistant],
    );
    const run = await client.query(
      `SELECT id, draft_config_id, k, entries_total, entries_done, status, result, error, started_by, started_at, completed_at
         FROM golden_runs
        WHERE classification = $1 AND assistant = $2 AND draft_config_id = $3
        ORDER BY started_at DESC LIMIT 1`,
      [classification, q.assistant, q.configId],
    );
    const uncovered = run.rows[0]
      ? await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM golden_set_entries e
          WHERE e.retired_at IS NULL AND e.classification = $1 AND e.assistant = $2 AND e.purpose = 'regression'
            AND NOT EXISTS (SELECT 1 FROM golden_run_attempts a WHERE a.run_id = $3 AND a.entry_id = e.id)`,
        [classification, q.assistant, run.rows[0].id],
      )
      : null;
    const byIntent = q.intents
      ? await client.query<{ intent: string; regression: string; capability: string; uploaded: string; exercised: string }>(
        `SELECT COALESCE(e.intent, '') AS intent,
                COUNT(*) FILTER (WHERE e.purpose = 'regression')::text AS regression,
                COUNT(*) FILTER (WHERE e.purpose = 'capability')::text AS capability,
                COUNT(*) FILTER (WHERE e.source = 'uploaded')::text AS uploaded,
                COUNT(*) FILTER (WHERE e.purpose = 'regression' AND EXISTS (
                  SELECT 1 FROM golden_run_attempts a
                   WHERE a.run_id = $3::uuid AND a.entry_id = e.id AND a.side = 'draft' AND a.not_exercised IS NULL))::text AS exercised
           FROM golden_set_entries e
          WHERE e.retired_at IS NULL AND e.classification = $1 AND e.assistant = $2
          GROUP BY 1`,
        [classification, q.assistant, run.rows[0]?.id ?? null],
      )
      : null;
    // A RUN REFUSES ONLY ON ENTRIES THAT ARE STILL LIVE REGRESSION: an entry retired, or promoted away, since the run no
    // longer stands for anything the draft must keep passing, so its failures are not the gate's.
    const record = run.rows[0] ? recordOf(run.rows[0]) : null;
    if (record?.result?.failures.length) {
      const live = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM golden_set_entries
          WHERE retired_at IS NULL AND classification = $1 AND assistant = $2 AND purpose = 'regression' AND id::text = ANY($3::text[])`,
        [classification, q.assistant, [...new Set(record.result.failures.map((f) => f.entryId))]],
      );
      record.result = liveFailuresOnly(record.result, new Set(live.rows.map((r) => r.id)));
    }
    return {
      entries: Number(counts.rows[0]?.entries ?? 0),
      regressionEntries: Number(counts.rows[0]?.regression ?? 0),
      uncoveredRegression: Number(uncovered?.rows[0]?.n ?? 0),
      run: record,
      ...(q.intents && byIntent ? coverageOf(q.intents, byIntent.rows) : {}),
    };
  });
}

/** A run's result with only the failures of entries still live regression; it refuses only if one remains. Pure. */
export function liveFailuresOnly(result: GateResult, live: ReadonlySet<string>): GateResult {
  const failures = result.failures.filter((f) => live.has(f.entryId));
  return { ...result, failures, refused: failures.length > 0 };
}

/** Counts per intent as the draft's pack lists them, every intent present, and what the pack does not declare. Pure. */
export function coverageOf(
  intents: string[],
  rows: Array<{ intent: string; regression: string | number; capability: string | number; uploaded: string | number; exercised: string | number }>,
): { coverage: IntentCoverage[]; outsidePack: Array<{ intent: string; entries: number }> } {
  const counted = new Map(rows.map((r) => [r.intent, r]));
  const coverage = [...new Set(intents)].map((intent) => {
    const r = counted.get(intent);
    return {
      intent,
      regression: Number(r?.regression ?? 0),
      capability: Number(r?.capability ?? 0),
      uploaded: Number(r?.uploaded ?? 0),
      exercised: Number(r?.exercised ?? 0),
    };
  });
  const declared = new Set(intents);
  const outsidePack = rows
    .filter((r) => !declared.has(r.intent))
    .map((r) => ({ intent: r.intent, entries: Number(r.regression) + Number(r.capability) }))
    .sort((a, b) => a.intent.localeCompare(b.intent));
  return { coverage, outsidePack };
}

/** A fresh run id, for a starter that has none. */
export const newRunId = (): string => randomUUID();

// ── A DEPLOYMENT'S OWN ENTRIES (ADR-065 decision 7) ──────────────────────────────────────────────────────────────────

export interface ImportGoldenEntries {
  op: 'import';
  classification: string;
  assistant: string;
  uploadId: string;
  uploadedBy: string;
  /** Read and checked by `manage-profiles` (`lib/golden-upload.ts`), not yet de-identified. */
  entries: UploadedEntry[];
}

export interface RetireGoldenUpload {
  op: 'retire-upload';
  classification: string;
  assistant: string;
  uploadId: string;
  retiredBy: string;
  /** Which kind of batch the caller may retire: an upload (`import-golden-set`) or a generation (`edit-profiles`). */
  source: 'uploaded' | 'generated';
}

export type GoldenImportResult =
  | { imported: number; uploadId: string; already?: true }
  | { refused: true; code: 'GOLDEN_SET_FULL'; params: { live: number; adding: number; capacity: number } }
  | { refused: true; code: 'DETECTOR_UNAVAILABLE' | 'DETECTOR_BUSY'; params: Record<string, never> }
  | { refused: true; code: 'DETECTOR_FAILED'; params: { count: number }; lines: number[] };

/** The deployment's detector, the one the de-identified copy is made with; null where none is wired. */
function uploadDetector(): PiiDetector | null {
  const id = (process.env.DEIDENTIFY_GUARDRAIL_ID || '').trim();
  const version = (process.env.DEIDENTIFY_GUARDRAIL_VERSION || '').trim();
  return id && version ? guardrailDetector(id, version) : null;
}

/**
 * De-identify every entry's texts. One batch first; if the detector refuses it, each entry alone, so the lines it cannot
 * process are named. Never the raw text in place of an answer the detector did not give.
 */
export async function deIdentifyEntries(
  entries: UploadedEntry[],
  anonymize: PiiDetector['anonymize'],
): Promise<{ entries: UploadedEntry[] } | { failedLines: number[] } | { busy: true }> {
  // WHOLE ENTRIES PER CALL, SEVERAL CALLS AT ONCE, so an upload's time is bounded by the slowest chunk rather than the sum
  // of every call: the import answers inside the request that started it.
  const chunks: UploadedEntry[][] = [];
  let current: UploadedEntry[] = [];
  let size = 0;
  for (const e of entries) {
    const n = textsOf(e).reduce((m, t) => m + t.length, 0);
    if (current.length && size + n > DETECT_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += n;
  }
  if (current.length) chunks.push(current);
  const masked = async (group: UploadedEntry[]): Promise<UploadedEntry[]> => {
    const texts = group.flatMap(textsOf);
    const out = await withThrottleRetry(() => anonymize(texts));
    if (out.length !== texts.length) throw new Error(`detector returned ${out.length} texts for ${texts.length}`);
    let at = 0;
    return group.map((e) => {
      const n = textsOf(e).length;
      const mine = out.slice(at, at + n);
      at += n;
      return withTexts(e, mine);
    });
  };
  const cleaned: UploadedEntry[] = [];
  const failedLines: number[] = [];
  let busy = false;
  await mapLimited(chunks, DETECT_CONCURRENCY, async (group) => {
    try {
      cleaned.push(...await masked(group));
    } catch (err) {
      // STILL THROTTLED AFTER BACKING OFF: the detector is busy, which is no line's fault.
      if (isThrottle(err)) {
        busy = true;
        return;
      }
      // THE DETECTOR'S OWN ERROR IS LOGGED, so a throttle or a missing grant is told apart from a line it cannot process.
      console.warn('[golden-run] the detector refused a chunk; checking its entries one at a time', detectorError(err));
      for (const e of group) {
        try {
          cleaned.push(...await masked([e]));
        } catch (one) {
          if (isThrottle(one)) {
            busy = true;
            continue;
          }
          console.warn('[golden-run] the detector could not process line', e.line, detectorError(one));
          failedLines.push(e.line);
        }
      }
    }
  });
  if (busy) {
    console.warn('[golden-run] the detector stayed throttled after backing off; nothing was stored');
    return { busy: true };
  }
  return failedLines.length
    ? { failedLines: failedLines.sort((a, b) => a - b) }
    : { entries: cleaned.sort((a, b) => a.line - b.line) };
}

const isThrottle = (err: unknown): boolean => /Throttl|TooManyRequests|ServiceQuotaExceeded/i.test(String((err as { name?: string })?.name ?? ''));

/** A call retried twice on a throttle, after 0.5 s and then 2 s; any other error is the call's own. */
async function withThrottleRetry<T>(call: () => Promise<T>): Promise<T> {
  for (const wait of [500, 2000]) {
    try {
      return await call();
    } catch (err) {
      if (!isThrottle(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return call();
}

/** Characters of entries per detector call, and calls at once. */
const DETECT_CHUNK_CHARS = 8000;
const DETECT_CONCURRENCY = 6;

/** What a failed call says about itself, never the text it was given. */
function detectorError(err: unknown): { name: string; message: string } {
  const e = err as { name?: string; message?: string };
  return { name: e?.name ?? 'Error', message: String(e?.message ?? err).slice(0, 200) };
}

/**
 * Write an upload into the assistant's set as capability entries, inside this function's classification. The set's
 * capacity is checked under a lock on the assistant's set, in the transaction that writes, so two uploads at once cannot
 * pass it together.
 */
export async function importGoldenEntries(
  input: ImportGoldenEntries,
  detector: PiiDetector | null = uploadDetector(),
): Promise<GoldenImportResult> {
  const classification = assertOwnClassification(input.classification);
  const out = await addEntries(classification, input.assistant, input.entries, input.uploadedBy, input.uploadId, 'uploaded', detector);
  if ('refused' in out) return out;
  return { imported: out.added, uploadId: input.uploadId, ...(out.already ? { already: true as const } : {}) };
}

/**
 * De-identify entries and write them as capability entries of one batch (an upload, or a generation), inside this
 * function's classification. The set's capacity is checked under a lock on the assistant's set, in the transaction that
 * writes, so two batches at once cannot pass it together.
 */
async function addEntries(
  classification: string,
  assistant: string,
  entries: UploadedEntry[],
  by: string,
  batchId: string,
  source: 'uploaded' | 'generated',
  detector: PiiDetector | null,
): Promise<{ added: number; already?: true } | Extract<GoldenImportResult, { refused: true }>> {
  if (!detector) return { refused: true, code: 'DETECTOR_UNAVAILABLE', params: {} };
  const before = await withReaderRole(classification, (client) => setCounts(client, classification, assistant, batchId, source));
  if (before.batch) return { added: before.batch, already: true };
  if (before.live + entries.length > GOLDEN_SET_CAPACITY) {
    return { refused: true, code: 'GOLDEN_SET_FULL', params: { live: before.live, adding: entries.length, capacity: GOLDEN_SET_CAPACITY } };
  }
  const deIdentified = await deIdentifyEntries(entries, detector.anonymize);
  if ('busy' in deIdentified) return { refused: true, code: 'DETECTOR_BUSY', params: {} };
  if ('failedLines' in deIdentified) {
    return { refused: true, code: 'DETECTOR_FAILED', params: { count: deIdentified.failedLines.length }, lines: deIdentified.failedLines.slice(0, 50) };
  }
  // TWO REQUESTS THE DETECTOR MADE ONE ("email alice@... about Q3" and "email bob@... about Q3") are one case, kept once.
  const seen = new Set<string>();
  const clean = { entries: deIdentified.entries.filter((e) => {
    const key = `${e.intent}\n${e.request}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
  return withWriterRole(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`golden-set:${classification}:${assistant}`]);
    // Again under the lock, in the transaction that writes: a batch written meanwhile writes nothing, and two batches at once
    // cannot pass the capacity together.
    const now = await setCounts(client, classification, assistant, batchId, source);
    if (now.batch) return { added: now.batch, already: true as const };
    if (now.live + clean.entries.length > GOLDEN_SET_CAPACITY) {
      return { refused: true as const, code: 'GOLDEN_SET_FULL' as const, params: { live: now.live, adding: clean.entries.length, capacity: GOLDEN_SET_CAPACITY } };
    }
    // Every parameter is cast: one used both as a value and in a comparison is otherwise typed two ways and refused.
    // ONE INSERT, and a request the set already holds live for the same intent is not added twice, so a batch sent again
    // after its capability entries were retired restores them without repeating the ones a person promoted.
    const res = await client.query(
      `INSERT INTO golden_set_entries
         (classification, purpose, assistant, intent, request_text, reference_text, nominated_by,
          reply_preferences, preceding_turns, source, upload_id)
       SELECT $1::text, 'capability', $2::text, e.intent, e.request, e.reference, $3::text, e.prefs::jsonb, e.turns::jsonb, $4::text, $5::uuid
         FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[]) AS e(intent, request, reference, prefs, turns)
        WHERE NOT EXISTS (
          SELECT 1 FROM golden_set_entries g
           WHERE g.classification = $1::text AND g.assistant = $2::text AND g.retired_at IS NULL
             AND g.intent = e.intent AND g.request_text = e.request)`,
      [classification, assistant, by, source, batchId,
       clean.entries.map((e) => e.intent), clean.entries.map((e) => e.request), clean.entries.map((e) => e.reference),
       clean.entries.map((e) => (e.replyPreferences ? JSON.stringify(e.replyPreferences) : null)),
       clean.entries.map((e) => (e.precedingTurns.length ? JSON.stringify(e.precedingTurns) : null))],
    );
    return { added: res.rowCount ?? 0 };
  });
}

/**
 * The set's live size, and the live CAPABILITY entries of this batch of this source: a batch is written already when it
 * still has those. A promoted entry no longer counts as the batch's, and an id of another kind of batch never matches.
 */
async function setCounts(
  client: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  classification: string,
  assistant: string,
  batchId: string,
  source: 'uploaded' | 'generated',
): Promise<{ live: number; batch: number }> {
  const res = await client.query<{ live: string; batch: string }>(
    `SELECT COUNT(*)::text AS live,
            COUNT(*) FILTER (WHERE upload_id = $3::uuid AND source = $4 AND purpose = 'capability')::text AS batch
       FROM golden_set_entries
      WHERE retired_at IS NULL AND classification = $1 AND assistant = $2`,
    [classification, assistant, batchId, source],
  );
  return { live: Number(res.rows[0]?.live ?? 0), batch: Number(res.rows[0]?.batch ?? 0) };
}

// ── ENTRIES GENERATED FROM THE DRAFT'S INTENT PACK (ADR-065 decision 8) ──────────────────────────────────────────────

export interface GenerateGoldenEntries {
  op: 'generate';
  classification: string;
  assistant: string;
  generationId: string;
  generatedBy: string;
  /** The intents to write requests for, in the pack's own words (`lib/golden-generate.ts`). */
  intents: GenerationIntent[];
  perIntent: number;
  /**
   * The caller named no intents: of `intents` (the whole pack), generate for the `GENERATE_MAX_INTENTS` the set holds the
   * fewest live entries for, so a pack larger than one call still gets its thinnest intents first.
   */
  leastCovered?: boolean;
}

export type GoldenGenerateResult =
  | { generated: number; generationId: string; byIntent: Record<string, number>; already?: true }
  | Extract<GoldenImportResult, { refused: true }>
  | { refused: true; code: 'GENERATION_FAILED'; params: { count: number; intents: string } };

/**
 * One call to the utility model, called as the relevance judge calls it: the prompt is the platform's own, written from the
 * pack, so it does not pass the person-facing input guardrail a turn does (which answers a block with copy, not requests).
 * A throttle is retried with backoff; any other error is the call's own.
 */
async function utilityAnswer(prompt: string): Promise<string> {
  const res = await withThrottleRetry(() => (generatorClient ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' }))
    .send(new InvokeModelCommand({
      modelId: UTILITY_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1500,
        temperature: 0.9,
        messages: [{ role: 'user', content: prompt }],
      }),
    })));
  const body = JSON.parse(new TextDecoder().decode(res.body));
  return String(body.content?.[0]?.text ?? '');
}
let generatorClient: BedrockRuntimeClient | undefined;

/**
 * Write requests for each intent and add them as capability entries marked generated, under one generation id so the
 * whole generation can be retired at once. An intent the model gave no usable answer for refuses the generation and is
 * named: nothing is stored, and the same call can be made again.
 */
export async function generateGoldenEntries(
  input: GenerateGoldenEntries,
  answer: (prompt: string) => Promise<string> = utilityAnswer,
  detector: PiiDetector | null = uploadDetector(),
): Promise<GoldenGenerateResult> {
  const classification = assertOwnClassification(input.classification);
  if (!detector) return { refused: true, code: 'DETECTOR_UNAVAILABLE', params: {} };
  // A RETRY OF A GENERATION ALREADY WRITTEN spends no model call: the console resends the same id after a cut-off answer.
  const { live, batch: already } = await withReaderRole(classification, (client) =>
    setCounts(client, classification, input.assistant, input.generationId, 'generated'));
  if (already) return { generated: already, generationId: input.generationId, byIntent: {}, already: true };
  // WITH NONE NAMED, ONLY WHAT FITS: the least covered intents, as many as the set has room for at this many per intent.
  const room = Math.floor((GOLDEN_SET_CAPACITY - live) / input.perIntent);
  const intents = input.leastCovered
    ? await leastCovered(classification, input.assistant, input.intents, Math.max(1, Math.min(GENERATE_MAX_INTENTS, room)))
    : input.intents;
  const adding = intents.length * input.perIntent;
  if (live + adding > GOLDEN_SET_CAPACITY) {
    return { refused: true, code: 'GOLDEN_SET_FULL', params: { live, adding, capacity: GOLDEN_SET_CAPACITY } };
  }
  const written: Array<{ intent: string; requests: string[] | null }> = [];
  // EVERY INTENT AT ONCE (at most GENERATE_MAX_INTENTS), so the call answers inside the request that started it.
  await mapLimited(intents, GENERATE_MAX_INTENTS, async (intent) => {
    const text = await answer(generationPrompt(intent, input.perIntent)).catch((err) => {
      console.warn('[golden-run] the utility model failed for intent', intent.key, detectorError(err));
      return '';
    });
    const requests = requestsFromAnswer(text, input.perIntent);
    // A short preview of an unusable answer: generated from the pack's own words, it describes no person.
    if (!requests && text) console.warn('[golden-run] the utility model answered with no usable requests for intent', intent.key, { preview: text.slice(0, 160) });
    written.push({ intent: intent.key, requests });
  });
  const failed = written.filter((w) => !w.requests).map((w) => w.intent).sort();
  if (failed.length) return { refused: true, code: 'GENERATION_FAILED', params: { count: failed.length, intents: failed.join(', ') } };
  const order = new Map(intents.map((i, n) => [i.key, n]));
  const entries: UploadedEntry[] = written
    .sort((a, b) => (order.get(a.intent) ?? 0) - (order.get(b.intent) ?? 0))
    .flatMap((w) => w.requests!.map((request) => ({ intent: w.intent, request, reference: null, precedingTurns: [], replyPreferences: null, line: 0 })))
    .map((e, n) => ({ ...e, line: n + 1 }));
  const out = await addEntries(classification, input.assistant, entries, input.generatedBy, input.generationId, 'generated', detector);
  if ('refused' in out) return out;
  if (out.already) return { generated: out.added, generationId: input.generationId, byIntent: {}, already: true };
  const byIntent: Record<string, number> = {};
  for (const e of entries) byIntent[e.intent] = (byIntent[e.intent] ?? 0) + 1;
  return { generated: out.added, generationId: input.generationId, byIntent };
}

/**
 * Retire the live entries of one upload or generation of this assistant's set. Only CAPABILITY entries: an entry a person
 * promoted to regression is retired one at a time under the golden set's own grant, never swept out with its batch.
 */
export async function retireGoldenUpload(input: RetireGoldenUpload): Promise<{ retired: number }> {
  const classification = assertOwnClassification(input.classification);
  const source = input.source === 'generated' ? 'generated' : 'uploaded';
  const res = await withWriterRole((client) => client.query(
    `UPDATE golden_set_entries SET retired_at = NOW(), retired_by = $4
      WHERE classification = $1 AND assistant = $2 AND upload_id = $3::uuid AND source = $5
        AND purpose = 'capability' AND retired_at IS NULL`,
    [classification, input.assistant, input.uploadId, input.retiredBy, source],
  ));
  return { retired: res.rowCount ?? 0 };
}


/** Of the pack's intents, the `limit` the set holds the fewest live entries for, in pack order among equals and as returned. */
async function leastCovered(classification: string, assistant: string, intents: GenerationIntent[], limit: number): Promise<GenerationIntent[]> {
  if (intents.length <= limit) return intents;
  const res = await withReaderRole(classification, (client) => client.query<{ intent: string; n: string }>(
    `SELECT COALESCE(intent, '') AS intent, COUNT(*)::text AS n FROM golden_set_entries
      WHERE retired_at IS NULL AND classification = $1 AND assistant = $2 GROUP BY 1`,
    [classification, assistant],
  ));
  const held = new Map(res.rows.map((r) => [r.intent, Number(r.n)]));
  return intents
    .map((intent, at) => ({ intent, at, n: held.get(intent.key) ?? 0 }))
    .sort((a, b) => a.n - b.n || a.at - b.at)
    .slice(0, limit)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.intent);
}


// ── A BATCH RUNS IN THE BACKGROUND, AND ITS ROW IS THE REPORT (ADR-065 decisions 7, 8) ─────────────────────────────────
//
// An upload or a generation is minutes of detector and model calls at most, longer than the request that starts it may
// wait, so `manage-profiles` answers at once and invokes this function as an Event. Its row is opened first, so a second
// start of the same batch while it runs does nothing, and it records how it ended. The Lambda service reports the
// invocation's end to EventBridge (the function's async destination), which tells the console's channel for this batch.

export type GoldenBatchKind = 'upload' | 'generation';
export type GoldenBatchStatus = 'running' | 'complete' | 'refused' | 'failed';

export interface GoldenBatch {
  batchId: string;
  kind: GoldenBatchKind;
  status: GoldenBatchStatus;
  /** How it ended: what was written, or the refusal's code and values. Null while it runs. */
  result: Record<string, unknown> | null;
  requestedBy: string;
  startedAt: string;
  completedAt: string | null;
}

export interface GoldenBatchQuery {
  op: 'batch';
  classification: string;
  assistant: string;
  batchId: string;
}

/** What the function answers for a batch, and what the async destination carries to the console's channel. */
export interface GoldenBatchOutcome {
  batchId: string;
  kind: GoldenBatchKind;
  status: GoldenBatchStatus;
}

/**
 * Open the batch's row, or take over one that ended or overran its deadline. False when the batch is running already, so a
 * second start is a no-op rather than a second batch.
 */
export async function claimBatch(classification: string, assistant: string, batchId: string, kind: GoldenBatchKind, by: string): Promise<boolean> {
  const res = await withWriterRole((client) => client.query(
    `INSERT INTO golden_batches (id, classification, assistant, kind, status, requested_by)
     VALUES ($1::uuid, $2, $3, $4, 'running', $5)
     ON CONFLICT (id) DO UPDATE SET status = 'running', result = NULL, requested_by = EXCLUDED.requested_by,
                                    started_at = NOW(), completed_at = NULL
      WHERE golden_batches.classification = EXCLUDED.classification AND golden_batches.assistant = EXCLUDED.assistant
        AND golden_batches.kind = EXCLUDED.kind
        AND (golden_batches.status <> 'running' OR golden_batches.started_at < NOW() - make_interval(secs => $6))
     RETURNING id`,
    [batchId, classification, assistant, kind, by, RUN_DEADLINE_MS / 1000],
  ));
  return (res.rowCount ?? 0) > 0;
}

async function finishBatch(batchId: string, status: Exclude<GoldenBatchStatus, 'running'>, result: Record<string, unknown>): Promise<void> {
  await withWriterRole((client) => client.query(
    `UPDATE golden_batches SET status = $2, result = $3, completed_at = NOW() WHERE id = $1::uuid`,
    [batchId, status, JSON.stringify(result)],
  ));
}

/**
 * Run one batch's work under its row: refused or complete by what the work answered, failed on a throw. Never throws, so
 * the async invocation succeeds and its destination reports the batch, not a Lambda error.
 */
export async function inBatch(
  classification: string,
  assistant: string,
  batchId: string,
  kind: GoldenBatchKind,
  by: string,
  work: () => Promise<Record<string, unknown>>,
): Promise<GoldenBatchOutcome> {
  if (!(await claimBatch(classification, assistant, batchId, kind, by))) return { batchId, kind, status: 'running' };
  try {
    const result = await work();
    const status = 'refused' in result ? 'refused' : 'complete';
    await finishBatch(batchId, status, result);
    return { batchId, kind, status };
  } catch (err) {
    console.error('[golden-run] the batch failed', batchId, detectorError(err));
    await finishBatch(batchId, 'failed', { error: detectorError(err).message }).catch(() => {});
    return { batchId, kind, status: 'failed' };
  }
}

/** One batch of this assistant's set, read as the classification's reader; one that overran its deadline reads failed. */
export async function readBatch(q: GoldenBatchQuery, now = Date.now()): Promise<GoldenBatch | null> {
  const classification = assertOwnClassification(q.classification);
  const res = await withReaderRole(classification, (client) => client.query(
    `SELECT id, kind, status, result, requested_by, started_at, completed_at FROM golden_batches
      WHERE id = $1::uuid AND classification = $2 AND assistant = $3`,
    [q.batchId, classification, q.assistant],
  ));
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  const started = Date.parse(iso(r.started_at) ?? '');
  const overdue = r.status === 'running' && Number.isFinite(started) && now - started > RUN_DEADLINE_MS;
  return {
    batchId: String(r.id),
    kind: r.kind as GoldenBatchKind,
    status: overdue ? 'failed' : r.status as GoldenBatchStatus,
    result: overdue ? { error: RUN_DEADLINE_ERROR } : (r.result as Record<string, unknown> | null) ?? null,
    requestedBy: String(r.requested_by),
    startedAt: iso(r.started_at) ?? '',
    completedAt: iso(r.completed_at),
  };
}
