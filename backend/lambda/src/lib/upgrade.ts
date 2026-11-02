/**
 * THE UPGRADE PATHS' SHARED FACTS (PLAN §16.6, P-11, P-12): the registration record, the claim, the
 * channel tags that relate an upgraded conversation to the visitor's, its seed, and its creator call.
 *
 * A registration record is written when a visitor registers (`guest-upgrade.ts`, `POST /guest/register`).
 * It lives in `Tokens` under the `registration` kind, keyed by the hash of the visitor's conversation
 * ARN, so one visit has one registration; it is never keyed or found by an email. It holds the visitor's
 * AppInstanceUser ARN, their conversation's ARN, the structured fields they entered, the key of the one
 * claim currently able to redeem it, and its state (`open`, then `claimed`). It expires 30 days after it
 * was written if nobody claims it.
 *
 * A claim is a `claim` token (`lib/tokens.ts`): 256 bits, single-use, carried only in the sign-in link
 * emailed to the address the visitor registered, and redeemed by the account that signs in from it
 * (`POST /upgrade/claim`). Redeeming it opens a new `customer-engagement` conversation for the
 * account through the customer classification's creator, and that channel carries two resource tags:
 * `upgradedFrom`, the visitor's conversation ARN, and `upgradedFromPerson`, the visitor's AppInstanceUser
 * ARN. Tags are written only at creation, by the creator's role, never by a member, so they are trusted
 * state where channel Metadata is not (`METADATA-AND-TAGS.md`). The funnel joins the two conversations by
 * the first tag, and erasure follows both (`lib/offboarding.ts`).
 *
 * PATH A (P-11) uses the same tags and the same seed: a bind keeps the visitor's AppInstanceUser, which is
 * vended at the account's classification and so no longer reaches the visitor's conversation, and the
 * credential exchange opens a new conversation at that classification (`bindTargetOf`), tagged with the
 * visitor's conversation and AppInstanceUser and seeded as a claim's is. Its channel id is deterministic
 * from the visitor's conversation (`boundChannelIdOf`), so a retried bind opens the same conversation.
 *
 * BOTH PATHS, ONCE THE CONVERSATION IS OPEN (FR26): the seed is the visitor's assistant's assessment of the
 * visit (`assessVisit`) beside the registered fields, and the visitor's conversation is then deleted
 * (`retireVisit`). Neither step ever stops a carry-over.
 */
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { GUEST_VISITOR_TYPE } from '../../../lib/config/conversation-types.js';
import { readTokenRecord, sha256Hex, tokenKey, type TokenRecord } from './tokens.js';

type Sender = { send(command: unknown): Promise<any> };

/** How long an unclaimed registration, and its claim, lasts. */
export const REGISTRATION_DAYS = 30;

/** The tag on a customer's conversation naming the visitor's conversation it was opened from. */
export const UPGRADE_SOURCE_TAG = 'upgradedFrom';
/** The tag naming the visitor's AppInstanceUser, whose messages erasure removes from that conversation. */
export const UPGRADE_SOURCE_PERSON_TAG = 'upgradedFromPerson';

/** The structured fields a visitor registers, each bounded. A name is required; nothing is an address. */
export interface RegistrationFields {
  name: string;
  company?: string;
  role?: string;
  note?: string;
}

const LIMITS: Record<keyof RegistrationFields, number> = { name: 80, company: 120, role: 80, note: 600 };

/** Control characters out, whitespace collapsed, bounded. */
function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const out = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return out || undefined;
}

/** The registration fields a request carries, or null when it carries no usable name. Unknown fields are dropped. */
export function registrationFieldsOf(raw: unknown): RegistrationFields | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = clean(r.name, LIMITS.name);
  if (!name) return null;
  const out: RegistrationFields = { name };
  for (const k of ['company', 'role', 'note'] as const) {
    const v = clean(r[k], LIMITS[k]);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * THE ADDRESS THE CLAIM EMAIL GOES TO (B6): a delivery route the visitor typed, for that one email, and
 * never a key. Nothing is found or joined by it (K2): the claim token in the email's link is what carries
 * the visit, to whichever account signs in from it. Null when it is not one plausible address.
 */
export function registrationAddressOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v) ? v : null;
}

/** The sparse index of registrations waiting for an operator, on `Tokens` when approval is declared `admin`. */
export const REGISTRATIONS_AWAITING_APPROVAL = 'registrationsAwaitingApproval';
/** The attribute that index is keyed on: set while a registration waits, removed when it is approved. */
export const APPROVAL_QUEUE_ATTRIBUTE = 'approvalQueue';

/** The registration record's key: one per visitor conversation. */
export const registrationKeyOf = (guestChannelArn: string): string => tokenKey('registration', guestChannelArn);

/**
 * WHAT THE ASSISTANT WROTE ABOUT THE VISIT (FR26), read from the visitor's conversation when the visit
 * carries over (`lib/visit-assessment.ts`). It is the assistant's own account, never a copy of what was
 * said: `summary` is what the visit was about, `assessment` what the visitor appears to want and how well
 * the deployment can serve it, `openQuestions` what is still unanswered, `welcome` one line the new
 * conversation opens with, addressed to the person, and `language` the BCP 47 tag the visitor wrote in.
 */
export interface VisitAssessment {
  summary: string;
  assessment: string;
  openQuestions: string[];
  welcome: string;
  language?: string;
}

/**
 * THE SEED (V5, FR26): what the new conversation carries from the visit, as grounding the assistant reads
 * in the server-only channel context (`domainContext`), never as fixed copy: the visitor's registered
 * fields, and the assistant's assessment of the visit when one could be written. No message of the visit
 * is copied. Without an assessment (the model could not answer) the seed carries the fields alone, and the
 * carry-over goes ahead (tenet D5).
 */
export function upgradeSeedOf(fields: RegistrationFields | null, sourceType: string, assessment?: VisitAssessment | null): Record<string, unknown> {
  return {
    upgradedFrom: sourceType,
    ...(fields ? { registration: { ...fields } } : {}),
    ...(assessment ? { assessment: { ...assessment, openQuestions: [...assessment.openQuestions] } } : {}),
  };
}

/**
 * THE SEED A VISIT CARRIES, from its registration record and the assessment, for either path: a claim reads
 * the record it redeems, and a bind reads the record of the conversation it continues, if the visitor
 * registered. Without either the seed names only the type the visit was.
 */
export function visitSeedOf(registration: TokenRecord | null | undefined, assessment?: VisitAssessment | null): Record<string, unknown> {
  if (!registration || registration.kind !== 'registration') return upgradeSeedOf(null, GUEST_VISITOR_TYPE, assessment);
  return upgradeSeedOf((registration.fields ?? { name: '' }) as RegistrationFields, String(registration.sourceType || GUEST_VISITOR_TYPE), assessment);
}

/** The registration record of the visitor's conversation, or null. Unreadable is a throw. */
export function readVisitRegistration(doc: Sender, tokensTable: string, guestChannelArn: string): Promise<TokenRecord | null> {
  return readTokenRecord(doc, tokensTable, registrationKeyOf(guestChannelArn));
}

/**
 * THE LINE THE NEW CONVERSATION'S WELCOME CARRIES (`visitSummary` in the channel context), from the seed:
 * the assistant's own sentence, in the visitor's language. Absent when the visit was not assessed.
 */
export function visitWelcomeOf(seed: Record<string, unknown> | null | undefined): string | undefined {
  const a = (seed?.assessment ?? null) as { welcome?: unknown } | null;
  return typeof a?.welcome === 'string' && a.welcome.trim() ? a.welcome.trim() : undefined;
}

// ── THE VISITOR'S CONVERSATION, ASSESSED AND THEN RETIRED ────────────────────────────────────────

/**
 * What the guest classification's creator is asked about the visitor's conversation: `assess` reads it
 * (at most `MAX_LISTED_MESSAGES` of its newest messages) and answers with the assistant's assessment;
 * `retire` deletes it once its seed is written. Each acts on a conversation of the creator's own
 * classification only, of the visitor type (`create-conversation-at-classification.ts`).
 */
export interface VisitRequest {
  kind: 'assess' | 'retire';
  classification: string;
  channelArn: string;
  /** For `assess`: what the visitor registered, which the assessment may use. */
  fields?: RegistrationFields | null;
}

async function invokeCreator(lambda: Sender, creator: string, request: unknown): Promise<Record<string, unknown> | null> {
  const invoked = await lambda.send(new InvokeCommand({
    FunctionName: creator,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(request)),
  }));
  return invoked?.FunctionError ? null : JSON.parse(new TextDecoder().decode(invoked?.Payload));
}

/**
 * THE ASSISTANT'S ASSESSMENT OF THE VISIT, or null when there is none: the creator could not be asked, the
 * conversation could not be read, or the model did not answer. Null never stops a carry-over (tenet D5):
 * the seed then carries the registered fields alone.
 */
export async function assessVisit(
  lambda: Sender,
  guestCreator: string,
  request: { classification: string; channelArn: string; fields?: RegistrationFields | null },
): Promise<VisitAssessment | null> {
  try {
    const answer = await invokeCreator(lambda, guestCreator, { kind: 'assess', ...request } satisfies VisitRequest);
    const a = answer?.ok === true ? (answer.assessment as VisitAssessment | undefined) : undefined;
    if (!a || typeof a.welcome !== 'string' || typeof a.summary !== 'string') {
      console.warn('[Upgrade] the visit carries over without an assessment', { why: String(answer?.error || 'no assessment') });
      return null;
    }
    return a;
  } catch (err) {
    console.warn('[Upgrade] the visit carries over without an assessment', { why: (err as { name?: string })?.name || 'error' });
    return null;
  }
}

/**
 * DELETE THE VISITOR'S CONVERSATION once its seed is written (P-12): the visit continues in the new
 * conversation, and the old one is not left open beside it. Best-effort: a conversation that cannot be
 * deleted lapses on its own expiration (a day after its last message), so a failure here is logged and
 * never undoes a carry-over. True when it is gone.
 */
export async function retireVisit(lambda: Sender, guestCreator: string, request: { classification: string; channelArn: string }): Promise<boolean> {
  try {
    const answer = await invokeCreator(lambda, guestCreator, { kind: 'retire', ...request } satisfies VisitRequest);
    if (answer?.ok === true) return true;
    console.warn('[Upgrade] the visitor\'s conversation was not deleted; it lapses on its expiration', { why: String(answer?.error || 'no answer') });
    return false;
  } catch (err) {
    console.warn('[Upgrade] the visitor\'s conversation was not deleted; it lapses on its expiration', { why: (err as { name?: string })?.name || 'error' });
    return false;
  }
}

/**
 * THE CHANNEL ID OF A BIND'S CONTINUATION: deterministic from the visitor's conversation, so a retried
 * bind names the same channel (create-or-get) and a visit continues in exactly one conversation.
 */
export function boundChannelIdOf(guestChannelArn: string): string {
  return `conv-bound-${sha256Hex(guestChannelArn).slice(0, 40)}`;
}

/** What a creator is asked to open for an upgraded visit (`create-conversation-at-classification.ts`). */
export interface UpgradeConversationRequest {
  /** `upgrade` for a claim (a second AppInstanceUser), `bind` for path A (the visitor's own). */
  kind: 'upgrade' | 'bind';
  classification: string;
  userArn: string;
  sourceChannelArn: string;
  sourcePersonArn: string;
  seed: Record<string, unknown>;
}

/**
 * OPEN THE UPGRADED CONVERSATION through the classification's creator, for either path. The creator's
 * answer, or null when it could not be invoked or failed.
 */
export async function openUpgradeConversation(
  lambda: Sender,
  creator: string,
  request: UpgradeConversationRequest,
): Promise<{ ok: boolean; channelArn?: string; error?: string } | null> {
  try {
    return (await invokeCreator(lambda, creator, request)) as { ok: boolean; channelArn?: string; error?: string } | null;
  } catch (err) {
    console.error('[Upgrade] the creator could not be invoked', { kind: request.kind, err: (err as { name?: string })?.name || 'error' });
    return null;
  }
}
