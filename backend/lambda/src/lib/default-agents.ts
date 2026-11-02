/**
 * WHICH ASSISTANTS A CONVERSATION TYPE ADDS, resolved from handle to bot ARN.
 *
 * A conversation type names its assistants by HANDLE - `advisor`, `ops-premium` - because a handle is
 * stable across deploys and a bot ARN is not: the `AppInstanceBot` is created per deployment, so a
 * config file holding one would be a config file that is wrong in every other account. The mapping
 * lives in the assignment records, which are the authority on which assistant holds which role
 * (`/{root}/assistant-assignments/{classification}/{role}/assistants/{assistant}`, and `.../{role}/alt` for a duel's alt).
 *
 * ── THE ASSIGNMENT RECORDS, NOT THE PRIMARY'S BOT-ARN KEY ────────────────────────────────────────
 *
 * A classification also publishes its primary's bot at `/{root}/assistant/{classification}/bot-arn`,
 * and using that for the primary and the assignment records for everyone else would special-case the
 * one handle that happens to be a classification's default. Those two paths are not interchangeable -
 * one is a role's assigned assistant and the other is a deployment's pointer - and the coincidence that each
 * shipped classification has a profile of the same name is exactly what hides the difference. One
 * resolver, one source, both handles.
 *
 * ── `live` ASSISTANTS ONLY ───────────────────────────────────────────────────────────────────────
 *
 * Each role publishes a `live` record and an `alt` record; the alt is the challenger a duel arms and is
 * empty between battles. Adding an alt would put a conversation in the hands of an assistant that
 * exists only while an experiment is running, so an `alt` record is never a match however well its
 * `assistant` name reads.
 *
 * ── AN UNRESOLVED HANDLE IS A REFUSAL, AND THAT IS THE POINT ─────────────────────────────────────
 *
 * The `ops` type's second assistant is built only where the deployment declares its role (`ops-premium` in
 * `profiles`). Without that there is no assignment and no bot, and the tolerant answer - add
 * whoever resolved, log the rest - delivers a conversation that looks right, is named right, and is
 * missing the assistant it was created for. Nobody reads a log to discover that. So this throws, the
 * creation fails, and the caller reports it (ADR-053 Phase 1: "an agent handle that resolves to no
 * assignment record is refused rather than producing a conversation with one assistant in it").
 *
 * ── SCOPED TO ONE CLASSIFICATION'S SUBTREE ──────────────────────────────────────────────────────
 *
 * The read is `GetParametersByPath` under a single classification, which is also the whole of the
 * caller's IAM grant, so a handle cannot resolve to an assistant in another classification even if a
 * deployment names two assistants the same. `(premium, ops)` and `(standard, ops)` are different role
 * instances with different scopes, and a resolver that searched both would let a type add the wrong
 * one (config/profiles.ts is explicit about this).
 */
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { isServingRecord, runtimeSeedFor, type AssignmentRecord } from './runtime-assistant.js';
import type { AssistantProfile } from '../../../lib/config/profiles.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';

let ssmClient: Pick<SSMClient, 'send'> = sessionClient(SSMClient, { requestHandler: BOUNDED_REQUEST_HANDLER });

/**
 * READ THE ASSIGNMENT RECORDS THROUGH THE HANDLER'S OWN SSM CLIENT. A cold function pays each client's first-call
 * setup once, so a handler that holds one hands it here (`create-conversation-at-classification.ts`). Optional:
 * without it the records are read through this module's turn-aware client, which a router turn needs.
 */
export function useDefaultAgentsSsmClient(client: Pick<SSMClient, 'send'>): void {
  ssmClient = client;
}

/** SSM namespace root, matching every other publisher. */
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

/** One resolved assistant: the handle the type named, and what it takes to add it. */
export interface ResolvedAgent {
  /** The handle as the conversation type spells it. */
  handle: string;
  /** The `AppInstanceBot` ARN to add as a channel member. */
  botArn: string;
  /** The assistant's role (`primary`, `ops`, ...), for the log line and the notification copy. */
  role: string;
  /** A runtime assistant's seed, from its record (ADR-048). Absent for a deploy-time assistant. */
  runtimeSeed?: AssistantProfile;
}

/**
 * Read every live assignment record for one classification, keyed by assistant handle.
 *
 * PAGED, because `GetParametersByPath` returns ten by default and a classification's assistants are not
 * bounded: each role publishes a live and an alt record, so four roles already exceed one page. A
 * handle that fell off the end would resolve to nothing and turn into the refusal below - a creation
 * failing for a reason that is nowhere in the payload.
 *
 * NOT CACHED. A role's live assistant changes when an experiment arms, and this runs once per conversation
 * created rather than once per turn, so a container-lifetime cache would buy nothing measurable and
 * could add yesterday's assistant.
 */
/**
 * Live assistants per classification, for the container's life.
 *
 * ADDED BECAUSE TWO READERS OF ONE FACT DISAGREED. The processor caches its bot-to-assistant resolution and
 * this one did not, so a turn addressed to a non-own bot paid a full paged `GetParametersByPath` while
 * the processor paid nothing for the same answer. An assistant's role and ARN change on a deploy and a
 * role's live assistant when an experiment arms, so neither is per turn.
 *
 * IT IS ALSO WHAT MAKES THE DELEGATION GATE FREE. "Could this conversation hold a roommate at all" is
 * answered from this map, so a deployment with one assistant per classification - which is every
 * deployment that has not asked for a second - reaches the roster read never.
 */
const assistantsByClassification = new Map<string, { at: number; assistants: Map<string, ResolvedAgent>; alts: Map<string, string> }>();
const ASSISTANTS_TTL_MS = 60_000;

/** Drop the container cache. Tests only. */
export function __resetAssistantCacheForTests(): void {
  assistantsByClassification.clear();
}

/**
 * Every live assistant in one classification, keyed by assistant handle. THROWS on an unreadable record set,
 * for a caller that must not mistake an outage for a classification with no assistants
 * (`lib/conversation-primary.ts`).
 */
export async function liveAssistantsByHandleOrThrow(classification: string): Promise<Map<string, ResolvedAgent>> {
  return liveAssistantsByHandle(classification);
}

async function liveAssistantsByHandle(classification: string): Promise<Map<string, ResolvedAgent>> {
  return (await assignmentsOf(classification)).assistants;
}

/** One paged read of a classification's records: its live assistants by handle, and each role's alt bot. */
async function assignmentsOf(classification: string): Promise<{ assistants: Map<string, ResolvedAgent>; alts: Map<string, string> }> {
  const hit = assistantsByClassification.get(classification);
  if (hit && Date.now() - hit.at < ASSISTANTS_TTL_MS) return hit;
  const assistants = new Map<string, ResolvedAgent>();
  // Each role's alt bot, by role. Recorded whether or not an experiment holds it: the bot exists from
  // deploy, and whether it may take a duel turn is the battle sanction's question.
  const alts = new Map<string, string>();
  let token: string | undefined;
  do {
    const res = await ssmClient.send(new GetParametersByPathCommand({
      Path: `${SSM_ROOT}/assistant-assignments/${classification}`,
      Recursive: true,
      MaxResults: 10,
      NextToken: token,
    }));
    for (const p of res.Parameters || []) {
      let parsed: AssignmentRecord;
      try {
        parsed = JSON.parse(p.Value || '{}') as AssignmentRecord;
      } catch {
        // A record this resolver cannot parse is skipped rather than guessed at. The handle it would
        // have carried then fails to resolve, which is a refusal with a name in it.
        continue;
      }
      if (parsed.occupancy === 'alt' && parsed.botArn && parsed.role && parsed.source !== 'runtime') {
        alts.set(parsed.role, parsed.botArn);
        continue;
      }
      if (parsed.occupancy !== 'live') continue;
      if (!parsed.botArn || !parsed.assistant || !parsed.role) continue;
      // A retiring or provisioning runtime assistant is not assigned: it reads as absent everywhere.
      if (!isServingRecord(parsed)) continue;
      const runtimeSeed = parsed.source === 'runtime' ? runtimeSeedFor(parsed, defaultProfileRegistry) : undefined;
      // A runtime record that does not describe a valid assistant adds nothing, rather than a bot
      // that would then be declined on every turn.
      if (parsed.source === 'runtime' && !runtimeSeed) continue;
      assistants.set(parsed.assistant, {
        handle: parsed.assistant,
        botArn: parsed.botArn,
        role: parsed.role,
        ...(runtimeSeed ? { runtimeSeed } : {}),
      });
    }
    token = res.NextToken;
  } while (token);
  // Cached only on a COMPLETE read. A throw propagates, so a partial enumeration never becomes the
  // cached answer - which would make a transient failure look like a classification that lost an assistant
  // for the container's life.
  const loaded = { at: Date.now(), assistants, alts };
  assistantsByClassification.set(classification, loaded);
  return loaded;
}

/**
 * The bot of one role's alt in one classification, from its assignment record (§3.7), or undefined when
 * the classification provisions none for that role. THROWS on an unreadable record set, so the battle
 * sanction refuses rather than mistaking an outage for an alt that does not exist.
 */
export async function altBotArnFor(classification: string, role: string): Promise<string | undefined> {
  if (!classification || !role) return undefined;
  return (await assignmentsOf(classification)).alts.get(role);
}

/**
 * Every LIVE assistant bot in one classification, whatever role it holds.
 *
 * WHO ASKS. The bypass-identity gate (`isSanctionedBattleBot`), which decides whether a turn may answer
 * as a bot its caller named. Its original set was this handler's own bot plus the ALT of its own role,
 * which is the whole of a duel - and it means a conversation holding a SECOND ROLE's assistant could
 * never have that assistant answer: the mention resolved, the flow claimed the turn and declared the
 * identity, and the gate refused it as unsanctioned because a second role's live bot is neither the
 * handler's own nor the alt of the handler's role. The turn then fell back to the primary, so the wrong
 * assistant answered and only a SecurityEvent log said so.
 *
 * WHY THIS IS SAFE TO ADMIT. The classification is fixed by the caller's own deployment and every ARN
 * returned here is read from the deployment-published assignment records, so nothing a caller asserts
 * reaches this set. It stays inside ONE classification, which is the only closed axis IAM evaluates and
 * the boundary ADR-042 pins an assistant to - so this widens WHICH ASSISTANT may answer and never WHAT
 * IT MAY REACH. An admitted bot still runs on its own credentials, because the processor resolves
 * the assistant from the bot it was told to answer as.
 *
 * `live` ONLY. An alt is a role's alternate assistant and is admitted by its own record (`altBotArnFor`);
 * putting a conversation's turn on an alt that exists only while an experiment is armed is not something
 * a mention should be able to do.
 */
export async function liveBotArnsForClassification(classification: string): Promise<string[]> {
  if (!classification) return [];
  const assistants = await liveAssistantsByHandle(classification);
  return [...assistants.values()].map((s) => s.botArn).filter(Boolean);
}

/**
 * Every live assistant in one classification, as the routing layer needs them: handle, bot and role.
 *
 * Distinct from the ARN-only reader above because a router matching a conversation's members against
 * this deployment's assistants needs the HANDLE to read what that assistant advertises, and the ROLE
 * only to say which assistant answered. Same single read either way.
 *
 * RETURNS EMPTY RATHER THAN THROWING. The only caller is on the reply path and treats "no roommates"
 * as the ordinary answer, so a records outage reads as a conversation with one assistant in it - which
 * is what every single-assistant deployment looks like anyway (tenet D5).
 */
export async function liveAssistantsForClassification(
  classification: string,
): Promise<ResolvedAgent[]> {
  if (!classification) return [];
  try {
    return [...(await liveAssistantsByHandle(classification)).values()];
  } catch (err) {
    console.warn('[default-agents] could not read the live assistants; this turn sees no roommates', {
      classification, err: (err as Error)?.message,
    });
    return [];
  }
}

/**
 * Resolve the handles a conversation type names into assistants it can add, or THROW.
 *
 * Order is preserved from the type's declaration, so the log and the notification name the assistants
 * in the order the type states them rather than in whatever order SSM enumerated.
 *
 * The error names every handle that did not resolve and every handle that did, because the two
 * failures it has to distinguish look identical from the outside: a role the deployment did not build,
 * and a handle misspelled in the registry.
 */
export async function resolveDefaultAgents(
  classification: string,
  handles: string[],
): Promise<ResolvedAgent[]> {
  const wanted = (handles || []).map((h) => h.trim()).filter(Boolean);
  if (wanted.length === 0) return [];

  const assistants = await liveAssistantsByHandle(classification);
  const resolved: ResolvedAgent[] = [];
  const missing: string[] = [];
  for (const handle of wanted) {
    const assistant = assistants.get(handle);
    if (assistant) resolved.push(assistant);
    else missing.push(handle);
  }

  if (missing.length) {
    throw new Error(
      `conversation type names assistant(s) with no live assignment record at classification `
      + `"${classification}": ${missing.join(', ')}. Live assistants found: `
      + `${[...assistants.keys()].join(', ') || '(none)'}. A role beyond "primary" is built only where the `
      + 'deployment declares it: its assistant named in profiles in deploy.config.json (npm run add-assistant-role).',
    );
  }
  return resolved;
}
