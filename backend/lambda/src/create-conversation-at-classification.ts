/**
 * A CLASSIFICATION'S CONVERSATION CREATOR.
 *
 * One deployed per conversational classification, and the classification is the FUNCTION's
 * (`CREATOR_CLASSIFICATION`), never the request's. Its role can create, tag and assemble a conversation
 * of that classification only, as the service admin, so a request that names another classification is
 * refused here and would be refused by IAM besides.
 *
 * Invoked directly by the person-facing API (`create-conversation.ts`), which has already authenticated
 * the person, refused an admin-plane classification, bounded the TTL and checked the person's reach, and
 * which holds no Amazon Chime SDK grant on a conversation. This function decides nothing about the person; it
 * refuses only what is not its own to create.
 *
 * ── A PERSON'S CONVERSATION ───────────────────────────────────────────────────────────────────────
 *
 * The typed request the person-facing API sends: a new room with a generated id, with only that person in it.
 *
 * ── AND A VISITOR'S ───────────────────────────────────────────────────────────────────────────────
 *
 * A second request, `kind: 'guest'`, opens an anonymous visitor's conversation (`guest-visitor`). It is
 * sent by guest start, in the credential exchange, never by the person-facing API, and it is served only
 * by the creator of an outside classification (the guest's), the one whose stack grants that exchange
 * the invoke.
 *
 * ── AND A CUSTOMER'S, FROM A CLAIM ────────────────────────────────────────────────────────────────
 *
 * A third, `kind: 'upgrade'`, opens the conversation a path B claim lands in (`guest-upgrade.ts`), at the
 * claim target's classification only (`claimTargetOf`), tagged with the visitor's conversation.
 *
 * ── AND A BOUND VISITOR'S CONTINUATION ────────────────────────────────────────────────────────────
 *
 * A fourth, `kind: 'bind'`, opens the conversation a path A bind continues the visit in (`lib/guest-bind.ts`),
 * sent by the credential exchange for the visitor's own AppInstanceUser, at the account's classification
 * and never the visitor's (`bindTargetOf`). Its channel id is deterministic from the visitor's
 * conversation, so a retried bind re-opens the one it opened, and only when its tags name that visit and
 * that person.
 *
 * ── AND THE VISITOR'S CONVERSATION, WHEN ITS VISIT CARRIES OVER (FR26, P-12) ─────────────────────
 *
 * Two more, served only by an outside classification's creator, on a visitor's conversation of its own
 * classification (`isVisitorConversation`), and sent by the carry-over's caller (a claim, a bind) with a
 * channel ARN that caller read from its own records, never from a body:
 *
 *  - `kind: 'assess'` reads the visit's newest messages as the service admin and answers with the
 *    visitor's assistant's assessment of it (`lib/visit-assessment.ts`), on that assistant's model and
 *    prompt from its active profile version. No assessment is an answer, never a refusal of the carry-over.
 *  - `kind: 'retire'` deletes the visitor's conversation once the new one and its seed exist.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { ExpirationCriterion } from '../../lib/config/conversation-types.js';
import type { Classification } from '../../lib/config/model-strategy.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import {
  completeBoundContinuation,
  createConversationForGuest,
  createConversationForPerson,
  createConversationForUpgrade,
  isVisitorConversation,
  retireVisitorConversation,
} from './lib/channel-creation.js';
import { ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockInvokeId, getModelCatalog } from '../../lib/config/model-strategy.js';
import { concreteModel, resolveActiveProfile } from './lib/active-profile.js';
import { getIntentPack, instructionsForIntent } from './lib/intent-pack.js';
import { recentChannelMessages } from './lib/chime/history.js';
import { assessVisitConversation, VISIT_ASSESSMENT_MESSAGES, type VisitGuard, type VisitModelInvoke } from './lib/visit-assessment.js';
import { primaryAssignmentOf } from './lib/conversation-primary.js';
import { conversationNameFor, conversationNameText, PLACEHOLDER_TITLE, type ConversationNameKind } from './lib/conversation-name.js';
import { loadMessageTemplateSet } from './lib/message-template-selection.js';
import { resolveServiceAdminBearer } from './lib/service-admin-bearer.js';
import { userArnFor } from './lib/person-arn.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { bindTargetOf, claimTargetOf, GUEST_VISITOR_TYPE } from '../../lib/config/conversation-types.js';
import { boundChannelIdOf, registrationFieldsOf, UPGRADE_SOURCE_PERSON_TAG, UPGRADE_SOURCE_TAG, type VisitAssessment, type VisitRequest } from './lib/upgrade.js';
import { readChannelTags } from './lib/channel-classification.js';
import { loadProfileRegistry, useProfileRegistrySsmClient } from '../../lib/profile-registry';
import { BOUNDED_REQUEST_HANDLER } from './lib/bounded-request-handler.js';
import { useDefaultAgentsSsmClient } from './lib/default-agents.js';
import { useServiceAdminBearerSsmClient } from './lib/service-admin-bearer.js';
import { useChannelCreationMessagingClient } from './lib/channel-creation.js';
import { logPhaseTiming, phaseTimer, PrimedRead, runsInLambda, type PhaseTimer } from './lib/cold-path.js';

// ── ONE CLIENT PER SERVICE, SHARED BY EVERY MODULE THIS FUNCTION READS THROUGH ──────────────────────
//
// A cold container pays each client's first-call setup (middleware, endpoint rules, credentials, TLS) once
// per client, so the registry, the assignment records, the service admin's parameter and the channel flow
// are all read through this one SSM client, and the conversation is assembled through this one messaging
// client. Bounded, like the clients those modules build for themselves, and with the registry's adaptive
// retry, so the cold starts of a burst back off together.
const ssmClient = new SSMClient({ requestHandler: BOUNDED_REQUEST_HANDLER, retryMode: 'adaptive', maxAttempts: 6 });
const messaging = chimeMessagingClient({ requestHandler: BOUNDED_REQUEST_HANDLER });
useProfileRegistrySsmClient(ssmClient);
useDefaultAgentsSsmClient(ssmClient);
useServiceAdminBearerSsmClient(ssmClient);
useChannelCreationMessagingClient(messaging);
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
const SSM_ROOT = process.env.SSM_ROOT || '';
const CLASSIFICATION = (process.env.CREATOR_CLASSIFICATION || '').trim();

/** What the API hands over. `classification` is checked against this function's own, never adopted. */
export interface CreateAtClassificationRequest {
  kind?: 'typed';
  classification: string;
  userArn: string;
  /** What the person called it. Absent: the room opens unnamed, with the placeholder its first message replaces. */
  title?: string;
  modelId: string;
  modelName?: string;
  topic?: string;
  triggerContext?: string;
  expirationOverride?: { days: number; criterion: ExpirationCriterion };
}

/** A visitor's conversation, requested by guest start for the visitor it minted. */
export interface CreateGuestAtClassificationRequest {
  kind: 'guest';
  classification: string;
  userArn: string;
}

/** A customer's conversation, requested by a path B claim for the account that redeemed it. */
export interface CreateUpgradeAtClassificationRequest {
  kind: 'upgrade';
  classification: string;
  userArn: string;
  sourceChannelArn: string;
  sourcePersonArn: string;
  seed: Record<string, unknown>;
}

/** A bound visitor's continuation, requested by the credential exchange after a path A bind. */
export interface CreateBindAtClassificationRequest {
  kind: 'bind';
  classification: string;
  /** The visitor's AppInstanceUser, which the bind made the account's. */
  userArn: string;
  sourceChannelArn: string;
  /** The same AppInstanceUser: under path A the visitor is the person. */
  sourcePersonArn: string;
  seed: Record<string, unknown>;
}

/** The visitor's conversation, assessed or retired when its visit carries over (`lib/upgrade.ts`). */
export type VisitAtClassificationRequest = VisitRequest;

export type VisitAtClassificationResult =
  | { ok: true; assessment?: VisitAssessment }
  | { ok: false; code: 'CLASSIFICATION_MISMATCH' | 'SERVER_MISCONFIG' | 'INVALID_REQUEST' | 'NOT_A_VISIT' | 'NO_ASSESSMENT' | 'RETIRE_FAILED'; error: string };

export type CreateAtClassificationResult =
  | { ok: true; channelArn: string; channelId: string; /** The name the room was created with, where the creator chose it. */ title?: string }
  | { ok: false; code: 'CLASSIFICATION_MISMATCH' | 'SERVER_MISCONFIG' | 'INVALID_REQUEST' | 'CONVERSATION_CREATION_FAILED'; error: string };

let cachedFlowArn: string | null = null;

async function flowArn(): Promise<string> {
  if (cachedFlowArn !== null) return cachedFlowArn;
  if (!CHANNEL_FLOW_ARN_PARAM) return (cachedFlowArn = '');
  try {
    cachedFlowArn = (await ssmClient.send(new GetParameterCommand({ Name: CHANNEL_FLOW_ARN_PARAM }))).Parameter?.Value || '';
  } catch (err) {
    console.warn('[CreateConversationAtClassification] could not read the channel flow', { message: (err as Error)?.message });
    return '';
  }
  return cachedFlowArn;
}

// ── STARTED WHILE THE MODULE LOADS (lib/cold-path.ts) ───────────────────────────────────────────────
//
// Every creation needs the same three reads before it can act: the classification's primary assistant, the
// channel flow and the service admin. A cold container starts all three, and the registry the assignment
// records are parsed against, during Init, and the first request takes what is already in flight. The
// assignment read waits for the registry because a runtime assistant's record is read against it; the
// other two do not, so they run beside it. Each is taken once and only while fresh, then read through its
// own cache as before, and a priming that failed or found nothing is read again once.
const primedPrimary = new PrimedRead('primary assistant', async () => {
  await loadProfileRegistry();
  return primaryAssignmentOf(CLASSIFICATION);
});
const primedFlowArn = new PrimedRead('channel flow', flowArn, { unusable: (arn) => !arn });
const primedBearer = new PrimedRead('service admin', resolveServiceAdminBearer, { unusable: (arn) => !arn });

/** Start the reads every creation needs. Run at module load in a deployed function; exported for tests. */
export function primeColdPath(): void {
  if (!CLASSIFICATION || !APP_INSTANCE_ARN) return;
  primedPrimary.prime();
  primedFlowArn.prime();
  primedBearer.prime();
}
if (runsInLambda()) primeColdPath();

/**
 * The three reads every creation needs, each timed, and the room's name where the room is opened for a purpose. A
 * primary that cannot be read is `null`. The name's template read follows the primary (it is worded by the primary's
 * own templates) and runs beside the channel flow and service admin reads, so it adds no step of its own.
 */
function creationReads(timer: PhaseTimer, naming?: { kind: ConversationNameKind; typeKey: string }) {
  const primary = timer.time('primaryAssistant', () => primedPrimary.get()).catch(() => null);
  return Promise.all([
    primary,
    timer.time('channelFlow', () => primedFlowArn.get()),
    timer.time('serviceAdmin', () => primedBearer.get()),
    naming ? primary.then((p) => roomName(naming.kind, naming.typeKey, p?.assistant, timer)) : Promise.resolve(''),
  ]);
}

/**
 * THE NAME A ROOM THIS CREATOR OPENS FOR A PURPOSE IS CREATED WITH (`conversation-name.ts`): the type's own `name`, else
 * the `conversation-name` template's section for the kind of room, worded by the room's assistant's templates, then the
 * classification's, then the shipped one. A store that cannot be read leaves the shipped wording, never the creation.
 */
async function roomName(kind: ConversationNameKind, typeKey: string, assistant: string | undefined, timer: PhaseTimer): Promise<string> {
  const templates = await timer.time('nameTemplates', () => loadMessageTemplateSet({ classification: CLASSIFICATION, ...(assistant ? { assistant } : {}) }))
    .catch((err) => {
      console.warn('[CreateConversationAtClassification] the room\'s name templates could not be read; the shipped wording names it', { err: (err as Error)?.name });
      return undefined;
    });
  return conversationNameFor({ kind, typeKey, ...(templates ? { words: { templates } } : {}) });
}

/** True until this container has served its first request. */
let coldContainer = true;

export function handler(req: CreateGuestAtClassificationRequest): Promise<CreateAtClassificationResult>;
export function handler(req: CreateUpgradeAtClassificationRequest): Promise<CreateAtClassificationResult>;
export function handler(req: CreateBindAtClassificationRequest): Promise<CreateAtClassificationResult>;
export function handler(req: VisitAtClassificationRequest): Promise<VisitAtClassificationResult>;
export function handler(req: CreateAtClassificationRequest): Promise<CreateAtClassificationResult>;
export async function handler(
  req: CreateAtClassificationRequest | CreateGuestAtClassificationRequest
    | CreateUpgradeAtClassificationRequest | CreateBindAtClassificationRequest | VisitAtClassificationRequest,
): Promise<CreateAtClassificationResult | VisitAtClassificationResult> {
  const timer = phaseTimer();
  const cold = coldContainer;
  coldContainer = false;
  let result: CreateAtClassificationResult | VisitAtClassificationResult | undefined;
  try {
    // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
    await timer.time('registry', async () => { await loadProfileRegistry(); });
    result = await dispatch(req, timer);
    return result;
  } finally {
    logPhaseTiming('conversation-creator', timer, {
      cold,
      kind: req?.kind ?? 'typed',
      classification: CLASSIFICATION,
      ok: result?.ok ?? false,
      ...(result && !result.ok ? { code: result.code } : {}),
    });
  }
}

async function dispatch(
  req: CreateAtClassificationRequest | CreateGuestAtClassificationRequest
    | CreateUpgradeAtClassificationRequest | CreateBindAtClassificationRequest | VisitAtClassificationRequest,
  timer: PhaseTimer,
): Promise<CreateAtClassificationResult | VisitAtClassificationResult> {
  // A FUNCTION WITH NO CLASSIFICATION, OR AN ADMIN-PLANE ONE, CREATES NOTHING. The stack builds one per
  // conversational classification, so either is a deployment fault.
  if (!CLASSIFICATION || !profiles.isConversational(CLASSIFICATION) || !APP_INSTANCE_ARN) {
    console.error('[CreateConversationAtClassification] not configured', { classification: CLASSIFICATION });
    return { ok: false, code: 'SERVER_MISCONFIG', error: 'this creator is not configured for a conversational classification' };
  }
  // THE REQUEST NAMES THE CLASSIFICATION IT WANTS, AND IT MUST BE THIS ONE. Dispatch chose this function
  // by that value, so a mismatch is a dispatch fault or a forged call; either way nothing is created.
  if (req?.classification !== CLASSIFICATION) {
    console.error('[CreateConversationAtClassification][SecurityEvent] refused a request for another classification', {
      own: CLASSIFICATION, requested: req?.classification,
    });
    return { ok: false, code: 'CLASSIFICATION_MISMATCH', error: `this creator creates ${CLASSIFICATION} conversations only` };
  }
  if (req.kind === 'guest') return createGuestConversation(req, timer);
  if (req.kind === 'upgrade') return createUpgradeConversation(req, timer);
  if (req.kind === 'bind') return createBoundConversation(req, timer);
  if (req.kind === 'assess' || req.kind === 'retire') return visitRequest(req);
  // AN ORDINARY CREATE NAMES NO KIND, so a kind this creator does not serve opens nothing.
  if ((req as { kind?: unknown }).kind !== undefined) return { ok: false, code: 'INVALID_REQUEST', error: 'this creator does not serve that kind of request' };
  return createTypedConversation(req as CreateAtClassificationRequest, timer);
}

// ── THE VISITOR'S CONVERSATION, WHEN ITS VISIT CARRIES OVER ──────────────────────────────────────

/** The visitor's assistant's model and prompt, from its active profile version (the profile seam). */
async function visitModel(): Promise<{ modelId: string; persona?: string; instructions?: string; guardrailId?: string }> {
  const primary = await primaryAssignmentOf(CLASSIFICATION);
  const active = await resolveActiveProfile(primary.assistant, { ssm: ssmClient, ssmRoot: SSM_ROOT });
  const key = concreteModel(active.models?.default) ?? active.profile.modelKey;
  const def = (getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '') as Record<string, Parameters<typeof bedrockInvokeId>[0] | undefined>)[key];
  return {
    modelId: def ? bedrockInvokeId(def) : '',
    persona: active.persona,
    instructions: instructionsForIntent('conversation_summary', active.intentPack ?? getIntentPack()),
    ...(active.guardrailId ? { guardrailId: active.guardrailId } : {}),
  };
}

/**
 * THE VISITOR CLASSIFICATION'S GUARDRAIL: the one its active version selects, else its default, read by name
 * at call time from the catalog its assistant stack publishes (`/assistant/<classification>/guardrails`),
 * because that stack deploys after this one. The grant reaches only guardrails tagged with this
 * classification.
 */
async function visitGuardrail(selected?: string): Promise<{ id: string; version: string }> {
  if (selected) return { id: selected, version: 'DRAFT' };
  const raw = (await ssmClient.send(new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${CLASSIFICATION}/guardrails` })))?.Parameter?.Value;
  const catalog = JSON.parse(raw || '[]') as Array<{ key?: string; guardrailId?: string; guardrailVersion?: string }>;
  const entry = catalog.find((e) => e.key === 'default');
  if (!entry?.guardrailId) throw new Error('the visitor classification publishes no default guardrail');
  return { id: entry.guardrailId, version: entry.guardrailVersion || 'DRAFT' };
}

/** What the model wrote, through that guardrail as model output. */
const guardVisit = (selected?: string): VisitGuard => async (texts) => {
  const g = await visitGuardrail(selected);
  const res = await (bedrock ??= new BedrockRuntimeClient({})).send(new ApplyGuardrailCommand({
    guardrailIdentifier: g.id,
    guardrailVersion: g.version,
    source: 'OUTPUT',
    content: texts.map((text) => ({ text: { text } })),
  }));
  return res.action === 'GUARDRAIL_INTERVENED' ? 'blocked' : 'pass';
};

let bedrock: BedrockRuntimeClient | null = null;
const converse: VisitModelInvoke = async ({ modelId, system, user, maxTokens, signal }) => {
  const res = await (bedrock ??= new BedrockRuntimeClient({})).send(new ConverseCommand({
    modelId,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { maxTokens, temperature: 0.2 },
  }), { abortSignal: signal });
  return (res.output?.message?.content ?? []).map((c) => ('text' in c && c.text ? c.text : '')).join('');
};

async function visitRequest(req: VisitAtClassificationRequest): Promise<VisitAtClassificationResult> {
  const channelArn = String(req.channelArn || '');
  if (!channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) return { ok: false, code: 'INVALID_REQUEST', error: 'channelArn names a conversation of this instance' };
  // ONLY AN OUTSIDE CLASSIFICATION'S CREATOR, ON A VISITOR'S CONVERSATION OF ITS OWN CLASSIFICATION.
  if (!profiles.outsideClassificationValues().includes(CLASSIFICATION)) {
    console.error('[CreateConversationAtClassification][SecurityEvent] a visit request reached a members classification\'s creator', { classification: CLASSIFICATION, kind: req.kind });
    return { ok: false, code: 'CLASSIFICATION_MISMATCH', error: 'this creator holds no visitor\'s conversation' };
  }
  try {
    const bearerArn = await resolveServiceAdminBearer();
    if (!bearerArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no service admin is configured' };
    if (req.kind === 'retire') {
      await retireVisitorConversation(messaging, { appInstanceArn: APP_INSTANCE_ARN, channelArn, classification: CLASSIFICATION, bearerArn });
      console.log(JSON.stringify({ _auditEvent: 'visitor_conversation_retired', channelArn, classification: CLASSIFICATION }));
      return { ok: true };
    }
    if (!(await isVisitorConversation(messaging, { appInstanceArn: APP_INSTANCE_ARN, channelArn, classification: CLASSIFICATION }))) {
      console.error('[CreateConversationAtClassification][SecurityEvent] an assessment was asked of a conversation that is not a visit of this classification', { channelArn });
      return { ok: false, code: 'NOT_A_VISIT', error: 'only a visitor\'s conversation of this classification is assessed here' };
    }
    const [messages, model] = await Promise.all([
      recentChannelMessages(messaging, channelArn, bearerArn, VISIT_ASSESSMENT_MESSAGES),
      visitModel(),
    ]);
    const fields = req.fields && typeof req.fields === 'object' ? registrationFieldsOf(req.fields) : null;
    const { guardrailId, ...prompt } = model;
    const assessment = await assessVisitConversation({ messages, fields, ...prompt }, converse, guardVisit(guardrailId));
    return assessment ? { ok: true, assessment } : { ok: false, code: 'NO_ASSESSMENT', error: 'the visit could not be assessed' };
  } catch (err) {
    console.warn('[CreateConversationAtClassification] the visit request could not be served', { kind: req.kind, err: (err as Error)?.name || (err as Error)?.message });
    return req.kind === 'retire'
      ? { ok: false, code: 'RETIRE_FAILED', error: (err as Error)?.message || 'the conversation could not be deleted' }
      : { ok: false, code: 'NO_ASSESSMENT', error: (err as Error)?.message || 'the visit could not be read' };
  }
}

async function createTypedConversation(req: CreateAtClassificationRequest, timer: PhaseTimer): Promise<CreateAtClassificationResult> {
  // The person is an AppInstanceUser of this instance; the API composed the ARN from the JWT's `sub`.
  if (!req.userArn?.startsWith(userArnFor(APP_INSTANCE_ARN, '')) || !req.modelId) {
    return { ok: false, code: 'INVALID_REQUEST', error: 'userArn and modelId are required' };
  }
  // A ROOM ASKED FOR WITH NO TITLE OPENS UNNAMED: the server writes the platform's placeholder, which the first message
  // replaces (`conversation-name.ts`). A client never sends the placeholder itself, so its language cannot decide it.
  const title = conversationNameText(typeof req.title === 'string' ? req.title : '') || PLACEHOLDER_TITLE;
  try {
    const [primary, channelFlowArn, creatorBearerArn] = await creationReads(timer);
    const botArn = primary?.botArn || '';
    if (!botArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no assistant is published for this classification' };
    // NO SERVICE ADMIN, NO CONVERSATION (step 33): never created as an assistant instead.
    if (!creatorBearerArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no service admin is configured to create conversations' };
    const created = await createConversationForPerson({
      appInstanceArn: APP_INSTANCE_ARN,
      botArn,
      userArn: req.userArn,
      classification: CLASSIFICATION as Classification,
      title,
      modelId: String(req.modelId),
      modelName: req.modelName,
      topic: req.topic,
      triggerContext: req.triggerContext,
      channelFlowArn,
      expirationOverride: req.expirationOverride,
      creatorBearerArn,
      timer,
    });
    return { ok: true, channelArn: created.channelArn, channelId: created.channelId, title };
  } catch (err) {
    console.error('[CreateConversationAtClassification] creation failed', { message: (err as Error)?.message });
    return { ok: false, code: 'CONVERSATION_CREATION_FAILED', error: (err as Error)?.message || 'creation failed' };
  }
}

// ── A VISITOR'S CONVERSATION ─────────────────────────────────────────────────────────────────────

async function createGuestConversation(req: CreateGuestAtClassificationRequest, timer: PhaseTimer): Promise<CreateAtClassificationResult> {
  // ONLY AN OUTSIDE CLASSIFICATION'S CREATOR OPENS A VISITOR'S CONVERSATION.
  if (!profiles.outsideClassificationValues().includes(CLASSIFICATION)) {
    console.error('[CreateConversationAtClassification][SecurityEvent] a visitor request reached a members classification\'s creator', { classification: CLASSIFICATION });
    return { ok: false, code: 'CLASSIFICATION_MISMATCH', error: `this creator does not open visitors' conversations` };
  }
  if (!req.userArn?.startsWith(userArnFor(APP_INSTANCE_ARN, ''))) return { ok: false, code: 'INVALID_REQUEST', error: 'userArn is required' };
  try {
    const [primary, channelFlowArn, creatorBearerArn, name] = await creationReads(timer, { kind: 'visitor', typeKey: GUEST_VISITOR_TYPE });
    const botArn = primary?.botArn || '';
    if (!botArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no assistant is published for this classification' };
    if (!creatorBearerArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no service admin is configured to create conversations' };
    if (!channelFlowArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no channel flow is published, so the conversation could not be addressed' };
    const modelId = profiles.profileFor(CLASSIFICATION)?.modelKey || '';
    const created = await createConversationForGuest({
      name,
      appInstanceArn: APP_INSTANCE_ARN,
      botArn,
      userArn: req.userArn,
      classification: CLASSIFICATION as Classification,
      modelId,
      channelFlowArn,
      creatorBearerArn,
      timer,
    });
    return { ok: true, channelArn: created.channelArn, channelId: created.channelId };
  } catch (err) {
    console.error('[CreateConversationAtClassification] the visitor\'s conversation could not be created', { message: (err as Error)?.message });
    return { ok: false, code: 'CONVERSATION_CREATION_FAILED', error: (err as Error)?.message || 'creation failed' };
  }
}

// ── A CUSTOMER'S CONVERSATION, FROM A CLAIM ──────────────────────────────────────────────────────

async function createUpgradeConversation(req: CreateUpgradeAtClassificationRequest, timer: PhaseTimer): Promise<CreateAtClassificationResult> {
  // ONLY THE CLAIM TARGET'S CREATOR OPENS ONE, at the one classification the target type permits.
  const target = claimTargetOf(GUEST_VISITOR_TYPE);
  if (!target || target.classification !== CLASSIFICATION) {
    console.error('[CreateConversationAtClassification][SecurityEvent] an upgrade request reached a creator that is not the claim target\'s', { classification: CLASSIFICATION });
    return { ok: false, code: 'CLASSIFICATION_MISMATCH', error: 'this creator does not open a claimed conversation' };
  }
  const userPrefix = userArnFor(APP_INSTANCE_ARN, '');
  if (!req.userArn?.startsWith(userPrefix) || !req.sourcePersonArn?.startsWith(userPrefix) || req.userArn === req.sourcePersonArn
    || !req.sourceChannelArn?.startsWith(`${APP_INSTANCE_ARN}/channel/`) || !req.seed || typeof req.seed !== 'object') {
    return { ok: false, code: 'INVALID_REQUEST', error: 'userArn, sourceChannelArn, sourcePersonArn and seed are required' };
  }
  try {
    const [primary, channelFlowArn, creatorBearerArn, name] = await creationReads(timer, { kind: 'customer', typeKey: target.typeKey });
    const botArn = primary?.botArn || '';
    if (!botArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no assistant is published for this classification' };
    if (!creatorBearerArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no service admin is configured to create conversations' };
    if (!channelFlowArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no channel flow is published, so the conversation could not be addressed' };
    const created = await createConversationForUpgrade({
      name,
      appInstanceArn: APP_INSTANCE_ARN,
      botArn,
      userArn: req.userArn,
      classification: CLASSIFICATION as Classification,
      typeKey: target.typeKey,
      sourceChannelArn: req.sourceChannelArn,
      sourcePersonArn: req.sourcePersonArn,
      seed: req.seed,
      modelId: profiles.profileFor(CLASSIFICATION)?.modelKey || '',
      channelFlowArn,
      creatorBearerArn,
      timer,
    });
    return { ok: true, channelArn: created.channelArn, channelId: created.channelId };
  } catch (err) {
    console.error('[CreateConversationAtClassification] the claimed conversation could not be created', { message: (err as Error)?.message });
    return { ok: false, code: 'CONVERSATION_CREATION_FAILED', error: (err as Error)?.message || 'creation failed' };
  }
}

// ── A BOUND VISITOR'S CONTINUATION, FROM A BIND ──────────────────────────────────────────────────

async function createBoundConversation(req: CreateBindAtClassificationRequest, timer: PhaseTimer): Promise<CreateAtClassificationResult> {
  // NEVER AT THE VISITOR'S CLASSIFICATION, and only where a type continues a visit at this one.
  const target = bindTargetOf(GUEST_VISITOR_TYPE, CLASSIFICATION);
  if (!target) {
    console.error('[CreateConversationAtClassification][SecurityEvent] a bind reached a creator no visit continues at', { classification: CLASSIFICATION });
    return { ok: false, code: 'CLASSIFICATION_MISMATCH', error: 'this creator does not continue a bound visit' };
  }
  const userPrefix = userArnFor(APP_INSTANCE_ARN, '');
  if (!req.userArn?.startsWith(userPrefix) || req.userArn !== req.sourcePersonArn
    || !req.sourceChannelArn?.startsWith(`${APP_INSTANCE_ARN}/channel/`) || !req.seed || typeof req.seed !== 'object') {
    return { ok: false, code: 'INVALID_REQUEST', error: 'userArn, sourceChannelArn, the same sourcePersonArn and seed are required' };
  }
  const channelId = boundChannelIdOf(req.sourceChannelArn);
  const channelArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;
  try {
    const [primary, channelFlowArn, creatorBearerArn, name] = await creationReads(timer, { kind: 'customer', typeKey: target.typeKey });
    const botArn = primary?.botArn || '';
    if (!botArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no assistant is published for this classification' };
    if (!creatorBearerArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no service admin is configured to create conversations' };
    if (!channelFlowArn) return { ok: false, code: 'SERVER_MISCONFIG', error: 'no channel flow is published, so the conversation could not be addressed' };
    try {
      const created = await createConversationForUpgrade({
        name,
        appInstanceArn: APP_INSTANCE_ARN,
        botArn,
        userArn: req.userArn,
        classification: CLASSIFICATION as Classification,
        typeKey: target.typeKey,
        sourceChannelArn: req.sourceChannelArn,
        sourcePersonArn: req.sourcePersonArn,
        seed: req.seed,
        channelId,
        modelId: profiles.profileFor(CLASSIFICATION)?.modelKey || '',
        channelFlowArn,
        creatorBearerArn,
        timer,
      });
      return { ok: true, channelArn: created.channelArn || channelArn, channelId };
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
    }
    // IT EXISTS: a retried bind. Re-opened only when it is this visit's continuation for this person, read
    // from its tags, which only a creator writes. Another classification's channel is not readable here.
    const tags = await readChannelTags(messaging, channelArn);
    if (tags[UPGRADE_SOURCE_TAG] !== req.sourceChannelArn || tags[UPGRADE_SOURCE_PERSON_TAG] !== req.userArn) {
      console.error('[CreateConversationAtClassification][SecurityEvent] a bind channel id names a conversation that is not its continuation', { channelArn });
      return { ok: false, code: 'CONVERSATION_CREATION_FAILED', error: 'the continuation channel names another visit' };
    }
    // A creation that stopped part way is finished: its flow, its context row, the assistant and the person, each idempotent.
    await completeBoundContinuation({ channelArn, botArn, userArn: req.userArn, bearerArn: creatorBearerArn, channelFlowArn });
    return { ok: true, channelArn, channelId };
  } catch (err) {
    console.error('[CreateConversationAtClassification] a bound visitor conversation could not be opened', { message: (err as Error)?.message });
    return { ok: false, code: 'CONVERSATION_CREATION_FAILED', error: (err as Error)?.message || 'creation failed' };
  }
}
