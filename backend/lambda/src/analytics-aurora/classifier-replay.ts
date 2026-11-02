/**
 * The classification shadow gate's REPLAY JOB (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2).
 *
 * Both classifier candidates label the same archived messages, off the request path, so the question
 * "is the challenger's labelling better?" can be answered without routing a single real user through
 * a model nobody has measured yet.
 *
 * Runs in the data-plane Lambda because it is Aurora work AND Bedrock work in the VPC, which is the
 * seam that already exists for exactly that combination (ADR-013). It is a batch job by design: a
 * second classifier call on a live turn would spend user latency on an internal measurement.
 *
 * Three exclusions, all of them counted rather than silent, because a corpus you cannot describe is
 * not evidence:
 *  - **Retracted messages are never replayed.** A redaction or deletion means a participant asked for
 *    that text to stop being readable, and reprocessing it through two models is exactly the kind of
 *    quiet reuse the request was meant to prevent.
 *  - **Fast-path messages are excluded**, because no model is consulted for them (see `fastPathIntent`).
 *  - **Messages with no readable content** cannot be classified at all.
 *
 * ── ONE CLASSIFICATION PER RUN, ON THAT CLASSIFICATION'S OWN REACH (tenet D12, ADR-054 decision 5) ──
 *
 * A run names its classification and the assistant whose classifier it compares. It reads only that
 * classification's exchanges answered by that assistant, both candidates must be text models the
 * classification allows (`modelFits`), and it executes on the classification's own replay function
 * (`REPLAY_CLASSIFICATION`), whose role can invoke only that classification's models. A function refuses a
 * run of any other classification, so the payload cannot widen what it reaches. Both candidates classify
 * against the assistant's served intent pack, recorded on the run when it is opened, which is the
 * taxonomy a live turn of that assistant classifies against.
 */

import { query } from './db-client.js';
import { ARCHIVAL_SUFFIX_SQL } from './update-events.js';
import { classifyIntent, fastPathIntent } from '../lib/intent-classifier.js';
import type { IntentPack } from '../lib/intent-pack.js';
import { validateReplayInput, DEFAULT_LIMIT, MAX_LIMIT } from '../lib/classifier-replay-input.js';
import { getModelCatalog, bedrockInvokeId } from '../../../lib/config/model-strategy.js';
import { modelFits } from '../../../lib/config/model-availability.js';

/**
 * The classification this function serves, from its own environment. Read per call so a test can set it.
 * Empty means the function was deployed without one, and then it runs nothing.
 */
const ownClassification = (): string => (process.env.REPLAY_CLASSIFICATION || '').trim();

/** Refuse a run this function may not execute: a different classification, or none at all. */
function assertOwnClassification(classification: string | null | undefined): string {
  const own = ownClassification();
  if (!own) throw new Error('[classifier-replay] this function serves no classification (REPLAY_CLASSIFICATION is unset)');
  if (classification !== own) {
    throw new Error(`[classifier-replay] this function runs ${own} replays only; the run is for ${classification || 'no classification'}`);
  }
  return own;
}

/** How many messages to classify at once. Two model calls each, so this is 2x in flight. */
const REPLAY_CONCURRENCY = 4;

export interface StartReplayInput {
  incumbentModel: string;
  challengerModel: string;
  /** The classification the run is in; must be this function's own. */
  classification: string;
  /** The assistant whose classifier is compared. Absent ⇒ the classification's primary. */
  assistant?: string;
  /** That assistant's served intent pack, resolved by the starter (outside the VPC, where SSM is reachable). */
  intentPack: IntentPack;
  /**
   * The id to open the run UNDER, minted by the caller that already answered the operator's click.
   * Absent ⇒ the database mints one.
   */
  runId?: string;
  /** The experiment this gate informs. Optional: a replay is useful before anyone commits to a split. */
  experimentId?: string;
  windowDays?: number;
  limit?: number;
  startedBy?: string;
}

export interface ReplayRunSummary {
  runId: string;
  experimentId: string | null;
  incumbentModel: string;
  challengerModel: string;
  /** Null on a run opened before runs named one (migration 078). */
  classification: string | null;
  assistant: string | null;
  windowStart: string;
  windowEnd: string;
  messagesConsidered: number;
  messagesReplayed: number;
  messagesRetracted: number;
  messagesFastPath: number;
  status: 'running' | 'complete' | 'failed';
  error?: string | null;
  /** Echoed back by `openClassifierReplay` so the async execute uses the window the console was shown. */
  limit?: number;
}

interface CandidateRow {
  exchange_id: string;
  message_id: string;
  content: string | null;
  retracted: boolean;
}

/**
 * Select the messages to replay, with the retraction check done IN THE QUERY.
 *
 * The check mirrors the admin conversation read: retraction is a `-RED`/`-DEL` SIBLING ROW keyed off
 * the base Chime message id. Every redaction and deletion is a Chime SDK API call, so the event
 * stream carries all of them and archival writes that sibling row — which is why it, and not the
 * `moderation_actions` audit table, is the authority here. That table adds WHO acted, only for
 * moderations performed through the admin console, via a second call whose failure the console
 * deliberately swallows so bookkeeping can never fail a moderation.
 *
 * Retracted rows are returned FLAGGED rather than filtered out, so the run can report how many it
 * declined to replay instead of quietly shrinking.
 *
 * ONE CLASSIFICATION AND ONE ASSISTANT. Only exchanges that ran in the run's classification and were
 * answered by the assistant under test are read: the corpus is that assistant's traffic, and no other
 * classification's content reaches this function. Both are bound parameters, and the classification is the
 * function's own (`assertOwnClassification`), not a value the payload chose.
 */
async function selectCandidates(
  windowStart: string,
  windowEnd: string,
  limit: number,
  classification: string,
  assistant: string,
): Promise<CandidateRow[]> {
  const res = await query<CandidateRow>(
    `SELECT e.id AS exchange_id,
            mu.message_id,
            COALESCE(mu.updated_content, mu.content) AS content,
            EXISTS (
              SELECT 1 FROM messages x
               WHERE x.channel_arn = mu.channel_arn
                 AND x.event_type IN ('REDACT_CHANNEL_MESSAGE','DELETE_CHANNEL_MESSAGE')
                 AND x.message_id IN (
                       regexp_replace(mu.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-RED',
                       regexp_replace(mu.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-DEL')
            ) AS retracted
       FROM exchanges e
       JOIN messages mu ON e.user_message_id = mu.id
      WHERE e.created_at >= $1::timestamptz
        AND e.created_at < $2::timestamptz
        AND e.conversation_classification = $4
        AND e.assistant = $5
      ORDER BY e.created_at DESC
      LIMIT $3`,
    [windowStart, windowEnd, limit, classification, assistant],
  );
  return res.rows || [];
}

/** Run `worker` over `items` with a bounded number in flight. */
async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Open a replay run and return its id, WITHOUT doing the work.
 *
 * The split exists because of a hard boundary: a 200-message replay is 400 model calls, minutes of
 * work, and API Gateway gives a request 29 seconds. A console that started the job synchronously
 * would time out every time and leave a `running` row nobody could account for. So the run is opened
 * (one INSERT) and the body runs asynchronously against that id — which also means the operator has
 * something to poll from the moment they click.
 *
 * **The id comes from the CALLER**, and that is load-bearing. This INSERT can only be issued from
 * inside the VPC (the database is there), while the click has to be answered from outside it (the
 * Lambda control plane is not reachable from the isolated subnets, so an in-VPC function cannot
 * invoke this job at all — that is the defect this shape fixes). The starter therefore mints the id,
 * hands it straight back, and this row appears a moment later under that same id. Without a
 * caller-supplied id there is nothing to return from a fire-and-forget invocation.
 */
export async function openClassifierReplay(input: StartReplayInput): Promise<ReplayRunSummary> {
  const { incumbentModel, challengerModel, classification, assistant, windowStart, windowEnd, limit } = validateReplayInput(input);
  // Opened only by the function of the run's own classification, so a run can never be recorded under
  // one classification and executed with another's reach.
  assertOwnClassification(classification);
  if (!input.intentPack || !Array.isArray(input.intentPack.intents) || input.intentPack.intents.length === 0) {
    // The deployment pack would classify against a taxonomy the assistant does not serve, and the
    // concordance would read as clean while measuring a task neither model performs in production.
    throw new Error('[classifier-replay] no intent pack: a run classifies against the assistant\'s served pack');
  }

  // `COALESCE($7::uuid, uuid_generate_v4())` rather than two statements: a caller-supplied id is used
  // as given, and the database still mints one when nobody supplied it (matching the column's own
  // default). `ON CONFLICT DO NOTHING` makes a redelivered async invocation idempotent instead of a
  // duplicate-key crash that would record a perfectly good run as failed.
  const runRes = await query<{ id: string }>(
    `INSERT INTO classifier_replay_runs
       (id, experiment_id, incumbent_model, challenger_model, window_start, window_end, started_by, status,
        classification, assistant, intent_pack)
     VALUES (COALESCE($7::uuid, uuid_generate_v4()), $1, $2, $3, $4::timestamptz, $5::timestamptz, $6, 'running',
             $8, $9, $10::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      input.experimentId || null,
      incumbentModel,
      challengerModel,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      input.startedBy || null,
      input.runId || null,
      classification,
      assistant,
      JSON.stringify(input.intentPack),
    ],
  );
  // No RETURNING row means the id was already there (a redelivery). The run exists, which is what
  // the caller needs to be true; treat it as opened rather than inventing a failure.
  const runId = runRes.rows[0]?.id || input.runId;
  if (!runId) throw new Error('[classifier-replay] failed to open a replay run');

  return {
    runId,
    experimentId: input.experimentId || null,
    incumbentModel,
    challengerModel,
    classification,
    assistant,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    messagesConsidered: 0,
    messagesReplayed: 0,
    messagesRetracted: 0,
    messagesFastPath: 0,
    status: 'running',
    limit,
  };
}

/**
 * Do the work for an already-open run: replay its window through both classifiers and close it.
 *
 * Reads the run's OWN stored window, models, classification, assistant and pack rather than taking them
 * again from the caller, so an async invocation cannot replay a different window, or another
 * classification's traffic, from the one the console recorded and showed.
 *
 * REFUSES a run of another classification, and a run that names none (one opened before runs did): the
 * function cannot reach another classification's models, and guessing a classification for an old run
 * would replay a corpus nobody asked for.
 */
export async function executeClassifierReplay(runId: string, limit = DEFAULT_LIMIT): Promise<ReplayRunSummary> {
  const res = await query<any>(
    `SELECT id, experiment_id, incumbent_model, challenger_model, window_start, window_end,
            classification, assistant, intent_pack
       FROM classifier_replay_runs WHERE id = $1`,
    [runId],
  );
  const r = (res.rows || [])[0];
  if (!r) throw new Error(`[classifier-replay] no such run: ${runId}`);
  const classification = assertOwnClassification(r.classification ?? null);
  const intentPack = (typeof r.intent_pack === 'string' ? JSON.parse(r.intent_pack) : r.intent_pack) as IntentPack | null;
  return runReplayBody({
    runId: String(r.id),
    experimentId: r.experiment_id ?? null,
    incumbentModel: String(r.incumbent_model),
    challengerModel: String(r.challenger_model),
    classification,
    assistant: String(r.assistant ?? ''),
    intentPack,
    windowStart: new Date(r.window_start),
    windowEnd: new Date(r.window_end),
    limit: Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT),
  });
}

/**
 * Replay a window of archived messages through both candidate classifiers, start to finish.
 *
 * Idempotent per message: re-running the same window into the same run updates the pair rather than
 * duplicating it, so a partial run can be resumed without double-counting the evidence.
 */
export async function startClassifierReplay(input: StartReplayInput): Promise<ReplayRunSummary> {
  const opened = await openClassifierReplay(input);
  return runReplayBody({
    runId: opened.runId,
    experimentId: opened.experimentId,
    incumbentModel: opened.incumbentModel,
    challengerModel: opened.challengerModel,
    classification: String(opened.classification),
    assistant: String(opened.assistant),
    intentPack: input.intentPack,
    windowStart: new Date(opened.windowStart),
    windowEnd: new Date(opened.windowEnd),
    limit: opened.limit ?? DEFAULT_LIMIT,
  });
}

/** The replay itself, against an already-open run. */
async function runReplayBody(ctx: {
  runId: string;
  experimentId: string | null;
  incumbentModel: string;
  challengerModel: string;
  classification: string;
  assistant: string;
  intentPack: IntentPack | null;
  windowStart: Date;
  windowEnd: Date;
  limit: number;
}): Promise<ReplayRunSummary> {
  const { runId, incumbentModel, challengerModel, classification, assistant, intentPack, windowStart, windowEnd, limit } = ctx;
  const base: ReplayRunSummary = {
    runId,
    experimentId: ctx.experimentId,
    incumbentModel,
    challengerModel,
    classification,
    assistant,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    messagesConsidered: 0,
    messagesReplayed: 0,
    messagesRetracted: 0,
    messagesFastPath: 0,
    status: 'running',
  };

  try {
    // CHECKED AGAIN AT EXECUTION, not only when the run was opened: the catalog's allowed classifications
    // can change between the two, and the role is granted only what the classification allows today.
    for (const key of [incumbentModel, challengerModel]) {
      const misfit = modelFits(key, classification, 'text');
      if (misfit) throw new Error(`[classifier-replay] ${misfit}`);
    }
    if (!assistant) throw new Error('[classifier-replay] the run names no assistant');
    if (!intentPack || !Array.isArray(intentPack.intents) || intentPack.intents.length === 0) {
      throw new Error('[classifier-replay] the run recorded no intent pack, so there is no taxonomy to classify against');
    }
    const candidates = await selectCandidates(windowStart.toISOString(), windowEnd.toISOString(), limit, classification, assistant);
    const considered = candidates.length;
    const retracted = candidates.filter((c) => c.retracted).length;

    const replayable = candidates.filter((c) => !c.retracted && (c.content ?? '').trim().length > 0);
    const fastPath = replayable.filter((c) => fastPathIntent(String(c.content)) !== null).length;
    const toClassify = replayable.filter((c) => fastPathIntent(String(c.content)) === null);

    // KEY → BEDROCK ID, here and not at the write. `incumbentModel`/`challengerModel` are catalog KEYS
    // (validated by `validateReplayInput`), because that is the vocabulary profiles and experiment
    // variants use and the only one the console can compare against. `classifyIntent` passes `modelId`
    // straight to `ConverseCommand`, so the key has to become an id somewhere - and it is HERE, where the
    // deployment's own region and account are known, rather than being frozen into a stored row that then
    // cannot travel between instances (SPEC-PORTABLE §5, the same reason a profile version stores a key).
    const catalog = getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '');
    const invokeIdFor = (key: string): string => {
      const def = catalog[key as keyof typeof catalog];
      if (!def) {
        // Unreachable via the validator, but a run that silently classified with the DEPLOYMENT DEFAULT
        // would produce a concordance figure attributed to two models neither of which ran. Refuse.
        throw new Error(`[classifier-replay] '${key}' is not in the model catalog; cannot resolve a model id`);
      }
      return bedrockInvokeId(def);
    };
    const incumbentModelId = invokeIdFor(incumbentModel);
    const challengerModelId = invokeIdFor(challengerModel);

    await mapLimited(toClassify, REPLAY_CONCURRENCY, async (row) => {
      const content = String(row.content);
      // Both candidates see the SAME message. That pairing is the whole point: it removes
      // between-sample variance, which is why this design needs far less traffic than a split.
      // AND THE SAME TAXONOMY, the assistant's served pack, which is what a live turn of that assistant
      // classifies against. A classification candidate differs from its control only in
      // `models.classifier`, so the pack is the same for both by the experiment's recipe.
      const [incumbent, challenger] = await Promise.all([
        classifyIntent(content, { modelId: incumbentModelId, pack: intentPack }),
        classifyIntent(content, { modelId: challengerModelId, pack: intentPack }),
      ]);
      await query(
        `INSERT INTO classifier_replay_labels
           (run_id, exchange_id, message_id, incumbent_label, challenger_label, concordant)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_id, exchange_id) DO UPDATE
           SET incumbent_label = EXCLUDED.incumbent_label,
               challenger_label = EXCLUDED.challenger_label,
               concordant = EXCLUDED.concordant`,
        [runId, row.exchange_id, row.message_id, incumbent.intent, challenger.intent,
          incumbent.intent === challenger.intent],
      );
    });

    await query(
      `UPDATE classifier_replay_runs
          SET messages_considered = $2, messages_replayed = $3, messages_retracted = $4,
              messages_fast_path = $5, status = 'complete', completed_at = NOW()
        WHERE id = $1`,
      [runId, considered, toClassify.length, retracted, fastPath],
    );

    return {
      ...base,
      messagesConsidered: considered,
      messagesReplayed: toClassify.length,
      messagesRetracted: retracted,
      messagesFastPath: fastPath,
      status: 'complete',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed run is RECORDED, not deleted. Its partial labels stay readable, and the gate refuses
    // to conclude from a run that did not finish rather than treating a truncated corpus as the set.
    await query(
      `UPDATE classifier_replay_runs SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [runId, message.slice(0, 2000)],
    ).catch(() => undefined);
    console.error('[classifier-replay] run failed:', message);
    return { ...base, status: 'failed', error: message };
  }
}

export interface ReplayLabelRow {
  id: string;
  exchangeId: string;
  messageId: string | null;
  incumbentLabel: string;
  challengerLabel: string;
  trueLabel: string | null;
  proposedLabel: string | null;
  adjudicatedBy: string | null;
  adjudicatedAt: string | null;
}

/** Read a run's labels. `pendingOnly` serves the adjudication queue: discordant and not yet ruled on. */
export async function listReplayLabels(
  runId: string,
  opts: { pendingOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<{ rows: ReplayLabelRow[]; total: number }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  // The queue is discordant AND unadjudicated. Concordant pairs are deliberately unreachable here:
  // they carry no comparative signal, and putting them in front of a human is the cost this design
  // exists to avoid.
  const where = opts.pendingOnly
    ? 'WHERE run_id = $1 AND concordant = FALSE AND adjudicated_at IS NULL'
    : 'WHERE run_id = $1';
  const res = await query<any>(
    `SELECT id, exchange_id, message_id, incumbent_label, challenger_label,
            true_label, proposed_label, adjudicated_by, adjudicated_at,
            COUNT(*) OVER() AS total_count
       FROM classifier_replay_labels
       ${where}
      ORDER BY created_at ASC
      LIMIT $2 OFFSET $3`,
    [runId, limit, offset],
  );
  const rows = res.rows || [];
  return {
    rows: rows.map((r: any) => ({
      id: String(r.id),
      exchangeId: String(r.exchange_id),
      messageId: r.message_id ?? null,
      incumbentLabel: String(r.incumbent_label),
      challengerLabel: String(r.challenger_label),
      trueLabel: r.true_label ?? null,
      proposedLabel: r.proposed_label ?? null,
      adjudicatedBy: r.adjudicated_by ?? null,
      adjudicatedAt: r.adjudicated_at ?? null,
    })),
    total: rows.length ? Number(rows[0].total_count) || rows.length : 0,
  };
}

export interface AdjudicateInput {
  labelId: string;
  /** The correct intent. May match neither prediction: both models can be wrong. */
  trueLabel: string;
  adjudicatedBy: string;
  note?: string;
}

/**
 * Record a human's ruling on one discordant pair.
 *
 * The human is the arbiter of record (INV-4). A model may PROPOSE a label to speed the queue, and
 * that proposal lives in its own column: this write is the only thing that sets `true_label`, so a
 * proposal cannot become the answer by being displayed next to one.
 *
 * A CONCORDANT pair cannot be adjudicated at all. It carries no comparative signal whatever the
 * truth, so a ruling on one would be labeling effort that changes no number, and accepting it would
 * imply the queue was incomplete.
 */
export async function adjudicateReplayLabel(input: AdjudicateInput): Promise<{ updated: boolean }> {
  const trueLabel = (input.trueLabel || '').trim();
  const adjudicatedBy = (input.adjudicatedBy || '').trim();
  if (!input.labelId || !trueLabel || !adjudicatedBy) {
    throw new Error('[classifier-replay] labelId, trueLabel and adjudicatedBy are required');
  }
  const res = await query(
    `UPDATE classifier_replay_labels
        SET true_label = $2, adjudicated_by = $3, adjudicated_at = NOW(), adjudication_note = $4
      WHERE id = $1 AND concordant = FALSE`,
    [input.labelId, trueLabel, adjudicatedBy, input.note || null],
  );
  return { updated: (res.rowCount ?? 0) > 0 };
}

/** A run plus every label it holds, the shape `evaluateClassifierGate` consumes. */
export async function getReplayRun(runId: string): Promise<{
  run: ReplayRunSummary | null;
  labels: Array<{ incumbentLabel: string; challengerLabel: string; trueLabel: string | null; conversationId: string | null }>;
}> {
  const runRes = await query<any>(
    `SELECT id, experiment_id, incumbent_model, challenger_model, window_start, window_end,
            messages_considered, messages_replayed, messages_retracted, messages_fast_path, classification, assistant,
            status, error
       FROM classifier_replay_runs WHERE id = $1`,
    [runId],
  );
  const r = (runRes.rows || [])[0];
  if (!r) return { run: null, labels: [] };

  // The conversation rides along so the gate clusters McNemar's interval by conversation: two messages
  // of one conversation are one person on one topic, not two independent labels.
  const labelRes = await query<any>(
    `SELECT l.incumbent_label, l.challenger_label, l.true_label, e.channel_arn
       FROM classifier_replay_labels l
       LEFT JOIN exchanges e ON e.id = l.exchange_id
      WHERE l.run_id = $1`,
    [runId],
  );
  return {
    run: {
      runId: String(r.id),
      experimentId: r.experiment_id ?? null,
      incumbentModel: String(r.incumbent_model),
      challengerModel: String(r.challenger_model),
      classification: r.classification ?? null,
      assistant: r.assistant ?? null,
      windowStart: String(r.window_start),
      windowEnd: String(r.window_end),
      messagesConsidered: Number(r.messages_considered) || 0,
      messagesReplayed: Number(r.messages_replayed) || 0,
      messagesRetracted: Number(r.messages_retracted) || 0,
      messagesFastPath: Number(r.messages_fast_path) || 0,
      status: r.status,
      error: r.error ?? null,
    },
    labels: (labelRes.rows || []).map((l: any) => ({
      incumbentLabel: String(l.incumbent_label),
      challengerLabel: String(l.challenger_label),
      trueLabel: l.true_label ?? null,
      conversationId: l.channel_arn ?? null,
    })),
  };
}

/** Replay runs, newest first, optionally for one experiment. */
export async function listReplayRuns(experimentId?: string): Promise<ReplayRunSummary[]> {
  const res = await query<any>(
    `SELECT id, experiment_id, incumbent_model, challenger_model, window_start, window_end,
            messages_considered, messages_replayed, messages_retracted, messages_fast_path, classification, assistant,
            status, error
       FROM classifier_replay_runs
       ${experimentId ? 'WHERE experiment_id = $1' : ''}
      ORDER BY started_at DESC
      LIMIT 50`,
    experimentId ? [experimentId] : [],
  );
  return (res.rows || []).map((r: any) => ({
    runId: String(r.id),
    experimentId: r.experiment_id ?? null,
    incumbentModel: String(r.incumbent_model),
    challengerModel: String(r.challenger_model),
    classification: r.classification ?? null,
    assistant: r.assistant ?? null,
    windowStart: String(r.window_start),
    windowEnd: String(r.window_end),
    messagesConsidered: Number(r.messages_considered) || 0,
    messagesReplayed: Number(r.messages_replayed) || 0,
    messagesRetracted: Number(r.messages_retracted) || 0,
    messagesFastPath: Number(r.messages_fast_path) || 0,
    status: r.status,
    error: r.error ?? null,
  }));
}
