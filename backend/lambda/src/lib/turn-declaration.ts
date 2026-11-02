/**
 * WHAT A TURN DECLARED ABOUT ITSELF, CARRIED IN THE MESSAGE IT POSTED.
 *
 * An exchange is "an assistant answered this message". A turn that answers through the async
 * processor declares that in Metadata (`answersMessageId`, `turnKind`, `deliveryOption`), and
 * archival reads it there. A turn that answers from the HANDLER has no such channel: Amazon Chime SDK
 * materializes the message from the Lex fulfillment return, and a fulfillment return carries messages
 * and session attributes, not message metadata. The only thing a handler-answered turn can hand
 * forward is its own CONTENT.
 *
 * So this is the same declaration, on the only carrier a `DIRECT` answer has. The alternative that
 * was in place until now is adjacency - `createExchangesFromRecords` took the first bot message after
 * a user message in the same Kinesis batch, with no marker test, no time bound and no
 * intervening-message test - which under a queue is exactly wrong: a burst produces a deferral
 * notice, a reading's proposal and an answer in an order that has nothing to do with which message
 * each belongs to.
 *
 * THE STANDING RULE THIS SERVES: accuracy over latency on the pairing. A
 * mismatched exchange is worse than a slow one, because a wrong pairing is indistinguishable from a
 * right one at read time and silently corrupts every figure built on it. Declaring the target costs a
 * channel read on the fastest turn in the system, and that is the accepted price.
 *
 * ── WHY ONE MARKER WITH KEYS RATHER THAN A MARKER PER FACT ─────────────────────────────────────
 *
 * Three facts travel together and arrive from one decision: what this answers, how it was delivered,
 * and what kind of turn it was. Three markers would be three patterns, three strippers to keep in
 * step and three chances for a reader to know about two of them. One marker means one parser and one
 * place to add the fourth fact when there is one.
 *
 * ── WHY IT CANNOT BE FORGED BY WHAT A MODEL WROTE ──────────────────────────────────────────────
 *
 * Keys and values are character-classed and bounded, exactly as `<!--corr:-->` is, so a crafted
 * marker cannot smuggle a key. `withTurnDeclaration` removes any declaration already present before
 * appending its own, so composed model text cannot bring one along; the reader takes the LAST
 * declaration for the same reason. And a declaration is only ever read off a BOT record, so a person
 * typing one into the conversation declares nothing about anybody's turn.
 *
 * A leaked marker is also masked at the guardrail boundary (`bedrock-guardrails.ts` names `turn`
 * alongside `ACTIVE_TASK` and `corr`) and stripped from everything a human or a judge reads
 * (`message-markers.ts` removes all HTML comments).
 */

import { DeliveryOption } from './delivery-options.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import { isHumanWaiting, normaliseLegacyTrigger } from './interaction-kinds.js';

/**
 * The assistant names this deployment declares, for validating a declared `assistant`.
 *
 * READ FROM THE REGISTRY, which is configuration and carries no AWS dependency - this module is a
 * pure content contract and archival imports it, so pulling in the profile LIFECYCLE (SSM, versions)
 * to answer "is this a name we declare" would drag a runtime dependency into a parser.
 *
 * Computed per call rather than memoized at module load: a deployment's profiles config is read at
 * import time today, and a cached array here would be one more thing to invalidate if that ever
 * changes. The list is a handful of strings.
 */
function declaredAssistantNames(): string[] {
  try {
    return defaultProfileRegistry.profileNames();
  } catch {
    // A registry that cannot be built is a deployment-configuration failure, and it must not turn a
    // parse into a throw: archival parses every bot message. No roster means no declared assistant is
    // recognized, which leaves the turn where it was before this field existed.
    return [];
  }
}

/**
 * The KINDS a turn may declare, and the set is deliberately closed.
 *
 * A closed set is what lets a query say "everything that is not an answer" without listing the kinds
 * it has not heard of. An ordinary answer declares no kind at all: absence means "this is an answer",
 * which is the only reading that keeps every message written before this existed correct.
 *
 * `reading` is queue work - it answers a BURST, so there is no single message it could name.
 * `drift`   is a suggestion about where the conversation is going. It IS a response to a message, and
 *           it deliberately does not do the work, so it names its target and stays out of the
 *           population that measures answers.
 * `welcome` is what a conversation opens with. NOBODY SENT ANYTHING TO PROVOKE IT - it fires on the
 *           assistant's membership at channel creation - so it answers no message, and pairing it
 *           would attach it to whatever happened to precede it and report a reply time measured from
 *           nothing.
 * `notification` is a message the platform sent that nobody asked for: a task assignment, a reminder,
 *           anything one-directional. Same reasoning as `welcome`, different producer, and it is the
 *           value `NoticeKind` already declares in Metadata - listed here so the CONTENT carrier
 *           accepts it too, since a Lex-fulfilled message has no Metadata this code controls.
 *
 * ── WHY THIS LIST GREW, AND WHAT IT FIXES ────────────────────────────────────
 *
 * A kind absent from this list is DROPPED by the parser below, so declaring it in content achieved
 * nothing and the message fell into `answer`. That bucket means "declared nothing" rather than "is an
 * answer", and the console reads it as the latter. Measured live: 348 messages counted as answers on
 * one day against 120 exchanges, so most of the bucket was messages nobody had paired and nobody was
 * waiting on.
 *
 * `join_recap` is the room's primary catching up a person who was just added. Nobody asked a question, so it
 *           answers no message; declared on its placeholder so it is never paired with what preceded it.
 *
 * ── THE TWO KINDS A PLACEHOLDER BECOMES WHEN THE ANSWER MOVES ─────────────────
 *
 * Latency is paired from whatever triggered a message to the message itself. When a turn delivers its
 * answer as a NEW message - a private answer targeted at the person, a broadcast duel answer, an answer
 * posted at the end because the placeholder became the queue notice - the placeholder is left behind as
 * something else, and both pairers took the earliest bot message after the person's, which is the
 * placeholder. The answer then counted as a turn with no exchange and no kind: 16 of them on one day.
 *
 * `receipt`   the placeholder closed out as a pointer to where the answer went ("I have replied to you
 *             privately", "my answer is in the conversation"). It answers nothing itself; the message
 *             the answer moved to pairs through its own declared `answersMessageId`.
 * `queue_ack` a queue notice, which is what the placeholder becomes when the notice is written into it.
 *             The same name the analytics label already gives a deferral notice (`turnKindSql`), so a
 *             notice reads as one kind wherever it was posted.
 * `event_step` an event workflow's `agent` step (ADR-061 decision 8): one turn nobody asked for, carrying the
 *             workflow, the step, the event and its outcome, so it pairs with nothing.
 * `task_step` an idle assistant taking up a task assigned to it (ADR-063 decision 5): one turn nobody's message started,
 *             carrying the task's type and state, so it pairs with nothing.
 */
export const TURN_KINDS = ['reading', 'drift', 'welcome', 'notification', 'join_recap', 'receipt', 'queue_ack', 'event_step', 'task_step'] as const;

/**
 * HOW A TURN ENTERED, and the only three values that are true of one.
 *
 * `lex` and `flow` are the two doors a person's message comes through: Amazon Chime SDK invoked the
 * assistant's Amazon Lex bot, or the channel flow invoked the router directly. `platform` is a turn no
 * message entered at all: the platform started it (a rebuttal, a welcome, an event workflow's step, a
 * task taken up), so it has neither door's work in front of its first frame and is a path of its own.
 *
 * VALIDATED FOR THE SAME REASON `delivery` IS, and more sharply: `messages.turn_entry` is
 * `VARCHAR(8)` (migration 054) while a declarable value runs to 128 characters, so a bot message
 * carrying a crafted `entry=` between those two numbers fails the INSERT - and archival inserts
 * inside a transaction, so the whole Kinesis batch aborts and retries on it. A declaration is
 * content-carried and content reaches the model, so "nobody would write that" is not an argument
 * available here. Every value here fits the column.
 */
export const TURN_ENTRIES = ['lex', 'flow', 'platform'] as const;
export type TurnEntry = (typeof TURN_ENTRIES)[number];

/**
 * THE ENTRY A TURN RECORDS, for every interaction kind (`interaction-kinds.ts`).
 *
 * A declared entry is carried as it is: the router declares `lex` or `flow` for every turn a person's
 * message starts, because both doors converge on it. A turn of a kind no message starts (a rebuttal, a
 * welcome, a join recap, an event step, a task step) entered through neither door, so its entry is
 * `platform`, read off the kind its dispatcher declared rather than guessed. Undefined only for a
 * person-started turn whose router declared nothing, which no current dispatch does.
 *
 * ONE RULE FOR THE PROCESSOR THAT STAMPS IT AND THE ARCHIVE THAT READS IT, so a row a producer wrote
 * without an entry and a row it wrote with one name the same path.
 */
export function turnEntryOf(declared: unknown, kind: string | null | undefined): TurnEntry | undefined {
  if (typeof declared === 'string' && (TURN_ENTRIES as readonly string[]).includes(declared)) {
    return declared as TurnEntry;
  }
  const interaction = normaliseLegacyTrigger(kind);
  return interaction && !isHumanWaiting(interaction) ? 'platform' : undefined;
}
export type TurnKind = (typeof TURN_KINDS)[number];

/** The kind a placeholder declares when it is closed out as a receipt for an answer posted elsewhere. */
export const RECEIPT_TURN_KIND = 'receipt' satisfies TurnKind;
/** The kind every queue notice declares, including one written into a running answer's placeholder. */
export const QUEUE_ACK_TURN_KIND = 'queue_ack' satisfies TurnKind;

/** A `MessageId` is opaque and Amazon Chime SDK permits up to 128 characters. */
const VALUE_MAX_LENGTH = 128;

/**
 * The delivery options a declaration may carry, which is the enum and nothing else.
 *
 * Listed from `DeliveryOption` rather than copied, so a new option cannot be declarable here and
 * unknown there - or the reverse, which is the shape that silently drops a real value.
 */
const DECLARABLE_DELIVERY: readonly string[] = Object.values(DeliveryOption);

/** The whole payload, bounded so a pathological input cannot make the reader work hard. */
const DECLARATION_MAX_LENGTH = 512;

const VALUE_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${VALUE_MAX_LENGTH}}$`);

/**
 * `<!--turn:k=v;k=v-->`, bounded and character-classed. Global, because the reader takes the last
 * match and the stripper removes every one.
 */
const DECLARATION_MARKER = new RegExp(
  `<!--turn:([A-Za-z0-9._;=-]{1,${DECLARATION_MAX_LENGTH}})-->`,
  'g',
);

/** What a turn may say about itself. Every field optional: a turn declares what it knows. */
export interface TurnDeclaration {
  /** The `MessageId` this turn answers. */
  answers?: string;
  /** The `DeliveryOption` this turn took, named by the turn rather than inferred from an absence. */
  delivery?: string;
  /** One of `TURN_KINDS`, or absent for an ordinary answer. */
  kind?: TurnKind;
  /**
   * The response phase this message IS, in the same vocabulary every other producer declares
   * (`respPhase`, read by `kindForPhase`).
   *
   * IT IS WHAT KEEPS A DIRECT ANSWER FROM BECOMING AN UNCLOSED TURN. The ledger reads a bot message
   * carrying a `<!--corr:-->` marker as the placeholder of a response that something else will
   * close. A handler-answered turn posts once and is already finished, so without a declared phase
   * the marker this module exists to add would have opened a response that never closes - turning
   * the fastest turn in the system into an unresolved one in every latency population.
   *
   * The DELIVERY OPTION IS NOT A SUBSTITUTE for it, which is the trap worth naming: `deliveryOption`
   * is stamped from the intent on every turn, so a turn whose intent maps to `DIRECT` but which fell
   * through to the processor carries `DIRECT` too. Finality is declared, never inferred.
   */
  phase?: string;
  /**
   * HOW THIS TURN ENTERED: `lex` or `flow`, which under `StandardMessages: NONE` is also whether the
   * message was targeted (migration 054 states the equivalence).
   *
   * IT IS HERE BECAUSE IT HAD NO CARRIER OF LAST RESORT AND `delivery` DID. The entry rides the
   * analytics metadata, and that metadata does not always reach archival: `pickFrontendMetadata`
   * slims it in Aurora mode and `entry` is not among the kept keys, while a `DIRECT` answer
   * materialized by Amazon Chime SDK from a Lex fulfillment carries no message metadata at all.
   * `delivery` survives both because archival falls back to this declaration; `entry` had no such
   * fallback and was simply lost.
   *
   * MEASURED before adding it: over 30 days, 153 `TASK_MULTI_STEP` and 24 `DIRECT` turns carried a
   * delivery option and no entry - the exact shape of one key having a content carrier and the other
   * not. The dimension is knowable at the moment the declaration is written (`isFlowEntry`), so
   * nothing has to be inferred to fill it.
   */
  entry?: TurnEntry;
  /**
   * WHICH ASSISTANT ANSWERED, by the name the platform knows it by (`AssistantProfile.name`).
   *
   * HERE FOR THE REASON `entry` IS HERE: it had no carrier of last resort. Every other path stamps
   * the responding assistant in metadata - `async-processor-core.ts` sets `agentType:
   * params.servingAssistant`, and the async processor guarantees a value - but a Lex-entry answer is
   * materialized by Amazon Chime SDK from the fulfillment return and carries NO message metadata at
   * all, so there was nowhere for the responder's identity to go. The router knows it: `attribution`
   * is resolved once where the identity is validated, from the classification's profile.
   *
   * MEASURED, and it is the residue of a defect that was otherwise fixed: `agent_type` is written
   * NULL by every writer and rendered `unknown` only at read time, and the remaining producers of an
   * unattributed COUNTED turn are the two Lex-entry returns that carry a correlation marker - the
   * DIRECT quick answer and the drift-spawned welcome. Both are reached by this field.
   *
   * NOT A CLASSIFICATION, and the distinction is the whole point of ADR-051: this names the assistant
   * that answered, which is an identity. The conversation's classification is a separate fact,
   * resolved from the channel tag and never from here.
   */
  assistant?: string;
}

const KEYS: Array<keyof TurnDeclaration> = ['answers', 'delivery', 'kind', 'phase', 'entry', 'assistant'];

/**
 * Can this value survive the round trip? A writer asks BEFORE posting, and the answer is the
 * reader's own, because it runs the reader's own pattern.
 *
 * The same guarantee `isReadableCorrelationId` gives, and for the same reason: an unreadable value is
 * not rejected anywhere downstream, it is simply posted and then silently cannot be read back, so the
 * turn that declared it pairs no better than one that declared nothing.
 */
export function isDeclarableValue(value: string): boolean {
  return VALUE_PATTERN.test(value);
}

/**
 * The marker for a declaration, or `''` when there is nothing readable to declare.
 *
 * A value that cannot round-trip is DROPPED rather than mangled or escaped. Declaring a truncated
 * message id would pair the answer with nothing and look exactly like a declaration that worked;
 * declaring nothing leaves the heuristic in place, which is where such a turn already was.
 */
export function turnDeclarationMarker(declaration: TurnDeclaration): string {
  const pairs: string[] = [];
  for (const key of KEYS) {
    const value = declaration[key];
    if (typeof value === 'string' && value && isDeclarableValue(value)) {
      pairs.push(`${key}=${value}`);
    }
  }
  if (!pairs.length) return '';
  const payload = pairs.join(';');
  if (payload.length > DECLARATION_MAX_LENGTH) return '';
  return `<!--turn:${payload}-->`;
}

/**
 * Read what the turn declared, from content that may carry anything else as well.
 *
 * THE LAST DECLARATION WINS. `withTurnDeclaration` already strips what it found before appending, so
 * a second one should not exist; when one does, the one this system appended is the later one.
 */
export function turnDeclarationOf(raw: string | null | undefined): TurnDeclaration {
  if (!raw) return {};
  // READ ENCODED OR NOT, as `correlationMarkerOf` is: every platform message is posted percent-encoded, and a reader
  // handed the stored Content sees the declaration as `%3C!--turn:...`.
  let content = raw;
  if (!content.includes('<!--') && content.includes('%3C!--')) {
    try { content = decodeURIComponent(content); } catch { /* keep the raw form */ }
  }
  const declaration: TurnDeclaration = {};
  // `matchAll` needs the global flag and a fresh cursor; the pattern is module-level and stateful.
  DECLARATION_MARKER.lastIndex = 0;
  let payload: string | null = null;
  for (const match of content.matchAll(DECLARATION_MARKER)) payload = match[1];
  if (payload === null) return {};
  for (const pair of payload.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!value || !isDeclarableValue(value)) continue;
    // `delivery` IS CHECKED AGAINST THE KNOWN SET, exactly as `kind` is below, and for a reason the
    // value bound does not cover: `messages.delivery_option` is VARCHAR(32) (migration 042) while a
    // declarable value runs to 128 characters. A bot message carrying a crafted `delivery=` between
    // those two numbers fails the INSERT, and archival inserts inside a transaction - so the whole
    // Kinesis batch aborts and retries on it, which is a poison pill for the stream rather than one
    // bad row. A declaration is content-carried and content reaches the model, so "nobody would write
    // that" is not an argument available here; it is the same reason markers are stripped on the way
    // in. An unknown value is DROPPED rather than truncated, because a truncated delivery option is a
    // wrong answer that looks like a right one.
    if (key === 'delivery') {
      if ((DECLARABLE_DELIVERY as readonly string[]).includes(value)) declaration.delivery = value;
    } else if (key === 'answers' || key === 'phase') declaration[key] = value;
    else if (key === 'kind' && (TURN_KINDS as readonly string[]).includes(value)) {
      declaration.kind = value as TurnKind;
    } else if (key === 'entry' && (TURN_ENTRIES as readonly string[]).includes(value)) {
      declaration.entry = value as TurnEntry;
    } else if (key === 'assistant') {
      // CHECKED AGAINST THE DECLARED ROSTER, for the reason `delivery` is checked rather than the
      // reason `answers` is not: this value lands in `messages.agent_type`, which readers group and
      // filter by, so a crafted `assistant=` would invent an assistant in every console rollup. A
      // declaration is content-carried and content reaches the model, so "nobody would write that" is
      // not an argument available here.
      //
      // An unknown name is DROPPED rather than kept, which leaves the turn exactly where it was
      // before this field existed - unattributed - instead of attributed to something that does not
      // exist. That is the same direction `isKnownProfile` already fails in.
      if (declaredAssistantNames().includes(value)) declaration.assistant = value;
    }
  }
  return declaration;
}

/**
 * Does this message say it IS the answer, rather than a stand-in for one?
 *
 * ── WHY EVERY PLACEHOLDER TEST IN THE SYSTEM NEEDED THIS THE DAY THE MARKER WAS ADDED ──────────
 *
 * Four readers decided "this is a placeholder" from the presence of a `<!--corr:-->` marker alone,
 * and each was right while the ONLY marked messages were placeholders:
 *
 *  - `isPlaceholderMessage` drops placeholders from the history handed to the model. A handler
 *    answered turn read as one would be deleted from the conversation - which is the exact shape of
 *    the "the assistant forgot the previous turn" defect that function's own header records.
 *  - the evaluation runner skips placeholders and walks forward for the real reply, so a greeting
 *    read as one would hand its user message to somebody else's answer to be judged against.
 *  - the client skips latency tracking on a placeholder, so the turn's timings would be dropped.
 *  - the ledger opens a response on a marked CREATE and waits for something to close it.
 *
 * So the test becomes "did the turn say it is finished", and the marker is only consulted for turns
 * that said nothing - which is every message written before this existed. Declared, not inferred:
 * the same reason `respPhase` exists at all.
 */
export function declaresFinalAnswer(content: string | null | undefined): boolean {
  return turnDeclarationOf(content).phase === 'final';
}

/** Remove every declaration from content, so the only one left is the one about to be appended. */
export function stripTurnDeclarations(content: string): string {
  DECLARATION_MARKER.lastIndex = 0;
  return content.replace(DECLARATION_MARKER, '');
}

/**
 * The content a turn posts, carrying its declaration and no other.
 *
 * Returns the content unchanged when there is nothing readable to declare, so a caller can use this
 * unconditionally rather than guarding at every call site.
 */
export function withTurnDeclaration(content: string, declaration: TurnDeclaration): string {
  const marker = turnDeclarationMarker(declaration);
  const cleaned = stripTurnDeclarations(content);
  return marker ? `${cleaned}${marker}` : cleaned;
}
