/**
 * Start a classifier replay (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2).
 *
 *   POST /classifier-replay-start  -> { run: { runId, ... }, started: true }
 *
 * **Non-VPC, and that is the entire point of this function existing.** The replay itself is a batch
 * Lambda inside the VPC (it needs Aurora and Bedrock), and something has to invoke it when an
 * operator clicks. The obvious home for that call — the analytics API handler — cannot make it: that
 * handler is attached to the ISOLATED subnets, which have no NAT, no internet gateway and no `lambda`
 * interface endpoint, so `lambda:Invoke` has no route and hangs until the function times out. IAM
 * permission was granted; reachability never existed. This is the one hop that must originate
 * outside the VPC, so it gets a function outside the VPC — the same shape as `ClientEventsFunction`,
 * which invokes the data-plane Lambda and works for exactly this reason.
 *
 * The run id is minted HERE and returned immediately, so the console has something to poll from the
 * click even though the row it names is written a moment later, inside the VPC, by the batch Lambda.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { requireAdmin, iamCallerSub } from './lib/auth.js';
import { validateReplayInput } from './lib/classifier-replay-input.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Read per request, not at module load, so the "not configured" branch is reachable in a test. */
const replayArn = () => process.env.CLASSIFIER_REPLAY_ARN || '';

const lambdaClient = new LambdaClient({ region: AWS_REGION });

function cors(origin?: string): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    Vary: 'Origin',
  };
}

function respond(status: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...cors(origin) }, body: JSON.stringify(body) };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = (event.headers?.origin || event.headers?.Origin) as string | undefined;
  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);

  // The gateway authorizer authenticates; this gates on admin authority, in whichever mode the
  // deployment runs (Cognito group / federated / IAM-signed). Never rely on the authorizer alone.
  const auth = requireAdmin(event);
  if ('statusCode' in auth) return { ...auth, headers: { ...auth.headers, ...cors(origin) } };

  const replayFunctionArn = replayArn();
  if (!replayFunctionArn) {
    // Nothing is opened in this case, deliberately: a run row with no function to execute it is the
    // "ships inert but reports success" failure the gate is supposed to make impossible.
    return respond(503, { error: 'The classifier replay function is not configured for this deployment' }, origin);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' }, origin);
  }

  // Validated HERE, synchronously, with the same pure rules the batch Lambda re-applies. An `Event`
  // invocation cannot report a rejection back, so a request that is never going to be valid must be
  // refused while the caller is still listening — otherwise the console polls an id forever.
  let validated;
  try {
    validated = validateReplayInput({
      incumbentModel: body.incumbentModel as string,
      challengerModel: body.challengerModel as string,
      windowDays: Number(body.windowDays) || undefined,
      limit: Number(body.limit) || undefined,
    });
  } catch (e) {
    return respond(400, { error: e instanceof Error ? e.message : 'Invalid replay request' }, origin);
  }

  const runId = randomUUID();
  // Attribution is server-side, like every other admin write here: the operator's own sub under IAM
  // enforcement, otherwise the verified claims. The body never names the actor.
  const startedBy = iamCallerSub(event) || auth.claims.sub || null;

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: replayFunctionArn,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({
        runId,
        limit: validated.limit,
        // The batch Lambda opens the row, because only it can reach the database. It re-derives the
        // window from `windowDays` so the stored window is the one the replay actually reads.
        open: {
          incumbentModel: validated.incumbentModel,
          challengerModel: validated.challengerModel,
          experimentId: (body.experimentId as string) || undefined,
          windowDays: Number(body.windowDays) || undefined,
          limit: validated.limit,
          startedBy,
        },
      })),
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[classifier-replay-start] could not invoke the replay function', message);
    // No row was written, so there is nothing to strand — the operator gets an error and no run.
    return respond(502, { error: 'Could not start the replay' }, origin);
  }

  console.log(JSON.stringify({
    _auditEvent: 'classifier_replay_start',
    timestamp: new Date().toISOString(),
    runId,
    startedBy,
    incumbentModel: validated.incumbentModel,
    challengerModel: validated.challengerModel,
  }));

  // `data: []` keeps the analytics-result shape the console's `queryAnalytics` unwraps. The window is
  // deliberately NOT claimed here: the authoritative one is the row the batch Lambda writes, and the
  // console reads it back from there rather than from this reply.
  return respond(202, {
    data: [],
    started: true,
    run: {
      runId,
      incumbentModel: validated.incumbentModel,
      challengerModel: validated.challengerModel,
      limit: validated.limit,
      status: 'running',
    },
  }, origin);
}
