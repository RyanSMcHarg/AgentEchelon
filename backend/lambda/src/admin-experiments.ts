/**
 * Experiments Admin API
 *
 * The write/read API behind the admin dashboard's Experiments tab and
 * `/battle` arming. The frontend (`frontend/src/services/
 * experimentService.ts`) derives this from the admin-conversations API
 * URL (`/admin/conversations` → `/admin/experiments`) and calls:
 *
 *   GET    /admin/experiments                        → { experiments: [...] }
 *   GET    /admin/experiments/challengers             → { challengers: [{ assistant, classification, role, inUseBy }] }
 *   POST   /admin/experiments             (Experiment) → the stored Experiment
 *   POST   /admin/experiments/{id}/status  { status,   → { ok, status, freedClassification? }
 *                                            decision? }
 *   DELETE /admin/experiments/{id}                    → { ok, mode, freedClassification }
 *
 * Lifecycle (DESIGN-EXPERIMENTS-BATTLE §3.2 / A.3, all additive): edits to a live
 * experiment that has collected data lock the variant models/count (L1, 409) and never
 * clobber `createdAt`; the status route enforces the transition state machine
 * (`completed`/`deleted` terminal — L2, 409), 404s a missing id (L6), records the
 * operator's `decision` on completing a run test (§3.2.1), and appends to the
 * append-only `transitions` audit on every change (L7). Activating an experiment whose
 * `endDate` has passed is refused (409 `EXPERIMENT_WINDOW_ENDED`) instead of reported as a
 * resume that resolves no traffic. DELETE hard-removes a never-started draft, else writes a
 * soft-delete tombstone (L8); both free the classification and release the challenger it named.
 *
 * Every write is a read-modify-write of one row, pinned to the row it was decided from
 * (`optimisticGuard`), so overlapping admin actions cannot drop each other's audit entries or
 * status label: the loser gets 409 `EXPERIMENT_CONCURRENT_MODIFICATION` and re-reads.
 *
 * Authorization: Cognito-authenticated (API Gateway Cognito authorizer
 * enforces the JWT; we additionally require a caller sub). `boundBy` is
 * **server-authoritative** — set from the caller, never trusted from the
 * client (audit attribution for who armed a battle experiment).
 *
 * Battle-arming responsibility: a battleEnabled experiment names its challenger by assistant id
 * (`challengerAssistant`, `alt-{role}-{classification}`). Arming checks that the classification's
 * assignment record provisions that alt (`lib/alt-assignment.ts`); the alt's bot ARN is read from the
 * record by whoever needs it and is never stored on the row.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  validateAndSanitizeExperiment,
  findClassificationConflicts,
  ExperimentValidationError,
  MAX_ACTIVE_EXPERIMENTS,
  isAllowedTransition,
  EXPERIMENT_STATUSES,
  appendTransition,
  sanitizeObjectiveStatement,
  battleSidesOf,
  type Experiment,
  type ExperimentVariant,
  type ExperimentDecision,
} from './lib/experiment-manager.js';
import { parseJsonBody, callerIsAdmin, callerCanManageProfiles, callerPersonId } from './lib/auth.js';
import { modelCatalogKeys } from '../../lib/config/model-strategy.js';
import { defaultProfileRegistry as profilesRegistry } from '../../lib/profile-registry';
import { isBattleOn, __clearBattleEnablementCache } from './lib/battle-enablement.js';
import { requireOwnedAssistant, isRefusal } from './lib/assistant-scope.js';
import { experimentBelongsTo } from './lib/experiment-ownership.js';
import { readAltAssignment, DUEL_ROLE, challengerOf, type AltAssignment, type LegacyBattleBinding } from './lib/alt-assignment.js';
import { userArnFor } from './lib/person-arn.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

// removeUndefinedValues: validateAndSanitizeExperiment leaves optional
// fields undefined (a blank systemPromptAddendum, imageGenModelKey on a
// text battle, etc.). Without this the marshaller throws on every
// UI-created experiment and the handler returns a bare 500 "Internal
// error" — the failure the post-2 demo driver hit at "Create & Activate".
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssmClient = new SSMClient({});
const lambdaClient = new LambdaClient({});
/** The profile writer this handler asks to pin an experiment's two versions, to promote its candidate, and to name the alt as its duel side while a battle holds it. */
const MANAGE_PROFILES_FUNCTION = process.env.MANAGE_PROFILES_FUNCTION_NAME || '';

const EXPERIMENTS_TABLE = process.env.EXPERIMENTS_TABLE || '';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
/** The SSM prefix the assignment records and the alt's versions live under, as the stack sets it. */
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);

// Statuses a caller may REQUEST via POST /{id}/status (End/Pause/Resume/Activate).
// `draft` is a create-time state and `deleted` goes through DELETE, so neither is
// requestable here. The from→to legality is enforced separately by isAllowedTransition.
const VALID_STATUS = ['active', 'paused', 'completed'] as const;

// The operator's recorded outcome when completing a test that RAN (DESIGN §3.2.1).
// `no_decision` is always available and the default, so an inconclusive test closes
// honestly (INV-1/INV-3) — the API never forces a winner.
const DECISION_OUTCOMES = ['promoted_treatment', 'kept_control', 'no_decision'] as const;

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,DELETE,OPTIONS' });

const respond = http.respond;

/**
 * Server-authoritative actor ARN for audit attribution (transitions, decision,
 * boundBy). Same shape used for `boundBy` — the app-instance user ARN when the
 * instance is known, else the bare sub. Never trusted from the client.
 */
function callerArn(callerSub: string): string {
  return APP_INSTANCE_ARN ? userArnFor(APP_INSTANCE_ARN, callerSub) : callerSub;
}

/** Fetch a stored experiment by id (null when absent). Used to drive update/edit
 *  semantics (preserve createdAt, guard live edits), the lifecycle transition guard,
 *  and Delete's hard-vs-soft decision. */
async function getExistingExperiment(experimentId: string): Promise<Experiment | null> {
  const res = (await ddb.send(
    // Strongly consistent: a lifecycle write right after a create (the console pauses, ends or completes what
    // it just made) must find the row, and an eventually consistent read can answer 404 for it.
    new GetCommand({ TableName: EXPERIMENTS_TABLE, Key: { experimentId }, ConsistentRead: true }),
  )) as { Item?: Experiment } | undefined;
  return res?.Item ?? null;
}

/**
 * L5 auto-complete (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.2). A past-`endDate` `active` experiment
 * already stops resolving traffic (`isLiveForClassification` gates on `endDate`), but its status LABEL
 * stays `active` and no audit records the expiry. Reconcile lazily on the admin list read: flip each
 * expired-active row to `completed` with an `auto:endDate` transition. Idempotent (conditioned on the row
 * still being `active`, so a concurrent manual transition wins) and best-effort - a write failure never
 * fails the read, and the row is reflected as completed in the response regardless (endDate is
 * authoritative). Lazy (no sweeper) per the spec's "lean lazy unless timeliness matters".
 */
async function reconcileExpiredExperiments(experiments: Experiment[]): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  await Promise.all(
    experiments.map(async (exp) => {
      // PAUSED EXPIRES TOO, and it did not.
      //
      // This read `active` only, so an experiment paused before its end date passed kept the label
      // `paused` for ever - suggesting something a person could Resume, when the window it would
      // resume into has closed. The runtime already agreed it was over: isLiveForClassification
      // stops resolving on `endDate > now` regardless of status, so only the LABEL was behind.
      const expiring = exp.status === 'active' || exp.status === 'paused';
      if (!expiring || !exp.endDate || new Date(exp.endDate) > now) return;
      const transitions = appendTransition(exp.transitions, {
        // The status actually read, so the audit says which state it expired OUT OF.
        from: exp.status,
        to: 'completed',
        by: 'system',
        at: nowIso,
        reason: 'auto:endDate',
      });
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: EXPERIMENTS_TABLE,
            Key: { experimentId: exp.experimentId },
            UpdateExpression: 'SET #s = :s, #t = :t',
            // Still in the state this reconcile READ, AND the audit is the one it read: `transitions`
            // is written back whole, so without the length check an edit or status change appended between
            // the Scan and this write is erased by it. A failed condition is already the benign path
            // (the row is presented as completed either way, and the next read reconciles it).
            ConditionExpression:
              '#s = :from AND (attribute_not_exists(#t) OR size(#t) = :expectedTransitions)',
            ExpressionAttributeNames: { '#s': 'status', '#t': 'transitions' },
            ExpressionAttributeValues: {
              ':s': 'completed',
              ':t': transitions,
              ':from': exp.status,
              ':expectedTransitions': (exp.transitions ?? []).length,
            },
          }),
        );
        exp.transitions = transitions;
      } catch (err) {
        // ConditionalCheckFailed = already transitioned by someone else; anything else is transient.
        // Either way the endDate is authoritative, so still present it as completed in this response.
        if (!isConditionalCheckFailed(err)) {
          console.warn('[admin-experiments] L5 auto-complete write failed (non-fatal):', (err as Error)?.name);
        }
      }
      exp.status = 'completed';

      // THE FOURTH EXIT, and the one with no operator behind it. The state machine has four ways out
      // of `active` - End, Pause, Delete and this one - and an alt released on only the first
      // three is an alt that outlives its experiment whenever the experiment simply ran out of time,
      // which is the ordinary way a test ends rather than an edge case.
      //
      // Unconditional on the write above succeeding: the endDate is authoritative either way (this
      // function presents the row as completed regardless), so the projection follows the fact rather
      // than the write that recorded it. A losing race re-vacates an already-vacant alt, which is a
      // no-op.
      await setAltAssignment({
        exp,
        experimentId: exp.experimentId,
        occupied: false,
      });
    }),
  );
}

/** True when a DynamoDB write's ConditionExpression failed: the row vanished between read and
 *  write, never existed, or another writer moved it. Lets the guarded writes answer 404 or 409
 *  (`respondToLostRace`) instead of a bare 500 (L6). */
function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

/**
 * OPTIMISTIC CONCURRENCY for a read-modify-write of an experiment row.
 *
 * Every lifecycle write here is a read-modify-write: `getExistingExperiment` reads the row, the
 * handler appends one entry to the append-only `transitions` audit (L7), and writes the WHOLE array
 * back. `attribute_exists(experimentId)` only asserts the row still exists, so two overlapping admin
 * actions both read N entries, both append their own, and the second write lands N+1 entries with
 * the first action's entry gone: the audit loses a status change while both callers are told 200.
 * The status label loses the same race, because an edit that omits `status` writes back the value it
 * read and walks a concurrently paused experiment back into live traffic.
 *
 * The guard pins the write to the row it was decided from - the status being replaced (the idiom
 * `advanceTaskStateTo` uses in `lib/task-tracking.ts`) plus the audit length, which also catches a
 * concurrent writer that appends WITHOUT changing status. A losing writer fails loudly and re-reads
 * (see `respondToLostRace`); it never silently clobbers.
 */
function optimisticGuard(existing: Experiment): {
  ConditionExpression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  // A legacy row predating the status field carries no `status` attribute at all (INV-2 reads that
  // as active). Pin such a row by the attribute's ABSENCE: comparing against a value the row does
  // not carry would refuse every write to it.
  const statusGuard = existing.status ? '#s = :expectedStatus' : 'attribute_not_exists(#s)';
  return {
    ConditionExpression:
      `attribute_exists(experimentId) AND ${statusGuard}`
      + ' AND (attribute_not_exists(#t) OR size(#t) = :expectedTransitions)',
    names: { '#s': 'status', '#t': 'transitions' },
    values: {
      ...(existing.status ? { ':expectedStatus': existing.status } : {}),
      ':expectedTransitions': (existing.transitions ?? []).length,
    },
  };
}

/**
 * Answer a failed `optimisticGuard` honestly. The condition covers two different situations that
 * need different answers, so re-read the row rather than reporting one as the other: absent means it
 * was deleted (404), present means it moved under this request (409). Either way nothing was
 * written, and the 409 names the status the row actually holds so the console can re-read and decide
 * again instead of retrying a decision made from a stale row.
 */
async function respondToLostRace(args: {
  experimentId: string;
  from: Experiment['status'];
  to: Experiment['status'];
  action: string;
  origin?: string;
}): Promise<APIGatewayProxyResult> {
  const { experimentId, from, to, action, origin } = args;
  const current = await getExistingExperiment(experimentId);
  if (!current) {
    return respond(404, { error: `Experiment "${experimentId}" not found` }, origin);
  }
  console.warn('[admin-experiments] write lost a race; not applied', {
    experimentId,
    action,
    from,
    to,
    current: current.status,
  });
  return respond(409, {
    error:
      `Experiment "${experimentId}" changed while this ${action} was in flight (it is now `
      + `'${current.status}'). Nothing was written - reload the experiment and retry.`,
    code: 'EXPERIMENT_CONCURRENT_MODIFICATION',
    from,
    to,
    currentStatus: current.status,
  }, origin);
}

/**
 * Whether an experiment has accrued traffic on any variant (DESIGN §3.2 L1 / §7).
 *
 * CURRENTLY ALWAYS FALSE, by construction: `exchange_count` is an ANALYTICS QUERY ALIAS computed at
 * read time and never persisted onto the stored variant, so the field this inspects is never present
 * on a record read back from DynamoDB. The only caller ANDs it with `status === 'draft'`, so the
 * hard-vs-soft delete choice is decided by status alone - which is the fail-safe answer anyway and
 * matches the same reasoning on the POST path: any non-draft experiment is treated as data-bearing.
 *
 * Kept rather than deleted because it is the correct shape if exchange counts are ever denormalized
 * onto the row, and because removing it would make `neverStarted` read as though status were the
 * DESIGNED signal rather than the fail-safe fallback. Do not treat a `false` from this as evidence
 * that an experiment has no traffic.
 */
function hasAccruedTraffic(exp: Experiment | null | undefined): boolean {
  if (!exp) return false;
  return (exp.variants || []).some((v) => {
    const t = v as unknown as { exchange_count?: number; exchangeCount?: number };
    const n =
      typeof t.exchange_count === 'number'
        ? t.exchange_count
        : typeof t.exchangeCount === 'number'
          ? t.exchangeCount
          : 0;
    return n > 0;
  });
}

/** A variant's tested configuration EXCLUDING weight — everything that is immutable
 *  once traffic accrues (DESIGN §3.2: "variant models and count are immutable; only
 *  weight, endDate, and objective may change"). Compared to detect a locked edit. */
function variantIdentity(v: ExperimentVariant): string {
  return JSON.stringify({
    variantId: v.variantId ?? null,
    modelKey: v.modelKey ?? null,
    profileRef: v.profileRef ?? null,
    imageGenModelKey: v.imageGenModelKey ?? null,
    systemPromptAddendum: v.systemPromptAddendum ?? null,
  });
}

/** True when the incoming variant set changes the models or the variant count vs the
 *  stored record — i.e. anything but per-variant weight (DESIGN §3.2 L1 / §7). Compare
 *  AFTER sanitizing the incoming variants so addendum normalization matches. */
function variantModelOrCountChanged(
  incoming: ExperimentVariant[],
  existing: ExperimentVariant[],
): boolean {
  if (incoming.length !== existing.length) return true;
  const byId = new Map(existing.map((v) => [v.variantId, v]));
  for (const v of incoming) {
    const prev = byId.get(v.variantId);
    if (!prev) return true; // variant renamed/replaced ⇒ the set changed
    if (variantIdentity(v) !== variantIdentity(prev)) return true;
  }
  return false;
}

/**
 * True when an edit changes WHAT THE EXPERIMENT COMPARES: its variant models and count
 * (`variantModelOrCountChanged`), or anything else the pinned versions were derived from (§3.5): the
 * experiment type and intent (which recipe derives the candidate from the variants) and the classification
 * (whose live assistant the control pins). An armed row's pins describe exactly these, so an edit that
 * keeps the pins must keep these too.
 */
function comparisonChanged(incoming: Experiment, existing: Experiment): boolean {
  const tiersOf = (e: Experiment) => JSON.stringify([...(e.tiers ?? [])].map(String).sort());
  return variantModelOrCountChanged(incoming.variants || [], existing.variants || [])
    || (incoming.experimentType ?? 'intent') !== (existing.experimentType ?? 'intent')
    || (incoming.intent ?? '') !== (existing.intent ?? '')
    || tiersOf(incoming) !== tiersOf(existing);
}

/** The 409 message when a classification already holds a live experiment. The code stays
 *  `EXPERIMENT_TYPE_CONFLICT` because the console and API clients key on it. */
const CLASSIFICATION_OCCUPIED =
  'A classification runs one experiment at a time, and this one already has a live experiment. '
  + 'Complete, pause, or delete the conflicting experiment(s) first.';

/** Shape the classification conflicts for the 409 body the console drives the
 *  End/Pause/Delete resolution from (DESIGN §3.2.1 / A.7). */
function conflictBody(conflicts: Experiment[]): Array<{
  experimentId: string;
  experimentType: string;
  tiers: string[];
}> {
  return conflicts.map((e) => ({
    experimentId: e.experimentId,
    experimentType: e.experimentType ?? 'intent',
    tiers: e.tiers ?? [],
  }));
}

/**
 * Count active experiments via a Scan with a FilterExpression so we never pull
 * the full table into memory.
 * `excludeId` skips the row being upserted so an idempotent re-write
 * doesn't double-count itself. Reads small table (admin path, infrequent
 * call), so the cost is bounded. Total table size — including paused
 * and completed rows — is unbounded, but the active count is what the
 * cap targets and the runtime resolver cares about.
 */
async function countActiveExperimentsExcluding(excludeId: string): Promise<number> {
  if (!EXPERIMENTS_TABLE) return 0;
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const raw = await ddb.send(
      new ScanCommand({
        TableName: EXPERIMENTS_TABLE,
        FilterExpression: '#s = :active',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':active': 'active' },
        ProjectionExpression: 'experimentId',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    // Defensive null guard — `ddb.send` is typed to always return a
    // response object, but unit tests may stub it with undefined; treat
    // that as "no rows" rather than throwing.
    const result = (raw ?? {}) as {
      Items?: Array<{ experimentId?: string }>;
      LastEvaluatedKey?: Record<string, unknown>;
    };
    for (const item of result.Items ?? []) {
      if (item.experimentId !== excludeId) count++;
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return count;
}

/**
 * THE ALT A BATTLE EXPERIMENT NAMES: the challenger of its one classification's primary role, from the
 * record that classification's stack writes (§3.7). A battle runs in exactly one classification (the
 * validator refuses any other), and the row names the alt by assistant id (`challengerOf`). Null for a
 * row that names no challenger, or when the classification provisions none. A record that cannot be read
 * throws.
 */
async function altOf(exp: { challengerAssistant?: string; tiers?: unknown } & LegacyBattleBinding): Promise<AltAssignment | null> {
  if (!challengerOf(exp)) return null;
  const classification = Array.isArray(exp.tiers) && exp.tiers.length === 1 ? String(exp.tiers[0]) : '';
  if (!classification) return null;
  return readAltAssignment(ssmClient, SSM_ROOT, classification, DUEL_ROLE);
}

/**
 * AN EXPERIMENT ARMS ONLY WITH ITS TWO VERSIONS PINNED (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5, ADR-050).
 *
 * Every experiment, battle or not, compares two complete versions of one assistant. The control (variants[0])
 * pins the live assistant's active version by number (`controlPin`); a `profile` experiment's control pins its
 * referenced version. The treatment (variants[1]) pins a candidate in the alt's history (`altPin`) whose
 * `derivedFrom` says this experiment and that variant produced it. A side with no pin, a pin to another
 * assistant, or a candidate derived for some other experiment is refused: that side would otherwise serve
 * something no experiment measured. Returns null when it may arm.
 *
 * The derivation is a profile write, and the writer of every profile is `manage-profiles` (§7), so this handler
 * checks the pins and never derives them itself (`deriveVersions` asks).
 */
async function armRefusal(exp: Experiment): Promise<{ error: string; code: string } | null> {
  const classification = exp.tiers?.length === 1 ? exp.tiers[0] : undefined;
  const type = exp.experimentType ?? 'intent';
  const controlName = type === 'profile' ? exp.variants?.[0]?.profileRef?.profileName : undefined;
  const role = controlName ? profilesRegistry.roleOfAssistant(controlName) : (classification ? { classification, role: DUEL_ROLE } : undefined);
  const alt = role ? profilesRegistry.altAssistantName(role.classification, role.role) : undefined;
  const treatmentCode = exp.battleEnabled ? 'BATTLE_TREATMENT_MUST_PIN_ALT_VERSION' : 'TREATMENT_MUST_PIN_CANDIDATE_VERSION';
  const controlCode = exp.battleEnabled ? 'BATTLE_CONTROL_MUST_PIN_LIVE_VERSION' : 'CONTROL_MUST_PIN_LIVE_VERSION';
  if (!alt) {
    return { error: 'The experiment has no alt this deployment declares, so its treatment has no candidate history.', code: treatmentCode };
  }
  const treatmentRefusal = await pinRefusal(exp, 1, alt, treatmentCode);
  if (treatmentRefusal) return treatmentRefusal;
  const live = controlName ?? (role ? profilesRegistry.roleAssistantName(role.classification, role.role) : undefined);
  if (!live) {
    return { error: "The experiment's role has no live assistant this deployment declares, so its control has no version.", code: controlCode };
  }
  const pin = exp.variants?.[0]?.controlPin;
  if (!pin || pin.profileName !== live || !Number.isInteger(pin.version) || pin.version < 1) {
    return { error: `The control must pin a version of ${live}, the live assistant's active version when the experiment is armed.`, code: controlCode };
  }
  return null;
}

/**
 * ARMING PINS BOTH VERSIONS (§3.5): asks the profile writer for the control's pin (the live active version, a
 * reference) and the treatment's candidate, and returns the variants with `controlPin` and `altPin` set, or a
 * refusal. A deployment that has not wired the function derives nothing here, and `armRefusal` then refuses
 * the arm by name.
 */
async function deriveVersions(
  exp: Experiment,
  actor: string,
): Promise<{ variants: ExperimentVariant[] } | { refusal: { status: number; error: string; code: string } }> {
  if (!MANAGE_PROFILES_FUNCTION) return { variants: exp.variants };
  let answer: { ok?: boolean; controlPin?: ExperimentVariant['controlPin']; altPin?: ExperimentVariant['altPin']; status?: number; error?: string; code?: string };
  try {
    const res = await lambdaClient.send(new InvokeCommand({
      FunctionName: MANAGE_PROFILES_FUNCTION,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ aeDeriveExperimentVersions: { experiment: exp, actor } })),
    }));
    answer = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') : {};
    if (res.FunctionError) answer = { ok: false, error: answer.error || 'the profile writer failed', code: 'DERIVATION_FAILED' };
  } catch (err) {
    console.error('[admin-experiments] could not ask the profile writer to pin the experiment\'s versions', err);
    return { refusal: { status: 503, error: "The experiment's versions could not be pinned; try again.", code: 'DERIVATION_UNAVAILABLE' } };
  }
  if (!answer.ok || !answer.controlPin || !answer.altPin) {
    return {
      refusal: {
        status: answer.status && answer.status >= 400 && answer.status < 600 ? answer.status : 422,
        error: `The experiment's versions could not be pinned: ${answer.error || 'no reason given'}`,
        code: answer.code || 'DERIVATION_FAILED',
      },
    };
  }
  const [control, treatment] = exp.variants;
  return { variants: [{ ...control, controlPin: answer.controlPin }, { ...treatment, altPin: answer.altPin }] };
}

/** One side's pin checked against the version it names: the right assistant, a concrete version, derived for this variant. */
async function pinRefusal(
  exp: Experiment,
  at: 0 | 1,
  assistant: string,
  code: string,
): Promise<{ error: string; code: string } | null> {
  const variant = exp.variants?.[at];
  const pin = at === 1 ? variant?.altPin : variant?.controlPin;
  const side = at === 1 ? 'treatment' : 'control';
  if (!pin || pin.profileName !== assistant || !Number.isInteger(pin.version) || (pin.version as number) < 1) {
    return { error: `The ${side} must pin a version of ${assistant}, derived for this experiment through variant-version, before the battle can run.`, code };
  }
  let derivedFrom: { experimentId?: string; variantId?: string } | undefined;
  try {
    const res = await ssmClient.send(new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${assistant}/definition:${pin.version}` }));
    derivedFrom = (JSON.parse(res.Parameter?.Value || '{}') as { derivedFrom?: typeof derivedFrom }).derivedFrom;
  } catch {
    return { error: `Version ${pin.version} of ${assistant} could not be read.`, code };
  }
  if (derivedFrom?.experimentId !== exp.experimentId || derivedFrom?.variantId !== variant?.variantId) {
    return { error: `Version ${pin.version} of ${assistant} was not derived for this experiment's ${variant?.variantId} variant.`, code };
  }
  return null;
}


/**
 * ── THE ALT IS ASSIGNED FOR THE LIFE OF THE EXPERIMENT, AND ONLY THEN ─────────────────────────
 *
 * A battle is an OPTION ON AN EXPERIMENT (DESIGN-BATTLE anchor 2): the two sides are that
 * experiment's variants, so an alt assistant exists because an experiment is running and stops
 * existing when it stops. That is the relationship this function keeps.
 *
 * The classification stack provisions the ALT at deploy - its bot and its Amazon Lex bot, recorded with
 * `assistant: null`, which is the honest between-battles state. This writes the ASSISTANT when an
 * experiment is armed and clears it when the experiment ends, so `(classification, role, alt)` answers
 * "who is challenging the live assistant right now" rather than "a bot exists". Everything else on the
 * record is the stack's and is written back as read, so the Lex bot a targeted reply arrives on stays
 * resolvable while an experiment holds the alt.
 *
 * WHY IT IS BEST-EFFORT AND NEVER FAILS THE WRITE. The experiment row is the source of truth for
 * what runs - `battleEnabled` plus the variants - and the assignment record is a projection of it
 * for readers that ask "who is this role's alt". A projection that cannot be written must not stop
 * the experiment being armed or ended: refusing to END an experiment because a parameter write
 * failed would leave a battle running that the operator has already stopped, which is the worse of
 * the two failures by a distance. It is logged loudly instead.
 */
async function setAltAssignment(args: {
  /** The experiment row: the alt it binds is its classification's (`altOf`). */
  exp: Experiment & LegacyBattleBinding;
  experimentId: string;
  /**
   * True while the experiment is armed and running; false when it ends, pauses or disarms.
   *
   * The NAME of the assistant is not the caller's to choose: it is `alt-{role}-{classification}` for the
   * role (`altAssistantName`). Deriving it here is what stops two call sites inventing two spellings for
   * one assistant.
   */
  occupied: boolean;
}): Promise<void> {
  if (!challengerOf(args.exp)) return;
  try {
    const record = await altOf(args.exp);
    if (!record) {
      console.warn(
        '[admin-experiments] the experiment\'s classification provisions no alt; the assignment record '
        + 'is left untouched.',
        { experimentId: args.experimentId, tiers: args.exp.tiers },
      );
      return;
    }
    const altName = profilesRegistry.altAssistantName(record.classification, record.role);
    if (args.occupied && !altName) {
      console.warn('[admin-experiments] the alt names a role this deployment does not declare; the record is left untouched', {
        classification: record.classification, role: record.role,
      });
      return;
    }
    await ssmClient.send(new PutParameterCommand({
      Name: `${SSM_ROOT}/assistant-assignments/${record.classification}/${record.role}/alt`,
      Overwrite: true,
      Type: 'String',
      Value: JSON.stringify({
        ...record,
        // NULL WHEN THE EXPERIMENT ENDS, not the last assistant left behind. A stale name reads
        // as "a challenger is live" to anything asking, which is exactly wrong between battles.
        //
        // THE ALT'S NAME, `alt-{role}-{classification}` (ADR-050): an assistant with its own profile,
        // derived through this experiment and published under this name. The classification is in it
        // because an assistant's name is instance-wide and a role is not.
        assistant: args.occupied ? altName : null,
        // WHICH experiment put it there, so an assignment can be traced to the thing that justifies
        // it. Cleared with the assistant.
        experimentId: args.occupied ? args.experimentId : null,
      }),
    }));
  } catch (err) {
    console.error(
      '[admin-experiments] could not update the alt assignment record; the experiment row still '
      + 'decides what runs, so this is a stale projection rather than a stale battle.',
      { experimentId: args.experimentId, err },
    );
  }
  await applyAltAlias(args.exp, args.occupied, args.experimentId);
}

/**
 * THE ALT'S IDENTITY CARRIES ITS PROFILE'S NAME WHILE THE EXPERIMENT HOLDS IT, the name
 * the duel gives it (`battleSideNames`): its pinned version's `displayName`, else the live assistant's, marked
 * as the challenger when the two match. So the room and its members panel name the challenger as the duel
 * does, a mention of that name resolves, and its provisioned name comes back when the experiment releases
 * it. The live identity's name is never changed for a battle. The rename is the profile writer's
 * (it holds the name applier); best-effort like the record above, and logged when it does not land.
 */
async function applyAltAlias(
  exp: Experiment & LegacyBattleBinding,
  occupied: boolean,
  experimentId?: string,
): Promise<void> {
  const challenger = challengerOf(exp);
  if (!challenger || !MANAGE_PROFILES_FUNCTION) return;
  const classification = Array.isArray(exp.tiers) && exp.tiers.length === 1 ? String(exp.tiers[0]) : '';
  const alt = classification ? profilesRegistry.altAssistantName(classification, DUEL_ROLE) : undefined;
  if (!alt) return;
  // FROM THE EXPERIMENT IN HAND (`battleSidesOf`), never a search for the live battle: `occupied` is this
  // experiment's status and arming, so one whose start date is still ahead holds the alt, and its identity
  // carries the duel's name from the moment it does.
  const alias = occupied
    ? (await battleSidesOf(exp).catch((err) => {
      console.warn("[admin-experiments] the challenger's name could not be resolved; the alt keeps its name", { alt, experimentId, err });
      return null;
    }))?.treatment?.displayName
    : undefined;
  try {
    const res = await lambdaClient.send(new InvokeCommand({
      FunctionName: MANAGE_PROFILES_FUNCTION,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ aeApplyAltAlias: { alt, ...(alias ? { alias } : {}) } })),
    }));
    const out = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') as { identityRename?: string; identityRenameError?: string } : {};
    if (res.FunctionError || out.identityRename === 'failed') {
      console.error("[admin-experiments] the alt identity's battle name did not land", { alt, alias, err: out.identityRenameError ?? res.FunctionError });
    }
  } catch (err) {
    console.error("[admin-experiments] could not ask for the alt identity's battle name", { alt, alias, err });
  }
}

/**
 * A BATTLE EXPERIMENT AS THE CONSOLE READS IT: the row, plus the name the duel gives each side
 * (`battleSidesOf`, the resolver the room and the alt's identity use), keyed by side. Derived on read from
 * the sides' pinned versions and never stored (`validateAndSanitizeExperiment` drops it), so a rename of a
 * version shows here as it shows in the room. A side whose name does not resolve is absent, and the console
 * shows its variant id alone. Only a battle-enabled row that is not deleted is read for names.
 */
async function withSideNames(exp: Experiment): Promise<Experiment & { sideNames?: { control?: string; treatment?: string } }> {
  if (exp.battleEnabled !== true || exp.status === 'deleted') return exp;
  const sides = await battleSidesOf(exp).catch((err) => {
    console.warn('[admin-experiments] the battle sides did not resolve; the console shows their variant ids', { experimentId: exp.experimentId, err });
    return null;
  });
  const control = sides?.control?.displayName?.trim();
  const treatment = sides?.treatment?.displayName?.trim();
  if (!control && !treatment) return exp;
  return { ...exp, sideNames: { ...(control ? { control } : {}), ...(treatment ? { treatment } : {}) } };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;
  const method = event.httpMethod;
  const path = event.path || '';

  if (method === 'OPTIONS') return respond(200, { ok: true }, origin);

  if (!EXPERIMENTS_TABLE) {
    return respond(500, { error: 'EXPERIMENTS_TABLE not configured' }, origin);
  }
  // The routes are IAM-authorized, so the person is the one the signed session names.
  const callerSub = await callerPersonId(event);
  if (!callerSub) return respond(401, { error: 'Unauthorized' }, origin);

  // Require admin, not just a valid sub — otherwise any signed-in basic user
  // could create / arm / pause / activate experiments, including battle-enabled
  // experiments that name a challenger and let attackers hijack model routing.
  // The admin gate is the shared, IdP-agnostic check (honors ADMIN_GROUP_NAMES
  // + service mode).
  if (!callerIsAdmin(event)) {
    console.warn('[admin-experiments] non-admin denied', { sub: callerSub });
    return respond(403, { error: 'Admin access required' }, origin);
  }

  // A TEAM MEMBER'S ROUTE NAMES ONE ASSISTANT. Its experiments are the ones `experimentBelongsTo`
  // admits; an experiment id outside that set answers as if it did not exist, and a create that is not
  // the assistant's own is refused.
  const scope = await requireOwnedAssistant(event, origin);
  if (isRefusal(scope)) return scope;
  const scopedId = scope ? event.pathParameters?.experimentId : undefined;
  if (scope && scopedId) {
    const target = await getExistingExperiment(scopedId);
    if (!target || !experimentBelongsTo(target, scope)) {
      return respond(404, { error: `Experiment "${scopedId}" not found` }, origin);
    }
  }

  try {
    // ── BATTLE ON/OFF, PER CLASSIFICATION (ADR-049) ──────────────────────────────────────────────
    //
    // Battle eligibility is a classification-level setting, not a property of an assistant, and it is
    // OFF until an operator turns it on ("typically only used for internal users", owner 2026-09-21).
    // It lives here because this is the surface an operator already uses to arm the experiment a duel
    // runs on, so turning battle on and arming the comparison are one visit rather than two.
    //
    // CAPABILITY IS NOT NEGOTIABLE FROM HERE. A classification whose deployment wires no battle
    // plumbing cannot be switched on, because the switch would promise what its IAM role cannot back -
    // which is exactly the defect this split fixes. The GET reports both, so the console can render a
    // classification as unavailable rather than as merely off.
    if (path.endsWith('/battle-settings')) {
      const conversational = profilesRegistry.classificationValues().filter((c) => profilesRegistry.isConversational(c));
      if (method === 'GET') {
        const settings = await Promise.all(conversational.map(async (classification) => ({
          classification,
          capable: profilesRegistry.isBattleCapable(classification),
          enabled: await isBattleOn(classification),
        })));
        return respond(200, { settings }, origin);
      }
      if (method === 'POST') {
        const parsed = parseJsonBody<{ classification?: string; enabled?: boolean }>(event, origin);
        if ('statusCode' in parsed) return parsed;
        const { classification, enabled } = parsed.body;
        if (!classification || typeof enabled !== 'boolean') {
          return respond(400, { error: 'classification and enabled (boolean) are required' }, origin);
        }
        if (!profilesRegistry.isBattleCapable(classification)) {
          return respond(409, {
            error: `Battle cannot be turned on for '${classification}': this deployment does not wire battle for it`,
            code: 'BATTLE_NOT_CAPABLE',
            classification,
          }, origin);
        }
        await ssmClient.send(new PutParameterCommand({
          Name: `${SSM_ROOT}/battle/${classification}/enabled`,
          Value: String(enabled),
          Type: 'String',
          Overwrite: true,
        }));
        // DROP THIS CONTAINER'S CACHED ANSWER, or the console's own re-read contradicts the write it
        // just made. `isBattleOn` memoizes per classification for 30 seconds and the GET above is what
        // fills that cache, so an operator who opens the tab (caching `false`), ticks the box and gets
        // re-read by the same warm container would watch the checkbox snap back and conclude the save
        // failed. Other containers still take up to the TTL, which is what `appliesWithinSeconds` says.
        __clearBattleEnablementCache();
        console.log('[admin-experiments] battle setting written', { classification, enabled, by: callerSub });
        return respond(200, { classification, enabled, appliesWithinSeconds: 30 }, origin);
      }
    }

    // ── THE CHALLENGERS A BATTLE CAN NAME ────────────────────────────────────────────────────────────
    //
    // One per battle-capable classification: the alt of its duel role, by assistant id, from the record
    // its classification stack writes. The console offers these rather than a list of its own, so it can
    // only name an assistant the deployment provisioned. `inUseBy` is the experiment the record says holds
    // the alt now, so the console can say which classification is taken. `?classification=` narrows it.
    if (method === 'GET' && path.endsWith('/challengers')) {
      const only = event.queryStringParameters?.classification;
      const classifications = profilesRegistry.classificationValues()
        .filter((c) => profilesRegistry.isBattleCapable(c) && (!only || c === only));
      const challengers: Array<{ assistant: string; classification: string; role: string; inUseBy: string | null }> = [];
      for (const classification of classifications) {
        const assistant = profilesRegistry.altAssistantName(classification, DUEL_ROLE);
        if (!assistant) continue;
        let record: AltAssignment | null;
        try {
          record = await readAltAssignment(ssmClient, SSM_ROOT, classification, DUEL_ROLE);
        } catch (err) {
          console.error('[admin-experiments] an alt assignment record could not be read', { classification, err });
          return respond(503, { error: 'The challengers could not be read; try again.' }, origin);
        }
        if (!record) continue; // the classification provisions no alt, so a battle cannot run there
        challengers.push({ assistant, classification, role: DUEL_ROLE, inUseBy: record.experimentId ?? null });
      }
      return respond(200, { challengers }, origin);
    }

    // GET /admin/experiments → list
    if (method === 'GET') {
      // Paginate the scan: a single Scan returns at most one page (≤1MB), so with enough
      // experiments an un-paginated read silently drops the rest — the console would show a
      // truncated list and miss real rows (e.g. a just-paused experiment awaiting Resume).
      const experiments: Experiment[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await ddb.send(
          new ScanCommand({ TableName: EXPERIMENTS_TABLE, ExclusiveStartKey: exclusiveStartKey }),
        );
        experiments.push(...((result.Items || []) as Experiment[]));
        exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (exclusiveStartKey);
      await reconcileExpiredExperiments(experiments);
      const visible = scope ? experiments.filter((e) => experimentBelongsTo(e, scope)) : experiments;
      return respond(200, { experiments: await Promise.all(visible.map(withSideNames)) }, origin);
    }

    // POST /admin/experiments/{id}/promote → copy the measured candidate into the live assistant (§3.6)
    //
    // An ACTIVATION of the live assistant's profile, through the profile writer: the route is in the
    // `activate-profiles` capability (IAM refuses a caller holding only the experiment capabilities), and
    // the handler re-checks that capability beside the experiment-admin check above. The profile writer
    // refuses unless the live active version is still the pinned control and the copy hashes to the
    // candidate's `configId`, before it writes anything. On success the experiment is completed with the
    // decision `promoted_treatment`, the promoted version is recorded on the row, and the alt is released
    // (its history keeps the candidate). Conversations enrolled in the experiment keep their pinned
    // versions (ADR-050).
    if (method === 'POST' && path.endsWith('/promote')) {
      const experimentId = event.pathParameters?.experimentId;
      if (!experimentId) return respond(400, { error: 'experimentId required' }, origin);
      if (!callerCanManageProfiles(event)) {
        return respond(403, { error: 'Promotion activates a profile version, which needs the activate-profiles capability', code: 'PROMOTION_NEEDS_ACTIVATE_PROFILES' }, origin);
      }
      const parsed = parseJsonBody<{ note?: string }>(event, origin);
      if ('statusCode' in parsed) return parsed;
      let note: string | undefined;
      try {
        note = sanitizeObjectiveStatement(parsed.body.note);
      } catch (err) {
        if (err instanceof ExperimentValidationError) return respond(400, { error: err.message, code: err.code }, origin);
        throw err;
      }
      const existing = await getExistingExperiment(experimentId);
      if (!existing) return respond(404, { error: `Experiment "${experimentId}" not found` }, origin);
      if (existing.status !== 'active' && existing.status !== 'paused') {
        return respond(409, { error: `Experiment "${experimentId}" is '${existing.status}'; only a running or paused experiment is promoted`, code: 'EXPERIMENT_NOT_RUNNING' }, origin);
      }
      if (!existing.servesVersions) {
        return respond(409, {
          error: 'This experiment was armed before experiments pinned two versions, so it has no measured candidate. Pause and resume it to pin them, or record the decision by ending it.',
          code: 'PROMOTION_NEEDS_TWO_VERSIONS',
        }, origin);
      }
      if (!MANAGE_PROFILES_FUNCTION) {
        return respond(503, { error: 'The profile writer is not configured, so nothing can be promoted', code: 'PROMOTION_UNAVAILABLE' }, origin);
      }
      const actor = callerArn(callerSub);
      let answer: { ok?: boolean; status?: number; error?: string; code?: string; profileName?: string; version?: number; configId?: string; identityRename?: string };
      try {
        const res = await lambdaClient.send(new InvokeCommand({
          FunctionName: MANAGE_PROFILES_FUNCTION,
          InvocationType: InvocationType.RequestResponse,
          Payload: Buffer.from(JSON.stringify({ aePromoteCandidate: { experiment: existing, actor } })),
        }));
        answer = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') : {};
        if (res.FunctionError) answer = { ok: false, error: answer.error || 'the profile writer failed', code: 'PROMOTION_FAILED' };
      } catch (err) {
        console.error('[admin-experiments] could not ask the profile writer to promote', err);
        return respond(503, { error: 'The promotion could not be requested; nothing was activated. Try again.', code: 'PROMOTION_UNAVAILABLE' }, origin);
      }
      if (!answer.ok || !answer.profileName || !Number.isInteger(answer.version) || !answer.configId) {
        const status = answer.status && answer.status >= 400 && answer.status < 600 ? answer.status : 422;
        return respond(status, { error: answer.error || 'The promotion was refused', code: answer.code || 'PROMOTION_FAILED' }, origin);
      }
      const now = new Date().toISOString();
      const decision: ExperimentDecision = { outcome: 'promoted_treatment', by: actor, at: now, ...(note !== undefined && { note }) };
      const promotion = { profileName: answer.profileName, version: answer.version as number, configId: answer.configId, at: now, by: actor };
      const transitions = appendTransition(existing.transitions, { from: existing.status, to: 'completed', by: actor, at: now, reason: 'promote' });
      const guard = optimisticGuard(existing);
      try {
        await ddb.send(new UpdateCommand({
          TableName: EXPERIMENTS_TABLE,
          Key: { experimentId },
          UpdateExpression: 'SET #s = :s, #t = :t, #d = :d, #p = :p',
          ExpressionAttributeNames: { ...guard.names, '#d': 'decision', '#p': 'promotion' },
          ExpressionAttributeValues: { ...guard.values, ':s': 'completed', ':t': transitions, ':d': decision, ':p': promotion },
          ConditionExpression: guard.ConditionExpression,
        }));
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          // THE VERSION IS ALREADY ACTIVE; only the experiment row moved under this request. Said plainly,
          // so the operator ends the experiment rather than promoting twice.
          console.error('[admin-experiments] promoted, but the experiment row changed before it could be completed', { experimentId, promotion });
          return respond(409, {
            error: `Version ${promotion.version} of ${promotion.profileName} is active, but the experiment changed while it was promoted and was not completed. Reload it and end it.`,
            code: 'PROMOTED_BUT_NOT_COMPLETED',
            promotion,
          }, origin);
        }
        throw err;
      }
      await setAltAssignment({ exp: existing, experimentId, occupied: false });
      return respond(200, {
        ok: true,
        status: 'completed',
        decision,
        promotion,
        ...(answer.identityRename && { identityRename: answer.identityRename }),
        freedClassification: (existing.tiers || [])[0],
        freedClassifications: existing.tiers || [],
      }, origin);
    }

    // POST /admin/experiments/{id}/status → guarded lifecycle transition
    if (method === 'POST' && path.endsWith('/status')) {
      const experimentId = event.pathParameters?.experimentId;
      if (!experimentId) return respond(400, { error: 'experimentId required' }, origin);
      // 400 on malformed JSON instead of 500 leak.
      const parsed = parseJsonBody<{ status?: string; decision?: ExperimentDecision }>(event, origin);
      if ('statusCode' in parsed) return parsed;
      const { status } = parsed.body;
      if (!status || !VALID_STATUS.includes(status as (typeof VALID_STATUS)[number])) {
        return respond(400, { error: `status must be one of ${VALID_STATUS.join(', ')}` }, origin);
      }
      // Narrowed to the requestable subset of Experiment['status'] for the typed guards.
      const to: Experiment['status'] = status as (typeof VALID_STATUS)[number];

      // L6: read the row first so a missing id is a clean 404 (not the old 500
      // from an uncaught conditional-check failure), and so the transition guard
      // (L2) and audit (L7) have the current status.
      const existing = await getExistingExperiment(experimentId);
      if (!existing) {
        return respond(404, { error: `Experiment "${experimentId}" not found` }, origin);
      }

      // L2/§3.2: enforce the state machine — `completed`/`deleted` are terminal,
      // and a no-op same-state set is rejected. Re-running a completed test uses a
      // new id.
      if (!isAllowedTransition(existing.status, to)) {
        return respond(409, {
          error:
            `Cannot change status from '${existing.status}' to '${to}'. `
            + `'completed' and 'deleted' are terminal — re-run with a new experiment id.`,
          code: 'INVALID_TRANSITION',
          from: existing.status,
          to,
        }, origin);
      }

      // The variants with both duel sides pinned, when this transition arms a battle; written with the status.
      let armedVariants: ExperimentVariant[] | undefined;
      if (to === 'active') {
        // An experiment whose `endDate` has passed has no window left to run in: resolution already
        // refuses it (`isLiveForClassification` gates on `endDate`), and the next list read
        // auto-completes it (L5). Writing the `active` label back therefore resumes nothing, so a
        // 200 here tells the operator a run restarted that never will. Refuse with the window in the
        // body. Extending the run is a real operation and stays available on the edit route, where
        // `endDate` is one of the three fields that remain editable on a live experiment (§3.2 L1)
        // and gets validated as a date; the status route does not take a second, unvalidated path to
        // the same field.
        const endsAt = existing.endDate ? new Date(existing.endDate).getTime() : NaN;
        if (!Number.isNaN(endsAt) && endsAt <= Date.now()) {
          return respond(409, {
            error:
              `Experiment "${experimentId}" ended at ${existing.endDate}, so activating it resolves `
              + 'no traffic. Extend its end date first (POST /admin/experiments with a later '
              + 'endDate), or create a new experiment (new id) to run it again.',
            code: 'EXPERIMENT_WINDOW_ENDED',
            endDate: existing.endDate,
            from: existing.status,
            to,
          }, origin);
        }

        // EVERY CHEAP REFUSAL RUNS BEFORE ANYTHING IS DERIVED. Deriving publishes a candidate version in the
        // alt's history, so an arm refused after it would leave a version no experiment measures.
        // Refuse to reactivate beyond the cap (excludes the row being touched).
        const activeCount = await countActiveExperimentsExcluding(experimentId);
        if (activeCount >= MAX_ACTIVE_EXPERIMENTS) {
          return respond(429, {
            error: `Maximum active experiments reached (${MAX_ACTIVE_EXPERIMENTS}). Complete or pause an existing experiment first.`,
            code: 'MAX_ACTIVE_EXPERIMENTS',
          }, origin);
        }
        // §3.2.1 / A.7: activating into an occupied classification returns the
        // conflicts so the console can drive End/Pause/Delete + auto-retry.
        const conflicts = await findClassificationConflicts({
          tiers: existing.tiers || [],
          excludeExperimentId: experimentId,
        });
        if (conflicts.length > 0) {
          return respond(409, {
            error: CLASSIFICATION_OCCUPIED,
            code: 'EXPERIMENT_TYPE_CONFLICT',
            conflicts: conflictBody(conflicts),
            conflictingExperimentIds: conflicts.map((e) => e.experimentId),
          }, origin);
        }

        // THE TWO VERSIONS ARE PINNED HERE, AT ARM (§3.5), and written with the status below. A resume pins
        // again, so a row armed before versions were pinned is armed this way when it is resumed.
        const derived = await deriveVersions(existing, callerArn(callerSub));
        if ('refusal' in derived) return respond(derived.refusal.status, { error: derived.refusal.error, code: derived.refusal.code, from: existing.status, to }, origin);
        armedVariants = derived.variants;
        const refused = await armRefusal({ ...existing, variants: armedVariants });
        if (refused) return respond(409, { ...refused, from: existing.status, to }, origin);
      }

      const now = new Date().toISOString();
      const actor = callerArn(callerSub);

      // §3.2.1: completing a test that RAN may record the operator's decision.
      // `by`/`at` are server-authoritative; `note` reuses the objective-prose
      // sanitizer; `no_decision` is a valid, honest outcome (INV-1/INV-3).
      let decision: ExperimentDecision | undefined;
      if (to === 'completed' && parsed.body.decision) {
        const d = parsed.body.decision;
        if (!DECISION_OUTCOMES.includes(d.outcome as (typeof DECISION_OUTCOMES)[number])) {
          return respond(400, {
            error: `decision.outcome must be one of ${DECISION_OUTCOMES.join(', ')}`,
            code: 'DECISION_OUTCOME_INVALID',
          }, origin);
        }
        let note: string | undefined;
        try {
          note = sanitizeObjectiveStatement(d.note);
        } catch (err) {
          if (err instanceof ExperimentValidationError) {
            return respond(400, { error: err.message, code: err.code }, origin);
          }
          throw err;
        }
        decision = { outcome: d.outcome, by: actor, at: now, ...(note !== undefined && { note }) };
      }

      // L7: append the transition to the append-only audit. Auto-expiry uses the
      // same edge tagged in `reason`; an operator action is tagged by the target.
      const transitions = appendTransition(existing.transitions, {
        from: existing.status,
        to,
        by: actor,
        at: now,
        reason: `status:${to}`,
      });

      // The write is pinned to the status and audit this transition was authorized from, so a
      // concurrent lifecycle write is refused rather than silently overwritten (optimisticGuard).
      const guard = optimisticGuard(existing);
      const names: Record<string, string> = { ...guard.names };
      const values: Record<string, unknown> = { ':s': to, ':t': transitions, ...guard.values };
      let setExpr = 'SET #s = :s, #t = :t';
      if (armedVariants) {
        names['#v'] = 'variants';
        values[':v'] = armedVariants;
        names['#sv'] = 'servesVersions';
        values[':sv'] = true;
        setExpr += ', #v = :v, #sv = :sv';
      }
      if (decision) {
        names['#d'] = 'decision';
        values[':d'] = decision;
        setExpr += ', #d = :d';
      }
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: EXPERIMENTS_TABLE,
            Key: { experimentId },
            UpdateExpression: setExpr,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ConditionExpression: guard.ConditionExpression,
          }),
        );
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          return respondToLostRace({
            experimentId,
            from: existing.status,
            to,
            action: 'status change',
            origin,
          });
        }
        throw err;
      }
      // THE ALT FOLLOWS THE STATUS. End or Pause vacates the alt; Resume/Activate assigns it again,
      // but only if this experiment is battle-armed at all - a non-battle experiment never had a
      // challenger to assign.
      await setAltAssignment({
        exp: existing,
        experimentId,
        occupied: to === 'active' && existing.battleEnabled === true,
      });

      // Pausing/completing frees the classification; return it so the console can
      // auto-retry a blocked create (§3.2.1). Activating occupies, so no freed set.
      return respond(200, {
        ok: true,
        status: to,
        ...(decision && { decision }),
        ...(to !== 'active' && {
          freedClassification: (existing.tiers || [])[0],
          freedClassifications: existing.tiers || [],
        }),
      }, origin);
    }

    // DELETE /admin/experiments/{id} → hard-delete a never-started draft, else a
    // soft-delete tombstone (L8 / §3.2.1). The hard/soft choice is server-side.
    if (method === 'DELETE') {
      const experimentId = event.pathParameters?.experimentId;
      if (!experimentId) return respond(400, { error: 'experimentId required' }, origin);

      const existing = await getExistingExperiment(experimentId);
      if (!existing) {
        return respond(404, { error: `Experiment "${experimentId}" not found` }, origin);
      }

      const now = new Date().toISOString();
      const actor = callerArn(callerSub);
      const freedClassifications = existing.tiers || [];
      // Never-started (still `draft`) with zero accrued data ⇒ nothing to preserve,
      // so remove the row outright. Otherwise the row ran (or holds an audit), so
      // keep a tombstone: historical exchanges keep their variant labels and the
      // transition audit (L7) survives.
      const neverStarted = existing.status === 'draft' && !hasAccruedTraffic(existing);

      // Both delete shapes are decided from the row read above - hard-vs-soft from its status, the
      // tombstone's audit from its `transitions` - so both carry the same guard: a hard delete must
      // not erase a draft that was activated in the meantime, and the tombstone must not drop a
      // concurrent entry from the audit it is meant to preserve.
      const guard = optimisticGuard(existing);
      try {
        if (neverStarted) {
          await ddb.send(
            new DeleteCommand({
              TableName: EXPERIMENTS_TABLE,
              Key: { experimentId },
              ExpressionAttributeNames: guard.names,
              ExpressionAttributeValues: guard.values,
              ConditionExpression: guard.ConditionExpression,
            }),
          );
        } else {
          const transitions = appendTransition(existing.transitions, {
            from: existing.status,
            to: 'deleted',
            by: actor,
            at: now,
            reason: 'delete:soft',
          });
          await ddb.send(
            new UpdateCommand({
              TableName: EXPERIMENTS_TABLE,
              Key: { experimentId },
              UpdateExpression: 'SET #s = :s, #t = :t',
              ExpressionAttributeNames: guard.names,
              ExpressionAttributeValues: { ':s': 'deleted', ':t': transitions, ...guard.values },
              ConditionExpression: guard.ConditionExpression,
            }),
          );
        }
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          return respondToLostRace({
            experimentId,
            from: existing.status,
            to: 'deleted',
            action: 'delete',
            origin,
          });
        }
        throw err;
      }

      // Either path frees the classification; a soft-delete row is active-only
      // scanned out of runtime resolution AND the battle side resolver, so the
      // challenger it named is released without an extra write.
      //
      // THE ASSIGNMENT RECORD IS THE EXCEPTION, and it is why this call exists (§3.2: "Delete frees
      // the classification and releases the challenger it named"). Release used to be implicit
      // precisely because nothing stored the binding outside the experiment row - the resolver
      // scanned active experiments and a deleted one simply stopped matching. The assignment record
      // is a stored projection, so it does not stop matching on its own: left alone it would say a
      // challenger holds the alt for an experiment that no longer exists.
      await setAltAssignment({
        exp: existing,
        experimentId,
        occupied: false,
      });

      return respond(200, {
        ok: true,
        mode: neverStarted ? 'hard' : 'soft',
        ...(neverStarted ? {} : { status: 'deleted' }),
        experimentId,
        freedClassification: freedClassifications[0],
        freedClassifications,
      }, origin);
    }

    // POST /admin/experiments → create or edit (upsert)
    if (method === 'POST') {
      // 400 on malformed JSON instead of 500 leak.
      const parsed = parseJsonBody<Experiment>(event, origin);
      if ('statusCode' in parsed) return parsed;
      const input = parsed.body;
      if (!input.experimentId) {
        return respond(400, { error: 'experimentId is required' }, origin);
      }
      if (scope) {
        // A battle names the classification's challenger: an admin decision.
        if (input.battleEnabled) {
          return respond(403, { error: 'Battle is set for a classification by an admin', code: 'BATTLE_IS_CLASSIFICATION_LEVEL' }, origin);
        }
        if (!experimentBelongsTo(input, scope)) {
          return respond(403, {
            error: 'A team creates only profile experiments whose every variant is its own assistant, on the classifications it serves',
            code: 'EXPERIMENT_OUTSIDE_ASSISTANT',
          }, origin);
        }
        // An edit must not take over an experiment that is someone else's.
        const prior = await getExistingExperiment(input.experimentId);
        if (prior && !experimentBelongsTo(prior, scope)) {
          return respond(404, { error: `Experiment "${input.experimentId}" not found` }, origin);
        }
      }

      // Read any existing row so an edit gets update semantics: preserve
      // createdAt (L1 — never clobber), keep the current status when the caller
      // omits one (don't silently reactivate a paused test), append an edit
      // transition (L7), and guard variant edits once traffic accrues.
      const existing = await getExistingExperiment(input.experimentId);

      // L2/§3.2 on the UPSERT path. The create route writes `status` straight onto the row, so
      // without these two guards it was a way around the state machine that POST /{id}/status
      // enforces: re-POSTing an existing id with `status:'active'` walked a `completed` or
      // soft-`deleted` (tombstoned) experiment back into live traffic resolution, and an arbitrary
      // string was stored unchecked, producing a row that is never live and never errors.
      if (input.status !== undefined && !EXPERIMENT_STATUSES.includes(input.status)) {
        return respond(400, {
          error: `status must be one of ${EXPERIMENT_STATUSES.join(', ')}`,
        }, origin);
      }
      if (existing) {
        // Terminal rows are not editable at all - the same rule the status route states as
        // "re-run with a new experiment id". Editing a tombstone is never a legitimate operation.
        if (existing.status === 'completed' || existing.status === 'deleted') {
          return respond(409, {
            error:
              `Experiment "${existing.experimentId}" is '${existing.status}', which is terminal, `
              + 'so it can no longer be edited or reactivated. Create a new experiment (new id) to run it again.',
            code: 'EXPERIMENT_TERMINAL',
            status: existing.status,
          }, origin);
        }
        // A status CHANGE requested through an edit must satisfy the same transition table as the
        // status route. Omitting `status` (a plain edit) keeps the current one and is not a transition.
        if (
          input.status !== undefined
          && input.status !== existing.status
          && !isAllowedTransition(existing.status, input.status)
        ) {
          return respond(409, {
            error: `Cannot change status from '${existing.status}' to '${input.status}'.`,
            code: 'INVALID_TRANSITION',
            from: existing.status,
            to: input.status,
          }, origin);
        }
      }

      const now = new Date().toISOString();
      const draft: Experiment = {
        ...input,
        // L1: preserve createdAt on update; only a brand-new row stamps `now`.
        createdAt: existing?.createdAt || now,
        status: input.status || existing?.status || 'active',
      };
      // THE PINS, THE SHAPE MARKER AND THE PROMOTION RECORD ARE THE SERVER'S. Arming writes the pins and
      // `servesVersions`, and the Promote action writes `promotion`, so a client never supplies them. An edit
      // of a row that was armed keeps the pins it was armed with, WHATEVER ITS STATUS: the live version may
      // have moved since, and an edit (weights, end date, objective) must not change what the experiment
      // compares. A paused experiment is the common case: dropping its pins on an edit left Promote refusing
      // it as never armed. What the pins were derived from cannot change on an armed row: that edit is
      // refused below (`comparisonChanged`), so a kept pin always describes the row it is kept on.
      delete draft.servesVersions;
      delete draft.promotion;
      const keepPins = !!existing && existing.servesVersions === true;
      draft.variants = (Array.isArray(draft.variants) ? draft.variants : []).map((v, i) => {
        const { controlPin: _c, altPin: _a, ...rest } = v ?? ({} as ExperimentVariant);
        void _c; void _a;
        const prior = keepPins ? existing!.variants?.find((p) => p.variantId === rest.variantId) : undefined;
        return {
          ...rest,
          ...(prior?.controlPin && i === 0 ? { controlPin: prior.controlPin } : {}),
          ...(prior?.altPin && i === 1 ? { altPin: prior.altPin } : {}),
        } as ExperimentVariant;
      });
      if (keepPins) draft.servesVersions = true;

      // Battle arming: server-set audit attribution, and the challenger must be one the classification's
      // assignment record provisions. The row names it by assistant id; its bot ARN stays on the record.
      if (draft.battleEnabled) {
        draft.boundBy = callerArn(callerSub);
        draft.boundAt = now;
        // ONE CLASSIFICATION NAMES THE ALT. A battle with any other number of classifications is the
        // validator's refusal below, which says so better than a missing alt would.
        if (challengerOf(draft) && Array.isArray(draft.tiers) && draft.tiers.length === 1) {
          let alt: AltAssignment | null;
          try {
            alt = await altOf(draft);
          } catch (err) {
            console.error('[admin-experiments] the alt assignment record could not be read', err);
            return respond(503, { error: 'The alt assistant\'s record could not be read; try again.' }, origin);
          }
          if (!alt) {
            return respond(
              400,
              {
                error: `The ${String(draft.tiers[0])} classification provisions no alt assistant, so a battle `
                  + 'cannot run there (is battle deployed for it?).',
                code: 'ALT_NOT_PROVISIONED',
              },
              origin,
            );
          }
        }
      }

      let sanitized: Experiment;
      try {
        // Catalog-checked: an unknown variant modelKey is a 400 here rather than an experiment that
        // silently runs both arms on the default model and reports "indistinguishable".
        sanitized = validateAndSanitizeExperiment(draft, modelCatalogKeys());
      } catch (err) {
        if (err instanceof ExperimentValidationError) {
          return respond(400, { error: err.message, code: err.code }, origin);
        }
        throw err;
      }

      // L1 / §7: once an experiment has LEFT draft, its variant MODELS and COUNT are locked - only
      // weight, endDate, and the objective may change. Changing what is being compared means a new
      // experiment (new id) so pre/post data is never pooled across a variant swap. FAIL-SAFE on the
      // data question: any non-draft experiment is treated as data-bearing. (`exchange_count` is an
      // analytics query alias, never persisted onto the stored row, so a per-variant traffic check off
      // the record is unreliable - status is the authoritative signal that traffic could have accrued.)
      // Draft/never-activated stays freely editable. Compared post-sanitize so display/addendum
      // normalization matches.
      if (
        existing
        && existing.status !== 'draft'
        && comparisonChanged(sanitized, existing)
      ) {
        return respond(409, {
          error:
            `Experiment "${existing.experimentId}" is live and has collected data, so what it compares `
            + '(its type, intent, classification, and variant models and count) is locked. Change only the '
            + 'weights, end date, or objective, or create a new experiment (new id) to compare something else.',
          code: 'EXPERIMENT_LIVE_EDIT_LOCKED',
        }, origin);
      }
      // A ROW THAT HOLDS PINS BUT NEVER RAN (a draft) may change what it compares, and its pins then describe
      // a comparison it no longer makes. They are removed here, explicitly, and arming derives new ones.
      if (keepPins && existing && existing.status === 'draft' && comparisonChanged(sanitized, existing)) {
        sanitized.variants = sanitized.variants.map((v) => {
          const { controlPin: _c, altPin: _a, ...rest } = v;
          void _c; void _a;
          return rest as ExperimentVariant;
        });
        delete sanitized.servesVersions;
        console.log('[admin-experiments] a draft changed what it compares; its pins are re-derived when it is armed', {
          experimentId: existing.experimentId,
        });
      }

      // Carry forward the recorded decision (set only via the status endpoint on
      // completion) so an edit can't spoof or drop it. L7: append a lifecycle audit
      // entry — 'create' for a new row, else an edit at the current status.
      sanitized.decision = existing?.decision;
      sanitized.transitions = appendTransition(existing?.transitions, {
        from: existing ? existing.status : 'create',
        to: sanitized.status,
        by: callerArn(callerSub),
        at: now,
        reason: existing ? 'edit' : 'create',
      });

      // Cap active experiments. Excludes the current row so an idempotent
      // re-create of an existing active
      // experiment is not punished. Placed AFTER validation so 400
      // responses (validation, alt-not-provisioned) don't pay an
      // unnecessary Scan, and BEFORE the Put so an over-cap write is
      // refused with 429.
      if (sanitized.status === 'active') {
        // EVERY CHEAP REFUSAL RUNS BEFORE ANYTHING IS DERIVED. Deriving publishes a candidate version in the
        // alt's history, so an arm refused after it would leave a version no experiment measures.
        const activeCount = await countActiveExperimentsExcluding(sanitized.experimentId);
        if (activeCount >= MAX_ACTIVE_EXPERIMENTS) {
          return respond(429, {
            error: `Maximum active experiments reached (${MAX_ACTIVE_EXPERIMENTS}). Complete or pause an existing experiment first.`,
            code: 'MAX_ACTIVE_EXPERIMENTS',
          }, origin);
        }

        // One live experiment per classification, whatever its type.
        const conflicts = await findClassificationConflicts({
          tiers: sanitized.tiers || [],
          excludeExperimentId: sanitized.experimentId,
        });
        if (conflicts.length > 0) {
          return respond(409, {
            error: CLASSIFICATION_OCCUPIED,
            code: 'EXPERIMENT_TYPE_CONFLICT',
            // §3.2.1 / A.7: the console drives End/Pause/Delete + auto-retry off this.
            conflicts: conflictBody(conflicts),
            conflictingExperimentIds: conflicts.map((e) => e.experimentId),
          }, origin);
        }

        // THE TWO VERSIONS ARE PINNED HERE, AT ARM (§3.5), and stored on the variants this Put writes. An edit
        // of an experiment that is already running keeps its pins (above) and pins nothing new. An edit that
        // ARMS the row (a create, or a paused or draft row set active) pins again, as Resume on the status
        // route does: the profile writer reuses a candidate that still says the same thing.
        if (!sanitized.servesVersions || existing?.status !== 'active') {
          const derived = await deriveVersions(sanitized, callerArn(callerSub));
          if ('refusal' in derived) return respond(derived.refusal.status, { error: derived.refusal.error, code: derived.refusal.code }, origin);
          sanitized.variants = derived.variants;
          sanitized.servesVersions = true;
        }
        const refused = await armRefusal(sanitized);
        if (refused) return respond(409, refused, origin);
      }

      // An EDIT rewrites the whole row from what the Get returned, including the status it read and
      // the audit it appended to, so it is pinned to that row (optimisticGuard): otherwise an edit
      // overlapping a Pause writes the stale `active` label back and drops the pause's audit entry,
      // and both callers see 200. A CREATE has no prior row to pin to and stays unconditional, so an
      // idempotent re-create still overwrites (the read that decides create-vs-edit is eventually
      // consistent, so conditioning a create on the row's absence would reject legitimate retries).
      const editGuard = existing ? optimisticGuard(existing) : null;
      try {
        await ddb.send(
          new PutCommand({
            TableName: EXPERIMENTS_TABLE,
            Item: sanitized,
            ...(editGuard
              ? {
                ConditionExpression: editGuard.ConditionExpression,
                ExpressionAttributeNames: editGuard.names,
                ExpressionAttributeValues: editGuard.values,
              }
              : {}),
          }),
        );
      } catch (err) {
        if (existing && isConditionalCheckFailed(err)) {
          return respondToLostRace({
            experimentId: sanitized.experimentId,
            from: existing.status,
            to: sanitized.status,
            action: 'edit',
            origin,
          });
        }
        throw err;
      }

      // ── THE ALT FOLLOWS THE EXPERIMENT ───────────────────────────────────────────────────────
      //
      // A battle is an option ON an experiment, so the challenger exists exactly while that
      // experiment is armed and running. Assigned when both are true; vacated the moment either
      // stops being true - a paused experiment runs no duels, and a disarmed one has no second side.
      await setAltAssignment({
        exp: sanitized,
        experimentId: sanitized.experimentId,
        occupied: sanitized.status === 'active' && sanitized.battleEnabled === true,
      });
      return respond(200, sanitized, origin);
    }

    return respond(404, { error: `No route for ${method} ${path}` }, origin);
  } catch (err) {
    console.error('[admin-experiments] error:', err);
    return respond(500, { error: 'Internal error' }, origin);
  }
};
