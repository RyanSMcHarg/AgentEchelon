/**
 * Assemble a conversation's per-turn HOST GROUNDING from its two sources, keeping the P1 privacy split:
 *  - member-readable channel Metadata → routing bits (contextId, userLanguage, segment) + the
 *    participant roster;
 *  - the SERVER-ONLY Channel Context store → the private grounding (domainContext, otherContexts,
 *    participantProfile, userName).
 *
 * This is the READ half of the P1 boundary: the private fields are never read from member-readable
 * Metadata. Fail-soft — a missing store row just yields no private grounding for the turn.
 */
import { getChannelContext } from './channel-context-client.js';
import { deriveFederatedSub } from './federated-identity.js';

export interface HostGrounding {
  /** Forwarded to the async processor; rendered into the system prompt by the host-context resolvers. */
  domainGrounding: Record<string, unknown>;
  /** The conversation's contextId (plan anchor), when present. */
  contextId?: string;
}

/** One participant, as the prompt should see them. */
export interface GroundedParticipant {
  /** The AppInstanceUser id membership reports (derived, for a federated member). */
  sub: string;
  /** Home IdP issuer, from the stored hint. Absent for a native member. */
  iss?: string;
  /** The host-supplied role on this conversation. Neither membership nor the IdP can supply it. */
  role?: string;
  /** Display name, resolved from the IdP at grounding time. Absent when it could not be resolved. */
  name?: string;
}

/**
 * How the caller reaches membership and the IdP.
 *
 * Injected rather than imported so this module keeps no Chime or Cognito client of its own: the
 * router already holds both, with per-container caches (`getHumanMemberArns`, the name cache), and a
 * second set here would double the calls on the per-turn path.
 */
export interface ParticipantResolvers {
  /** The channel's HUMAN member ids, live from `ListChannelMemberships`. */
  listHumanMemberSubs: () => Promise<string[]>;
  /** Display name for one member; `hint` carries the raw (iss, sub) when the member is federated. */
  resolveName: (memberSub: string, hint?: { iss: string; rawSub: string }) => Promise<string | undefined>;
}

/**
 * @param channelArn   the conversation's channel ARN (store key)
 * @param contextMeta  the already-resolved, member-readable channel Metadata object
 * @param participants how to read membership and resolve names; omit to ground without a roster
 */
export async function assembleHostGrounding(
  channelArn: string,
  contextMeta: Record<string, unknown>,
  participants?: ParticipantResolvers,
): Promise<HostGrounding> {
  const domainGrounding: Record<string, unknown> = {};
  let contextId: string | undefined;

  // Member-readable bits (from channel Metadata): the plan anchor and the participant roster, which is
  // already visible to members through `ListChannelMemberships` and grounds nothing on its own.
  if (typeof contextMeta.contextId === 'string' && contextMeta.contextId) contextId = contextMeta.contextId;

  // Private grounding + model-routing signals (from the server-only store; never member-readable).
  const priv = await getChannelContext(channelArn);
  if (priv) {
    if (priv.domainContext) domainGrounding.domainContext = priv.domainContext;
    if (priv.otherContexts) domainGrounding.otherContexts = priv.otherContexts;
    if (typeof priv.userName === 'string' && priv.userName) domainGrounding.userName = priv.userName;
    if (typeof priv.participantProfile === 'string' && priv.participantProfile) {
      domainGrounding.participantProfile = priv.participantProfile;
    }
    // NOTE: `priv.memberIdentities` is deliberately NOT the roster — see below. It is consulted only
    // as a hint source for the two fields nothing else can supply.
    // Language + geography routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING): `userLanguage` selects the reply
    // language and `segment.country === 'CN'` routes to the Chinese model. These come from the store for
    // the same reason as the four fields above, and it matters MORE for them: they do not merely ground
    // the answer, they choose which model produces it, so sourcing them from member-writable Metadata
    // would let a member redirect their own conversation's model selection.
    if (typeof priv.userLanguage === 'string' && priv.userLanguage) {
      domainGrounding.userLanguage = priv.userLanguage;
    }
    if (priv.segment && typeof priv.segment === 'object') domainGrounding.segment = priv.segment;
  }

  // WHO is in the conversation: CHANNEL MEMBERSHIP, resolved live, never a stored copy.
  //
  // The prompt renders this as who is on the plan ("on a SHARED plan, ask who's responsible"), so a
  // stale entry is not a cosmetic error — the assistant addresses someone who left, or omits someone
  // who joined, and does it with the confidence of stated fact. A roster written at creation time
  // drifts the moment anybody is added or removed, and nothing ever corrects it.
  //
  // Membership is the record; the IdP owns names. The stored roster survives only as a HINT for the
  // two things neither can supply:
  //   - `iss`, the home-IdP issuer. A federated member's AppInstanceUser id is
  //     `deriveFederatedSub(iss, sub)`, a one-way hash, so membership alone cannot say which IdP to
  //     ask for their name. This is the same demotion `channel-notify.readIssuerHints` already
  //     applies on the delivery path, and it is safe for the same reason: the roster is fixed by
  //     membership before the hint is consulted, so a tampered entry cannot ADD anyone — at worst it
  //     points a real member at the wrong pool, where the lookup fails and the name is simply absent.
  //   - `role`, which is host-supplied and exists nowhere else.
  //
  // A member the stored roster has never heard of still appears, with no `iss` and no `role`. That is
  // the case the old shape got wrong: they were in the conversation and invisible to the assistant.
  if (participants) {
    const hints = new Map<string, { iss: string; rawSub: string; role?: string }>();
    for (const p of (priv?.memberIdentities || [])) {
      if (!p || typeof p.sub !== 'string' || !p.sub) continue;
      if (typeof p.iss === 'string' && p.iss) {
        // Keyed by the id MEMBERSHIP reports: the roster holds the raw pair, membership the derived id.
        hints.set(deriveFederatedSub(p.iss, p.sub), { iss: p.iss, rawSub: p.sub, role: p.role });
      } else {
        hints.set(p.sub, { iss: '', rawSub: p.sub, role: p.role });
      }
    }

    const memberSubs = await participants.listHumanMemberSubs();
    if (memberSubs.length > 0) {
      const roster: GroundedParticipant[] = [];
      for (const sub of memberSubs) {
        const hint = hints.get(sub);
        const name = await participants.resolveName(
          sub,
          hint?.iss ? { iss: hint.iss, rawSub: hint.rawSub } : undefined,
        );
        const entry: GroundedParticipant = { sub };
        if (hint?.iss) entry.iss = hint.iss;
        if (hint?.role) entry.role = hint.role;
        if (name) entry.name = name;
        roster.push(entry);
      }
      domainGrounding.participants = roster;
    } else {
      // Membership could not be read (or the channel genuinely has no human members). Ground with NO
      // roster rather than falling back to the stored copy: the fallback is the very drift this
      // change removes, and an absent roster degrades the prompt honestly where a stale one asserts
      // something false.
      console.warn(
        `[host-grounding] channel ${channelArn}: no human memberships resolved; `
        + 'grounding this turn WITHOUT a participant roster rather than from the stored copy.',
      );
    }
  }

  // LEGACY CHANNELS: detect, report, and deliberately do NOT fall back.
  //
  // These six fields used to be written into channel Metadata; the P1 split moved them to the
  // server-only store and the writers stopped populating Metadata. A conversation created before that
  // change carries its grounding ONLY in Metadata, so it silently degrades to an ungrounded turn here
  // (and, for the two routing signals, to the deployment's default model and language).
  //
  // Reading them back out of Metadata would fix the degradation and open a worse hole: a channel's
  // creator is a moderator of their own channel and holds `chime:UpdateChannel` (granted for owner
  // RENAME - see cognito-auth-stack), and Chime's UpdateChannel writes Name and Metadata in the SAME
  // call, which IAM cannot separate. A member can therefore set Metadata freely, so any private field
  // sourced from it is attacker-controlled input landing directly in the assistant's system-prompt
  // grounding. That is why the read half takes these ONLY from the server-only store, and why a
  // "compatibility fallback" must never be added here.
  //
  // Degrading is the correct behaviour; degrading INVISIBLY is not. Log once per channel so the size
  // of the legacy population is observable and a backfill can be a decision rather than a discovery.
  // Values are never logged - only which keys were present.
  if (!priv) {
    const legacyKeys = ['participantProfile', 'domainContext', 'otherContexts', 'userName',
      'userLanguage', 'segment']
      .filter((k) => contextMeta[k] !== undefined && contextMeta[k] !== null && contextMeta[k] !== '');
    if (legacyKeys.length > 0) {
      console.warn(
        `[host-grounding] channel ${channelArn} has legacy private grounding in member-readable Metadata `
        + `(${legacyKeys.join(', ')}) and no Channel Context row; serving this turn UNGROUNDED. `
        + 'Metadata is member-writable, so it is never used as a source for these fields.',
      );
    }
  }

  return { domainGrounding, contextId };
}

// ---------------------------------------------------------------------------
// WRITE-SIDE BOUNDS on the two largest host-supplied grounding inputs
// ---------------------------------------------------------------------------
//
// Here rather than in either federated handler, because BOTH write these fields and an unbounded value
// arriving through either one breaks the same reader - this module's `assembleHostGrounding`, whose
// result the router spreads whole into the async processor's payload.
//
// WHERE IT BREAKS. The private store is DynamoDB (400KB an item), so it accepts far more than the rest
// of the system can carry. The dispatch is an `Event` invoke, capped at 256KB, and the grounding shares
// that budget with the transcript, retrieved RAG chunks and the conversation summary. Past the cap the
// invoke throws `RequestEntityTooLargeException`, which `invokeAsync` logs and swallows - so the worker
// never runs and the placeholder is never resolved. Not one turn either: EVERY turn in that
// conversation, because the grounding is re-read and re-sent each time.
//
// These were the only host-supplied fields on the creation path accepted with no cap at all, while every
// sibling (`participantProfile` at 600 chars, `participants` at 8) was capped. Bounding at the write is
// what turns a permanently stuck conversation into something the host can see and correct.

/** Side contexts beyond the primary plan. */
export const MAX_OTHER_CONTEXTS = 16;
/** 64KB of grounding leaves ample room in the 256KB payload for everything else it carries. */
export const MAX_DOMAIN_CONTEXT_BYTES = 64 * 1024;
/** Plan items, trimmed by COUNT before any byte check. */
export const MAX_DOMAIN_CONTEXT_ITEMS = 200;

/**
 * A plan bounded to what can actually be dispatched, or `undefined` when it cannot be.
 *
 * `items` is trimmed FIRST and by count: it is the field that grows without limit, and a prompt reads it
 * sequentially, so keeping the first N is more useful than truncating a serialized blob mid-object. If it
 * is still oversized after that, the whole value is DROPPED rather than sent partially - a plan the host
 * believes is complete but which silently lost its tail is worse grounding than none. The loud log is
 * what tells the host to send less.
 */
export function boundedDomainContext<T extends object>(
  raw: T | unknown,
  logPrefix: string,
): T | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // Generic over the caller's own shape: each handler has already established what it accepts, and this
  // only ever REMOVES entries, so bounding cannot make a valid value invalid.
  const ctx = { ...(raw as T) } as T & { items?: unknown[] };
  if (Array.isArray(ctx.items) && ctx.items.length > MAX_DOMAIN_CONTEXT_ITEMS) {
    console.warn(`${logPrefix} domainContext.items over cap; trimming`, {
      received: ctx.items.length, kept: MAX_DOMAIN_CONTEXT_ITEMS,
    });
    ctx.items = ctx.items.slice(0, MAX_DOMAIN_CONTEXT_ITEMS);
  }
  const bytes = Buffer.byteLength(JSON.stringify(ctx), 'utf8');
  if (bytes > MAX_DOMAIN_CONTEXT_BYTES) {
    console.error(`${logPrefix} domainContext exceeds the dispatchable budget; DROPPING it`, {
      bytes, cap: MAX_DOMAIN_CONTEXT_BYTES,
    });
    return undefined;
  }
  return ctx;
}

/** Side contexts bounded by count. Non-arrays are dropped, matching the callers' prior behaviour. */
export function boundedOtherContexts(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_OTHER_CONTEXTS);
}
