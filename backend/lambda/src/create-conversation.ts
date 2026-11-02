/**
 * A PERSON OPENS A CONVERSATION. The primary user-facing creation path.
 *
 * THIS REPLACES `lambda/create-conversation/index.js`, AND THE POINT IS THE IMPORT. That handler was
 * deployed with `Code.fromAsset` as raw JavaScript, so it could not import `lib/*` - which is why it
 * hand-mirrored classification admission through `CLASSIFICATION_ADMISSION_JSON` and read its default
 * retention from env vars the stack mirrored out of the conversation-type registry. Two copies of a
 * decision, pinned by a test precisely because they can drift. Bundled, it calls the registry and the
 * canonical creator directly, and both mirrors are gone.
 *
 * ── WHY CONSOLIDATION IS NOT TIDYING HERE (ADR-053) ─────────────────────────────────────────────
 *
 * Six implementations create a conversation, and a conversation TYPE can only mean something if one of
 * them owns creation. Until this change `typed-conversation-from-event` was the only path that honored
 * a type, so a conversation opened through this API - which is every conversation a person opens - got
 * none of its type's retention, assistants or routing. That is the gap `SPEC-CONVERSATION-TYPES` has to
 * describe as a limitation rather than a feature.
 *
 * ── WHAT THIS HANDLER KEEPS, AND WHY IT IS NOT IN THE LIBRARY ───────────────────────────────────
 *
 * Authorization and request validation stay here: the reach gate, the admin-plane refusal, the TTL
 * limit and the required-field check. Each has to reach the caller as a specific status and code that
 * the web client reads, and a library returning those would be inventing an HTTP contract. The codes are
 * unchanged from the handler this replaces - MISSING_CLAIMS, MISSING_REQUIRED_FIELDS,
 * INVALID_EXPIRATION_DAYS, INVALID_EXPIRATION_CRITERION, CLASSIFICATION_NOT_CONVERSATIONAL,
 * TIER_FORBIDDEN, SERVER_MISCONFIG, CONVERSATION_CREATION_FAILED - because a renamed code is a silent
 * break in a client nobody redeployed. `CLASSIFICATION_REQUIRED` is ADDED rather than renamed from
 * anything: it is the refusal that replaces the `|| 'basic'` floor, so it describes a request the old
 * handler accepted. Adding a code cannot break a client; changing what one means can.
 *
 * ── WHAT CHANGES FOR A CONVERSATION OPENED HERE ─────────────────────────────────────────────────
 *
 * Its default retention is now the TYPE's `expiration` rather than an env mirror; it is created by the
 * service admin, so every assistant's welcome passes through the channel flow instead of the creating
 * assistant's escaping it; and its context row is written by the same writer every other origin uses,
 * before the channel exists, which is the ordering the onboarding gate depends on. Who is added does
 * not change: the ordinary type, `general`, declares no `defaultAgents` and manual membership.
 *
 * ── THIS FUNCTION CREATES NOTHING ITSELF ─────────────────────────
 *
 * After the checks it invokes the requested classification's creator
 * (`create-conversation-at-classification.ts`), one per conversational classification, whose role can
 * create only a conversation of that classification. This role holds the invoke and no Amazon Chime SDK
 * grant, so no one role spans every classification's conversations.
 *
 * ── ONE PATH FOR EVERY ISSUER ────────────────────────────────────────────────────────────────────
 *
 * Which conversation a caller opens follows from their issuer's entry in the trusted-issuer registry
 * (`lib/config/issuers.ts`), never from a route. A person whose issuer declares the one-conversation
 * session (`clearance: { oneChannel }`) opens a HOST'S CONTEXT CONVERSATION: create-or-get on the
 * host's `{contextType, contextId}`, at the classification their issuer names, by that classification's
 * creator. Everyone else opens a typed conversation at a classification their clearance reaches.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import {
  DEFAULT_CONVERSATION_TYPE,
  MAX_CONVERSATION_TTL_DAYS,
  typeAdmitsIssuers,
  type ExpirationCriterion,
} from '../../lib/config/conversation-types.js';
import type {
  CreateAtClassificationRequest,
  CreateAtClassificationResult,
  CreateContextAtClassificationRequest,
  CreateContextAtClassificationResult,
} from './create-conversation-at-classification.js';
import { userArnFor } from './lib/person-arn.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { callerHolderToken, callerOneChannel, callerPerson, callerPersonId } from './lib/auth.js';
import { responder } from './lib/http-response.js';
import { resolveConversationCreatorArn, useConversationCreatorArnSsmClient } from './lib/conversation-creator-arn.js';
import { loadProfileRegistry, useProfileRegistrySsmClient } from '../../lib/profile-registry';
import { SSMClient } from '@aws-sdk/client-ssm';
import { BOUNDED_REQUEST_HANDLER } from './lib/bounded-request-handler.js';
import { logPhaseTiming, phaseTimer, PrimedRead, runsInLambda, type PhaseTimer } from './lib/cold-path.js';

const lambdaClient = new LambdaClient({});
// ONE SSM CLIENT for the registry and the creators' keys, so a cold container pays its first-call setup once.
const ssmClient = new SSMClient({ requestHandler: BOUNDED_REQUEST_HANDLER, retryMode: 'adaptive', maxAttempts: 6 });
useProfileRegistrySsmClient(ssmClient);
useConversationCreatorArnSsmClient(ssmClient);
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === 'true';

// ── STARTED WHILE THE MODULE LOADS (lib/cold-path.ts) ───────────────────────────────────────────────
//
// A cold container reads the registry and then every member classification's creator key during Init, so
// the first request takes them already in flight. Each is taken once and only while fresh; a creator key
// that could not be read is read again once by the request that needs it.
const primedCreators = new Map<string, PrimedRead<string | undefined>>();

/** Start the registry read and, once it lands, each member creator's key. Exported for tests. */
export function primeColdPath(): Promise<void> {
  return loadProfileRegistry().then(() => {
    for (const classification of profiles.memberClassificationValues()) {
      if (!profiles.isConversational(classification) || primedCreators.has(classification)) continue;
      const read = new PrimedRead(`${classification} creator`, () => resolveConversationCreatorArn(classification), {
        unusable: (arn) => !arn,
      });
      read.prime();
      primedCreators.set(classification, read);
    }
  }, () => undefined);
}
if (runsInLambda()) void primeColdPath();

/**
 * A MEMBER CLASSIFICATION'S CREATOR, found by its key at call time (`resolveConversationCreatorArn`). Never an
 * outside one's: a person never opens a visitor's or a customer's conversation through this API, and the
 * function's invoke is bounded to the members' creators by their `audience` tag besides.
 */
async function creatorFor(classification: string, timer?: PhaseTimer): Promise<string | undefined> {
  if (profiles.audienceOf(classification) !== 'members') return undefined;
  const primed = primedCreators.get(classification);
  primedCreators.delete(classification);
  const read = () => (primed ? primed.get() : resolveConversationCreatorArn(classification));
  return timer ? timer.time('creatorArn', read) : read();
}

/** True until this container has served its first request. */
let coldContainer = true;

/** Invoke a classification's creator synchronously and return its parsed answer, timed. */
async function invokeCreator<T>(creator: string, request: unknown, timer: PhaseTimer): Promise<{ functionError?: string; result: T }> {
  const invoked = await timer.time('invokeCreator', () => lambdaClient.send(new InvokeCommand({
    FunctionName: creator,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(request)),
  })));
  if (invoked.FunctionError) return { functionError: invoked.FunctionError, result: undefined as T };
  return { result: JSON.parse(new TextDecoder().decode(invoked.Payload)) as T };
}

// This route allows any origin and any header, and sends no Content-Type header.
const http = responder({ origin: { fixed: '*' }, allowHeaders: '*', json: false });
const reply = (statusCode: number, body: unknown) => http.respond(statusCode, body);

const EXPIRATION_CRITERIA: ExpirationCriterion[] = ['CREATED_TIMESTAMP', 'LAST_MESSAGE_TIMESTAMP'];

interface ApiEvent {
  body?: string | Record<string, unknown> | null;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> } };
}

/** The context creator's refusals, as this API has always answered them. */
const CONTEXT_REFUSAL_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  NOT_A_MEMBER: 403,
  CLASSIFICATION_MISMATCH: 500,
  SERVER_MISCONFIG: 500,
  CONVERSATION_CREATION_FAILED: 500,
};

/**
 * A ONE-CONVERSATION PERSON OPENS THEIR HOST'S CONTEXT CONVERSATION, by the creator of the
 * classification their issuer names. The creator bounds every host field, creates or re-opens, and
 * admits to an existing conversation only its own members.
 */
async function openContextConversation(classification: string, userArn: string, body: Record<string, unknown>, timer: PhaseTimer) {
  const creator = profiles.isKnownClassification(classification) ? await creatorFor(classification, timer) : undefined;
  if (!creator) {
    return reply(500, { error: 'no conversation creator is deployed for this classification', code: 'SERVER_MISCONFIG' });
  }
  const request: CreateContextAtClassificationRequest = { kind: 'context', classification, userArn, body };
  const { functionError, result } = await invokeCreator<CreateContextAtClassificationResult>(creator, request, timer);
  if (functionError) throw new Error(`the ${classification} creator failed: ${functionError}`);
  if (!result.ok) {
    return reply(CONTEXT_REFUSAL_STATUS[result.code] ?? 500, { error: result.error, code: result.code });
  }
  return reply(200, {
    conversationArn: result.conversationArn,
    userArn: result.userArn,
    contextType: result.contextType,
    contextId: result.contextId,
  });
}

export const handler = async (event: ApiEvent) => {
  const timer = phaseTimer();
  const cold = coldContainer;
  coldContainer = false;
  let response: ReturnType<typeof reply> | undefined;
  try {
    // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
    await timer.time('registry', async () => { await loadProfileRegistry(); });
    response = await openConversation(event, timer);
    return response;
  } finally {
    logPhaseTiming('create-conversation', timer, {
      cold,
      statusCode: response?.statusCode ?? 0,
      ...(response && response.statusCode >= 400 ? { code: codeOf(response.body) } : {}),
    });
  }
};

/** The refusal code a reply carries, for the timing line. */
function codeOf(body: string | undefined): string | undefined {
  try {
    return (JSON.parse(body || '{}') as { code?: string }).code;
  } catch {
    return undefined;
  }
}

async function openConversation(event: ApiEvent, timer: PhaseTimer) {
  try {
    // NEVER TRUST A BODY-SUPPLIED userArn. It would let a caller impersonate any user, or bypass the
    // reach gate by submitting another person's sub. The API Gateway authorizer rejects unauthenticated
    // requests; the person is resolved from the verified token and the ARN is composed from it.
    // A one-conversation person is admitted HERE, because what follows is decided by that reach: they
    // open their host's context conversation and nothing else.
    const apiEvent = event as unknown as APIGatewayProxyEvent;
    const callerSub = await callerPersonId(apiEvent, { oneChannel: true });
    if (!callerSub) return reply(401, { error: 'Unauthorized', code: 'MISSING_CLAIMS' });
    if (!APP_INSTANCE_ARN) {
      return reply(500, { error: 'APP_INSTANCE_ARN not configured', code: 'SERVER_MISCONFIG' });
    }
    const userArn = userArnFor(APP_INSTANCE_ARN, callerSub);

    const body = (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) || {};

    const oneChannel = callerOneChannel(apiEvent);
    if (oneChannel) return await openContextConversation(oneChannel, userArn, body as Record<string, unknown>, timer);
    const {
      title, modelId, modelName, modelTier, topic, triggerContext, expirationDays, expirationCriterion,
    } = body as Record<string, unknown>;

    // NO TITLE IS A ROOM OPENED UNNAMED: the creator writes the platform's placeholder, which the first message replaces
    // (`conversation-name.ts`). A title sent is the person's own name for the room.
    if (!modelId) {
      return reply(400, {
        error: 'modelId is required (userArn is derived from JWT)',
        code: 'MISSING_REQUIRED_FIELDS',
      });
    }

    // ── NO `|| 'basic'` FLOOR: AN ABSENT CLASSIFICATION IS REFUSED (ADR-046) ────
    //
    // This read `String(modelTier || 'basic')`, carried over from the handler it replaces, and it is the
    // literal ADR-046 removes. A classification is a DECLARED SET OF GRANTS rather than a ladder, so
    // there is no lowest classification to fall back to: on a deployment whose classifications are `legal` and
    // `finance` there is no `basic` at all, and the default turned an omitted field into a 403 naming a
    // classification the deployment does not declare - a refusal wearing the wrong name.
    //
    // IT WAS NEVER AN ESCALATION, and saying so is not a reason to keep it: the reach gate below and the
    // IAM classification condition both still bound what the caller gets. What it was is an omitted
    // field silently choosing someone else's classification.
    if (modelTier === undefined || modelTier === null || String(modelTier) === '') {
      return reply(400, {
        error: 'modelTier is required; this deployment declares no default classification to fall back to',
        code: 'CLASSIFICATION_REQUIRED',
      });
    }
    const requestedClassification = String(modelTier);

    // ── RETENTION TOGGLE 3: a per-conversation TTL, bounded by the DEPLOYMENT's limit ─────────────
    //
    // The limit is imported rather than mirrored into an env var now, which is the whole reason this
    // handler is bundled. It used to compare against Chime's own fifteen-year limit and nothing else, so
    // the API accepted a conversation outliving anything the type registry allows.
    let expirationOverride: { days: number; criterion: ExpirationCriterion } | undefined;
    if (expirationDays !== undefined || expirationCriterion !== undefined) {
      const days = Number(expirationDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_CONVERSATION_TTL_DAYS) {
        return reply(400, {
          error: `expirationDays must be an integer between 1 and ${MAX_CONVERSATION_TTL_DAYS} `
            + `(this deployment's conversation limit)`,
          code: 'INVALID_EXPIRATION_DAYS',
        });
      }
      if (!EXPIRATION_CRITERIA.includes(expirationCriterion as ExpirationCriterion)) {
        return reply(400, {
          error: `expirationCriterion must be one of ${EXPIRATION_CRITERIA.join(', ')}`,
          code: 'INVALID_EXPIRATION_CRITERION',
        });
      }
      expirationOverride = { days, criterion: expirationCriterion as ExpirationCriterion };
    }
    // NO per-request override falls through to the TYPE's own expiration, applied by the creator. The
    // handler no longer carries a default of its own, which is one fewer place for the two to disagree.

    // ── NO CONVERSATION AT AN ADMIN-PLANE CLASSIFICATION ─────────────────────────────────────────
    //
    // Its assistant owns the admin notification channel and has no conversational runtime, so a
    // conversation there is held by an assistant that never answers. Refused for everyone, including an
    // administrator who reaches `admin` and would otherwise pass. Asked of the registry now rather than
    // of a mirrored `adminPlane` array.
    if (!profiles.isConversational(requestedClassification)) {
      return reply(400, {
        error: `${requestedClassification} is not a classification a conversation can be created at`,
        code: 'CLASSIFICATION_NOT_CONVERSATIONAL',
      });
    }

    // ── THE REACH GATE: membership of the grant set, never a rank comparison ─────────────────────
    //
    // A grant set need not be a rank prefix (ADR-046), so this is `includes` and not a comparison. Asked
    // of the registry rather than of the mirror, which is the drift this bundling removes.
    // AND A COMBINATION THIS DEPLOYMENT HAS NOT NAMED REACHES NOTHING, which is the half a naive
    // union of grants silently loses. `resolveHolderToken` returns the one declared classification
    // whose grant set is exactly what these groups hold, or undefined when no declared classification
    // means that combination - and undefined denies every requested classification below, which is the
    // fail-closed direction. The mirror this replaces implemented the same rule by hand; asking the
    // registry is what stops the two drifting.
    // The caller's token, through their issuer's clearance source and within its declared classifications, which is
    // where their reach comes from. READ FROM THE CLAIMS AND NOT FROM A LIVE LOOKUP: the IAM
    // classification-tag gate is the real enforcement, so a claim at most one token-lifetime stale
    // cannot exceed it.
    const holderToken = callerHolderToken(apiEvent);
    const userReach = holderToken ? profiles.grantsFor(holderToken) : [];
    if (!userReach.includes(requestedClassification)) {
      return reply(403, {
        error: `Your tier (${userReach.length ? userReach.join('+') : 'none'}) does not authorize `
          + `${requestedClassification} conversations`,
        code: 'TIER_FORBIDDEN',
      });
    }

    // ── THE TYPE'S ISSUER NARROWING (T1, FR23), AFTER THE REACH GATE ─────────────────────────────
    //
    // A person opens an ordinary conversation (`general`), and a type that lists the issuers it admits
    // refuses one signed in through another, even where the classification admits them. It can only
    // refuse: it never admits somebody the gate above did not.
    const openerIssuer = (await callerPerson(apiEvent))?.issuer?.id;
    if (!typeAdmitsIssuers(DEFAULT_CONVERSATION_TYPE, openerIssuer ? [openerIssuer] : [])) {
      return reply(403, { error: 'conversations of this kind do not admit people who sign in this way', code: 'ISSUER_NOT_ADMITTED' });
    }

    // ── DISPATCHED TO THAT CLASSIFICATION'S CREATOR ───────────────
    //
    // This function holds no Amazon Chime SDK grant. Each conversational classification has its own
    // creator (`create-conversation-at-classification.ts`), whose role can create a conversation of
    // that classification only, so the reach gate above decides WHICH creator is asked and IAM bounds
    // what that creator can make. A classification with no creator is a deployment fault.
    const creator = await creatorFor(requestedClassification, timer);
    if (!creator) {
      return reply(500, { error: 'no conversation creator is deployed for this classification', code: 'SERVER_MISCONFIG' });
    }
    const request: CreateAtClassificationRequest = {
      classification: requestedClassification,
      userArn,
      ...(typeof title === 'string' && title.trim() ? { title } : {}),
      modelId: String(modelId),
      modelName: modelName === undefined ? undefined : String(modelName),
      topic: topic === undefined ? undefined : String(topic),
      triggerContext: triggerContext === undefined ? undefined : String(triggerContext),
      expirationOverride,
    };
    const { functionError, result: created } = await invokeCreator<CreateAtClassificationResult>(creator, request, timer);
    if (functionError) {
      throw new Error(`the ${requestedClassification} creator failed: ${functionError}`);
    }
    if (!created.ok) {
      // The creator's own refusals keep the codes this API has always returned.
      if (created.code === 'SERVER_MISCONFIG') return reply(500, { error: created.error, code: 'SERVER_MISCONFIG' });
      throw new Error(`the ${requestedClassification} creator refused: ${created.code}: ${created.error}`);
    }

    const now = new Date().toISOString();
    // THE RESPONSE SHAPE IS UNCHANGED, field for field. The web client reads every one of these.
    return reply(200, {
      success: true,
      conversation: {
        id: created.channelId,
        conversationArn: created.channelArn,
        // THE NAME THE ROOM WAS CREATED WITH, which for an unnamed room is the platform's placeholder.
        title: created.title ?? title,
        modelId,
        modelName,
        modelTier: requestedClassification,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    console.error('Error creating conversation:', error);
    return reply(500, {
      success: false,
      // Logged above. DEBUG_ERRORS echoes it to the caller while debugging only.
      error: DEBUG_ERRORS
        ? (error as Error).message
        : 'Could not create the conversation. Please try again; if it persists, contact an administrator.',
      code: 'CONVERSATION_CREATION_FAILED',
    });
  }
}
