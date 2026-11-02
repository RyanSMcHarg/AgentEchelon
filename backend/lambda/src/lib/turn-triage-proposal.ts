/**
 * THE READING THE TRIAGE TURN PRODUCES, and how it is asked for and read back (ADR-033).
 *
 * Triage decides whether each queued message amends work already in progress or opens new work. That
 * is a judgment about meaning, not a property of the text: the same words amend a report or start a
 * task depending on what was already happening. So a model makes the call, and this module is the
 * contract with it - what it is asked, and what an answer is allowed to look like.
 *
 * ── A DECLARED SHAPE, NEVER AN INFERRED ONE ──────────────────────────────────────────────────────
 *
 * The reply is parsed from explicit markers, the way `NEED_CLARIFICATION` and `NO_REBUTTAL` already
 * are, and for the same reason: substring inference over prose turns a model's wording choices into
 * control flow. A line that does not match is not a decision.
 *
 * ── AND IT FAILS CLOSED ──────────────────────────────────────────────────────────────────────────
 *
 * An unreadable or partial reply produces NO tasks and NO proposal. The queue stays where it is and
 * the next turn tries again. That is late, and late is recoverable; inventing a classification for
 * messages nobody understood is not. The same rule the ledger's phase mapping follows - an
 * unrecognized value can never be the one that closes something.
 *
 * ── THE PROPOSAL IS NOT AN EXECUTION ─────────────────────────────────────────────────────────────
 *
 * What comes out is proposal-and-confirm, the shape `reorder_items` and `assign_item` already use:
 * nothing is applied until the person answers. Executing a reading silently means the first time they
 * learn how their messages were interpreted is when the wrong work is already done.
 */

// TASKS GO THROUGH THE STORE SEAM, not the table. Same signatures; the boundary is inside.
import { createTask } from './task-store.js';
import { turnQueueEnabled } from './turn-lock.js';
import { principalIdFromArn } from './task-tracking.js';
import type { ClarificationFollowUp } from './clarification-follow-up.js';
import { DeliveryOption } from './delivery-options.js';
import type { TaskPriority, TaskVisibility } from './task-tracking.js';
import type { AssistantCopy } from './active-profile.js';
import { noticeLine, type NoticeCopyKey } from './assistant-notice.js';
import { personIdFromArn } from './person-arn.js';

/**
 * A line the person reads: the assistant's own copy for `key`, else the shipped default in
 * `DEFAULT_NOTICE_COPY` (tenets P5 and D11). Trimmed, as configured copy always was here.
 */
function say(copy: AssistantCopy | undefined, key: NoticeCopyKey, vars: Record<string, string | number> = {}): string {
  return noticeLine(copy, key, vars).trim();
}

/** The machine a triaged request runs on. Declared in task-state-machines.ts. */
export const QUEUED_REQUEST_TASK_TYPE = 'queued_request';
/** What a queued message becomes when the reading could not make out what it asks for. */
export const QUEUED_CLARIFICATION_TASK_TYPE = 'queued_clarification';

/**
 * WHAT A TRIAGE TURN CARRIES BESIDES ITS PROMPT.
 *
 * All three are decisions made when the queue was READ, one dispatch earlier, and none of them can be
 * recovered from the triage turn itself: its prompt is generated text, it has no task of its own, and
 * re-deriving the visibility would mean re-reading every queued message from the channel. So they
 * travel with the turn.
 *
 * They travel as ONE value rather than three attributes because they are one decision - what this
 * queue is - and splitting them lets a partial parse produce a turn that knows which messages it is
 * reading but not who may see the work: the failure that publishes a private request.
 */
export interface TriageTurnContext {
  /**
   * The queued messages as the PEOPLE wrote them, carried apart from the prompt that wraps them.
   *
   * The input guardrail screens the turn's user message, and on a triage turn that value is the
   * whole assembled contract: instructions telling the model what to do, wrapped around quoted user
   * text. That is the shape of a prompt-injection attempt, so the prompt-attack filter fired on our
   * own scaffolding and blocked every triage turn before the model was called - which is why the
   * judged reading never once succeeded and every drain fell back to the derived floor.
   *
   * The answer is not to stop screening, it is to screen what is actually untrusted. This field is
   * that: what a person sent, with none of our own instructions around it.
   */
  userContent?: string;
  /** The queued messages this turn is reading. The reply is parsed against exactly these. */
  ids: string[];
  /**
   * Queued ids that had nothing readable left in them. Not part of the reading contract - the
   * model is never asked about them - but they must leave the queue with everything else, or
   * they hold the notice open forever.
   */
  accountedIds?: string[];
  /**
   * What the READING may be seen by: one answer for the whole batch, private if any queued message
   * was targeted.
   *
   * IT NO LONGER DECIDES A TASK'S VISIBILITY, and the distinction is the point. The reading names
   * every queued request in one message, so its floor has to be the most restrictive of them - that is
   * the fail-closed argument working correctly, because the reading really does carry a targeted
   * sender's request into a shared message. An individual TASK carries one request, so it takes that
   * request's own answer (`targetedIds`, applied per item where the tasks are created).
   */
  visibility: TaskVisibility;
  /**
   * WHICH of the queued messages were targeted, by id.
   *
   * `visibility` above is one answer for the whole batch and cannot describe a mixed queue, so it
   * decides the reading and not the tasks. These ids decide two things the aggregate cannot: each
   * task's own visibility, and WHICH request may not be merged with another. A targeted
   * message opens its own task and is never folded into work in flight without its sender
   * confirming (DESIGN 2.4.1), and that decision needs the ids rather than the aggregate.
   *
   * ABSENT means an older dispatcher, whose payload predates this field. Absence is read as "none
   * known targeted", which leaves the previous behavior intact rather than inventing targeting
   * that was never recorded.
   */
  targetedIds?: string[];
  /**
   * WHO SENT each queued message, by id.
   *
   * A queue is not one person's. The dispatch carried a single sender - the LAST queued message's
   * - and every task the batch produced was attributed to them, so a request from one person
   * became work owned by whoever happened to send last. On a private task that inverts the
   * redaction as well: `mayReadDetails` keys on the task's own requester, so the wrong owner is
   * exactly who may read it.
   *
   * ABSENT means an older dispatcher, and the caller falls back to the single sender it was given
   * - the previous behavior, rather than an invented attribution.
   */
  sendersById?: Record<string, string>;
  /** Whether there was work already in progress the proposal can ask about. */
  inFlight: boolean;
  /** What that work IS, when the record named the message it answers. Absent falls back to the bare phrase. */
  inFlightLabel?: string;
  /**
   * WHICH PASS THIS IS, 1-based. Triage is a bounded loop rather than a single call (DESIGN 2.3): a
   * reading assembled from a queue the assistant only partly understands is worse than a slower one,
   * because the person corrects it by hand.
   *
   * ABSENT MEANS THE FIRST PASS, which is what a payload written by an older dispatcher carries. It
   * degrades to exactly the single-call behavior that shipped before the loop existed.
   */
  pass: number;
  /**
   * What the passes before this one cost, when this pass was handed off to. Those passes posted
   * nothing, so their usage is recorded on the message this reading eventually posts.
   */
  priorPasses?: { inputTokens: number; outputTokens: number; bedrockMs: number };
}

/**
 * THE LOOP'S BOUND, and it is a number rather than a principle.
 *
 * An unbounded loop on a path a person is waiting on is a latency defect wearing an intelligence
 * costume. ONE bound, and it counts passes.
 *
 * THERE WAS A WALL CLOCK HERE AND IT IS GONE (maintainer, 2026-08-30). Six seconds, started when the
 * first pass was dispatched, and its own comment called it deliberate that it "binds first". It did
 * bind first - it bound ALWAYS. Every check of it happens after a model call has answered, and a
 * model call is longer than six seconds, so the option was granted before the turn ran and refused
 * the moment it came back. A reply that took the offer carried no reading, which then read as an
 * unusable answer and dropped the whole queue to the derived floor: the person waited LESS and got
 * WORSE, and was never told why.
 *
 * The impatience it was guarding is real and is already answered by something better. The queue
 * notice, the stage machine and a placeholder updated in place all tell the person what is
 * happening while the reading runs. A deadline on this path should change what is SAID, never
 * whether the reading may continue.
 *
 * SPEND IS NOT WHAT IT BOUNDED EITHER, so nothing here loosens a cost control. This count is the
 * spend bound for one drain - at most three model calls - and the per-user and global hourly Bedrock
 * budgets in abuse-controls.ts are the backstop. Elapsed time never counted a call.
 */
export const TRIAGE_MAX_PASSES = 3;

/**
 * Is another pass still affordable?
 *
 * ONE QUESTION: how deep is this chain already. It is answerable identically before a turn runs and
 * after it answers, which is what the clock was not - and that difference is the whole defect.
 */
export function mayTakeAnotherPass(ctx: Pick<TriageTurnContext, 'pass'>): boolean {
  return ctx.pass < TRIAGE_MAX_PASSES;
}

/**
 * Did the reading ask for another pass?
 *
 * A DECLARED MARKER, never inferred from prose, which is the same rule the `TRIAGE:` lines follow. A
 * model that merely SOUNDS uncertain has still produced a reading, and treating hedged prose as a
 * request to loop would spend the person's budget on a reading that was already there.
 *
 * AND IT MUST BE THE WHOLE ANSWER. A reply carrying both `ANOTHER_PASS:` and `TRIAGE:` lines is
 * self-contradictory, and the safe reading of a contradiction is the one that does not discard work:
 * the `TRIAGE:` lines are a reading, so they win and the loop ends.
 */
export function parseAnotherPassRequest(
  response: string,
  expectedIds: string[],
): { requested: boolean; reason?: string } {
  if (!response) return { requested: false };
  // Only the text BEFORE `PROPOSAL:`, the same boundary the machine lines are parsed within: a
  // proposal that quoted the marker back must not be able to spend a pass.
  const machinePart = response.split(/^PROPOSAL:/m)[0] || '';
  const m = machinePart.match(/^ANOTHER_PASS:[ \t]*(.*)$/m);
  if (!m) return { requested: false };
  if (parseTriageProposal(response, expectedIds)) return { requested: false };
  const reason = (m[1] || '').trim();
  return reason ? { requested: true, reason } : { requested: true };
}

/**
 * Read the context back, or return undefined.
 *
 * UNDEFINED MEANS THE TURN IS NOT A TRIAGE TURN. A malformed value must never yield a half-populated
 * context: a turn holding ids but no visibility would create the right tasks and show them to the
 * wrong people, which is the one failure the visibility exists to prevent. Absent, the turn behaves
 * as an ordinary one - its reply is posted as an answer, which is late and wrong but not disclosing.
 */
export function parseTriageTurnContext(raw: string | undefined): TriageTurnContext | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<TriageTurnContext>;
    const ids = parsed?.ids;
    if (!Array.isArray(ids) || !ids.length) return undefined;
    if (!ids.every((x) => typeof x === 'string' && x)) return undefined;
    // Checked against the closed set rather than defaulted. A default here would be a disclosure
    // decision nobody made, taken on the evidence that a value failed to arrive.
    if (parsed.visibility !== 'conversation' && parsed.visibility !== 'private') return undefined;
    // THE PASS COUNT DEFAULTS, unlike the visibility above, and the asymmetry is deliberate. A missing
    // visibility is a disclosure decision nobody made, so it refuses. A missing pass count is an older
    // dispatcher that never looped, and defaulting it to the first pass degrades to exactly the
    // single-call behavior that shipped before - it cannot disclose anything.
    const accountedIds = Array.isArray(parsed.accountedIds)
      ? (parsed.accountedIds as unknown[]).filter((v): v is string => typeof v === 'string' && !!v)
      : undefined;
    const pass = typeof parsed.pass === 'number' && parsed.pass >= 1 ? Math.floor(parsed.pass) : 1;
    // ── THE ENRICHMENTS, AND WHY A MISSING ONE IS NOT THE SAME AS AN ABSENT ONE ───────────────
    //
    // This parser is built field by field, which is right: it is the boundary a serialized payload
    // crosses, and a field it does not name cannot arrive. The cost is that a field ADDED to the
    // dispatcher and not added here is silently dropped, and the feature built on it is inert on the
    // deployed path while every unit test around it passes. That is exactly what happened to all
    // three fields below.
    //
    // TARGETING FAILS CLOSED, LOUDLY. If `targetedIds` is present but malformed, proceeding without
    // it would treat somebody's targeted message as ordinary and publish work they sent privately.
    // So a malformed value refuses the whole context, exactly as a missing visibility does: the turn
    // behaves as an ordinary one and the queue waits for the next notice.
    const targetedRaw = parsed.targetedIds;
    let targetedIds: string[] | undefined;
    if (targetedRaw !== undefined) {
      if (!Array.isArray(targetedRaw)) return undefined;
      if (!targetedRaw.every((x: unknown) => typeof x === 'string' && x)) return undefined;
      // An id that is not in this batch is a payload describing a queue this turn is not reading.
      const known = new Set(ids);
      if (!targetedRaw.every((x: string) => known.has(x))) return undefined;
      targetedIds = targetedRaw;
    }

    // WHO SENT EACH, same rule: a wrong sender attributes one person's private request to another.
    const sendersRaw = parsed.sendersById;
    let sendersById: Record<string, string> | undefined;
    if (sendersRaw !== undefined) {
      if (typeof sendersRaw !== 'object' || sendersRaw === null || Array.isArray(sendersRaw)) {
        return undefined;
      }
      const entries = Object.entries(sendersRaw as Record<string, unknown>);
      if (!entries.every(([k, v]) => typeof v === 'string' && v && ids.includes(k))) return undefined;
      sendersById = Object.fromEntries(entries as Array<[string, string]>);
    }

    // THE UNTRUSTED HALF, carried so the input guardrail can score what a PERSON wrote rather than
    // the contract wrapped around it. Optional and non-structural: a malformed one costs the
    // guardrail its narrow input, which degrades to screening the whole prompt - the old behavior -
    // rather than costing the turn.
    const userContent = typeof parsed.userContent === 'string' && parsed.userContent
      ? parsed.userContent
      : undefined;

    // AND THE DESCRIPTION OF THE WORK IN FLIGHT, which is the fourth field to be added to the
    // dispatcher and not to this parser (code review, 2026-09-04). `dispatchTriageTurn` sends it
    // deliberately - "so a re-read pass compares against the same work the first pass did" - and it
    // was dropped here, so passes 2 and 3 fell back to the literal phrase and could classify the same
    // amendment differently from pass 1, for no reason a person could see.
    //
    // It is exactly the failure the comment above this block warns about, committed in the same file
    // that warns about it. Only the boolean survived, and a boolean cannot say what the work is.
    const inFlightLabel = typeof parsed.inFlightLabel === 'string' && parsed.inFlightLabel.trim()
      ? parsed.inFlightLabel
      : undefined;

    const prior = parsed.priorPasses;
    const priorPasses = prior && [prior.inputTokens, prior.outputTokens, prior.bedrockMs]
      .every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      ? { inputTokens: prior.inputTokens, outputTokens: prior.outputTokens, bedrockMs: prior.bedrockMs }
      : undefined;

    return {
      ...(priorPasses ? { priorPasses } : {}),
      ids,
      visibility: parsed.visibility,
      inFlight: parsed.inFlight === true,
      ...(inFlightLabel ? { inFlightLabel } : {}),
      pass,
      ...(accountedIds?.length ? { accountedIds } : {}),
      ...(targetedIds ? { targetedIds } : {}),
      ...(sendersById ? { sendersById } : {}),
      ...(userContent ? { userContent } : {}),
    };
  } catch {
    return undefined;
  }
}

/** What triage decided one queued message is. */
export type QueuedIntent =
  /** It changes work already in progress. */
  | 'amends'
  /** It asks for something new, which becomes its own task. */
  | 'new'
  /**
   * IT IS HERE AND THE READING CANNOT SAY WHAT THE WORK IS (maintainer, 2026-09-03).
   *
   * The vocabulary was `amends` or `new`, so every message was forced to be one of them - and `new`
   * opens a `queued_request` in `proposed`, which is a row saying "here is the work I propose to
   * do". A message nobody understood therefore produced a confident proposal, labeled with a slice
   * of the person's own words read back to them.
   *
   * That is the over-claim this design exists to avoid, in the one place it costs most: the person
   * has to notice the proposal is wrong, and a task nobody can act on sits in their list until they
   * do. Saying "I have it, I cannot tell what it needs" is both truer and more useful, and it is what
   * a placeholder MEANS - the message is safe, the work is not yet defined, and one answer defines it.
   *
   * IT COVERS AN UNSUPPLIED REFERENT, not only an unintelligible message (maintainer, 2026-09-04). A
   * reading that works out the SUBJECT and still cannot name the request is unclear: "the usual",
   * "the other one", "like we did last time" all leave a specific that only the person has.
   * Measured on the deployment - the model classified "Same as the other one, but do it the way we
   * did before" as NEW, labelled "Reformat onboarding report to match a prior style the user
   * references but hasn't specified". It had understood the ambiguity exactly and said so in the
   * label, and still produced a proposal.
   *
   * That is the case this now names, because a label admitting the gap does not repair the claim.
   * A proposal says the work is defined enough to begin; queued work begins nothing until the
   * person confirms, so asking costs one answer and a wrong item costs the correction and whatever
   * was done under it.
   */
  | 'unclear';

export interface ProposedItem {
  messageId: string;
  intent: QueuedIntent;
  /** A short label for the work, for the proposal the person reads. Never the raw message. */
  label: string;
  priority: TaskPriority;
  /** The reference of the task this item became, once created (ADR-035). */
  taskRef?: number;
}

/**
 * THE REFERENCES A PERSON TYPES, ADDED BY THE PLATFORM (ADR-035).
 *
 * The model writes the proposal before its tasks exist, so it cannot know their references; and a
 * reference must be exact, so it is never left to the model to write. This line lists the new items
 * that got one, in the reading's own labels (never the raw message), and nothing for a targeted item,
 * whose label the room may not read. Empty when nothing has a reference.
 */
export function referenceLine(items: ProposedItem[], targeted: Set<string>): string {
  const refs = items
    .filter((i) => i.taskRef && !targeted.has(i.messageId) && i.intent !== 'amends')
    .map((i) => `#${i.taskRef} ${i.label}`);
  return refs.length ? refs.join('\n') : '';
}

/**
 * ONE SUBJECT THE QUEUE COVERS, and the messages that are about it.
 *
 * Named by the reading rather than computed, because there is no mechanical test for two requests
 * being about the same thing. A wrong grouping costs the person one correction; not offering to
 * separate them at all costs every later answer in the conversation, since everything in a room is
 * context for everything after it (DESIGN 2.4.2).
 */
export interface ProposedTopic {
  /** A short name for the subject, in the person's terms. Never the raw message. */
  label: string;
  /** The queued messages that belong to it. Each queued id appears in exactly one topic. */
  messageIds: string[];
}

export interface TriageProposal {
  items: ProposedItem[];
  /**
   * The subjects this queue turned out to cover, when the reading found more than one.
   *
   * BEST EFFORT, like `spoken` and unlike `items`. The items are a machine decision and fail closed:
   * a partial reading would have the caller clear a queue whose remainder was never triaged. A
   * partial TOPIC block costs an OFFER, which is neither a decision nor a lost message, so it is
   * dropped on its own rather than failing the reading that carried it.
   */
  topics?: ProposedTopic[];
  /**
   * True when this reading was DERIVED from the queued messages rather than judged by the model.
   *
   * It changes what the person is told, never whether the drain runs: the drain is deterministic and
   * the reading is judged, and both always run (ADR-033). A derived reading is the honest floor - one
   * piece of work per message, nothing grouped, nothing prioritized - and the copy says so instead of
   * presenting a fallback as a considered plan.
   */
  derived?: true;
  /**
   * WHAT THE ASSISTANT SAYS, in its own voice.
   *
   * The triage turn is a model turn: it already runs with this profile's persona and with the
   * reply-language instruction the host applies to every turn. Asking it for structure and then
   * composing the human-facing prose here threw both away - a deployment that configured a terse
   * assistant, or a warm one, or a conversation being held in another language, got the same flat
   * English sentence assembled by a string builder.
   *
   * BEST EFFORT, unlike the items. The machine decision must fail closed, so it is parsed from
   * declared markers and refuses anything partial. The VOICE cannot fail closed in the same way -
   * a missing paragraph is not a wrong decision - so its absence falls back to the composed text
   * rather than discarding a reading the model got right.
   */
  spoken?: string;
  /**
   * Whether triage could tell if the work already in flight is still wanted.
   *
   * TRUE is the interesting case and the one the ADR names: a person who says "actually, what was Q3
   * headcount?" mid-report may have amended nothing and may have abandoned the report, and there is
   * no way to tell from the message which they meant. Guessing wastes their time in both directions -
   * finish a report nobody wants, or discard one they were waiting for - so it is asked.
   */
  inFlightAmbiguous: boolean;
}

/** The marker a triage reply must carry to be a decision at all. */
const TRIAGE_LINE = /^[ \t]*TRIAGE[ \t]*:[ \t]*(.+)$/gim;
/** The optional marker saying the in-flight work's fate is unclear. */
const AMBIGUOUS_LINE = /^[ \t]*IN_FLIGHT_UNCLEAR[ \t]*$/im;
const TOPIC_LINE = /^[ \t]*TOPIC[ \t]*:[ \t]*(.+)$/gim;

/**
 * THE WORK ALREADY RUNNING, AS A SUBJECT ON THE QUEUE.
 *
 * A split is a comparison and it needs both sides. Grouping only the QUEUED messages meant a single
 * arriving message could never be a split - there was nothing to compare it against - so a person
 * who interrupted a long report with one unrelated question was never asked, and the offer appeared
 * only when two messages happened to land before a reading fired. Measured live: a reading of two
 * named two subjects and offered, a reading of one named none and offered nothing, same
 * conversation, same person, minutes apart.
 *
 * So the turn in progress takes a TOPIC line of its own under this id. A queued message then either
 * JOINS it - the same subject, and it continues here - or stands as its own, which is exactly the
 * question the offer asks. "More than one subject" then needs no special case, because both sides
 * of the comparison are on the queue where they belong.
 *
 * It is never OFFERED for moving: it is the thing being separated FROM, and the conversation it
 * would move to is the one it is already in.
 */
export const IN_FLIGHT_TOPIC_ID = 'IN_FLIGHT';

const PRIORITIES: ReadonlySet<string> = new Set<TaskPriority>(['high', 'normal', 'low']);
const INTENTS: ReadonlySet<string> = new Set<QueuedIntent>(['amends', 'new', 'unclear']);

/**
 * What the triage turn is told to do.
 *
 * The message ids are given back to the model verbatim because they are what the reply must key on:
 * asking it to describe which message it meant, in prose, would put an identity resolution in the
 * middle of a classification and both would get worse.
 */
/**
 * THE CONTRACT, SAID WHERE THE PERSONA CANNOT TALK OVER IT.
 *
 * A triage turn is dispatched as an ordinary turn request, so it runs with the deployment's
 * persona and every instruction that shapes an ordinary answer. Asking for strict machine lines in
 * the USER message alone loses to all of that: measured against the deployment, the model answered
 * in prose every time - zero `TRIAGE:` lines, no `PROPOSAL:` marker, not even the `ANOTHER_PASS:`
 * escape hatch - so no reading was ever usable and every drain fell back to the derived floor. The
 * judged half of this design never ran once in production.
 *
 * The persona is deliberately KEPT. The spoken half of the proposal is the assistant's own voice
 * and the conversation's own language, and composing that here instead is the thing
 * `buildProposalMessage` exists not to do. This governs the SHAPE of the reply, not its manner:
 * machine lines first, then a marker, then the assistant sounding like itself.
 *
 * The ids are repeated because they must be copied exactly - `parseTriageProposal` checks every
 * field against a closed set and refuses a reply whole if one is invented.
 */
/**
 * ON BY DEFAULT WHEREVER DRIFT AND THE QUEUE BOTH ARE, which is what makes it a default rather than
 * a third switch nobody turns on.
 *
 * The two halves it needs already exist and are already decided elsewhere. DRIFT is the capability
 * that can spawn a conversation from a parent one, and a deployment running it has already accepted
 * that; the stack wires the split function wherever drift is wired, which is what sets the ARN below.
 * THE QUEUE is what produces a reading covering several subjects in the first place - with no queue
 * there is no batch to find subjects in. Neither is a new decision for an operator to make.
 *
 * The queue half is read from the ENVIRONMENT rather than decided at synth, for the reason
 * `turnQueueWiring` gives about its own grant: turning the queue on is a configuration change to a
 * deployed function, not a code change and not a re-synth. (The flag itself is captured once at
 * module load, which is the same thing for a Lambda: changing it replaces the execution environment.)
 *
 * What it still refuses is a HALF-WIRED deployment. An option the runtime would then refuse is the
 * failure this file already names once, about another pass: it teaches the model to ask for
 * something that silently does not happen, and leaves a person answering a question nobody can act
 * on. Naming the subjects is useful on its own, so that half never waits on this.
 */
function splitOfferAvailable(): boolean {
  return !!process.env.CONVERSATION_SPLIT_FUNCTION_ARN && turnQueueEnabled();
}

export function triageContractDirective(
  ids: string[],
  mayAskForAnotherPass = false,
  /**
   * WHETHER THERE IS WORK IN FLIGHT, which is the other thing a subject can be separated from.
   *
   * A single queued message was treated as "no split possible" everywhere - the model was not asked
   * to name a subject, the parser discarded a lone one, and the offer filter discarded it again. The
   * reasoning was that separating a subject from itself is noise, and that is right when the queue
   * is the whole world. It is not right when the person interrupted something: "what was our Q3
   * headcount?" arriving during a fifteen-paragraph onboarding report is one queued message and two
   * subjects, and moving it out is exactly what the offer is for.
   */
  hasWorkInFlight = false,
  /**
   * WHETHER THIS CONVERSATION ALREADY HAS OPEN WORK to rank the arrivals against.
   *
   * NEW WORK IS NOT NEXT WORK (maintainer, 2026-09-01). Priority was assigned against the batch alone, so
   * a queue read after earlier work was already recorded produced a fresh ordering blind to it - and
   * a list ranked only against itself is, in effect, the list that goes first.
   *
   * IT IS SAID HERE RATHER THAN IN THE USER MESSAGE because this is where the list is. The
   * conversation-tasks hint is appended to the system prompt of every turn, this one included,
   * ordered and carrying each item's priority; `buildTriagePrompt` runs in the dispatcher, which on
   * the arrival path is post-processing and holds only `GetItem` on the tasks table - it cannot read
   * the list it would be telling the model to use.
   *
   * PASSED, NEVER ASSUMED. An instruction to rank against a list that is not there teaches the model
   * to invent one, the same failure the another-pass option is gated for.
   */
  hasOpenWork = false,
  /**
   * TRUE WHEN THE READING IS RECORDED THROUGH THE TOOL, which changes what this asks for entirely.
   *
   * Offering the tool while still instructing the line format gives the model two contracts for one
   * answer, and the prompt wins - measured: `toolCalled: false` on every turn, the model dutifully
   * writing TRIAGE lines at a tool it had been given and told nothing about. The rules are identical
   * either way; only the channel differs, so only the channel is described differently.
   */
  viaTool = false,
): string {
  const lines = [
    '',
    '',
    'THIS TURN IS A CLASSIFICATION STEP, NOT AN ANSWER.',
    'Messages arrived while you were working. You are reading them, not replying to them, and you',
    'must not begin, continue or describe the work they ask for.',
    '',
    // THE CHANNEL, AND ONLY THE CHANNEL, DIFFERS. Every rule below - one entry per message, the
    // vocabulary, the "do not guess" instruction, not beginning the work - holds identically. What
    // changes is whether the answer is a line of text this runtime then parses, or a call whose
    // fields the model selects from a set it cannot step outside.
    //
    // OFFERING THE TOOL WITHOUT SAYING SO IS WORSE THAN NOT OFFERING IT. Measured: with the tool
    // registered and this directive still describing the line format, every turn came back
    // `toolCalled: false` - the model followed the prompt, which is the correct thing for it to do.
    ...(viaTool ? [
      'Record your reading by CALLING the `record_reading` tool. Do not write the reading as text:',
      'prose describing a decision is not read as one. Make exactly one call, with one entry per',
      'message listed below and no entries for anything else.',
    ] : [
      'Your reply MUST begin with one line per message, before any other text, in exactly this form:',
    ]),
    ...(viaTool ? [] : ['TRIAGE: <id> | <amends|new|unclear> | <high|normal|low> | <a short label for the work>']),
    '',
    'Use "unclear" in TWO cases. First, when you have the message and cannot tell what it is asking',
    'you to do. Second, and just as important, when you can tell the SUBJECT but the request turns on',
    'something the person referred to without supplying it - "the usual", "the other one", "like we',
    'did last time". Knowing what they are talking about is not the same as knowing what they want.',
    'The test is simple: if starting the work would mean choosing something they did not say, it is',
    'unclear.',
    '',
    'Do not guess in order to fill the line. Naming your uncertainty in the label of a NEW item does',
    'not make it honest - a proposal is a claim that the work is defined enough to begin, and this',
    'one is not, so the person has to notice and correct it. Asking costs them one answer; a wrong',
    'item costs them the correction and everything done under it. For an unclear message the label',
    'should name what you would need to know, not what you would do.',
    '',
    'The ids, copied exactly, one line each:',
    ...ids.map((id) => '  ' + id),
    '',
    ...(hasOpenWork ? [
      'The priority you give each message is RELATIVE TO THE OPEN WORK IN THIS CONVERSATION, listed',
      'above in its current order. Something arriving now is not automatically next: place it against',
      'what is already recorded. A private task there still holds a position - rank against it as you',
      'would any other, without guessing what it is.',
      '',
    ] : []),
  ];
  // THE TEXT FORM IS ASKED FOR ON THE TEXT CHANNEL ONLY, and leaving it ungated put a runtime marker
  // in front of a person (owner-reported, 2026-09-05): `TOPIC: Status / what's happening next |
  // IN_FLIGHT, 60c1373a...` opened a reply on the TOOL channel.
  //
  // The `TRIAGE:` form beside it was already gated and this was not, which is the whole of the
  // defect: on the tool channel the model was told to record its reading by calling the tool, then
  // told to write TOPIC lines "in exactly this form", then told that everything it writes is for the
  // person and no part of it is parsed. Three instructions, and the second contradicts the third.
  // It wrote the line, and the tool channel takes the whole reply as prose - so the line was spoken.
  //
  // Nothing is lost by gating it: `topics` is a field on the reading tool, so on that channel the
  // subjects already travel as structure. This is the same mistake as offering the tool while still
  // describing the line format, recorded above - two contracts for one answer.
  if ((ids.length > 1 || hasWorkInFlight) && !viaTool) {
    // ASKED FOR ONLY WHEN A SPLIT IS POSSIBLE - which is NOT the same as "more than one message".
    // A single queued message cannot cover two subjects on its own, but it does not have to: the
    // work already running is the second one. The guard was `ids.length > 1`, so a person who
    // interrupted a long turn with one unrelated question was never asked, and the offer could only
    // appear when the queue happened to hold two messages at the moment a reading fired.
    //
    // BOTH DIRECTIONS ARE GUARDED, and they were not. The wording cautioned against inventing a
    // division and said nothing against collapsing real ones, which is a one-sided instruction and
    // biases the way one-sided instructions do. Observed live: three requests - a headcount figure,
    // which tools a process touches, and whether the pricing page is accurate - came back as ONE
    // topic, reasoned as "all three are quick lookups from internal context". That is a fact about
    // how this assistant ANSWERS rather than about what was ASKED, and it is true of nearly every
    // request here, so as an axis it collapses every queue into one topic.
    //
    // Over-merging is also the failure that hides: one topic is not an error, it is "no split
    // needed", so the offer simply never appears and nothing looks wrong.
    lines.push(
      '',
      'Then group those messages by SUBJECT, one line per subject, in exactly this form:',
      'TOPIC: <a short name for the subject> | <the ids it covers, comma separated>',
      '',
      // BOTH SIDES OF THE COMPARISON. Without this the running work is invisible to the grouping,
      // so a single queued message has nothing to be a different subject FROM.
      ...(hasWorkInFlight
        ? [
          'The work you were already doing is also a subject. Give it a TOPIC line of its own, using',
          'the literal id ' + IN_FLIGHT_TOPIC_ID + ' in place of a message id:',
          'TOPIC: <a short name for what you were working on> | ' + IN_FLIGHT_TOPIC_ID,
          'Put a queued id on THAT line instead of its own when the message is about the work you',
          'were already doing rather than about something else.',
          '',
        ]
        : []),
      'The subject is what a request is ABOUT, not how you would answer it. That several of them',
      'are answered by looking something up is true of nearly everything asked here, so it groups',
      'nothing.',
      '',
      'Every id above must appear in exactly one TOPIC line. Put two together only when answering',
      'one would tell you something about the other; if they would be better served as separate',
      'conversations, they are separate subjects. Neither invent a division that is not there nor',
      'merge distinct requests to be tidy.',
      '',
    );
  } else if ((ids.length > 1 || hasWorkInFlight) && viaTool) {
    // THE RULE WITHOUT THE FORM. Only the text SHAPE was channel-specific; the judgement it asks for
    // is not, and dropping it with the form would have silently ended the split offer on the primary
    // channel - over-merging is the failure that hides, because one subject reads as "no split
    // needed" and nothing looks wrong.
    lines.push(
      '',
      'Also record the SUBJECTS this queue covers, in the `topics` field of that same call, whenever',
      'it covers more than one. Every id appears in exactly one topic.',
      ...(hasWorkInFlight ? [
        'The work you were already doing is also a subject: give it a topic of its own using the',
        'literal id ' + IN_FLIGHT_TOPIC_ID + ', and put a queued id on that topic instead of its own',
        'when the message is about the work you were already doing.',
      ] : []),
      'The subject is what a request is ABOUT, not how you would answer it. That several of them are',
      'answered by looking something up is true of nearly everything asked here, so it groups nothing.',
      'Put two together only when answering one would tell you something about the other. Neither',
      'invent a division that is not there nor merge distinct requests to be tidy.',
      '',
    );
  }
  // THE SPOKEN HALF IS ASKED FOR DIFFERENTLY, because on one channel it has to be separated from
  // the machine lines and on the other there is nothing to separate it from.
  //
  // Left as the text wording while the tool was live, the model was told to write a marker "after
  // those lines" when it had written no lines - so it called the tool and stopped, the loop ran out
  // of iterations on `stopReason: tool_use`, and the turn logged "the model returned no text; there
  // is nothing to answer with". Measured on the deployment.
  lines.push(...(viaTool ? [
    'After you have called the tool, and only then, say to the person - in your own voice and in the',
    'language of the conversation - what you understood and what you propose to do. Everything you',
    'write is for them: the reading is already recorded, and no part of your words is parsed.',
  ] : [
    'After those lines, and only after them, write a single line containing exactly:',
    'PROPOSAL:',
    'and then say to the person, in your own voice and in the language of the conversation, what',
    'you understood and what you propose to do. That part is yours. The lines above are not.',
  ]));
  // ── SPEAK ABOUT THE MESSAGES YOU WERE GIVEN, AND NOTHING ELSE (owner-reported, 2026-09-05) ─────
  //
  // The open work above is POSITIONS, NOT SUBJECTS - `openWork` carries a type, a priority and
  // whether it is private, and deliberately no label, so that a private task can hold its place in
  // the order without its contents being handed to the turn. The ranking instruction already says
  // not to guess what one is. Nothing said not to TALK about them, and the two are different acts.
  //
  // Measured: a reading closed by telling somebody "there are a few earlier messages still open -
  // 'Who created it', 'What's dpit', and 'Hop' - and I wasn't able to act on them". Two of those
  // were open. The third had been read as an amendment to the work in flight, folded into it, and
  // ANSWERED - the task table for that conversation holds no row for it, because none was ever
  // meant to exist. The model had reconstructed the list from the conversation history and got it
  // wrong, and on this channel its prose is spoken whole, so nothing compared the claim to the work.
  //
  // The cost is not an untidy sentence. Being told that something already answered is still
  // outstanding invites the person to answer it again, and makes the assistant look like it has
  // lost the thread of a conversation it is in fact holding correctly.
  //
  // BOTH CHANNELS, because the rule is about what may be SAID and neither channel changes that.
  lines.push(
    '',
    'Speak only about the messages listed above. Do not tell the person what other work is open, do',
    'not restate earlier messages as still outstanding, and do not describe anything you were not',
    'given here - you have been told the POSITION of the other work in this conversation, never its',
    'subject, so any account of it would be invented. If something earlier was already dealt with,',
    'saying it is still open asks the person to answer it twice.',
  );
  if ((ids.length > 1 || hasWorkInFlight) && splitOfferAvailable()) {
    // THE OFFER IS THE MODEL'S TO WORD, and tenet D11 is why. This turn already carries the
    // deployment's persona and the conversation's language; a sentence composed here would be the
    // same flat English in every deployment and every language. The RULE is stated, not the words.
    lines.push(
      '',
      viaTool
        ? 'If you recorded more than one topic, then in that same paragraph tell the person the'
        : 'If you wrote more than one TOPIC line, then in that same paragraph tell the person the',
      'conversation is now covering more than one subject, name the subjects, and offer to continue',
      'any of them in a separate conversation so the context stays separate.',
      'Do not offer to move the work you were already doing; it continues here.',
      'ASK WHICH ONES they want separated. Do not assume all of them, and do not assume none.',
      'Nothing moves unless they say so, so do not describe the split as something already decided.',
    );
  }
  if (mayAskForAnotherPass) {
    lines.push(
      '',
      'If you genuinely cannot produce that reading yet, reply with ONLY a single ANOTHER_PASS:',
      'line giving a short reason, and no TRIAGE: lines.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function buildTriagePrompt(args: {
  queued: Array<{ messageId: string; content: string }>;
  /** The work already in progress, if any, so the model can say whether it is still wanted. */
  inFlightLabel?: string;
  /**
   * Whether another pass is still affordable. Offered to the model ONLY when it is: an instruction
   * describing an option the runtime would then refuse teaches it to ask for something that silently
   * does not happen, and the reply that asks is a reply that produced no reading.
   */
  mayAskForAnotherPass?: boolean;
  /**
   * TRUE when the reading is recorded through the tool, which is what this prompt must NOT restate.
   *
   * The system directive already carries the contract. This message restating a DIFFERENT one - the
   * line format, and a vocabulary of only `amends|new` - is the "two contracts for one answer"
   * failure a third time, and the worst of the three: the one that omits `unclear` is the one the
   * model reads last, so the value it is being asked to use was the value the closer instruction
   * forbade.
   */
  viaTool?: boolean;
}): string {
  const { queued, inFlightLabel, mayAskForAnotherPass, viaTool } = args;
  const lines = queued.map((m) => `- id=${m.messageId} :: ${m.content}`).join('\n');
  return [
    'These messages arrived while you were working and have not been answered yet.',
    inFlightLabel
      ? `You were working on: ${inFlightLabel}`
      : 'You were not working on a named task.',
    '',
    lines,
    '',
    'Read them TOGETHER, not one at a time: several messages that are one request read as one request',
    'only when they are seen at once.',
    '',
    'For EACH message, decide whether it CHANGES what you were already working on, or asks for',
    'something NEW that deserves its own piece of work. Do not answer any of them yet.',
    '',
    // SAID ONCE, IN THE PLACE THAT OWNS IT. On the tool channel the system directive states the
    // contract - the call, the three intents, the rule for `unclear` - and repeating a two-value
    // vocabulary here would contradict it.
    ...(viaTool ? [] : [
      'Reply with one line per message, in this exact form and nothing else on the line:',
      'TRIAGE: <id> | <amends|new|unclear> | <high|normal|low> | <a short label for the work>',
      '',
    ]),
    // ── EVERY LITERAL BELOW IS THE TEXT CHANNEL'S, AND ONLY THE TEXT CHANNEL'S (e2e, 2026-09-15) ────
    //
    // `TRIAGE:` above was gated on the channel from the start and these three were not, which is the
    // same "two contracts for one answer" failure this file already records twice - once for offering
    // the tool while still describing the line format, once for the `TOPIC:` line that was spoken to a
    // person on 2026-09-05. On the tool channel the reading is recorded by `record_reading` and
    // NOTHING parses the model's text, so `PROPOSAL:`, `ANOTHER_PASS:` and `IN_FLIGHT_UNCLEAR` mean
    // nothing there - while the directive tells the model that everything it writes is for the person.
    // Given both, it obeyed both, and a proposal opened with a bolded `**PROPOSAL:**` heading in front
    // of somebody.
    //
    // NOTHING IS LOST BY GATING THEM. `in_flight_unclear` is a field on the reading tool, so that
    // judgement travels as structure and is asked for as structure below. The another-pass escape
    // hatch is stated by `triageContractDirective`, which is the system prompt this message must not
    // restate differently. And the spoken half is still asked for - it is only the marker separating
    // it from machine lines that were never written that goes.
    //
    // ON THE TEXT CHANNEL EVERY ONE OF THEM IS A PARSE BOUNDARY and stays exactly as it is:
    // `parseTriageProposal` splits on `PROPOSAL:` and that split is a security boundary rather than
    // tidiness, `parseAnotherPassRequest` reads its marker from before it, and `AMBIGUOUS_LINE` is how
    // the in-flight question is declared at all.
    //
    // TENET D11 IS NOT IN THE WAY HERE, and this half is the direction the tenet prefers: it takes
    // English literals OUT of what the model is told to write, leaving the judgement to travel as a
    // boolean field instead of a phrase.
    //
    // STEP 3 OF THE LOOP (DESIGN 2.3). Returning a confident reading it does not have is the failure
    // this exists to prevent, so the model is given somewhere to put "not yet" other than a guess.
    mayAskForAnotherPass && !viaTool
      ? 'If you genuinely cannot produce that reading yet - because you need to look something up '
        + 'first - reply with ONLY this line instead, and no TRIAGE: lines:\n'
        + 'ANOTHER_PASS: <a short reason, for the log>'
      : '',
    '',
    // THE JUDGEMENT WITHOUT THE FORM, exactly as the directive handles `topics` on this channel: the
    // question is the same either way, and only where the answer is put changes.
    inFlightLabel
      ? (viaTool
        ? 'If you cannot tell whether the work you were doing is still wanted, say so in the '
          + '`in_flight_unclear` field of that call.'
        : 'If you cannot tell whether the work you were doing is still wanted, add a line: IN_FLIGHT_UNCLEAR')
      : '',
    '',
    // THE VOICE. The lines above are for the machine; this is the part a person reads, and it is
    // asked for in the assistant's OWN words because this turn already carries the deployment's
    // persona and its reply-language instruction. A composed sentence would discard both.
    viaTool
      // WRAPPED SO NO PHRASE BREAKS ACROSS A LINE. The reply-language instruction is the one the
      // model most needs to read whole, and a line break through the middle of it is a needless way
      // to make it easier to skim past.
      ? 'Then tell the person what you understood, in your own voice and in the language of the '
        + 'conversation.\nSay what you would do first and ask them to correct you.'
      : 'Then write PROPOSAL: on its own line, and after it tell the person what you understood, in your\n'
        + 'own voice and in the language of the conversation. Say what you would do first and ask them to\n'
        + 'correct you.',
    inFlightLabel
      ? 'If you were unsure whether to finish what you were working on, ask them that too.'
      : '',
    // ── WHAT CHANGES THE WORK IN FLIGHT IS ALREADY BEING ROLLED IN ──────────────
    //
    // The runtime folds these into the answer before it is sent; it does not wait for the person to
    // confirm. Measured live: the proposal said "I'll fold all of that into one comprehensive answer
    // when I respond ... I'll get the full answer to you first", while the folded answer was already
    // being written, and it arrived 20 seconds later without anybody having replied. So the proposal
    // says what is actually happening, and asks only about what is genuinely open.
    inFlightLabel
      ? 'Anything you judged to CHANGE what you were working on is being included in that answer now, '
        + 'before it is sent. Say that plainly, in the present tense, and do not ask them to confirm it '
        + 'or to wait for it. Ask only about the new or unclear messages.'
      : '',
    // The person cannot open a message id, and pasting one reads as a system leak in a sentence
    // meant for them.
    'Do not include the message ids.',
  ].filter(Boolean).join('\n');
}

/**
 * Read a triage reply, or return null.
 *
 * NULL MEANS "NOT A DECISION", and the caller leaves the queue alone. A partially readable reply is
 * still null: acting on the half that parsed would create some of the work and silently drop the
 * rest, which is worse than doing none of it, because the dropped half looks like a request that
 * never happened.
 */
/**
 * WHY a reading was refused, in structure only.
 *
 * `parseTriageProposal` returns null for eight different reasons and the caller logged none of
 * them, so a queue that stopped draining said nothing about what the model had actually replied.
 * This is the diagnostic half, kept OUT of the parser so the parser stays a pure contract check.
 *
 * IT REPORTS SHAPE, NEVER CONTENT. The ids and the counts are safe to log; the labels and the
 * spoken half are the person's own words coming back through the model, and this record has no
 * business holding a copy of those - the queue itself refuses to hold content for the same reason.
 */
export function describeTriageParseFailure(
  response: string,
  expectedIds: string[],
): {
  triageLines: number;
  emittedIds: string[];
  unexpectedIds: string[];
  missingIds: string[];
  hadProposalMarker: boolean;
  hadAnotherPass: boolean;
} {
  const raw = (response ?? '').trim();
  const split = /^[ \t]*PROPOSAL[ \t]*:[ \t]*$/im.exec(raw);
  const text = split ? raw.slice(0, split.index) : raw;
  const emitted: string[] = [];
  TRIAGE_LINE.lastIndex = 0;
  for (const match of text.matchAll(TRIAGE_LINE)) {
    const first = match[1].split('|')[0]?.trim();
    if (first) emitted.push(first);
  }
  const expected = new Set(expectedIds);
  const emittedSet = new Set(emitted);
  return {
    triageLines: emitted.length,
    emittedIds: emitted,
    unexpectedIds: emitted.filter((id) => !expected.has(id)),
    missingIds: expectedIds.filter((id) => !emittedSet.has(id)),
    hadProposalMarker: !!split,
    hadAnotherPass: /^ANOTHER_PASS:/m.test(text),
  };
}

/**
 * The subjects the reading named, or nothing.
 *
 * FAIL SOFT, AND SAY NOTHING RATHER THAN SOMETHING PARTIAL. A topic block that does not cover the
 * queue exactly once is a grouping nobody can act on: offering to split "these two of your five"
 * leaves the person deciding about messages the offer never mentions. Undefined means the reading
 * stands and no split is offered, which is the right outcome for an unusable grouping.
 */
/**
 * WHICH SUBJECTS MAY BE OFFERED TO THIS PERSON, AND WHAT EACH ONE WOULD BECOME (DESIGN 2.4.2).
 *
 * A queue is not always one person. Several people share a room with the same assistant, and two of
 * them typing at once is ordinary - so the subjects a reading finds can belong to different people,
 * and some of them can be nobody else's business.
 *
 * THREE THINGS ARE DECIDED HERE, and each is a disclosure question rather than a tidiness one:
 *
 *   - A subject that exists because of a TARGETED message is private. Splitting it must carry only
 *     its requester, because the room never saw it; carrying the room would publish it by moving it.
 *   - Every subject is recorded, with WHOSE it is, because the assistant deals with the shared ones
 *     in the open and then goes to each person privately about theirs. Narrowing to one person here
 *     would mean everybody else was never asked about their own.
 *   - TWO PEOPLE'S TARGETED MESSAGES ON ONE SUBJECT ARE TWO REQUESTS, NOT ONE. A message has exactly
 *     one sender, so a subject holding targeted messages from two people is not one request that two
 *     people made - it is two private requests that happen to be about the same thing, and the
 *     reading grouped them by their subject. Each becomes its own private request, belonging to its
 *     own sender. Merging them would put two people's private requests in one room on the authority
 *     of whichever answered first (2.4.1); dropping the subject would silently lose both.
 *   - Untargeted messages inside such a subject are NOT offered. Once a subject has been divided by
 *     privacy, what is left is half a thread, and nobody can meaningfully consent to moving half a
 *     thread somewhere else. Those messages stay where they are, which costs an offer and loses
 *     nothing.
 *
 * An ordinary subject carries the ROOM with it, which is the opposite default and the right one: the
 * room could already read it, and moving it into a conversation they are not in would make a shared
 * thread disappear for everyone but the person who answered.
 */
export function topicsForOffer(args: {
  topics: ProposedTopic[];

  /** Queued messages that were targeted, so not the room's to read. */
  targetedIds?: string[];
  /** Who sent each queued message, as an AppInstanceUser ARN. */
  sendersById?: Record<string, string>;
}): Array<{
  label: string;
  messageIds: string[];
  private?: boolean;
  requestorId?: string;
}> {
  const targeted = new Set(args.targetedIds ?? []);
  const senders = args.sendersById ?? {};
  // `inFlight` is internal to this function: it decides what may move and is not part of the offer.
  const offerable: Array<{
    label: string; messageIds: string[]; private?: boolean; requestorId?: string; inFlight?: boolean;
  }> = [];

  // THE SHORT FORM, and only the short form. A sender arrives here as a full ARN, and the principal
  // id is its tail - which is what every identity comparison in this design uses, and what makes the
  // recorded subject comparable without parsing it. The ARN is derivable again wherever a message
  // actually has to be addressed, so keeping it would store the account, the region and the app
  // instance on every subject of every queue to save a concatenation.
  const principalOf = (arn: string): string => personIdFromArn(arn) || arn;

  for (const topic of args.topics) {
    // ── IS THIS THE WORK ALREADY RUNNING? ASKED OF THE TOPIC, NOT OF WHAT SURVIVES THE SPLIT ─────
    //
    // The `movable` filter at the end reads `IN_FLIGHT_TOPIC_ID` out of each entry's own
    // `messageIds`. That works for the untargeted branch, which pushes `topic.messageIds` intact,
    // and fails for the private one: it rebuilds each entry from the TARGETED ids alone, and the
    // in-flight marker is not a targeted message, so it never survives. A private message grouped
    // with the work in flight therefore passed the filter, and the assistant offered to move the
    // work it was already doing - accepting which creates a conversation named for in-flight work
    // that then stays exactly where it was.
    //
    // The question belongs to the SUBJECT either way, so it is asked once, here, of the topic.
    const topicIsInFlight = topic.messageIds.includes(IN_FLIGHT_TOPIC_ID);
    // PARTITIONED BY WHOSE PRIVATE MESSAGE IT WAS. A message has one sender, so each distinct sender
    // among the targeted messages is a distinct private request that merely shares a subject with
    // the others.
    const byRequestor = new Map<string, string[]>();
    // TARGETED, BUT WE DO NOT KNOW WHOSE. `sendersById` is optional and the dispatcher omits an entry
    // for a message whose `Sender.Arn` it could not read, while still listing that id in
    // `targetedIds` - so "this is private" and "this is whose" can disagree, and this is the side
    // that must not be guessed.
    let targetedWithNoSender = false;
    for (const id of topic.messageIds) {
      if (!targeted.has(id)) continue;
      const arn = senders[id];
      if (!arn) { targetedWithNoSender = true; continue; }
      const existing = byRequestor.get(arn);
      if (existing) existing.push(id);
      else byRequestor.set(arn, [id]);
    }

    // FAILS CLOSED, and it used to fail open. Dropping the id above left a topic whose targeted
    // messages were ALL unattributable looking like an ordinary one, so it was pushed below as a
    // public subject still carrying those ids: stored un-private, shown by `readPendingSplit` to
    // anyone in the room, and - if chosen - turned into a conversation NAMED for that private
    // request with the whole room carried into it.
    //
    // Not offering costs a convenience on a turn where the offer was optional anyway. Offering
    // wrongly publishes something somebody deliberately sent privately, and does it in a channel
    // name, which is the one place it cannot be redacted afterwards.
    if (targetedWithNoSender) {
      console.warn('[turn-triage] a targeted message has no known sender; not offering this subject', {
        label: topic.label, messages: topic.messageIds.length,
      });
      continue;
    }

    if (!byRequestor.size) {
      // Ordinary, and the room comes with it. Reached only when NOTHING in the topic was targeted.
      offerable.push({ label: topic.label, messageIds: topic.messageIds, inFlight: topicIsInFlight });
      continue;
    }

    // WHOSE IT IS travels with it. Who may be told about it is decided when the offer is READ, by
    // whoever is standing in front of it - see `readPendingSplit`.
    for (const [requestorArn, messageIds] of byRequestor) {
      offerable.push({
        label: topic.label,
        messageIds,
        private: true,
        requestorId: principalOf(requestorArn),
        inFlight: topicIsInFlight,
      });
    }

    // The untargeted remainder of a subject that turned out to be partly private is deliberately
    // left out: it is half a thread, and moving half a thread is not something anybody can consent
    // to on the strength of a label that described the whole.
  }

  // WHAT MAY MOVE IS NOT WHAT COUNTS AS A SUBJECT. The work in progress is one of the subjects this
  // conversation is covering - that is the point of putting it on the queue - but it is the thing
  // being separated FROM, so it is never among the things that may move. Counting the subjects and
  // choosing what may move are two different questions, and conflating them is what left "one report
  // plus one unrelated question" looking like a single-subject queue.
  // ASKED OF THE SUBJECT, recorded above. Reading the marker out of the entry's own ids was only
  // ever correct for entries that kept the whole topic.
  const movable = offerable
    .filter((t) => !t.inFlight)
    .map(({ inFlight: _inFlight, ...offer }) => offer);
  return args.topics.length > 1 ? movable : [];
}
export function parseTopicLines(text: string, expectedIds: string[]): ProposedTopic[] | undefined {
  const expected = new Set(expectedIds);
  const topics: ProposedTopic[] = [];
  const claimed = new Set<string>();

  TOPIC_LINE.lastIndex = 0;
  for (const match of text.matchAll(TOPIC_LINE)) {
    const parts = match[1].split('|').map((part) => part.trim());
    if (parts.length < 2) return undefined;
    const label = parts[0];
    const messageIds = parts.slice(1).join(',').split(',').map((id) => id.trim()).filter(Boolean);
    if (!label || !messageIds.length) return undefined;

    for (const id of messageIds) {
      // The work in progress is a subject but not a queued message, so it is accepted here and left
      // out of the coverage check below - there is no id in the queue for it to account for.
      if (id === IN_FLIGHT_TOPIC_ID) continue;
      // An id outside the queue, or in two topics at once, is a grouping with no single answer.
      if (!expected.has(id) || claimed.has(id)) return undefined;
      claimed.add(id);
    }
    topics.push({ label, messageIds });
  }

  // EVERY queued message sits in exactly one topic, or there is no usable grouping. Anything less
  // describes part of the queue while the person believes it describes all of it.
  if (!topics.length || claimed.size !== expected.size) return undefined;

  // ONE TOPIC IS NOT A SPLIT, and with the running work carrying a topic of its own this needs no
  // exception: a queued message on a different subject makes two, and one that continues the running
  // work makes one, which is the ordinary case and correctly offers nothing.
  return topics.length > 1 ? topics : undefined;
}

export function parseTriageProposal(
  response: string,
  expectedIds: string[],
): TriageProposal | null {
  const raw = (response ?? '').trim();
  if (!raw) return null;

  /**
   * THE MACHINE PART AND THE SPOKEN PART ARE SPLIT BEFORE EITHER IS READ, and the split is a
   * security boundary rather than tidiness.
   *
   * `TRIAGE:` lines are matched anywhere in the text. If the spoken paragraph were included in that
   * search, a proposal that happened to quote a person's message back - "you asked me to TRIAGE: ..."
   * - could contribute a line to the decision. Reading the contract only from the text BEFORE the
   * marker means the prose can say anything at all and change nothing.
   */
  const split = /^[ \t]*PROPOSAL[ \t]*:[ \t]*$/im.exec(raw);
  const text = split ? raw.slice(0, split.index) : raw;
  const spoken = split ? raw.slice(split.index + split[0].length).trim() : '';

  const expected = new Set(expectedIds);
  const items: ProposedItem[] = [];
  const seen = new Set<string>();

  TRIAGE_LINE.lastIndex = 0;
  for (const match of text.matchAll(TRIAGE_LINE)) {
    const parts = match[1].split('|').map((p) => p.trim());
    if (parts.length < 4) return null;
    const [messageId, intent, priority, ...rest] = parts;
    const label = rest.join(' | ').trim();

    // Every field is checked against a closed set. A value outside it is a reply this contract does
    // not cover, and guessing which one was meant is how an unrecognized answer becomes a decision.
    if (!expected.has(messageId)) return null;
    if (!INTENTS.has(intent)) return null;
    if (!PRIORITIES.has(priority)) return null;
    if (!label) return null;
    // A message classified twice has no single answer, so the reply is not usable.
    if (seen.has(messageId)) return null;
    seen.add(messageId);

    items.push({
      messageId,
      intent: intent as QueuedIntent,
      priority: priority as TaskPriority,
      label,
    });
  }

  // EVERY queued message must be accounted for. A reply covering some of them would have the caller
  // clear a queue whose remainder was never triaged.
  if (items.length !== expectedIds.length) return null;

  const topics = parseTopicLines(text, expectedIds);

  return {
    items,
    inFlightAmbiguous: AMBIGUOUS_LINE.test(text),
    ...(topics ? { topics } : {}),
    // Only when the model actually said something. An empty marker is the same as no marker, and
    // posting a blank message would be worse than posting the composed one.
    ...(spoken ? { spoken } : {}),
  };
}

/**
 * What the person reads: the proposal, in their terms.
 *
 * IT DESCRIBES, IT DOES NOT ANNOUNCE. "Here is what I understood" rather than "I have created three
 * tasks", because nothing has been created: this is the reading, and the next thing that happens is
 * their answer. Copy that claims work already exists would make the pause look like a formality.
 *
 * THE IN-FLIGHT QUESTION IS ASKED LAST AND ASKED PLAINLY. It is the decision only they can make, and
 * burying it under a list is how it gets skipped. When triage could tell, it is not asked at all -
 * a question with an obvious answer teaches people to stop reading the questions.
 */
/**
 * What could not be recorded, said plainly.
 *
 * NAMED, NEVER HIDDEN. A message that failed to become a task is one the person believes arrived,
 * and the only way they find out otherwise is being told - so it carries the labels and the one
 * action that fixes it. Silence here is the failure this whole design is judged against.
 *
 * IT IS NOT LEFT TO THE MODEL, and that is the one place a fixed string is the right answer: the
 * write failed AFTER the reply was generated, so the model could not have known. A voice cannot
 * report a fact it never saw.
 */
/**
 * WHAT COULD NOT BE RECORDED, WITHOUT SAYING WHAT THE PRIVATE ONES WERE.
 *
 * This lands in the same room-visible message as the proposal, so it is under the same rule as the
 * list above (section 2.4.0): a targeted request's label describes something somebody sent privately,
 * and naming it here publishes it. The itemised list was filtered and this was not, so one failed
 * task write was enough to put a private label in front of everyone - on the path that only runs
 * when something has already gone wrong.
 *
 * Untargeted ones are named, because a person cannot resend what they cannot identify. Targeted ones
 * are counted; their senders learn which from the private follow-up they get anyway.
 */
function couldNotRecord(lost: ProposedItem[], targeted: Set<string> = new Set(), copy?: AssistantCopy): string {
  const named = lost.filter((l) => !targeted.has(l.messageId));
  const hidden = lost.length - named.length;

  const lines: string[] = [
    say(copy, 'triageCouldNotRecord', { count: lost.length }),
    ...named.map((l) => `- ${l.label}`),
  ];
  if (hidden) lines.push(`- ${say(copy, 'triageCouldNotRecordPrivate', { count: hidden })}`);
  lines.push(say(copy, 'triageResendLost'));
  return lines.join('\n');
}

/**
 * THE READING THAT CANNOT FAIL, built from the messages themselves.
 *
 * `parseTriageProposal` fails closed, and it should: a half-understood grouping that has already
 * created tasks is worse than none. But the DRAIN must not fail with it. The queue is always emptied
 * (ADR-033), so when the judged reading is unusable this supplies the floor the drain runs against.
 *
 * Deliberately the dumbest possible reading. Every message becomes its own piece of work at ordinary
 * priority, because that is what is knowable without judgement: guessing that two messages are one
 * request, or that one amends the work in flight, is exactly the judgement that just failed. Being
 * boring here is what makes it safe to always run.
 */
export function deriveTriageProposal(
  messages: { messageId: string; content: string }[],
  copy?: AssistantCopy,
): TriageProposal | null {
  const items: ProposedItem[] = messages
    .filter((m) => m.messageId)
    .map((m) => ({
      messageId: m.messageId,
      // UNCLEAR, AND NEVER `new` OR `amends` (maintainer, 2026-09-03: "if a whole reading is unclear the
      // assistant should just state so").
      //
      // This floor runs when the judged reading was UNUSABLE - nothing was understood about any of
      // these messages. It marked them `new` anyway, which opens a `queued_request` in `proposed`:
      // a row per message saying "here is the work I propose to do", labeled with a slice of the
      // person's own words. A reading that understood nothing was thereby the most confident output
      // this path can produce, and every one of those items was a guess the person had to notice and
      // correct.
      //
      // `amends` was already refused here for exactly this reason - folding a message into running
      // work is a claim the derived floor has no basis for - and `new` is the same claim about what
      // the work IS. The honest answer is the one the vocabulary now has: these arrived, they are
      // held, and what they ask for is not known.
      //
      // FR10 IS UNCHANGED AND STILL SATISFIED. The queue still always drains and every message still
      // becomes a durable, owned item that nothing loses. What changed is what that item CLAIMS.
      intent: 'unclear' as QueuedIntent,
      priority: 'normal' as TaskPriority,
      label: deriveLabel(m.content, copy),
    }));
  return items.length ? { items, inFlightAmbiguous: false, derived: true } : null;
}

/** A short handle for a piece of work, taken from the message rather than invented. */
function deriveLabel(content: string, copy?: AssistantCopy): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim();
  if (!flat) return say(copy, 'triageDerivedLabel');
  // Long enough to recognize the request in a task list, short enough to be a label rather than a
  // copy of the message: the task row is not where a person's words are stored.
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

/**
 * A TARGETED REQUEST IS COUNTED IN THE ROOM, NEVER DESCRIBED THERE.
 *
 * The proposal updates the turn placeholder, and `UpdateChannelMessage` carries no `Target` - so
 * everything in it is read by every member. That makes the LABEL of a targeted request a disclosure
 * rather than a courtesy: a label is a short description of what somebody asked for privately, and
 * describing it is the leak.
 *
 * What the room gets is a COUNT. That the queue held private requests is not itself private - the
 * deferral notice already says how many messages are waiting - and saying nothing would leave the
 * person who sent one unsure it arrived at all. What the count must never carry is whose, or about
 * what.
 */
export function publicProposalCount(targeted: number, copy?: AssistantCopy): string {
  return say(copy, 'queuedPrivateCount', { count: targeted });
}

export function buildProposalMessage(
  proposal: TriageProposal,
  lost: ProposedItem[] = [],
  opts: {
    /** Queued messages that were targeted. Their labels never reach the room. */
    targetedIds?: string[];
    /**
     * The work already open in this conversation, so the order shown is the WHOLE order.
     *
     * Structural rather than `ConversationTask`, to keep this module free of the task store: what it
     * needs is a position and something to call it, and a private row supplies both.
     */
    openWork?: Array<{ taskType?: string; private?: true; priority?: TaskPriority; taskRef?: number }>;
    /**
     * Whether to take outstanding clarifications up, offer to, or say nothing.
     *
     * DECIDED BY THE CALLER, which is what keeps the rule testable on its own and this module free of
     * the task store: the decision is about priorities across live work, and composing a message is
     * not the place to be reading tasks.
     */
    followUp?: ClarificationFollowUp;
    copy?: AssistantCopy;
  } = {},
): string {
  const targetedSet = new Set(opts.targetedIds ?? []);
  const targetedCount = proposal.items.filter((i) => targetedSet.has(i.messageId)).length;
  /**
   * THE MODEL'S OWN WORDS, WHEN IT GAVE THEM.
   *
   * This turn runs with the deployment's persona and the host's reply-language instruction already
   * applied, so its prose is in the right voice and the right language. Composing a sentence here
   * instead produced the same flat English for a terse assistant, a warm one, and a conversation
   * being held in Chinese.
   *
   * WHAT IS STILL APPENDED IS WHAT THE MODEL COULD NOT KNOW. A task write that failed happens AFTER
   * this reply was generated, so no amount of voice covers it - the platform has to say it, and say
   * it plainly, because a person told their message was picked up when nothing holds it is the one
   * outcome this design exists to prevent.
   */
  // THE MODEL'S PROSE IS REFUSED WHEN THE BATCH WAS MIXED, and this is the part easy to get wrong.
  // The reading was shown every queued message INCLUDING the targeted ones, and nothing in its
  // contract tells it which of them the room may not see - so its paragraph is free to narrate a
  // private request into a message it has no way to know is public. Its voice is worth a great deal
  // and it is not worth that. The composed list below is built from the untargeted items only.
  if (proposal.spoken && !targetedCount) {
    // THE REFERENCES FOLLOW THE ASSISTANT'S OWN WORDS, so a reply from any channel can name an item.
    const created = lost.length
      ? proposal.items.filter((i) => !lost.some((l) => l.messageId === i.messageId))
      : proposal.items;
    const refs = referenceLine(created, targetedSet);
    const spoken = refs ? `${proposal.spoken}\n\n${refs}` : proposal.spoken;
    return lost.length
      ? `${spoken}\n\n${couldNotRecord(lost, new Set(), opts.copy)}`
      : spoken;
  }
  // WHAT LANDED, not what was read. An item whose task write failed exists nowhere, so naming it here
  // would tell the person their message was picked up when nothing holds it - the exact reassurance
  // this design exists to make true. It is named separately below instead, as something to resend.
  // AND WHAT THE ROOM MAY READ. A targeted item is dropped from the itemised list entirely - not
  // relabelled and not redacted in place, because a redaction sitting in an ordered list still says
  // where in the order it fell.
  const kept = (lost.length
    ? proposal.items.filter((i) => !lost.some((l) => l.messageId === i.messageId))
    : proposal.items).filter((i) => !targetedSet.has(i.messageId));
  const amends = kept.filter((i) => i.intent === 'amends');
  const fresh = kept.filter((i) => i.intent === 'new');

  // ── WHEN NOTHING WAS UNDERSTOOD, SAY THAT AND NOTHING ELSE (maintainer, 2026-09-03) ────────────────
  //
  // "Here is what I understood" is a false sentence in front of a list of things it did not
  // understand, and it is the most damaging place to say it: the person reads the opening, trusts the
  // list, and only later finds that every item was a guess. A whole reading being unclear is the one
  // case where the assistant should simply state so.
  //
  // `triageUnclear` is REUSED rather than a new key, because it is already the deployment's words for
  // exactly this - the bounded loop ending without a reading - and its contract already requires the
  // wording to ask something answerable rather than only admit confusion.
  const nothingUnderstood = kept.length > 0 && kept.every((i) => i.intent === 'unclear');
  const lines: string[] = [nothingUnderstood
    ? say(opts.copy, 'triageUnclear')
    : say(opts.copy, 'triageUnderstood')];

  if (amends.length) {
    lines.push('', say(opts.copy, 'triageAmendsHeading'));
    for (const a of amends) lines.push(`- ${a.label}`);
  }
  // ── AND THE ONES IT COULD NOT MAKE OUT, SAID SEPARATELY ────────────────────────────────────────
  //
  // Listed apart from the work, not mixed into it, because they are a different claim: the message is
  // held and the request is not understood. Folding them into the proposed list would put items
  // there that nobody has agreed and the assistant cannot start - which is the confident-guess
  // failure the `unclear` intent exists to end.
  //
  // The LABEL for an unclear item names what the reading would need to know rather than what it would
  // do, so these lines read as questions. Nothing here quotes the message: the proposal is posted to
  // the room.
  const unclear = kept.filter((i) => i.intent === 'unclear');
  if (unclear.length) {
    // NO HEADING WHEN THE OPENING ALREADY SAID IT. A whole-reading failure would otherwise say it
    // could not tell what these ask for twice in three lines, which reads as a stutter rather than
    // as care. The heading exists to SEPARATE these from work that was understood; with no such work
    // in the message, there is nothing to separate them from.
    if (!nothingUnderstood) {
      lines.push('', say(opts.copy, 'queuedUnclear'));
    } else {
      lines.push('');
    }
    for (const u of unclear) lines.push(`- ${u.label}`);
  }
  if (fresh.length) {
    // High first, then normal, then low. The ORDER IS SHOWN because it is the thing being proposed:
    // a list with no order is not a plan anyone can correct.
    const rank: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

    // ── NEW WORK IS NOT NEXT WORK (maintainer, 2026-09-01) ────────────────────────────────────────────
    //
    // This ranked the arriving messages against each other and showed them alone, so a queue read
    // after earlier work was already recorded produced a fresh numbered list starting at 1. Nothing
    // said where those items fell against the tasks already open, and a list ranked only against
    // itself reads as the list that goes first - which is the opposite of what triage is for.
    //
    // A PRIVATE ROW TAKES ITS PLACE AND SAYS SO (maintainer, 2026-09-01, extending the 2026-08-23 rule
    // that existence is conversation-visible). Its position is occupancy, not content, so it is
    // listed as private rather than omitted - omitting it would move everything below it up a place
    // and misstate the order for everyone.
    const open = (opts.openWork ?? []).map((t) => ({
      priority: t.priority ?? ('normal' as TaskPriority),
      // Named exactly as the context hint names it, and no more specifically: anything else would
      // invent detail the read deliberately stripped.
      label: t.private ? say(opts.copy, 'triagePrivateTaskLabel') :(t.taskType || 'general'),
      isNew: false,
      ref: t.taskRef,
    }));
    const incoming = fresh.map((f) => ({ priority: f.priority, label: f.label, isNew: true, ref: f.taskRef }));
    // STABLE, which is load-bearing: at equal priority the work already recorded keeps its place and
    // the arrival falls in behind it. An unstable sort here would let a tie displace work the person
    // has already been shown, silently, in the one message whose whole purpose is to state an order.
    const merged = [...open, ...incoming].sort((a, b) => rank[a.priority] - rank[b.priority]);

    lines.push('', open.length
      ? say(opts.copy, 'triageOrderAgainstOpen')
      : say(opts.copy, 'triageOrderNew'));
    // MARKED ONLY WHEN THE LIST IS MIXED. In a list that is entirely new work the marker
    // distinguishes nothing, and putting it on every line changes the message every conversation
    // without open work has always received, to say something it already said by being the whole list.
    // A REFERENCE IN PLACE OF A POSITION (ADR-035). A position number beside a reference invites the
    // wrong reply ("2" typed for the second line, which is item #5), so an item that has a reference is
    // listed by it, in the same order. The order is what the list states; the reference is what a
    // person types.
    merged.forEach((m, i) => lines.push(
      `${m.ref ? `#${m.ref}` : `${i + 1}.`} ${open.length && m.isNew ? say(opts.copy, 'triageNewItem', { label: m.label }) : m.label}`,
    ));
  }

  // Counted, never described.
  if (targetedCount) lines.push('', publicProposalCount(targetedCount, opts.copy));

  // ── AND WHAT IS STILL OUTSTANDING FROM BEFORE (maintainer, 2026-09-03) ─────────────────────────────
  //
  // A clarification waits on a person, so left alone it waits forever - it sits in their list and
  // nothing raises it again unless they think to. The queue clearing is the moment the assistant has
  // nothing more urgent, which is exactly when it should either take them up or offer to.
  //
  // SAID HERE RATHER THAN AS A SECOND MESSAGE. This is the drain's own message, already in front of
  // the person at the moment the condition becomes true, so the alternative is a separate line
  // arriving seconds later saying something the first could have said.
  //
  // A COUNT AND NOTHING ELSE, the same discipline the private-request count follows: several people
  // may be waiting on questions of their own, and re-stating each in the room would publish what each
  // was asked. That clarifications are outstanding is not private; what any of them says is.
  if (opts.followUp && opts.followUp.action !== 'stay-quiet') {
    const { action, count } = opts.followUp;
    // OFFERS when nothing established an order between these and the work already open, since choosing
    // either way would be the assistant inventing that decision; otherwise ANNOUNCES, while still leaving
    // them able to say no, since they may know something the ordering does not.
    lines.push('', say(opts.copy, action === 'offer' ? 'clarificationsOffer' : 'clarificationsWorkingThrough', { count }));
  }

  if (lost.length) lines.push('', couldNotRecord(lost, targetedSet, opts.copy));

  lines.push('', proposal.inFlightAmbiguous
    ? say(opts.copy, 'triageAskInFlight')
    : say(opts.copy, 'triageInviteCorrection'));

  return lines.join('\n');
}

/**
 * Turn a reading into work.
 *
 * ONE TASK PER NEW REQUEST, AND NONE FOR AN AMENDMENT. An amendment changes work that already exists;
 * giving it its own task would split one piece of work into two and leave the person closing a task
 * that was never separate. When there is nothing in flight to amend, an amendment IS new work, and it
 * is treated as such rather than dropped - the alternative silently loses the message.
 *
 * THE TASK IS CREATED, NOT PROPOSED-THEN-CREATED. The work is visible as an open item immediately and
 * the person's answer decides what happens to it, which may be closing it straight away. That reuses
 * the state machine instead of inventing a confirm step beside it: `proposed` awaits the requester, so
 * everything that already understands "a task awaiting the person means their next message is the
 * awaited input" covers the pause for free.
 *
 * VISIBILITY IS THE QUEUE'S, NOT EACH MESSAGE'S. Triage resolved one answer for the batch and it
 * already failed toward silence on a mixed queue; re-deciding per task here would give a
 * conversation-visible task to a message that arrived in the same private breath as a targeted one.
 *
 * BEST EFFORT, PER TASK. A creation that fails is logged and skipped rather than aborting the rest:
 * the person is better served by three of four pieces of work existing and a proposal that names them
 * than by none of it because one write failed. What comes back is what actually landed, which is why
 * this call asks `createTask` to REPORT a failed write instead of swallowing it - the default is right
 * for a task that accompanies an answer and wrong for one that IS the answer.
 */
export async function createTasksFromProposal(args: {
  proposal: TriageProposal;
  channelArn: string;
  senderArn: string;
  assistantId: string;
  /**
   * The batch floor, carried for the reading and for anything this function says in the room. It no
   * longer decides a task's visibility - `targetedIds` does, per item.
   */
  visibility: TaskVisibility;
  hasWorkInFlight: boolean;
  correlationId?: string;
  /**
   * The queued messages that were TARGETED, by id.
   *
   * THE ONLY THING THAT DECIDES A TASK'S VISIBILITY. The batch value cannot express a mixed queue:
   * computed as "private if ANY was targeted", it made an untargeted request private because somebody
   * else in the same burst asked privately. These ids answer per message, and separately say WHICH
   * request must not be merged with another.
   */
  targetedIds?: string[];
  /** Who sent each queued message. Absent falls back to `senderArn` for all of them. */
  sendersById?: Record<string, string>;
  /**
   * WHAT EACH QUEUED MESSAGE WAS CLASSIFIED AS when it queued, by id (ADR-064 decision B). A `queued_request` is a
   * platform machine, not an intent, so its steps route, and its turns are attributed, under the intent of the message
   * it holds. Absent for a message whose intent was not recorded, whose task then routes by each turn's message.
   */
  intentsById?: Record<string, string>;
}): Promise<{ created: ProposedItem[]; lost: ProposedItem[] }> {
  const {
    proposal, channelArn, senderArn, assistantId, visibility, hasWorkInFlight, correlationId,
  } = args;
  const targeted = new Set(args.targetedIds ?? []);

  /**
   * ABSENT IS NOT EMPTY, and here that distinction is the difference between failing closed and
   * failing open.
   *
   * `targetedIds` PRESENT means the dispatcher looked and is telling us which messages were targeted -
   * so a message not in the set was genuinely not targeted, and its task takes `conversation`.
   *
   * `targetedIds` ABSENT means an older dispatcher whose payload predates the field: nothing looked, so
   * "not in the set" carries no information. Reading it as "not targeted" would turn every task that
   * dispatcher creates into a shared one, including a request its sender addressed privately. So an
   * absent field keeps the batch value, which is the behavior that was there before per-item visibility
   * existed - the direction the field's own contract promises.
   */
  const perItemVisibilityKnown = args.targetedIds !== undefined;

  // A TARGETED MESSAGE ALWAYS GETS ITS OWN TASK (DESIGN 2.4.1).
  //
  // `amends` folds a message into the work already in flight rather than opening anything, and
  // that work is not necessarily private or even this person's. Folding a targeted request into
  // it combines a private message with a public one, which is not triage's call to make: it may
  // read them together and propose it, and the person who sent the targeted one has to confirm
  // before they become one thing. Until then they stay separate, which costs an extra task and
  // no privacy.
  const needsOwnTask = proposal.items.filter(
    (i) => i.intent === 'new' || i.intent === 'unclear' || !hasWorkInFlight || targeted.has(i.messageId),
  );

  // AN UNCLEAR MESSAGE GETS A DIFFERENT KIND OF ROW, and this is the whole reason the intent exists.
  //
  // `queued_request` starts at `proposed`, which says "here is the work I propose to do". For a
  // message the reading could not make out, that is a claim nobody is entitled to make: the person
  // gets a confident work item labeled with a slice of their own words, and has to notice it is
  // wrong before anything can be fixed. `queued_clarification` says the true thing instead - the
  // message is held, the request is not understood, and one answer defines it.
  const taskTypeFor = (item: ProposedItem): string =>
    (item.intent === 'unclear' ? QUEUED_CLARIFICATION_TASK_TYPE : QUEUED_REQUEST_TASK_TYPE);

  // THE WRITES RUN TOGETHER, each with its own outcome. One task landing says nothing about whether
  // its neighbor will, so writing them sequentially was N round trips on the path the proposal is
  // waiting on (the other of section 7.4's two named reductions). Order is preserved by `Promise.all`
  // itself - results come back in the input's order - so `created` and `lost` keep the reading's
  // order exactly as the sequential loop kept it.
  const outcomes = await Promise.all(needsOwnTask.map(async (item) => {
    try {
      const task = await createTask(
        // The task's own record of what opened it. `createTask` reads the channel and sender from
        // these attributes, which is the shape every other caller hands it.
        {
          inputTranscript: item.label,
          requestAttributes: {
            'CHIME.channel.arn': channelArn,
            // THIS message's sender. `createTask` derives the requester from this attribute, and
            // the requester is who a private task may be read by - so attributing a batch to one
            // person hands their neighbor's private work to them.
            'CHIME.sender.arn': args.sendersById?.[item.messageId] || senderArn,
          },
        },
        // A triaged request is multi-step by construction: it was proposed, it awaits an answer, and
        // only then does any work happen.
        DeliveryOption.TASK_MULTI_STEP,
        taskTypeFor(item),
        correlationId,
        {
          userMessageId: item.messageId,
          // THIS MESSAGE'S VISIBILITY, AND NOT THE BATCH'S IN EITHER DIRECTION. A public request in a
          // queue stays public, and a private one stays private.
          //
          // This said "the batch value is only a floor for the reading itself" and then used the batch
          // value as the VALUE - so in a queue of one targeted and one open request, BOTH tasks were
          // written private. `targetedIds` was already plumbed per message and already used to force
          // a targeted item private and to refuse folding it into in-flight work; only this
          // else-branch still deferred to the collapse.
          //
          // WHY THE FAIL-CLOSED ARGUMENT DOES NOT COVER AN UNTARGETED ITEM. `turn-triage.ts` defends
          // the collapse as "over-disclosing publishes a request its sender chose to keep off the
          // room", and that is exactly right about the TARGETED message - which is why the first
          // branch here forces it private. But the sender of an untargeted request chose no such
          // thing: making their task private hides work the room was meant to see, and does it
          // because somebody ELSE in the same burst asked privately. The asymmetry that justifies
          // failing closed is per message, so the answer has to be per message too.
          visibility: targeted.has(item.messageId)
            ? 'private'
            : (perItemVisibilityKnown ? 'conversation' : visibility),
          priority: item.priority,
          // NORMALIZED, because the caller holds a bot ARN and every other task row records a bare
          // principal id. An ARN here would be a value nothing joins to: `resolveTaskAssignee` reduces
          // its ARN-shaped field through this same function, so a triage task recorded whole would
          // be invisible to every "this assistant's work" read. Idempotent on an id already bare.
          assistantId: principalIdFromArn(assistantId) || undefined,
          ...(args.intentsById?.[item.messageId] ? { openingIntent: args.intentsById[item.messageId] } : {}),
          throwOnWriteFailure: true,
        },
      );
      // The reference the task was given, so the proposal can show it (ADR-035).
      const taskRef = (task as { taskRef?: number } | undefined)?.taskRef;
      return { item: taskRef ? { ...item, taskRef } : item, landed: true };
    } catch (err) {
      console.error('[turn-triage] could not create a task for a queued request', {
        messageId: item.messageId, err: (err as Error)?.message,
      });
      return { item, landed: false };
    }
  }));

  return {
    created: outcomes.filter((o) => o.landed).map((o) => o.item),
    /** Items whose task did not land. The caller must not describe these as picked up. */
    lost: outcomes.filter((o) => !o.landed).map((o) => o.item),
  };
}

/** The tool a reading uses to record what it decided. */
export const READING_TOOL_NAME = 'record_reading';

/**
 * The spoken half of a reply on the TOOL channel, with any machine marker taken off the front.
 *
 * On that channel the whole reply is the proposal - there is no machine half in the text to separate
 * it from - so it is taken whole. A model that still opens with `PROPOSAL:` out of habit therefore
 * put a runtime marker in front of a person, which is exactly what the no-markers guard exists to
 * catch and did.
 *
 * The marker is meaningless here rather than harmful, so it is STRIPPED rather than treated as a
 * contract: taking the text after it, or the text itself when there is none, is right either way.
 */
export function spokenFromReply(raw: string): string {
  const marker = /^[ \t]*PROPOSAL[ \t]*:[ \t]*$/im.exec(raw || '');
  const afterProposal = marker ? raw.slice(marker.index + marker[0].length) : (raw || '');

  // EVERY MACHINE LINE, NOT JUST THE ONE THAT LEAKED FIRST.
  //
  // `PROPOSAL:` alone was stripped, and a `TOPIC:` line reached a person anyway (owner-reported,
  // 2026-09-05). The prompt no longer asks for that line on this channel, which removes the cause;
  // this removes the CLASS, because the next marker added to the text contract would otherwise
  // arrive here by the same route, and the pairing of a prompt that no longer asks with a stripper
  // that refuses is the shape this repo already uses for rules it cannot afford to restate.
  //
  // WHOLE LINES ONLY, and anywhere in the reply rather than only at the front. These forms carry a
  // field-separated structure that ordinary prose does not produce by accident, and on this channel
  // NO part of the text is parsed - so a line in runtime vocabulary is meaningless wherever it sits,
  // not merely out of place at the top. Restricting the strip to a leading run would have left the
  // same line spoken the moment a model wrote one sentence before it.
  // The trailing newline goes with the line. Matching the line alone left an empty one behind, so a
  // marker removed from between two sentences became a paragraph break the model never wrote - and
  // collapsing blank runs afterwards to hide it would flatten the real paragraph breaks in prose.
  const machineLine = [
    /^[ \t]*TRIAGE[ \t]*:.*(?:\r?\n)?/gim,
    /^[ \t]*TOPIC[ \t]*:.*(?:\r?\n)?/gim,
    /^[ \t]*ANOTHER_PASS[ \t]*:.*(?:\r?\n)?/gim,
    /^[ \t]*PROPOSAL[ \t]*:[ \t]*(?:\r?\n)?/gim,
    // The one marker that carries no fields and was never in this list at all. Stripped as a prefix
    // like `PROPOSAL:` rather than as a whole line with its content, because nothing follows it by
    // contract - and if a model writes a sentence after it, the sentence is the person's to read.
    /^[ \t]*IN_FLIGHT_UNCLEAR[ \t]*(?:\r?\n)?/gim,
  ];
  let s = afterProposal;
  for (const pattern of machineLine) s = s.replace(pattern, '');
  // ── AND A DECORATED MARKER IS STILL A MARKER (e2e, 2026-09-15) ────────────────────────────────
  //
  // Every pattern above anchors on a BARE token at the start of a line, so a model that dressed the
  // same token up walked straight past all of them: `**PROPOSAL:**` opened a proposal in front of a
  // person on a run where a plain `PROPOSAL:` would have been stripped. A heading, a block quote and
  // a code span do it too, and which one a model reaches for is a per-run choice - so this is a
  // class rather than one more string.
  //
  // WHOLE LINE OR NOTHING, and that constraint is the whole safety of it. A line that is only the
  // decorated token says nothing to anybody, so removing it costs no words. A heading with content
  // after it - "**Proposal:** ship on Friday" - is the assistant SPEAKING, and taking a sentence
  // away from the person reading it is a worse failure than the leak. So this test is end-to-end on
  // the line, where the prefix patterns above deliberately are not.
  //
  // TENET D11 IS NOT IN THE WAY, and it looks like it is. These five tokens are literals THE PLATFORM
  // wrote into its own prompt, so matching them is matching our own emission - the class the tenet
  // names explicitly as pattern work that stays, alongside a `<!--corr:-->` marker and an ARN.
  // Nothing here reads what a PERSON or a model said in order to decide what happens next; the line
  // is dropped from what is displayed and no control flow turns on it.
  s = s.split('\n').filter((line) => !isMarkerOnlyLine(line)).join('\n');
  // Collapse what the stripping left behind, so a removed line does not become a blank gap.
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The tokens this runtime writes into its own prompts. Ours to match; never a person's words. */
const MARKER_ONLY_LINES: ReadonlySet<string> = new Set([
  'TRIAGE:', 'TOPIC:', 'ANOTHER_PASS:', 'PROPOSAL:', 'IN_FLIGHT_UNCLEAR',
]);

/**
 * Is this line NOTHING BUT one of our markers, however it was dressed up?
 *
 * Markdown decoration is taken off both ends - emphasis, a code span, a heading, a block quote - and
 * what is left must be the token EXACTLY. Anything else on the line, before or after, means the line
 * is prose and survives whole.
 */
function isMarkerOnlyLine(line: string): boolean {
  const bare = line
    .trim()
    .replace(/^[\s>#*_`]+/, '')
    .replace(/[\s*_`]+$/, '')
    // `**PROPOSAL**:` puts the closing emphasis INSIDE the token. Same line, same nothing said.
    .replace(/[*_`]+:$/, ':');
  if (!bare) return false;
  // `PROPOSAL :` is the same marker as `PROPOSAL:`, which is the spacing the patterns above tolerate.
  return MARKER_ONLY_LINES.has(bare.replace(/[ \t]+:$/, ':').toUpperCase());
}

/**
 * THE SELECTION THAT DRIVES THE PROCESS IS A CHOICE FROM A SET, NOT A LINE OF PROSE
 * (maintainer, 2026-09-03: "the model is making calls on clarify meaning etc ... but the selection to
 * drive process downstream should have deterministic outcomes").
 *
 * The JUDGEMENT stays the model's, and has to: whether a message amends the work in flight, whether
 * it can be understood at all, how it ranks, which subject it belongs to. None of that is mechanical.
 * What was also the model's, and should never have been, is the FORM the judgement arrives in - a
 * `TRIAGE:` line, matched with a regex, whose fields are then checked against closed sets. The
 * decision was constrained; the channel carrying it was not.
 *
 * That gap is not theoretical. The design records it as measured: a triage turn is dispatched as an
 * ordinary turn, so it answers in the profile's persona and in prose - "zero `TRIAGE:` lines, no
 * `PROPOSAL:` marker, and not even the `ANOTHER_PASS:` escape hatch". The reading was unusable, and
 * the derived floor exists to survive it. A tool call cannot be answered in prose.
 *
 * WHAT THE SCHEMA MAKES IMPOSSIBLE, rather than merely detectable:
 *   - an intent outside the three that exist;
 *   - a priority outside the three that exist;
 *   - a message id that was never queued - the ids are an enum of exactly this queue, so the reading
 *     cannot classify a message that does not exist, or silently rename one that does;
 *   - a reply that is prose, since a tool call is structure or it is not a tool call.
 *
 * AND THE `PROPOSAL:` SPLIT STOPS BEING A SECURITY BOUNDARY. Text markers had to be parsed only from
 * before that marker, because a proposal quoting somebody's message - "you asked me to TRIAGE: ..." -
 * could otherwise contribute a line to the decision. Tool arguments are a separate channel from the
 * prose, so quoting cannot reach them at all.
 */
export function readingToolSpec(queuedIds: string[]): {
  toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
} {
  return {
    toolSpec: {
      name: READING_TOOL_NAME,
      description:
        'Record your reading of the messages that arrived while you were working. Call this exactly '
        + 'once, with one entry per queued message and no entries for anything else. This is how the '
        + 'reading is recorded: prose describing your decision is not read as one. Do not begin, '
        + 'continue or describe the work any of these messages ask for.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: 'One entry per queued message, all of them.',
              items: {
                type: 'object',
                properties: {
                  // THE IDS OF THIS QUEUE AND NO OTHERS. A reading cannot invent a message, miss one
                  // by mistyping it, or quietly classify something from earlier in the conversation.
                  message_id: { type: 'string', enum: queuedIds },
                  intent: {
                    type: 'string',
                    enum: ['amends', 'new', 'unclear'],
                    description:
                      '"amends" changes the work already running. "new" asks for something else. '
                      + '"unclear" covers two cases: you cannot tell what it asks for, OR you can tell '
                      + 'the subject but the request turns on something referred to and never supplied '
                      + '("the usual", "the other one", "like last time"). If starting the work would '
                      + 'mean choosing something the person did not say, it is unclear. Do not guess to '
                      + 'fill this in, and do not use "new" with a label that admits the gap - a '
                      + 'proposal claims the work is defined enough to begin.',
                  },
                  priority: { type: 'string', enum: ['high', 'normal', 'low'] },
                  label: {
                    type: 'string',
                    description:
                      'A short handle for the work, in your own words, never the message quoted back. '
                      + 'For an unclear message, name what you would need to know rather than what '
                      + 'you would do.',
                  },
                },
                required: ['message_id', 'intent', 'priority', 'label'],
              },
            },
            topics: {
              type: 'array',
              description:
                'The subjects this queue turned out to cover, when it covers more than one. Every '
                + 'queued id appears in exactly one topic, and `IN_FLIGHT` may be used to mean the '
                + 'work already running. Omit entirely when the queue is about one thing.',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: 'A short name for the subject, in the person\'s terms. Never a message quoted back.',
                  },
                  message_ids: { type: 'array', items: { type: 'string' } },
                },
                required: ['label', 'message_ids'],
              },
            },
            in_flight_unclear: {
              type: 'boolean',
              description:
                'True only when you cannot tell whether the work already running is still wanted.',
            },
          },
          required: ['items'],
        },
      },
    },
  };
}

/**
 * Turn a `record_reading` call into the reading everything downstream already consumes.
 *
 * EVERY FIELD IS CHECKED AGAIN, and the enum in the schema is not the reason to skip it. A schema is
 * a request to the provider, not a guarantee from it: providers differ in whether they enforce one,
 * a fallback path may not enforce it at all, and this is the value that decides what happens to
 * somebody's message. The same closed sets the text contract used are applied here, so the two
 * channels cannot disagree about what is valid.
 *
 * @returns the reading, or null when it does not account for exactly this queue - which sends the
 *   drain to the derived floor, where every message becomes a clarification rather than a guess.
 */
export function proposalFromReadingTool(
  input: unknown,
  expectedIds: string[],
): TriageProposal | null {
  const raw = (input as { items?: unknown })?.items;
  if (!Array.isArray(raw) || !raw.length) return null;

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const items: ProposedItem[] = [];

  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    const messageId = typeof e?.message_id === 'string' ? e.message_id : '';
    const intent = typeof e?.intent === 'string' ? e.intent : '';
    const priority = typeof e?.priority === 'string' ? e.priority : '';
    const label = typeof e?.label === 'string' ? e.label.trim() : '';

    if (!expected.has(messageId)) return null;
    if (!INTENTS.has(intent)) return null;
    if (!PRIORITIES.has(priority)) return null;
    if (!label) return null;
    // A message classified twice has no single answer, exactly as in the text contract.
    if (seen.has(messageId)) return null;
    seen.add(messageId);

    items.push({
      messageId,
      intent: intent as QueuedIntent,
      priority: priority as TaskPriority,
      // Uncapped, exactly as the text contract leaves it: the label is the reading's own short
      // handle, and a cap here that the other channel does not apply would make the two disagree.
      label,
    });
  }

  // EVERY QUEUED MESSAGE OR NONE. A partial reading would clear the queue while accounting for only
  // part of it, which is the silent loss this whole path exists to prevent.
  if (seen.size !== expected.size) return null;

  // TOPICS TRAVEL TOO, AND LEAVING THEM OUT BROKE A REQUIREMENT SILENTLY.
  //
  // The first version of this converter returned only the items, so on the tool channel - which is
  // the PRIMARY one - a queue covering two subjects produced no topics, and with no topics there is
  // nothing to offer: the split offer (FR8) could never fire again. Nothing failed. The reading was
  // valid, the tasks were right, and one feature simply stopped existing.
  //
  // The rules are the text channel's, applied identically: every queued id in exactly one topic,
  // `IN_FLIGHT` allowed as the work already running, and fewer than two subjects is not a split.
  const topics = topicsFromToolInput((input as { topics?: unknown })?.topics, expected);

  return {
    items,
    inFlightAmbiguous: (input as { in_flight_unclear?: unknown })?.in_flight_unclear === true,
    ...(topics ? { topics } : {}),
  };
}

/**
 * WHY a `record_reading` call was refused, as a shape and never as content: null when it is usable.
 *
 * The refusal sends the drain to the derived floor, which carries no topics, so a refused call costs the
 * split offer as well as the reading. Without the reason the log said only `toolCalled: true, usable:
 * false` (e2e, 2026-10-23), which cannot tell a mistyped id from a missing entry from a stringified array.
 * The checks mirror `proposalFromReadingTool` one for one; the fields named are the schema's, and the ids
 * named are the queue's own hashes, never a person's words.
 */
export function readingToolRefusal(input: unknown, expectedIds: string[]): string | null {
  const raw = (input as { items?: unknown })?.items;
  if (!Array.isArray(raw)) return `items-not-an-array:${raw === null ? 'null' : typeof raw}`;
  if (!raw.length) return 'items-empty';
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const e = entry as Record<string, unknown>;
    const messageId = typeof e?.message_id === 'string' ? e.message_id : '';
    if (!expected.has(messageId)) return `item-${index}:message-id-not-queued`;
    if (!INTENTS.has(typeof e?.intent === 'string' ? e.intent : '')) return `item-${index}:intent-outside-the-set`;
    if (!PRIORITIES.has(typeof e?.priority === 'string' ? e.priority : '')) return `item-${index}:priority-outside-the-set`;
    if (!(typeof e?.label === 'string' && e.label.trim())) return `item-${index}:label-empty`;
    if (seen.has(messageId)) return `item-${index}:message-id-repeated`;
    seen.add(messageId);
  }
  if (seen.size !== expected.size) return `ids-missing:${expected.size - seen.size}-of-${expected.size}`;
  return null;
}

/**
 * The subjects a reading named, validated exactly as the text channel validates them.
 *
 * BEST EFFORT, LIKE THE TEXT CHANNEL'S. A malformed grouping costs an OFFER, which is neither a
 * decision nor a lost message - so it returns undefined and the reading still stands, where a
 * malformed ITEM invalidates the whole reading. The two are different kinds of wrong.
 */
function topicsFromToolInput(raw: unknown, expected: Set<string>): ProposedTopic[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const claimed = new Set<string>();
  const topics: ProposedTopic[] = [];

  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    const label = typeof e?.label === 'string' ? e.label.trim() : '';
    const ids = Array.isArray(e?.message_ids)
      ? (e.message_ids as unknown[]).filter((i): i is string => typeof i === 'string')
      : [];
    if (!label || !ids.length) return undefined;

    for (const id of ids) {
      // The work already running is a subject but not a queued message, so it is accepted here and
      // left out of the coverage check below - there is no id in the queue for it to account for.
      if (id === IN_FLIGHT_TOPIC_ID) continue;
      // An id outside the queue, or in two topics at once, is a grouping with no single answer.
      if (!expected.has(id) || claimed.has(id)) return undefined;
      claimed.add(id);
    }
    // THE IDS AS GIVEN, `IN_FLIGHT` INCLUDED (code review, 2026-09-04). An earlier version built a
    // filtered array and pushed that, dropping the marker - and `topicsForOffer` decides what may
    // MOVE by asking whether a topic's ids include it. Stripped, the work already running stopped
    // looking like the thing being separated FROM and became a movable subject with no messages in
    // it: the person was offered the chance to move the work in progress, and choosing it moved
    // nothing. The text channel keeps it for exactly this reason; the two must agree.
    topics.push({ label, messageIds: ids });
  }

  // Every queued message accounted for, or the grouping is not a description of THIS queue.
  if (!topics.length || claimed.size !== expected.size) return undefined;
  // One subject is not a split, and offering to separate a queue from itself is noise.
  return topics.length > 1 ? topics : undefined;
}
