/**
 * THE PROVISIONER: ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT (ADR-048, amended 2026-10-24).
 *
 * Every assistant's identity (its `AppInstanceBot`) and its Amazon Lex bot are built and removed here, and nowhere
 * else, on a session of `RuntimeAssistantProvisionerRole` tagged with the classification the work is at
 * (`runtimeAssistantProvisioningAllow`). That role is the only one in the app holding an identity or Amazon Lex
 * write, and only this function's role may assume it. It is core infrastructure (the `Messaging` stack, beside the
 * app instance the identities live on), because every deployment has assistants and not every deployment declares
 * `admin`. It answers three direct invokes and nothing else:
 *
 *   - `{ op: 'build', assistantId }` from `manage-assistants` (the console): build the console-created assistant
 *     whose directory entry is `provisioning`, recording each id on the entry as it exists;
 *   - `{ op: 'remove', assistantId, botArn?, lexBotId? }` from `manage-assistants`: remove the identity and the
 *     Amazon Lex bot of an assistant being retired, or of a build being undone;
 *   - `{ op: 'seed-declared', callerClassification, requestType, ... }` from a stack's seed
 *     (`seed-declared-assistants.ts`, a thin CloudFormation adapter): seed the declaration
 *     (`lib/declared-assistants.ts`).
 *
 * WHO CAN ASK, AND FOR WHAT. IAM is the first layer: `lambda:InvokeFunction` on this function is held by
 * `manage-assistants`' role and by each seed's role, and by nothing else in the app (asserted on the synthesized
 * app). No API Gateway route targets it. A Lambda function cannot see who invoked it, so a request PROVES its caller
 * (`lib/provisioner-claim.ts`): before invoking, the caller writes a claim carrying the digest of the exact request
 * under `{root}/provisioner-claims/seed/{classification}/` (that classification's seed role alone may write there,
 * granted in the classification's own stack) or `{root}/provisioner-claims/console/` (`manage-assistants`' role
 * alone). This function reads the claim at the path the request's own caller writes, and refuses a request whose
 * claim is missing, stale or written for another request. So a principal that may invoke this function cannot ask
 * in another's name: IAM refuses it the write that would prove it. The rest is checked here against the directory
 * and the registry rather than the request:
 *
 *   - the request must be exactly one of the three shapes; anything else (an API Gateway event included) is refused;
 *   - `build` and `remove` are the console's, and `seed-declared` is the seed's of the classification it names;
 *   - `build` builds only an entry that is `provisioning`, was created in the console, and is at a conversational
 *     classification other than the admin plane, which only the console's validated create writes;
 *   - `remove` removes only ids the assistant's own entry or record carries, and never an `active` assistant's: an
 *     assistant is marked `retiring` (a write the seeds cannot make) before its identity can be removed;
 *   - `seed-declared` refuses a declaration for a classification other than the one its claim proves, a
 *     classification the registry does not declare, and any assistant whose name is not the registry's own name
 *     for its classification, role and occupancy. A removal touches only entries the directory records as declared
 *     at that classification.
 *
 * WHY A CLAIM AND NOT AN ALIAS PER CLASSIFICATION. An alias each seed alone may invoke would put every
 * classification on this core stack (an alias pins a version this stack publishes), so adding a classification
 * would change the core. A claim path is granted by the classification's own stack, on its own seed's role, and
 * this function's read of it names no classification at all.
 */
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { LexModelsV2Client } from '@aws-sdk/client-lex-models-v2';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { loadProfileRegistry, refreshProfileRegistry, defaultProfileRegistry } from '../../lib/profile-registry';
import { chimeIdentityClient } from './lib/chime/clients.js';
import {
  buildIdentity,
  removeBuilt,
  deleteIdentity,
  deleteLexBot,
  lexBotNameFor,
  type ProvisionerClients,
} from './lib/assistant-provisioner.js';
import { claimRefusal } from './lib/provisioner-claim.js';
import {
  directoryParamName,
  runtimeAssignmentParamName,
  readDirectoryEntry,
  type DirectoryEntry,
} from './lib/runtime-directory.js';
import { seed, checkDeclaration, type Declaration, type SeedResult } from './lib/declared-assistants.js';
import { ASSISTANT_ID_PATTERN } from './lib/assistant-acting-policy.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || '';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
/** The one role Amazon Lex runs every assistant's bot as. */
const LEX_BOT_ROLE_ARN = process.env.RUNTIME_LEX_BOT_ROLE_ARN || '';
/** The session role every build and removal runs on, assumed with the classification as a session tag. */
const PROVISIONER_ROLE_ARN = process.env.RUNTIME_PROVISIONER_ROLE_ARN || '';
/** Every assistant's Amazon Lex bot writes its text conversation logs here. */
const LEX_CONVERSATION_LOG_GROUP_ARN = process.env.LEX_CONVERSATION_LOG_GROUP_ARN || '';
/** A fulfillment function must be one of this deployment's. */
const FUNCTION_PREFIX = process.env.ROUTER_FUNCTION_PREFIX || '';
/** Prefixes each declared assistant's Amazon Lex bot name, so two instances in one account never collide. */
const LEX_BOT_NAME_PREFIX = process.env.LEX_BOT_NAME_PREFIX || 'ae';
/** The ownership function, when the deployment has one (`admin`): it seeds a declared owner onto a new identity. */
const OWNERSHIP_FUNCTION_NAME = process.env.OWNERSHIP_FUNCTION_NAME || '';

const ssm = new SSMClient({ region: REGION });
const sts = new STSClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

// ── THE REQUESTS ───────────────────────────────────────────────────────────────────────────────────

/** Every request carries the id of the claim its caller wrote for it (`lib/provisioner-claim.ts`). */
interface Claimed { claim?: string }
export interface BuildRequest extends Claimed { op: 'build'; assistantId: string }
export interface RemoveRequest extends Claimed { op: 'remove'; assistantId: string; botArn?: string; lexBotId?: string }
export interface SeedDeclaredRequest extends Claimed {
  op: 'seed-declared';
  /** The classification the invoking seed serves, from its own environment, and the path its claim is under. */
  callerClassification: string;
  requestType: 'Create' | 'Update' | 'Delete';
  logicalResourceId: string;
  physicalResourceId?: string;
  /** The function that fulfills the declared assistants' Amazon Lex turns. */
  fulfillmentArn: string;
  declaration: Declaration;
  oldDeclaration?: Declaration;
  /**
   * True when CloudFormation is rolling back the update that wrote `oldDeclaration` (the seed reads its stack's
   * status): a role that update added is withdrawn and the assistants it built are removed, never refused.
   */
  rollback?: boolean;
}
export type ProvisionerRequest = BuildRequest | RemoveRequest | SeedDeclaredRequest;

export interface BuildAnswer {
  ok: boolean;
  lexBotId?: string;
  botArn?: string;
  /** Why the build failed; what it built is already removed, except `leftover`. */
  error?: string;
  leftover?: string[];
}

export interface RemoveAnswer {
  /** False when the identity could not be deleted; nothing else was then attempted. */
  identityGone: boolean;
  leftover: string[];
}

const SHAPES: Record<ProvisionerRequest['op'], { required: string[]; optional: string[] }> = {
  build: { required: ['op', 'assistantId', 'claim'], optional: [] },
  remove: { required: ['op', 'assistantId', 'claim'], optional: ['botArn', 'lexBotId'] },
  'seed-declared': {
    required: ['op', 'callerClassification', 'requestType', 'logicalResourceId', 'fulfillmentArn', 'declaration', 'claim'],
    optional: ['physicalResourceId', 'oldDeclaration', 'rollback'],
  },
};

/**
 * The request, or a refusal. Exactly one of the three shapes, every field of the type it must be and no field
 * besides: an API Gateway event, or any request carrying something this function does not read, is refused.
 */
export function requestOf(event: unknown): ProvisionerRequest {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('provisioner: the request is not an object');
  const e = event as Record<string, unknown>;
  const shape = typeof e.op === 'string' ? SHAPES[e.op as ProvisionerRequest['op']] : undefined;
  if (!shape || !Object.prototype.hasOwnProperty.call(SHAPES, e.op as string)) throw new Error(`provisioner: '${String(e.op)}' is not an operation`);
  const keys = Object.keys(e);
  const unknown = keys.filter((k) => !shape.required.includes(k) && !shape.optional.includes(k));
  if (unknown.length) throw new Error(`provisioner: ${e.op} takes no ${unknown.join(', ')}`);
  const missing = shape.required.filter((k) => e[k] === undefined || e[k] === null);
  if (missing.length) throw new Error(`provisioner: ${e.op} needs ${missing.join(', ')}`);
  const strings = ['assistantId', 'botArn', 'lexBotId', 'callerClassification', 'requestType', 'logicalResourceId', 'physicalResourceId', 'fulfillmentArn', 'claim'];
  for (const k of strings) if (e[k] !== undefined && typeof e[k] !== 'string') throw new Error(`provisioner: ${k} must be a string`);
  if (e.rollback !== undefined && typeof e.rollback !== 'boolean') throw new Error('provisioner: rollback must be a boolean');
  if (e.assistantId !== undefined && !ASSISTANT_ID_PATTERN.test(e.assistantId as string)) throw new Error('provisioner: assistantId is not an assistant id');
  if (e.op === 'seed-declared' && !['Create', 'Update', 'Delete'].includes(e.requestType as string)) {
    throw new Error(`provisioner: '${String(e.requestType)}' is not a CloudFormation request type`);
  }
  return e as unknown as ProvisionerRequest;
}

// ── THE SESSION ────────────────────────────────────────────────────────────────────────────────────

const sessions = new Map<string, { clients: ProvisionerClients; until: number }>();

/**
 * THE CLIENTS FOR WORK AT `classification`, on a session of the provisioner role tagged with it. The role's grant is
 * written as the session's `classification` tag, so the session reaches that classification's assistants and no
 * other's, and IAM refuses the crossing case rather than this code. Kept for most of its hour, per classification.
 */
async function sessionClients(classification: string): Promise<ProvisionerClients> {
  const held = sessions.get(classification);
  if (held && held.until > Date.now()) return held.clients;
  if (!PROVISIONER_ROLE_ARN) throw new Error('RUNTIME_PROVISIONER_ROLE_ARN is not set; no assistant is built or retired');
  const out = await sts.send(new AssumeRoleCommand({
    RoleArn: PROVISIONER_ROLE_ARN,
    RoleSessionName: `provisioner-${classification}`.slice(0, 64),
    Tags: [{ Key: 'classification', Value: classification }],
    DurationSeconds: 3600,
  }));
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('the provisioner session returned no credentials');
  const credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  const clients = {
    identity: chimeIdentityClient({ region: REGION, credentials }),
    lex: new LexModelsV2Client({ region: REGION, credentials }),
  };
  sessions.set(classification, { clients, until: Date.now() + 50 * 60_000 });
  return clients;
}

/** A fulfillment function of this deployment, or a refusal. */
function ownFunction(arn: string, what: string): string {
  const expected = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_PREFIX}`;
  if (!FUNCTION_PREFIX || !arn.startsWith(expected)) throw new Error(`the ${what} ARN is not one of this deployment's functions`);
  return arn;
}

// ── BUILD (the console) ────────────────────────────────────────────────────────────────────────────

async function routerArnFor(classification: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${classification}/router-arn` }));
  return ownFunction(res?.Parameter?.Value || '', `${classification} router`);
}

async function putEntry(assistantId: string, value: DirectoryEntry): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: directoryParamName(SSM_ROOT, assistantId), Value: JSON.stringify(value), Type: 'String', Overwrite: true }));
}

/** Why a console build of this entry is refused, or null. */
export function buildRefusal(entry: DirectoryEntry | null): string | null {
  if (!entry) return 'it has no directory entry';
  if (entry.origin === 'declared') return 'it is declared; a deploy seeds it';
  if (entry.status !== 'provisioning') return `it is ${entry.status}, not provisioning`;
  const c = entry.classification;
  const profiles = defaultProfileRegistry;
  if (!profiles.isConversational(c) || profiles.resolveClassification(c) !== c || profiles.adminPlaneValues().includes(c)) {
    return `'${c}' is not a conversational classification`;
  }
  return null;
}

export async function build(assistantId: string): Promise<BuildAnswer> {
  const entry = await readDirectoryEntry(ssm, SSM_ROOT, assistantId);
  const refusal = buildRefusal(entry);
  if (refusal) return { ok: false, error: `'${assistantId}' is not built: ${refusal}`, leftover: [] };
  const { classification, role } = entry as DirectoryEntry;
  const built: { lexBotId?: string; botArn?: string } = {};
  // Each id is on the entry as soon as it exists, still `provisioning`, so a build killed before its end leaves
  // what retire needs to remove it (`withAbandonedBuild`).
  const checkpoint = () => putEntry(assistantId, {
    ...(entry as DirectoryEntry), ...(built.lexBotId ? { lexBotId: built.lexBotId } : {}), ...(built.botArn ? { botArn: built.botArn } : {}),
  });
  let clients: ProvisionerClients | undefined;
  try {
    const routerArn = await routerArnFor(classification);
    clients = await sessionClients(classification);
    await buildIdentity(clients, {
      assistantId, classification, role,
      displayName: entry!.displayName || assistantId,
      createdAt: entry!.createdAt,
      lexBotName: lexBotNameFor(assistantId),
      description: `Runtime assistant ${assistantId} (${classification}, ${role})`,
      lexBotRoleArn: LEX_BOT_ROLE_ARN,
      fulfillmentArn: routerArn,
      logGroupArn: LEX_CONVERSATION_LOG_GROUP_ARN || undefined,
      appInstanceArn: APP_INSTANCE_ARN,
      region: REGION,
      account: ACCOUNT_ID,
      welcome: true,
    }, built, checkpoint);
    console.log(JSON.stringify({ _audit: 'assistant-provisioner', action: 'built', assistant: assistantId, classification, role, botArn: built.botArn, lexBotId: built.lexBotId }));
    return { ok: true, lexBotId: built.lexBotId, botArn: built.botArn };
  } catch (err) {
    const error = (err as Error)?.message || String(err);
    // What was built is removed here, by the principal that built it.
    const leftover = clients ? await removeBuilt(clients, APP_INSTANCE_ARN, built) : [];
    console.error('[assistant-provisioner] the build failed; what it built is removed', { assistantId, built, error, leftover });
    return { ok: false, error, leftover, ...(leftover.length ? built : {}) };
  }
}

// ── REMOVE (the console's retire, and a build being undone) ────────────────────────────────────────

/** Why a removal is refused, or null: only ids this assistant's own entry or record names, never an active one's. */
export function removeRefusal(
  entry: DirectoryEntry | null,
  record: { botArn?: string; lexBotId?: string } | null,
  req: Pick<RemoveRequest, 'botArn' | 'lexBotId'>,
): string | null {
  if (!entry) return 'it has no directory entry';
  if (entry.status === 'active' || entry.status === 'retired') return `it is ${entry.status}; mark it retiring first`;
  const known = (k: 'botArn' | 'lexBotId') => [entry[k], record?.[k]].filter(Boolean);
  if (req.botArn && !known('botArn').includes(req.botArn)) return 'the identity named is not this assistant\'s';
  if (req.lexBotId && !known('lexBotId').includes(req.lexBotId)) return 'the Amazon Lex bot named is not this assistant\'s';
  return null;
}

export async function remove(req: RemoveRequest): Promise<RemoveAnswer> {
  const entry = await readDirectoryEntry(ssm, SSM_ROOT, req.assistantId);
  let record: { botArn?: string; lexBotId?: string } | null = null;
  if (entry) {
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: runtimeAssignmentParamName(SSM_ROOT, entry.classification, entry.role, req.assistantId) }));
      record = JSON.parse(res?.Parameter?.Value || '{}');
    } catch (err) {
      if ((err as { name?: string })?.name !== 'ParameterNotFound') throw err;
    }
  }
  const refusal = removeRefusal(entry, record, req);
  if (refusal) throw new Error(`provisioner: '${req.assistantId}' is not removed: ${refusal}`);
  if (!req.botArn && !req.lexBotId) return { identityGone: true, leftover: [] };
  const clients = await sessionClients(entry!.classification);
  // The identity first: it is what can act, so it is the hard stop, and a Lex bot is never removed from under one.
  if (req.botArn && !(await deleteIdentity(clients, APP_INSTANCE_ARN, req.botArn))) {
    return { identityGone: false, leftover: [`identity ${req.botArn}`] };
  }
  const leftover: string[] = [];
  if (req.lexBotId && !(await deleteLexBot(clients, req.lexBotId))) leftover.push(`Lex bot ${req.lexBotId}`);
  console.log(JSON.stringify({ _audit: 'assistant-provisioner', action: 'removed', assistant: req.assistantId, classification: entry!.classification, botArn: req.botArn, lexBotId: req.lexBotId, leftover }));
  return { identityGone: true, leftover };
}

// ── SEED A DECLARATION (a stack's seed) ────────────────────────────────────────────────────────────

/**
 * Why a declaration is refused before anything is read or built, or null. The caller's classification (which its
 * claim proved) must be the declaration's; on a create or update the classification must be one the registry declares and every declared
 * name the registry's own for its classification, role and occupancy. A delete is held to the directory instead
 * (only entries recorded as declared at that classification are removed), because a classification being removed
 * may already have left the registry.
 */
export function seedRefusal(req: SeedDeclaredRequest): string | null {
  const c = req.declaration?.classification;
  if (req.callerClassification !== c) {
    return `the declaration names classification '${c}', and its seed serves '${req.callerClassification}'`;
  }
  if (req.requestType === 'Delete') return null;
  const profiles = defaultProfileRegistry;
  if (profiles.resolveClassification(c) !== c || !(profiles.isConversational(c) || profiles.adminPlaneValues().includes(c))) {
    return `'${c}' is not a classification this deployment's registry declares`;
  }
  for (const a of req.declaration.assistants ?? []) {
    const expected = a.occupancy === 'alt' ? profiles.altAssistantName(c, a.role) : profiles.roleAssistantName(c, a.role);
    if (expected !== a.assistantId) {
      return `'${a.assistantId}' is not the registry's ${a.occupancy === 'alt' ? 'alt' : 'assistant'} for ${c}/${a.role}${expected ? ` (it names '${expected}')` : ''}`;
    }
  }
  return null;
}

export async function seedDeclared(req: SeedDeclaredRequest): Promise<SeedResult | Record<string, never>> {
  // A ROW THIS DEPLOY HAS JUST PUBLISHED must be read, so the set is read again rather than served from the cache,
  // and a read that fails says so rather than deciding from the set read before it.
  if (req.requestType !== 'Delete') await refreshProfileRegistry();
  const refusal = seedRefusal(req);
  if (refusal) throw new Error(`provisioner: ${refusal}`);
  const classification = checkDeclaration(req.declaration, req.callerClassification).classification;
  const fulfillmentArn = req.requestType === 'Delete' ? req.fulfillmentArn : ownFunction(req.fulfillmentArn, 'fulfillment');
  const profiles = defaultProfileRegistry;
  return seed({
    ssm,
    clients: await sessionClients(classification),
    invokeOwnership: async (assistantId: string, botArn: string) => {
      if (!OWNERSHIP_FUNCTION_NAME || !profiles.profileByName(assistantId)?.ownerTeam) return;
      const out = await lambdaClient.send(new InvokeCommand({ FunctionName: OWNERSHIP_FUNCTION_NAME, Payload: Buffer.from(JSON.stringify({ op: 'seed', botArn })) }));
      if (out.FunctionError) console.error('[assistant-provisioner][SecurityEvent] the owner seed failed; the assistant stays admins-only until it is seeded', { botArn });
    },
    ssmRoot: SSM_ROOT,
    region: REGION,
    account: ACCOUNT_ID,
    appInstanceArn: APP_INSTANCE_ARN,
    classification,
    fulfillmentArn,
    lexBotRoleArn: LEX_BOT_ROLE_ARN,
    logGroupArn: LEX_CONVERSATION_LOG_GROUP_ARN || undefined,
    lexBotNamePrefix: LEX_BOT_NAME_PREFIX,
  }, {
    requestType: req.requestType,
    logicalResourceId: req.logicalResourceId,
    physicalResourceId: req.physicalResourceId,
    declaration: req.declaration,
    oldDeclaration: req.oldDeclaration,
    rollback: req.rollback === true,
  });
}

// ── THE HANDLER ────────────────────────────────────────────────────────────────────────────────────

export const handler = async (event: unknown): Promise<BuildAnswer | RemoveAnswer | SeedResult | Record<string, never>> => {
  const req = requestOf(event);
  // WHO ASKED, proven before anything else is read: the claim at the path only the request's own caller can write.
  const unproven = await claimRefusal(ssm, SSM_ROOT, req as unknown as Record<string, unknown> & { op: string });
  if (unproven) {
    console.error('[assistant-provisioner][SecurityEvent] a request did not prove its caller', { op: req.op, unproven });
    throw new Error(`provisioner: the request does not prove its caller: ${unproven}`);
  }
  await loadProfileRegistry();
  if (req.op === 'build') return build(req.assistantId);
  if (req.op === 'remove') return remove(req);
  return seedDeclared(req);
};
