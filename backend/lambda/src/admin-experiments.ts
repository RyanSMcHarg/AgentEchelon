/**
 * Experiments Admin API
 *
 * The write/read API behind the admin dashboard's Experiments tab and
 * `/battle` arming. The frontend (`frontend/src/services/
 * experimentService.ts`) derives this from the admin-conversations API
 * URL (`/admin/conversations` → `/admin/experiments`) and calls:
 *
 *   GET    /admin/experiments                        → { experiments: [...] }
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
 * append-only `transitions` audit on every change (L7). DELETE hard-removes a
 * never-started draft, else writes a soft-delete tombstone (L8); both free the
 * classification and release any bound alt-bot slot.
 *
 * Authorization: Cognito-authenticated (API Gateway Cognito authorizer
 * enforces the JWT; we additionally require a caller sub). `boundBy` is
 * **server-authoritative** — set from the caller, never trusted from the
 * client (audit attribution for who armed a battle experiment).
 *
 * Battle-arming responsibility (per experiment-manager.ts:
 * "altBotSlotArn … computed at admin-write time from altBotSlotId + the
 * SSM roster"): for a battleEnabled experiment this resolves
 * `altBotSlotId` → `altBotSlotArn` from the alt-bot slot roster SSM
 * parameter and denormalizes it onto the row, so the runtime
 * resolveBattleVariantBySlotArn lookup works and channel-battle enable
 * doesn't reject with "missing altBotSlotArn".
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
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  validateAndSanitizeExperiment,
  findTypeExclusionConflicts,
  ExperimentValidationError,
  MAX_ACTIVE_EXPERIMENTS,
  isAllowedTransition,
  EXPERIMENT_STATUSES,
  appendTransition,
  sanitizeObjectiveStatement,
  type Experiment,
  type ExperimentVariant,
  type ExperimentDecision,
} from './lib/experiment-manager.js';
import { parseJsonBody, callerIsAdmin } from './lib/auth.js';
import { modelCatalogKeys } from '../../lib/config/model-strategy.js';

// removeUndefinedValues: validateAndSanitizeExperiment leaves optional
// fields undefined (a blank systemPromptAddendum, imageGenModelKey on a
// text battle, etc.). Without this the marshaller throws on every
// UI-created experiment and the handler returns a bare 500 "Internal
// error" — the failure the post-2 demo driver hit at "Create & Activate".
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssmClient = new SSMClient({});

const EXPERIMENTS_TABLE = process.env.EXPERIMENTS_TABLE || '';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ALT_BOT_SLOTS_ROSTER_PARAM =
  process.env.ALT_BOT_SLOTS_ROSTER_PARAM || '/agent-echelon/alt-bot-slots/roster';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');

// Statuses a caller may REQUEST via POST /{id}/status (End/Pause/Resume/Activate).
// `draft` is a create-time state and `deleted` goes through DELETE, so neither is
// requestable here. The from→to legality is enforced separately by isAllowedTransition.
const VALID_STATUS = ['active', 'paused', 'completed'] as const;

// The operator's recorded outcome when completing a test that RAN (DESIGN §3.2.1).
// `no_decision` is always available and the default, so an inconclusive test closes
// honestly (INV-1/INV-3) — the API never forces a winner.
const DECISION_OUTCOMES = ['promoted_treatment', 'kept_control', 'no_decision'] as const;

function corsHeaders(origin?: string): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    Vary: 'Origin',
  };
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

function getCallerSub(event: APIGatewayProxyEvent): string | null {
  const claims = (event.requestContext.authorizer?.claims || {}) as Record<string, string>;
  return claims.sub || null;
}

/**
 * Server-authoritative actor ARN for audit attribution (transitions, decision,
 * boundBy). Same shape used for `boundBy` — the app-instance user ARN when the
 * instance is known, else the bare sub. Never trusted from the client.
 */
function callerArn(callerSub: string): string {
  return APP_INSTANCE_ARN ? `${APP_INSTANCE_ARN}/user/${callerSub}` : callerSub;
}

/** Fetch a stored experiment by id (null when absent). Used to drive update/edit
 *  semantics (preserve createdAt, guard live edits), the lifecycle transition guard,
 *  and Delete's hard-vs-soft decision. */
async function getExistingExperiment(experimentId: string): Promise<Experiment | null> {
  const res = (await ddb.send(
    new GetCommand({ TableName: EXPERIMENTS_TABLE, Key: { experimentId } }),
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
      if (exp.status !== 'active' || !exp.endDate || new Date(exp.endDate) > now) return;
      const transitions = appendTransition(exp.transitions, {
        from: 'active',
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
            ConditionExpression: '#s = :active',
            ExpressionAttributeNames: { '#s': 'status', '#t': 'transitions' },
            ExpressionAttributeValues: { ':s': 'completed', ':t': transitions, ':active': 'active' },
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
    }),
  );
}

/** True when a DynamoDB write's ConditionExpression failed (the row vanished
 *  between read and write, or never existed). Lets the guarded writes return 404
 *  instead of a bare 500 (L6). */
function isConditionalCheckFailed(err: unknown): boolean {
  return (
    !!err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
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
    displayName: v.displayName ?? null,
    systemPromptAddendum: v.systemPromptAddendum ?? null,
  });
}

/** True when the incoming variant set changes the models or the variant count vs the
 *  stored record — i.e. anything but per-variant weight (DESIGN §3.2 L1 / §7). Compare
 *  AFTER sanitizing the incoming variants so display/addendum normalization matches. */
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

/** Shape the type-exclusion conflicts for the 409 body the console drives the
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

let cachedRoster: Array<{ slotId: string; botArn: string }> | null = null;
async function resolveSlotArn(slotId: string): Promise<string | null> {
  if (!cachedRoster) {
    try {
      const res = await ssmClient.send(
        new GetParameterCommand({ Name: ALT_BOT_SLOTS_ROSTER_PARAM }),
      );
      cachedRoster = JSON.parse(res.Parameter?.Value || '[]');
    } catch (err) {
      console.warn('[admin-experiments] roster read failed:', err);
      cachedRoster = [];
    }
  }
  return cachedRoster!.find((s) => s.slotId === slotId)?.botArn || null;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin || event.headers?.Origin;
  const method = event.httpMethod;
  const path = event.path || '';

  if (method === 'OPTIONS') return respond(200, { ok: true }, origin);

  if (!EXPERIMENTS_TABLE) {
    return respond(500, { error: 'EXPERIMENTS_TABLE not configured' }, origin);
  }
  const callerSub = getCallerSub(event);
  if (!callerSub) return respond(401, { error: 'Unauthorized' }, origin);

  // Require admin, not just a valid sub — otherwise any signed-in basic user
  // could create / arm / pause / activate experiments, including battle-enabled
  // experiments that bind alt-bot slots and let attackers hijack model routing.
  // The admin gate is the shared, IdP-agnostic check (honors ADMIN_GROUP_NAMES
  // + service mode).
  if (!callerIsAdmin(event)) {
    console.warn('[admin-experiments] non-admin denied', { sub: callerSub });
    return respond(403, { error: 'Admin access required' }, origin);
  }

  try {
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
      return respond(200, { experiments }, origin);
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

      if (to === 'active') {
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
        const typeConflicts = await findTypeExclusionConflicts({
          experimentType: existing.experimentType ?? 'intent',
          tiers: existing.tiers || [],
          excludeExperimentId: experimentId,
        });
        if (typeConflicts.length > 0) {
          return respond(409, {
            error:
              'A classification experiment cannot run alongside another experiment type on the same classification. '
              + 'Complete, pause, or delete the conflicting experiment(s) first.',
            code: 'EXPERIMENT_TYPE_CONFLICT',
            conflicts: conflictBody(typeConflicts),
            conflictingExperimentIds: typeConflicts.map((e) => e.experimentId),
          }, origin);
        }
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

      const names: Record<string, string> = { '#s': 'status', '#t': 'transitions' };
      const values: Record<string, unknown> = { ':s': to, ':t': transitions };
      let setExpr = 'SET #s = :s, #t = :t';
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
            ConditionExpression: 'attribute_exists(experimentId)',
          }),
        );
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          return respond(404, { error: `Experiment "${experimentId}" not found` }, origin);
        }
        throw err;
      }
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

      try {
        if (neverStarted) {
          await ddb.send(
            new DeleteCommand({
              TableName: EXPERIMENTS_TABLE,
              Key: { experimentId },
              ConditionExpression: 'attribute_exists(experimentId)',
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
              ExpressionAttributeNames: { '#s': 'status', '#t': 'transitions' },
              ExpressionAttributeValues: { ':s': 'deleted', ':t': transitions },
              ConditionExpression: 'attribute_exists(experimentId)',
            }),
          );
        }
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          return respond(404, { error: `Experiment "${experimentId}" not found` }, origin);
        }
        throw err;
      }

      // Either path frees the classification; a soft-delete row is active-only
      // scanned out of runtime resolution AND the battle-slot resolver, so the
      // bound alt-bot slot is released without an extra write.
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

      // Battle arming: server-set audit attribution + denormalize the
      // slot ARN from the roster (so runtime variant resolution works).
      if (draft.battleEnabled) {
        draft.boundBy = callerArn(callerSub);
        draft.boundAt = now;
        if (draft.altBotSlotId) {
          const slotArn = await resolveSlotArn(draft.altBotSlotId);
          if (!slotArn) {
            return respond(
              400,
              {
                error: `Alt-bot slot "${draft.altBotSlotId}" is not provisioned (check the alt-bot slot pool / roster).`,
              },
              origin,
            );
          }
          draft.altBotSlotArn = slotArn;
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
        && variantModelOrCountChanged(sanitized.variants, existing.variants || [])
      ) {
        return respond(409, {
          error:
            `Experiment "${existing.experimentId}" is live and has collected data, so its variant `
            + 'models and count are locked. Change only the weights, end date, or objective — or '
            + 'create a new experiment (new id) to compare different models.',
          code: 'EXPERIMENT_LIVE_EDIT_LOCKED',
        }, origin);
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
      // responses (validation, slot-not-provisioned) don't pay an
      // unnecessary Scan, and BEFORE the Put so an over-cap write is
      // refused with 429.
      if (sanitized.status === 'active') {
        const activeCount = await countActiveExperimentsExcluding(sanitized.experimentId);
        if (activeCount >= MAX_ACTIVE_EXPERIMENTS) {
          return respond(429, {
            error: `Maximum active experiments reached (${MAX_ACTIVE_EXPERIMENTS}). Complete or pause an existing experiment first.`,
            code: 'MAX_ACTIVE_EXPERIMENTS',
          }, origin);
        }

        // Type-exclusion rule: a classification experiment cannot be active
        // alongside any other type on a shared classification (and vice versa).
        const typeConflicts = await findTypeExclusionConflicts({
          experimentType: sanitized.experimentType ?? 'intent',
          tiers: sanitized.tiers || [],
          excludeExperimentId: sanitized.experimentId,
        });
        if (typeConflicts.length > 0) {
          return respond(409, {
            error:
              'A classification experiment cannot run alongside another experiment type on the same classification. '
              + 'Complete, pause, or delete the conflicting experiment(s) first.',
            code: 'EXPERIMENT_TYPE_CONFLICT',
            // §3.2.1 / A.7: the console drives End/Pause/Delete + auto-retry off this.
            conflicts: conflictBody(typeConflicts),
            conflictingExperimentIds: typeConflicts.map((e) => e.experimentId),
          }, origin);
        }
      }

      await ddb.send(
        new PutCommand({ TableName: EXPERIMENTS_TABLE, Item: sanitized }),
      );
      return respond(200, sanitized, origin);
    }

    return respond(404, { error: `No route for ${method} ${path}` }, origin);
  } catch (err) {
    console.error('[admin-experiments] error:', err);
    return respond(500, { error: 'Internal error' }, origin);
  }
};
