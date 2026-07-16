/**
 * Experiments Admin API
 *
 * The write/read API behind the admin dashboard's Experiments tab and
 * `/battle` arming. The frontend (`frontend/src/services/
 * experimentService.ts`) derives this from the admin-conversations API
 * URL (`/admin/conversations` → `/admin/experiments`) and calls:
 *
 *   GET  /admin/experiments                       → { experiments: [...] }
 *   POST /admin/experiments            (Experiment) → the stored Experiment
 *   POST /admin/experiments/{id}/status  { status } → { ok: true }
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
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  validateAndSanitizeExperiment,
  findTypeExclusionConflicts,
  ExperimentValidationError,
  MAX_ACTIVE_EXPERIMENTS,
  type Experiment,
} from './lib/experiment-manager.js';
import { parseJsonBody, callerIsAdmin } from './lib/auth.js';

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

const VALID_STATUS = ['active', 'paused', 'completed'] as const;

function corsHeaders(origin?: string): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
      const result = await ddb.send(new ScanCommand({ TableName: EXPERIMENTS_TABLE }));
      const experiments = (result.Items || []) as Experiment[];
      return respond(200, { experiments }, origin);
    }

    // POST /admin/experiments/{id}/status → status update
    if (method === 'POST' && path.endsWith('/status')) {
      const experimentId = event.pathParameters?.experimentId;
      if (!experimentId) return respond(400, { error: 'experimentId required' }, origin);
      // 400 on malformed JSON instead of 500 leak.
      const parsed = parseJsonBody<{ status?: string }>(event, origin);
      if ('statusCode' in parsed) return parsed;
      const { status } = parsed.body;
      if (!status || !VALID_STATUS.includes(status as (typeof VALID_STATUS)[number])) {
        return respond(400, { error: `status must be one of ${VALID_STATUS.join(', ')}` }, origin);
      }
      // Refuse to reactivate beyond the cap. Counts everything that's `active`
      // today and would still be
      // active after this write (i.e. not the row being touched). Only
      // applied when the requested status IS active.
      if (status === 'active') {
        const activeCount = await countActiveExperimentsExcluding(experimentId);
        if (activeCount >= MAX_ACTIVE_EXPERIMENTS) {
          return respond(429, {
            error: `Maximum active experiments reached (${MAX_ACTIVE_EXPERIMENTS}). Complete or pause an existing experiment first.`,
            code: 'MAX_ACTIVE_EXPERIMENTS',
          }, origin);
        }
      }
      await ddb.send(
        new UpdateCommand({
          TableName: EXPERIMENTS_TABLE,
          Key: { experimentId },
          UpdateExpression: 'SET #s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status },
          ConditionExpression: 'attribute_exists(experimentId)',
        }),
      );
      return respond(200, { ok: true }, origin);
    }

    // POST /admin/experiments → create
    if (method === 'POST') {
      // 400 on malformed JSON instead of 500 leak.
      const parsed = parseJsonBody<Experiment>(event, origin);
      if ('statusCode' in parsed) return parsed;
      const input = parsed.body;
      if (!input.experimentId) {
        return respond(400, { error: 'experimentId is required' }, origin);
      }

      const now = new Date().toISOString();
      const draft: Experiment = {
        ...input,
        createdAt: now,
        status: input.status || 'active',
      };

      // Battle arming: server-set audit attribution + denormalize the
      // slot ARN from the roster (so runtime variant resolution works).
      if (draft.battleEnabled) {
        draft.boundBy = APP_INSTANCE_ARN
          ? `${APP_INSTANCE_ARN}/user/${callerSub}`
          : callerSub;
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
        sanitized = validateAndSanitizeExperiment(draft);
      } catch (err) {
        if (err instanceof ExperimentValidationError) {
          return respond(400, { error: err.message, code: err.code }, origin);
        }
        throw err;
      }

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
        // alongside any other type on a shared tier (and vice versa).
        const typeConflicts = await findTypeExclusionConflicts({
          experimentType: sanitized.experimentType ?? 'intent',
          tiers: sanitized.tiers || [],
          excludeExperimentId: sanitized.experimentId,
        });
        if (typeConflicts.length > 0) {
          return respond(409, {
            error:
              'A classification experiment cannot run alongside another experiment type on the same tier. '
              + 'Complete or pause the conflicting experiment(s) first.',
            code: 'EXPERIMENT_TYPE_CONFLICT',
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
