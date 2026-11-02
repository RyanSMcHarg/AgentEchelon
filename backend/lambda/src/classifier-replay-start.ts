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
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { requireAdmin } from './lib/auth.js';
import { responder, originsFrom } from './lib/http-response.js';
import { validateReplayInput, replayArnEnvName } from './lib/classifier-replay-input.js';
import { resolveActiveProfile } from './lib/active-profile.js';
import { parseIntentPack, resolvePackParameterValue, type IntentPack } from './lib/intent-pack.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGINS, '', { trim: true, dropEmpty: true });
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

/**
 * The replay function of ONE classification. Read per request, not at module load, so the "not
 * configured" branch is reachable in a test. There is no shared function to fall back to: a run executes
 * with its own classification's reach or not at all (tenet D12).
 */
const lambdaClient = new LambdaClient({ region: AWS_REGION });
const ssmClient = new SSMClient({ region: AWS_REGION });
const replayArns = new Map<string, string>();
/** For tests: forget the replay functions found. */
export function forgetReplayFunctions(): void {
  replayArns.clear();
}

/**
 * The classification's replay function, its classification's own stack's: found under the key that stack publishes
 * (`<CLASSIFIER_REPLAY_PARAM_ROOT>/<classification>/classifier-replay-arn`) at call time and kept for the container,
 * so this function's environment names no classification. The shape is `resolveRouterArn`'s: an explicit
 * variable (`CLASSIFIER_REPLAY_ARN_<C>`) wins where one is set. Empty when none is published.
 */
async function replayArnFor(classification: string): Promise<string> {
  const explicit = process.env[replayArnEnvName(classification)];
  if (explicit) return explicit;
  const cached = replayArns.get(classification);
  if (cached) return cached;
  const root = (process.env.CLASSIFIER_REPLAY_PARAM_ROOT || '').trim();
  if (!root) return '';
  try {
    const arn = ((await ssmClient.send(new GetParameterCommand({ Name: `${root}/${classification}/classifier-replay-arn` }))).Parameter?.Value || '').trim();
    if (arn) replayArns.set(classification, arn);
    return arn;
  } catch (err) {
    console.error('[classifier-replay-start] the replay function parameter could not be read', { classification, err: (err as Error)?.name });
    return '';
  }
}

/**
 * The intent pack the assistant serves: its active version's, else its classification's deployment pack,
 * else the platform's. The same order a live turn of that assistant resolves (`router-agent-handler.ts`
 * reads the version's pack and falls back to the classification's `assistant-intent-pack`). Resolved
 * here, outside the VPC, because the replay function has no route to SSM.
 */
export async function servedIntentPack(assistant: string, classification: string, ssm: Pick<SSMClient, 'send'> = ssmClient): Promise<IntentPack> {
  const active = await resolveActiveProfile(assistant, { ssm: ssm as SSMClient, ssmRoot: SSM_ROOT });
  if (active.intentPack) return active.intentPack;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${classification}/assistant-intent-pack` }));
    return parseIntentPack(await resolvePackParameterValue(res.Parameter?.Value, classification));
  } catch (err) {
    // Not every classification publishes a deployment pack; one that does not serves the platform's.
    if ((err as { name?: string })?.name === 'ParameterNotFound') return parseIntentPack(undefined);
    throw err;
  }
}

const http = responder({ origin: { allow: ALLOWED_ORIGINS, fallback: '*' }, methods: 'POST,OPTIONS' });
const respond = http.respond;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = (event.headers?.origin || event.headers?.Origin) as string | undefined;
  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);

  // The gateway authorizer authenticates; this gates on admin authority, in whichever mode the
  // deployment runs (Cognito group / federated / IAM-signed). Never rely on the authorizer alone.
  const auth = await requireAdmin(event);
  if ('statusCode' in auth) return { ...auth, headers: { ...auth.headers, ...http.headers(origin) } };

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
      classification: body.classification as string,
      assistant: (body.assistant as string) || undefined,
      windowDays: Number(body.windowDays) || undefined,
      limit: Number(body.limit) || undefined,
    });
  } catch (e) {
    return respond(400, { error: e instanceof Error ? e.message : 'Invalid replay request' }, origin);
  }

  const replayFunctionArn = await replayArnFor(validated.classification);
  if (!replayFunctionArn) {
    // Nothing is opened in this case, deliberately: a run row with no function to execute it is the
    // "ships inert but reports success" failure the gate is supposed to make impossible.
    return respond(503, { error: `The classifier replay function for ${validated.classification} is not configured for this deployment` }, origin);
  }

  // THE TAXONOMY BOTH CANDIDATES CLASSIFY AGAINST, resolved now so a run that cannot have one is refused
  // while the operator is listening rather than recorded as a failure later.
  let intentPack: IntentPack;
  try {
    intentPack = await servedIntentPack(validated.assistant, validated.classification);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[classifier-replay-start] could not resolve the assistant\'s intent pack', { assistant: validated.assistant, message });
    return /no seed profile named/.test(message)
      ? respond(400, { error: `'${validated.assistant}' is not an assistant this replay can compare` }, origin)
      : respond(503, { error: 'Could not read the assistant\'s intent pack' }, origin);
  }

  const runId = randomUUID();
  // Attribution is server-side, like every other admin write here: the person the signed session names,
  // or the signing principal when it is not a person. The body never names the actor.
  const startedBy = auth.claims.actor || null;

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
          classification: validated.classification,
          assistant: validated.assistant,
          intentPack,
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
    classification: validated.classification,
    assistant: validated.assistant,
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
      classification: validated.classification,
      assistant: validated.assistant,
      limit: validated.limit,
      status: 'running',
    },
  }, origin);
}
