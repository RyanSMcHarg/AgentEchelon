/**
 * THE ASSISTANT VEND: THE ONE PLACE AN ASSISTANT SESSION IS MINTED (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * Every step of a turn acts as the assistant the turn was routed to. That identity is a session on the
 * classification's acting role, tagged with the assistant, its assistant role and its bot. This
 * function is the only principal the acting role trusts, so it is the only thing that can produce such
 * a session, and it produces one only for a turn the router routed.
 *
 * WHAT IT CHECKS, IN ORDER:
 *   1. The routing record for the correlation id exists, is unexpired, and is for this classification.
 *      Only the router (and the battle orchestrator for a rebuttal round) can write it.
 *   2. The bot it names is an assistant of this classification, according to the assignment records,
 *      and that record names an assistant and an assistant role. The assistant and role are taken
 *      from the record, never from the caller or from the routing record.
 *   3. The assistant id is safe to substitute into an IAM path.
 *   4. The assistant's approved definition (or, for an experiment or battle variant the router recorded,
 *      the variant's) decides which session policies narrow the session (`assistant-grant.ts`). The
 *      session can only narrow: its permission is the acting role, the boundary and those policies.
 * Any failure refuses the session. There is no fallback identity: a turn that cannot be vended a
 * session does not act at all.
 *
 * WHAT IT CANNOT CHECK is whether the router chose the right assistant within this classification.
 * That decision is code, as it is for a person at the credential exchange.
 *
 * THE RESPONSE CARRIES CREDENTIALS, which is why this is a synchronous invoke and never an event: an
 * asynchronous event is kept by the Lambda service and replayed to failure destinations, and a session
 * must not travel that way.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParametersByPathCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { readTurnRouting } from './lib/turn-routing.js';
import { ASSISTANT_ID_PATTERN, botIdFromArn } from './lib/assistant-acting-policy.js';
import { grantEdgesFor, grantDefinitionOf, isSpeakRoute, SPEAK_EDGE, type GrantDefinition, type GrantCatalog } from './lib/assistant-grant.js';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { isServingRecord, runtimeSeedFor, type AssignmentRecord } from './lib/runtime-assistant.js';
import { isNoActiveVersion } from './lib/active-label.js';
import type { AssistantProfile } from '../../lib/config/profiles.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const REGION = process.env.AWS_REGION || 'us-east-1';
const CLASSIFICATION = process.env.CLASSIFICATION || '';
const TURN_ROUTING_TABLE = process.env.TURN_ROUTING_TABLE || '';
const ACTING_ROLE_ARN = process.env.ACTING_ROLE_ARN || '';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const GRANT_POLICY_PREFIX = process.env.GRANT_POLICY_PREFIX || '';

function jsonList(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
const GRANT_CATALOG: GrantCatalog = {
  edges: new Set(jsonList(process.env.GRANT_EDGES)),
  alwaysModelKeys: jsonList(process.env.GRANT_ROUTED_MODELS),
  defaultImageModelKey: process.env.GRANT_DEFAULT_IMAGE_MODEL || '',
};

const ddb = new DynamoDBClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const sts = new STSClient({ region: REGION });

export interface VendRequest {
  correlationId: string;
}

export interface VendResponse {
  ok: true;
  assistant: string;
  role: string;
  botArn: string;
  /** The definition the session was narrowed by, so the processor serves exactly that version. */
  definition?: { profileName: string; version?: number };
  /**
   * A runtime assistant's seed (ADR-048), built from its own assignment record, so the processor resolves
   * its versions without reading the record again. Non-secret: the compiled fields of a profile.
   */
  seed?: AssistantProfile;
  /** The session policies the session carries, by edge, for the audit trail. */
  grants: string[];
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string };
}

export interface VendRefusal {
  ok: false;
  reason: string;
}

interface AssistantEntry { assistant: string; role: string; runtimeSeed?: AssistantProfile }

/**
 * Which assistant each bot of this classification is, from the assignment records.
 *
 * CACHED BRIEFLY rather than for the container: an experiment arming or ending rewrites the alt's
 * record, and a turn must see that within a minute. A miss re-reads once before refusing, so a record
 * written seconds ago is not refused on a stale cache.
 */
let index: { at: number; byBot: Map<string, AssistantEntry> } | null = null;
const INDEX_TTL_MS = 60_000;

async function loadIndex(): Promise<Map<string, AssistantEntry>> {
  const byBot = new Map<string, AssistantEntry>();
  let token: string | undefined;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({
      Path: `${SSM_ROOT}/assistant-assignments/${CLASSIFICATION}`,
      Recursive: true,
      MaxResults: 10,
      NextToken: token,
    }));
    for (const p of res.Parameters || []) {
      try {
        const v = JSON.parse(p.Value || '{}') as AssignmentRecord;
        // A retiring or provisioning runtime assistant is vended nothing (ADR-048).
        if (!isServingRecord(v)) continue;
        // A runtime record vends only when it describes a valid assistant of this classification.
        const runtimeSeed = v.source === 'runtime' ? runtimeSeedFor(v, defaultProfileRegistry) : undefined;
        if (v.source === 'runtime' && (!runtimeSeed || v.classification !== CLASSIFICATION)) continue;
        if (v.botArn && v.assistant && v.role) {
          byBot.set(v.botArn, { assistant: v.assistant, role: v.role, ...(runtimeSeed ? { runtimeSeed } : {}) });
        }
      } catch {
        // A record this function cannot parse names no assistant, so it vends nothing for it.
      }
    }
    token = res.NextToken;
  } while (token);
  index = { at: Date.now(), byBot };
  return byBot;
}

async function assistantForBot(botArn: string): Promise<AssistantEntry | null> {
  const fresh = index && Date.now() - index.at < INDEX_TTL_MS ? index.byBot : await loadIndex();
  const hit = fresh.get(botArn);
  if (hit) return hit;
  // One re-read on a miss, unless the index was just loaded.
  if (index && Date.now() - index.at < 1000) return null;
  return (await loadIndex()).get(botArn) ?? null;
}

/**
 * THE APPROVED DEFINITION, the same one the processor will serve: ALWAYS the routed assistant's own.
 * An alt (`alt-{role}-{classification}`) is an assistant with its own profile (ADR-050), so it is read
 * under its own name and never under the classification's primary. Read with the `active` label, which
 * only the review flow moves. No active version means the compiled seed is served, which declares nothing
 * and so selects everything. Any other failure refuses: the vend does not guess.
 */
const definitionCache = new Map<string, { at: number; value: { profileName: string; version?: number; definition: GrantDefinition | null } }>();
const DEFINITION_TTL_MS = 30_000;

async function approvedDefinition(assistant: string): Promise<{ profileName: string; version?: number; definition: GrantDefinition | null }> {
  const profileName = assistant;
  const hit = definitionCache.get(profileName);
  if (hit && Date.now() - hit.at < DEFINITION_TTL_MS) return hit.value;
  let value: { profileName: string; version?: number; definition: GrantDefinition | null } = { profileName, definition: null };
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/assistant/${profileName}/definition:active` }));
    const raw = res.Parameter?.Value;
    if (raw) value = { profileName, version: res.Parameter?.Version, definition: grantDefinitionOf(JSON.parse(raw)) ?? null };
  } catch (err) {
    if (!isNoActiveVersion(err)) throw err;
  }
  definitionCache.set(profileName, { at: Date.now(), value });
  return value;
}

/**
 * Sessions, cached per bot. A session carries no correlation id, so every turn of one assistant can
 * share one until it nears expiry; the routing check above still runs on every call, which is the gate.
 */
const sessions = new Map<string, VendResponse>();
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export async function handler(event: VendRequest): Promise<VendResponse | VendRefusal> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const refuse = (reason: string): VendRefusal => {
    // A refusal is either a broken deployment or something asking for an identity it was not routed
    // to, and both want a person. Logged as a security event with what was asked, never with secrets.
    console.error('[AssistantVend][SecurityEvent] refused', { reason, correlationId: event?.correlationId, classification: CLASSIFICATION });
    return { ok: false, reason };
  };
  if (!CLASSIFICATION || !TURN_ROUTING_TABLE || !ACTING_ROLE_ARN || !GRANT_POLICY_PREFIX || !GRANT_CATALOG.edges.has('base')) {
    return refuse('the vend is not configured');
  }
  const correlationId = typeof event?.correlationId === 'string' ? event.correlationId : '';
  if (!correlationId) return refuse('no correlation id');

  const routing = await readTurnRouting(ddb, TURN_ROUTING_TABLE, correlationId);
  if (!routing) return refuse('no routing record for this turn');
  if (routing.classification !== CLASSIFICATION) return refuse('the routing record is for another classification');

  const entry = await assistantForBot(routing.botArn);
  if (!entry) return refuse('the routed bot is not an assistant of this classification');
  if (!ASSISTANT_ID_PATTERN.test(entry.assistant)) return refuse('the assistant id is not safe for an IAM path');
  const botId = botIdFromArn(routing.botArn);
  if (!botId) return refuse('the routed bot ARN has no bot id');

  // A NAME THE DEPLOYMENT DOES NOT DECLARE IS REFUSED, never served on another assistant's definition
  // (tenet P4, ADR-046): a declared profile, the alt of a declared role, or a runtime assistant assigned by
  // its own record (ADR-048).
  const isAlt = !!defaultProfileRegistry.roleOfAlt(entry.assistant);
  const isRuntime = !!entry.runtimeSeed && !defaultProfileRegistry.profileByName(entry.assistant) && !isAlt;
  if (!defaultProfileRegistry.profileByName(entry.assistant) && !isAlt && !isRuntime) {
    return refuse('the routed assistant names no profile this deployment declares');
  }
  let approved: { profileName: string; version?: number; definition: GrantDefinition | null };
  try {
    approved = await approvedDefinition(entry.assistant);
  } catch (err) {
    return refuse(`the assistant's approved definition could not be read (${(err as { name?: string })?.name ?? 'error'})`);
  }
  // A SPEAK ROUTE gets the speak edge alone, whatever the definition selects: the caller is a service
  // posting a notice, not a turn, and IAM lets the shared services write only speak routes (Phase 1c).
  if (isSpeakRoute(correlationId) && !GRANT_CATALOG.edges.has(SPEAK_EDGE)) return refuse('the speak edge is not deployed');
  // AN ALT SERVES THE VERSION ITS EXPERIMENT PINNED FOR THIS TURN. Its versions are published unlabelled,
  // so with no `active` label and no pinned definition on the routing record there is nothing approved to
  // narrow by, and narrowing by nothing would select everything. A speak route posts and never runs a
  // turn, so a duel's alt may still post (its placeholder, a notice, a marker edit) on the speak edge.
  if (isAlt && !approved.definition && !routing.variant?.definition && !isSpeakRoute(correlationId)) {
    return refuse('the alt has no pinned version for this turn');
  }
  // A RUNTIME ASSISTANT WITH NO ACTIVE VERSION DOES NOT ACT, ON ANY ROUTE. It has no compiled profile, so
  // there is no seed whose behavior could stand in. Posting as it would answer in the name of an assistant
  // that has no approved behavior, so a speak route is refused too, and the router names it to the person
  // and reports it instead (`reportTurnNotStarted`), rather than a fallback masking the fault.
  if (isRuntime && !approved.definition && !routing.variant?.definition) {
    return refuse('the runtime assistant has no active version');
  }
  const grants = isSpeakRoute(correlationId) ? [SPEAK_EDGE] : grantEdgesFor(approved.definition, routing.variant, GRANT_CATALOG);

  // Keyed by what the session IS: the bot, the definition version it was narrowed by, and the grants.
  // An activation or a different variant changes the key, so a narrowed session never outlives the
  // definition that narrowed it.
  const cacheKey = `${routing.botArn}|${approved.version ?? 'seed'}|${grants.join(',')}`;
  const cached = sessions.get(cacheKey);
  if (cached && cached.assistant === entry.assistant && cached.role === entry.role
    && Date.parse(cached.credentials.expiration) - REFRESH_MARGIN_MS > Date.now()) {
    return cached;
  }

  const res = await sts.send(new AssumeRoleCommand({
    RoleArn: ACTING_ROLE_ARN,
    RoleSessionName: `${entry.assistant}-${botId.slice(0, 8)}`.slice(0, 64),
    SourceIdentity: entry.assistant,
    // Literal keys, so an auditor reading this call sees exactly what the trust policy and the
    // acting role's statements compare. They are the `SESSION_TAG` names.
    Tags: [
      { Key: 'assistant', Value: entry.assistant },
      { Key: 'classification', Value: CLASSIFICATION },
      { Key: 'role', Value: entry.role },
      { Key: 'bot', Value: botId },
    ],
    // THE NARROWING: the session is the acting role intersected with these.
    PolicyArns: grants.map((edge) => ({ arn: `${GRANT_POLICY_PREFIX}${edge}` })),
    DurationSeconds: 3600,
  }));
  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    return refuse('STS returned no credentials');
  }
  const out: VendResponse = {
    ok: true,
    assistant: entry.assistant,
    role: entry.role,
    botArn: routing.botArn,
    ...(approved.version !== undefined ? { definition: { profileName: approved.profileName, version: approved.version } } : {}),
    ...(isRuntime && entry.runtimeSeed ? { seed: entry.runtimeSeed } : {}),
    grants,
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration.toISOString(),
    },
  };
  sessions.set(cacheKey, out);
  // PACKED SIZE, logged because it is a limit of its own: STS compresses the session policies and tags and
  // refuses the call past 100 percent. The number of policy ARNs is bounded by `grantEdgesFor`; this is not.
  console.log('[AssistantVend] vended', { assistant: entry.assistant, role: entry.role, definition: out.definition, grants, packedPolicySize: res.PackedPolicySize });
  return out;
}

/** For tests. */
export function resetVendCaches(): void {
  index = null;
  sessions.clear();
  definitionCache.clear();
}
