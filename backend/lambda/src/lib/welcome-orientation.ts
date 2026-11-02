/**
 * Welcome orientation - the copy the assistant opens a conversation with.
 *
 * ORIENTATION IS THE WHOLE WELCOME CONTEXT, not one input beside the others. It is everything that
 * orients a person in this conversation: who they are, where they are, what access they have, WHY THIS
 * CONVERSATION EXISTS, and what they can do next. The deployment's SSM parameter is one SOURCE of
 * orientation; a topic the user supplied is another; a drift carry-over from a previous conversation is
 * another; incident state will be another.
 *
 * CONFIG-DRIVEN by design: the PLATFORM ships a generic, classification-neutral welcome, and a DEPLOYMENT
 * (e.g. the Stratum demo) supplies company-specific orientation via SSM (`ASSISTANT_WELCOME_PARAM`)
 * with NO code change - which is itself a worked customization example. Absent config ⇒ the generic
 * welcome (byte-for-byte the historical greeting, so un-configured deployments are unaffected).
 *
 * COMPOSITION IS ADDITIVE ACROSS SOURCES. There is no branch at which one present value discards
 * another. Two earlier shapes of this module both got that wrong at different scales:
 *
 *   - it gated the whole oriented welcome on `companyName || companyBlurb || examples`, so an
 *     orientation carrying only an access line and a platform note fell all the way back to the generic
 *     greeting and threw both configured fields away;
 *   - it SHORT-CIRCUITED on `triggerContext` and then on `topic`, so a conversation that knew why it
 *     existed forgot which company it was in - the same defect one level up.
 *
 * Now: every present field renders, every absent one omits only its own clause, and the generic welcome
 * is what an EMPTY assembly renders rather than a branch anything falls back into. Absent and rejected
 * fields are REPORTED to the caller ({@link WelcomeComposition.missingFields},
 * {@link OrientationParse.issues}) so the router can log and count them. This module stays pure - it
 * decides copy, not observability.
 *
 * TRUST IS MIXED HERE, DELIBERATELY. The deployment fields come from SSM (operator-controlled). The
 * conversation fields come from Amazon Chime SDK channel `Metadata`, which is MEMBER-WRITABLE: a
 * participant holds `UpdateChannel`, which sets Name and Metadata in one call. So `topic`,
 * `priorSubject` and `parentRef` are attacker-controlled text, and they are marker-stripped before they
 * can reach the copy. That matters more once a template is model-filled, where the same text becomes
 * part of a prompt.
 */

import { stripMessageMarkers } from './message-markers.js';
import type { CallSiteCapabilities } from './context-source-shapes.js';
import {
  buildSourceTable,
  insertValue,
  resolveTemplateFields,
  sourceLookup,
  type ResolveSite,
  type SourceLookup,
  type VariableValue,
  type VersionVariable,
} from './variables.js';

/**
 * The assembled orientation. Two groups, distinguished by WHO controls them and therefore how much they
 * are trusted - see the trust note in the module header.
 */
export interface WelcomeOrientation {
  // ── Deployment-configured (SSM, operator trust). Who and where the user is. ──
  /** Company/organization name, e.g. "Stratum Technologies". */
  companyName?: string;
  /** One clause about the company, e.g. "an enterprise SaaS company (workflow automation, ~280 people, Austin)". */
  companyBlurb?: string;
  /** One line about the signed-in user's access, e.g. "You have standard access - internal company info (directory, processes, roadmap)." */
  accessBlurb?: string;
  /** 2–4 grounded example prompts to try (rendered as bullets). */
  examples?: string[];
  /** Optional closing note, e.g. a pointer to learn about / customize the platform. */
  platformNote?: string;

  // ── Per-conversation (channel Metadata, MEMBER trust). Why this conversation exists. ──
  /** What the user is here for, supplied at creation. Durable across the conversation. */
  topic?: string;
  /**
   * What a previous conversation was about, when this one continues from it (drift redirect, handoff).
   *
   * A LABEL, never the user's message body: the drift design's by-reference principle forbids copying a
   * user's text into a new conversation, so this carries the subject and {@link parentRef} carries the
   * way back to it.
   */
  priorSubject?: string;
  /** Link target for the conversation this one continues from, rendered as a markdown link. */
  parentRef?: string;
  /**
   * The user's own message that caused this conversation to exist, quoted back to them.
   *
   * DISTINCT from {@link priorSubject}, which is the topic label. The subject says what the new
   * conversation is about; this says what the person actually typed, so they can see the assistant picked
   * up the right thread rather than having to trust a paraphrase.
   *
   * Quoting a user's message into a NEW conversation creates a second copy of text that already exists in
   * the parent, which the drift design's by-reference principle otherwise avoids. That is a deliberate
   * product decision (the user asked to be shown their own words), and it carries an erasure consequence:
   * redacting or deleting the original does not remove this copy. Anything that erases a message has to
   * reach the copies too.
   */
  priorMessage?: string;
  /**
   * WHAT HAPPENED, when an event opened this conversation. One line, in the event's own words.
   *
   * DISTINCT FROM `priorSubject`, and the distinction is the whole point. `priorSubject` is a LABEL and
   * renders as a noun phrase ("picks up Latency SLA breach - checkout API"); this is the event's
   * SENTENCE ("p95 latency on the checkout API crossed its SLA for 10 consecutive minutes."). Before
   * this field existed the summary reached `domainContext.title` - which the TURN grounding reads and
   * this composer does not - so an alert-opened conversation could answer questions about the alert and
   * could not mention it in its opening line. Observed live 2026-10-03: both assistants in the first ops
   * conversation opened with the label alone and neither said what had happened.
   *
   * MEMBER TRUST, like every other conversation field: it arrives through the channel-context store, and
   * the module header's reasoning applies unchanged - it is marker-stripped and capped before it can
   * reach composed copy.
   */
  eventSummary?: string;
  /**
   * WHAT A CARRIED-OVER VISIT WAS, in the visitor's assistant's own words (FR26): one or two sentences the
   * model wrote, in the visitor's language, when the visit carried over into this conversation. Rendered as
   * the opening of the welcome; a conversation that carries it is a continuation, like a drift follow-up.
   * Arrives through the channel-context store and is capped and marker-stripped like every other field.
   */
  visitSummary?: string;
}

/**
 * NO ROLE BRANCH LIVES IN THIS MODULE, and the attempt to add one is recorded because it was wrong.
 *
 * A `'lead' | 'support'` discriminator was started here on 2026-10-03 so the role a conversation was
 * opened for could give the full orientation while the primary said only that it had arrived. The owner
 * stopped it for the right reason: one shared composer that branches on role and type grows a branch per
 * role times per type, in code every assistant shares and none of them owns. Adding an assistant would
 * mean editing this file, which is the opposite of an assistant being a configured building block
 * (tenet P1), and it puts user-facing copy back into a shared function rather than into the versioned
 * artifact that already carries the rest of an assistant's voice.
 *
 * WHERE IT BELONGS INSTEAD: the assistant's own version, which declares its welcome as a workflow with an
 * opening step, the workflow's `types` naming the kind of room it opens (W1, ADR-061). This module keeps one
 * job: render a template against the fields the orientation carries. `eventSummary` above is such a field, which is
 * why it stays.
 */

/** Deployment-configured fields: what `ASSISTANT_WELCOME_PARAM` may set, and the only fields whose
 *  absence is reported. A conversation field is legitimately absent on an ordinary conversation. */
export const DEPLOYMENT_FIELDS = [
  'companyName',
  'companyBlurb',
  'accessBlurb',
  'examples',
  'platformNote',
] as const;

/** Per-conversation fields: carried on the channel, never settable from the deployment parameter. */
export const CONVERSATION_FIELDS = ['topic', 'priorSubject', 'parentRef', 'priorMessage', 'eventSummary', 'visitSummary'] as const;

/**
 * THE WELCOME'S TEMPLATE STEP (W1): the opening an assistant's welcome workflow says first, as one step of that workflow
 * (`opening` in `event-workflow.ts`). Its fields are the orientation fields a deployment may set, and `text` is the
 * assistant's own opening text, `{{field}}` placeholders over `WELCOME_FIELDS` and the version's variables.
 *
 * The welcome is an INTENT, so it belongs to the assistant and travels on its versioned profile, which is what makes it
 * editable, validatable and roll-back-able by whoever owns that assistant, with no deploy. What varies for ONE assistant
 * is the kind of room it opens in, so a welcome workflow names its conversation `types` and the room's type selects it
 * (`welcomeWorkflowOf`). The role needs no key: an assistant acts in exactly one classification (ADR-042) and a
 * difference between two jobs is a second role with a second assistant (ADR-048), so the profile already fixes the role,
 * and a template can still say it with `{{role}}`.
 */
export interface WelcomeOpeningStep extends Pick<WelcomeOrientation, DeploymentField> {
  /**
   * The assistant's own opening text, rendered instead of the built-in clause assembly (`renderWelcomeTemplate`). Absent,
   * the assembly over these fields and whatever the room carries.
   */
  text?: string;
}

/** The fields an opening step carries: its own text and the deployment fields. */
export const OPENING_STEP_KEYS: readonly string[] = ['text', 'companyName', 'companyBlurb', 'accessBlurb', 'examples', 'platformNote'];
const MAX_OPENING_TEXT = 2000;
const MAX_OPENING_EXAMPLES = 4;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Why an opening step is refused, or nothing. A per-conversation field is carried on the room and refused here by name,
 * as the deployment parameter's parser reports it.
 */
export function openingStepErrors(opening: unknown, at: string): string[] {
  if (!isPlainObject(opening)) return [`${at} is an object of orientation fields, or {} for the deployment's orientation`];
  const errs: string[] = [];
  for (const [k, v] of Object.entries(opening)) {
    if ((CONVERSATION_FIELDS as readonly string[]).includes(k)) {
      errs.push(`${at}.${k} is carried per conversation and cannot be set on a version`);
    } else if (k === 'examples') {
      if (!Array.isArray(v) || v.some((e) => typeof e !== 'string' || !e.trim())) errs.push(`${at}.examples must be a list of non-blank prompts`);
      else if (v.length > MAX_OPENING_EXAMPLES) errs.push(`${at}.examples holds at most ${MAX_OPENING_EXAMPLES} prompts`);
    } else if (OPENING_STEP_KEYS.includes(k)) {
      if (typeof v !== 'string' || !v.trim()) errs.push(`${at}.${k} must be non-blank text`);
      else if (v.length > MAX_OPENING_TEXT) errs.push(`${at}.${k} must be at most ${MAX_OPENING_TEXT} characters`);
    } else {
      errs.push(`${at}.${k} is not a field of an opening; it carries ${OPENING_STEP_KEYS.join(', ')}`);
    }
  }
  return errs;
}

/** What an opening step says in a room: its own text and the orientation fields beside it. */
export interface OpeningSelection {
  /** The opening text, when the step carries one. */
  template?: string;
  /** The orientation fields the step sets, parsed exactly as the deployment parameter is. */
  orientation: WelcomeOrientation | null;
  /** Fields the step carries that the parser refused, for the caller to report. */
  issues: string[];
}

/**
 * THE ASSISTANT'S OWN OPENING, or null when its opening step carries nothing of its own and the classification's
 * configured copy applies.
 *
 * The router's welcome and the console's preview both read an opening through this function, so what the console shows
 * is what the router posts. The orientation fields pass through {@link parseWelcomeOrientationDetailed}, the parser the
 * deployment parameter goes through, so a version cannot set a per-conversation field; the text is copy rather than a
 * field set, and {@link renderWelcomeTemplate} bounds what it can print.
 */
export function selectOpening(step: WelcomeOpeningStep | null | undefined): OpeningSelection | null {
  if (!step) return null;
  const template = typeof step.text === 'string' && step.text.trim() ? step.text : undefined;
  const fields = Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'text'));
  const own = Object.keys(fields).length ? parseWelcomeOrientationDetailed(JSON.stringify(fields)) : null;
  if (!template && !own?.orientation) return null;
  return { ...(template ? { template } : {}), orientation: own?.orientation ?? null, issues: own?.issues ?? [] };
}

/**
 * Would quoting `quote` back only repeat what `subject` already said?
 *
 * The drift topic label is derived FROM the originating message, so for a short question the label and
 * the message are effectively the same words and rendering both is padding. Compared on normalized
 * alphanumerics so punctuation, case and spacing do not hide the repeat ("How many tigers live in
 * India" vs "How many tigers live in India?").
 *
 * ONE DIRECTION ONLY: the label must contain the quote. A quote that CONTAINS the label is longer than
 * it and carries detail the label dropped ("Can you pull the Q2 ARR review and flag anything below plan
 * for the board?" against the label "the Q2 ARR review") - suppressing that would throw away what the
 * person actually asked. Testing containment both ways silently did exactly that.
 *
 * A redundant quote costs one line; a quote wrongly dropped loses the person's own words. So the bias
 * is toward rendering.
 */
export function subsumesQuote(subject: string | undefined, quote: string): boolean {
  if (!subject) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(subject);
  const b = norm(quote);
  if (!a || !b) return false;
  return a.includes(b);
}

export type DeploymentField = (typeof DEPLOYMENT_FIELDS)[number];
export type ConversationField = (typeof CONVERSATION_FIELDS)[number];
export type OrientationField = DeploymentField | ConversationField;

/** Every field the assembled orientation can carry. */
export const ORIENTATION_FIELDS: readonly OrientationField[] = [
  ...DEPLOYMENT_FIELDS,
  ...CONVERSATION_FIELDS,
];

const MAX_EXAMPLES = 4;

/** The generic platform welcome. Byte-for-byte the historical greeting: an un-configured deployment
 *  must be unaffected by anything in this module. */
const GENERIC_WELCOME =
  "Hi - I'm your assistant for this conversation. I can answer questions, draft documents, "
  + 'analyse data, help with code, or work through a plan with you. What would you like to start with?';

/** Caps on member-controlled text, so a participant cannot push the rest of the welcome out of view. */
const MAX_TOPIC = 200;
const MAX_PRIOR_SUBJECT = 240;
/** The quoted user message. Longer than a subject (it is their sentence, not a label) but still capped so
 *  one long message cannot push the orientation out of the welcome. */
const MAX_PRIOR_MESSAGE = 400;
/** The event's own line. A sentence rather than a label, so sized like the quoted message. */
const MAX_EVENT_SUMMARY = 400;
/** The assistant's line about a carried-over visit. Its writer bounds it to the same length. */
const MAX_VISIT_SUMMARY = 400;
/**
 * The link back to the originating conversation. Sized for a full channel ARN (URI-encoded, ~150 chars) plus
 * a `#message=<id>` fragment, with headroom.
 *
 * It gets its own limit because it is a URL and the prose caps are far too small for one: reusing the topic
 * cap (200) truncated the reference mid-fragment and emitted a link to a message id that does not exist.
 * Over this limit the reference is DROPPED, never shortened - half a URL is not a shorter URL.
 */
const MAX_PARENT_REF = 512;

export interface OrientationParse {
  /** The usable deployment orientation, or null when the raw value carried nothing at all. */
  orientation: WelcomeOrientation | null;
  /**
   * Why the raw value was not fully usable, one human-readable reason per problem. EMPTY means the
   * value parsed cleanly. A non-empty list on a configured deployment is a misconfiguration the
   * operator cannot otherwise see: the router serves degraded copy and nothing else reports it.
   */
  issues: string[];
}

/**
 * Parse the DEPLOYMENT orientation from the SSM param, reporting everything it had to reject.
 *
 * Only {@link DEPLOYMENT_FIELDS} are read. A parameter naming `topic` or `priorSubject` is ignored, by
 * construction rather than by filtering: those describe one conversation and are carried on the channel,
 * so letting a deployment-wide parameter set them would apply one conversation's reason-for-existing to
 * every conversation.
 *
 * Tolerant by design - a partially valid parameter yields the valid part rather than nothing, because
 * discarding a whole orientation over one bad field is the failure this module exists to avoid. The
 * `issues` list is what turns that tolerance from silent into observable.
 */
export function parseWelcomeOrientationDetailed(raw: string | null | undefined): OrientationParse {
  if (raw === null || raw === undefined || !raw.trim()) {
    // Not an issue: an absent parameter is the documented un-configured path, and the caller
    // distinguishes "never configured" from "configured and broken" by whether it expected a value.
    return { orientation: null, issues: [] };
  }

  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { orientation: null, issues: ['the parameter value is not valid JSON'] };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { orientation: null, issues: ['the parameter value is not a JSON object'] };
  }

  const r = o as Record<string, unknown>;
  const issues: string[] = [];

  const str = (key: DeploymentField): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') {
      issues.push(`${key} is ${Array.isArray(v) ? 'an array' : typeof v}, not a string - ignored`);
      return undefined;
    }
    if (!v.trim()) {
      issues.push(`${key} is blank - ignored`);
      return undefined;
    }
    return v.trim();
  };

  let examples: string[] | undefined;
  if (r.examples !== undefined && r.examples !== null) {
    if (!Array.isArray(r.examples)) {
      issues.push(`examples is ${typeof r.examples}, not an array of strings - ignored`);
    } else {
      const kept = r.examples.filter((e): e is string => typeof e === 'string' && e.trim().length > 0);
      const dropped = r.examples.length - kept.length;
      if (dropped > 0) issues.push(`${dropped} of ${r.examples.length} examples were blank or not strings - dropped`);
      if (kept.length > MAX_EXAMPLES) {
        issues.push(`${kept.length} examples supplied, only the first ${MAX_EXAMPLES} are rendered`);
      }
      const trimmed = kept.map((e) => e.trim()).slice(0, MAX_EXAMPLES);
      if (trimmed.length) examples = trimmed;
    }
  }

  // A deployment parameter that tries to set a per-conversation field is reported rather than silently
  // dropped: it is a misunderstanding of the config surface, and the operator will otherwise wonder why
  // the value never appears.
  for (const field of CONVERSATION_FIELDS) {
    if (r[field] !== undefined) {
      issues.push(`${field} is carried per conversation and cannot be set from the deployment parameter - ignored`);
    }
  }

  const companyName = str('companyName');
  const companyBlurb = str('companyBlurb');
  const accessBlurb = str('accessBlurb');
  const platformNote = str('platformNote');

  const out: WelcomeOrientation = {
    ...(companyName ? { companyName } : {}),
    ...(companyBlurb ? { companyBlurb } : {}),
    ...(accessBlurb ? { accessBlurb } : {}),
    ...(examples ? { examples } : {}),
    ...(platformNote ? { platformNote } : {}),
  };

  // ANY surviving field is enough to orient the user.
  const hasAnything = DEPLOYMENT_FIELDS.some((f) => out[f] !== undefined);
  if (!hasAnything) {
    issues.push('the parameter carried no usable orientation field');
    return { orientation: null, issues };
  }
  return { orientation: out, issues };
}

/** Value-only form of {@link parseWelcomeOrientationDetailed}, for callers that do not report. */
export function parseWelcomeOrientation(raw: string | null | undefined): WelcomeOrientation | null {
  return parseWelcomeOrientationDetailed(raw).orientation;
}

/** Whether the copy came from an assembled orientation or is the empty-assembly default. */
export type WelcomeVariant = 'oriented' | 'generic';

export interface WelcomeComposition {
  /** The welcome copy. */
  content: string;
  /** `oriented` when at least one orientation field contributed; `generic` for an empty assembly. */
  variant: WelcomeVariant;
  /** Every field that contributed, in group order. The positive counterpart of `missingFields`. */
  contributed: OrientationField[];
  /**
   * DEPLOYMENT fields the deployment did not supply, when at least one of them did. Each is a piece of
   * copy the user did NOT see; the rest of the welcome is unaffected. Conversation fields are NOT
   * reported: their absence is normal on an ordinary conversation, so reporting them would make every
   * healthy welcome look misconfigured.
   */
  missingFields: DeploymentField[];
  /**
   * True when nothing was available and the generic copy was rendered. Legitimate on an un-configured
   * deployment and a defect on a configured one - only the caller knows which, so this states the fact
   * rather than a severity.
   */
  usedGenericFallback: boolean;
}

/** Member-controlled text, capped and marker-stripped before it can reach the copy or a prompt. */
function safeMemberText(value: string | undefined, maxLen: number): string | undefined {
  const stripped = stripMessageMarkers(value).trim();
  if (!stripped) return undefined;
  return stripped.slice(0, maxLen);
}

/**
 * THE FIELDS A WELCOME TEMPLATE MAY NAME, each declared once as a variable source (ADR-060, slice 1c), with the cap
 * the clause assembly applies to it. A conversation field is the channel-context row's text, member trust, read
 * through the resolver like every other inserted value; `role` and `examples` are the call site's own: the role this
 * deployment's assignment record names (platform text) and the version's suggested prompts (operator text, capped
 * when they were parsed), rendered as a list so `{{examples}}` belongs on a line of its own.
 */
export const WELCOME_FIELDS = {
  topic: { source: 'conversation:topic', cap: MAX_TOPIC },
  eventSummary: { source: 'conversation:eventSummary', cap: MAX_EVENT_SUMMARY },
  priorSubject: { source: 'conversation:priorSubject', cap: MAX_PRIOR_SUBJECT },
  priorMessage: { source: 'conversation:priorMessage', cap: MAX_PRIOR_MESSAGE },
  visitSummary: { source: 'conversation:visitSummary', cap: MAX_VISIT_SUMMARY },
  parentRef: { source: 'conversation:parentRef', cap: MAX_PARENT_REF },
  role: { source: 'assistant:role' },
  examples: { source: 'assistant:examples' },
} as const satisfies Record<string, { source: string; cap?: number }>;
export type WelcomeField = keyof typeof WELCOME_FIELDS;

/** The fields the console offers to insert, in the order it lists them. */
export const WELCOME_TOKENS = ['topic', 'eventSummary', 'priorSubject', 'priorMessage', 'visitSummary', 'role', 'examples'] as const;

/** A legacy `{name}` token of letters, not already inside `{{...}}`. */
const LEGACY_TOKEN = /(?<!\{)\{([a-zA-Z]+)\}(?!\})/g;

/**
 * A STORED OPENING'S LEGACY `{token}` READ AS `{{token}}` (ADR-060 decision 5): every letters-only token, so a
 * template saved before the migration keeps every line, and a line naming a token nothing resolves drops exactly as
 * it always did. Text already in `{{field}}` form is left as written.
 */
export function welcomeTemplateFields(template: string): string {
  return template.replace(LEGACY_TOKEN, (_m, f: string) => `{{${f}}}`);
}

/** The `{{field}}` placeholders of a welcome template: the grammar every message and document template uses. */
const FIELD = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * What a welcome resolves its version's variables through (ADR-060, slice 1b): the classification's sources and the
 * version's variables, the values this call site holds by source, and what it has settled. Absent, a template names
 * only the welcome's own fields.
 */
export interface WelcomeVariables {
  lookup: SourceLookup;
  variables?: Readonly<Record<string, VersionVariable>>;
  /** Values the welcome already holds, by source (`conversation:type`, `conversation:classification`). */
  values?: Readonly<Record<string, VariableValue | undefined>>;
  callSite?: CallSiteCapabilities;
}

let fixedLookup: SourceLookup | undefined;
const welcomeLookup = (): SourceLookup => (fixedLookup ??= sourceLookup(buildSourceTable({ catalog: [] })));

/** `WelcomeIntent` before the shape is read: neither the sender nor the channel has converged (`welcomeCallSite`). */
const WELCOME_SETTLES_NOTHING: CallSiteCapabilities = { identitySettled: false, conversationSettled: false, subjectSettled: false };

/**
 * Render a conversation type's welcome TEMPLATE against the orientation a room carries.
 *
 * WHY A TEMPLATE AT ALL, when `composeWelcome` already assembles clauses. The clause assembly answers
 * one question - "introduce an assistant in a room" - and answers it the same way for every assistant
 * in that room, which is correct until a room holds two. A type that opens for a REASON and adds
 * several assistants needs each one to open differently, and that difference is copy rather than logic.
 * So each assistant's version declares its copy, with a variant per conversation type, and this renders it. No role
 * branch lives in this module: the caller selects the assistant's opening step (`selectOpening`) and hands the
 * chosen template here.
 *
 * EVERY FIELD IS A VARIABLE (ADR-060, slice 1c). A template names `{{field}}`, the syntax every message and
 * document template uses, and a stored `{token}` is read as `{{token}}` (`welcomeTemplateFields`). A field is one of
 * `WELCOME_FIELDS`, each a declared source read through the resolver (`insertValue`: member text stripped of every
 * marker and delimiter, capped by its type and then by the welcome's own cap), or one of the version's variables,
 * read through `versionLookup` and inserting its fallback when the welcome does not hold its value. The opening is
 * read by the room, so a fact about a person renders empty here and its fallback stands.
 *
 * A LINE WITH AN UNRESOLVED FIELD IS DROPPED, NOT PRINTED WITH A HOLE IN IT, so a template can carry an optional
 * sentence per line: a room opened with no summary reads as if that line was never written.
 */
export function renderWelcomeTemplate(
  template: string,
  o: WelcomeOrientation,
  /**
   * What this assistant is in this room, for a template that wants to say it.
   *
   * NOT a selection axis - see {@link WelcomeOpeningStep} for why the welcome is selected by conversation type
   * instead. It is here so copy can name the job ("I am the operations assistant here") without the
   * resolver growing a second dimension that an assistant's identity already fixes.
   */
  assistant: { role?: string } = {},
  vars?: WelcomeVariables,
): { content: string; contributed: OrientationField[]; missing: OrientationField[] } {
  const contributed: OrientationField[] = [];
  const missing: OrientationField[] = [];
  const lookup = vars?.lookup ?? welcomeLookup();
  const site: ResolveSite = { callSite: vars?.callSite ?? WELCOME_SETTLES_NOTHING, audience: 'room', section: 'chat' };
  const examples = (o.examples ?? []).filter((e) => typeof e === 'string' && e.trim()).slice(0, MAX_EXAMPLES);
  const ownVariable = (name: string) => Object.prototype.hasOwnProperty.call(vars?.variables ?? {}, name);
  const resolved = new Map<string, string | undefined>();
  const valueOf = (name: string): string | undefined => {
    if (resolved.has(name)) return resolved.get(name);
    let text: string | undefined;
    if (name === 'role') text = assistant.role;
    else if (name === 'examples') text = examples.length ? examples.map((e) => `- ${e.trim()}`).join('\n') : undefined;
    else if (Object.prototype.hasOwnProperty.call(WELCOME_FIELDS, name) && !ownVariable(name)) {
      const { source, cap } = WELCOME_FIELDS[name as WelcomeField] as { source: string; cap: number };
      text = insertValue(name, lookup(source), o[name as ConversationField], site)?.slice(0, cap);
    } else {
      text = resolveTemplateFields({ [name]: name }, { lookup, variables: vars?.variables, values: vars?.values ?? {}, site })[name];
    }
    resolved.set(name, text);
    return text;
  };
  const lines: string[] = [];
  for (const line of welcomeTemplateFields(template).split('\n')) {
    const fields = [...line.matchAll(FIELD)].map((m) => m[1] as OrientationField);
    const unresolved = fields.filter((f) => !valueOf(f)?.trim());
    for (const f of unresolved) if (!missing.includes(f)) missing.push(f);
    if (fields.length && unresolved.length) continue;
    for (const f of fields) if (!contributed.includes(f)) contributed.push(f);
    lines.push(line.replace(FIELD, (_m, f: string) => valueOf(f) || ''));
  }
  return { content: lines.join('\n').trim(), contributed, missing };
}

/**
 * Compose the welcome from the assembled orientation. Additive across sources: every present field
 * renders its own clause and no present field is discarded because another is set.
 *
 * `priorSubject` and `topic` both answer "why does this conversation exist", so only one of them
 * renders that sentence (`priorSubject` first, being the more specific). That is a precedence WITHIN one
 * group to avoid two redundant sentences - it never suppresses another group.
 */
export function composeWelcome(orientation?: WelcomeOrientation | null): WelcomeComposition {
  const greeting = 'Hi';
  const o = orientation ?? {};

  // Member-controlled fields are sanitized first, so every downstream check sees the safe value.
  const topic = safeMemberText(o.topic, MAX_TOPIC);
  const priorSubject = safeMemberText(o.priorSubject, MAX_PRIOR_SUBJECT);
  // A URL, NOT prose - so it is never truncated. Capping it like a topic sliced through the `#message=<id>`
  // fragment and produced a link to a message that does not exist: an anchor that looks live and lands
  // nowhere, which is worse than having no anchor. Over the limit, the whole reference is dropped instead.
  const parentRefRaw = safeMemberText(o.parentRef, MAX_PARENT_REF + 1);
  const parentRef = parentRefRaw && parentRefRaw.length <= MAX_PARENT_REF ? parentRefRaw : undefined;
  if (parentRefRaw && !parentRef) {
    console.warn('[welcome] parentRef exceeded its limit and was dropped rather than truncated into a '
      + 'broken link');
  }
  const priorMessage = safeMemberText(o.priorMessage, MAX_PRIOR_MESSAGE);

  const contributed: OrientationField[] = [];
  const lines: string[] = [];

  // Is this a SPAWNED conversation (a drift follow-up), or a fresh one?
  //
  // Keyed on the spawn evidence rather than a flag, so it cannot drift out of sync with how these
  // channels are created: `priorSubject`/`priorMessage` are set only by the drift channel creation path.
  //
  // Computed HERE, before section 1, because the answer changes what section 1 should say - see below.
  // A CARRIED-OVER VISIT (FR26) is a continuation too: the person was talking with the assistant a moment
  // ago, as a visitor. Its opening is the assistant's own line about that visit, written in the visitor's
  // language when the visit carried over (`lib/visit-assessment.ts`), and nothing is re-introduced.
  const visitSummary = safeMemberText(o.visitSummary, MAX_VISIT_SUMMARY);
  const isSpawned = !!(priorSubject || priorMessage || visitSummary);

  // 1. Lead: who the assistant is, and where. Without a company name the "at <company>" clause is
  //    DROPPED rather than filled with a placeholder - never invent an organization the config did not
  //    name.
  //
  //    SUPPRESSED ON A SPAWNED CONVERSATION. The person did not arrive here cold: they were already
  //    mid-conversation with this same assistant and accepted an offer to continue one thought. They
  //    know who it is and where they are - they were just told, in the thread they came from.
  //    Re-introducing the assistant ("Hi - I'm your assistant at <company>, <blurb>.") pushes the only
  //    line that matters - what THIS thread is for - down the message, and reads as though the
  //    assistant has forgotten the conversation they were both just having.
  //
  //    Same principle that already suppresses sections 3-5 below, applied to the lead: a spawned
  //    conversation opens on its CONTINUITY, not on an introduction. Observed live 2026-08-06 on
  //    `conv-drift-1786065899491-…`, where the drift child led with the full Stratum introduction
  //    before reaching "This conversation picks up quarterly revenue forecasting".
  if (!isSpawned) {
    if (o.companyName) {
      contributed.push('companyName');
      if (o.companyBlurb) contributed.push('companyBlurb');
      lines.push(`${greeting} - I'm your assistant at ${o.companyName}${o.companyBlurb ? `, ${o.companyBlurb}` : ''}.`);
    } else {
      lines.push(`${greeting} - I'm your assistant for this conversation.`);
      // A blurb with no company name still describes where the user is, so it keeps its own line rather
      // than being discarded with the clause that would have carried it.
      if (o.companyBlurb) {
        contributed.push('companyBlurb');
        lines.push('', `You're working with ${o.companyBlurb}.`);
      }
    }
  }

  // 2. Why this conversation exists. A carried-over visit says so in the assistant's own words; otherwise
  //    `priorSubject` wins the sentence, and `topic` takes it after that.
  if (visitSummary) {
    contributed.push('visitSummary');
    lines.push(visitSummary);
  } else if (priorSubject) {
    contributed.push('priorSubject');
    // "the conversation it came from", not "your previous conversation". The original is not previous in the
    // sense of finished - it stays in place for whatever else is live in it, which is the whole point of
    // splitting the topic out. Calling it previous tells the person a thread they still need has ended.
    const link = parentRef ? ` (${`[the conversation it came from](${parentRef})`})` : '';
    if (parentRef) contributed.push('parentRef');
    lines.push('', `This conversation picks up ${priorSubject}${link}, so the other thread can carry on.`);
  } else if (topic) {
    contributed.push('topic');
    lines.push('', `I can help with ${topic}.`);
  }

  // 2a. The person's own words, quoted back. Rendered as a blockquote so it is visibly THEIR text and not
  //     the assistant's, and placed under the reason-for-existing sentence it evidences.
  //
  //     SUPPRESSED WHEN IT WOULD ONLY REPEAT §2. The topic label is DERIVED from this same message, so on
  //     a short question the two render as near-identical lines - observed live as "This conversation picks
  //     up How many tigers live in India (the conversation it came from)" immediately followed by "You
  //     asked: > How many tigers live in India". Quoting a person's words straight back to them twice reads
  //     as padding. Only quote when the quote actually ADDS something the label did not carry.
  if (priorMessage && !subsumesQuote(priorSubject, priorMessage)) {
    contributed.push('priorMessage');
    lines.push('', 'You asked:', `> ${priorMessage.replace(/\n+/g, ' ')}`);
  }

  // A SPAWNED conversation stops here.
  //
  // Sections 3-5 orient someone opening a FRESH conversation: what their access covers, what to try, what
  // the platform is. A drift follow-up is not that - the person was already mid-conversation, has seen all
  // of it, and arrived here by accepting an offer to continue ONE thought. Repeating the full orientation
  // buries the only line that matters (what this thread is for) under boilerplate they just read.
  //
  // `isSpawned` is computed above section 1, which also uses it.
  if (!isSpawned) {
    // 3. What the user's access covers.
    if (o.accessBlurb) {
      contributed.push('accessBlurb');
      lines.push('', o.accessBlurb);
    }

    // 4. Concrete things to try.
    if (o.examples && o.examples.length) {
      contributed.push('examples');
      lines.push('', 'A few things you can try:');
      for (const e of o.examples) lines.push(`- ${e}`);
    }

    // 5. Closing note.
    if (o.platformNote) {
      contributed.push('platformNote');
      lines.push('', o.platformNote);
    }
  }

  // Nothing contributed ⇒ the generic platform welcome. This is what an EMPTY ASSEMBLY renders, not a
  // branch that a partial orientation can fall into.
  if (!contributed.length) {
    return {
      content: GENERIC_WELCOME,
      variant: 'generic',
      contributed: [],
      missingFields: [],
      usedGenericFallback: true,
    };
  }

  // Every section after the first prepends a blank separator, which assumed section 1 always rendered.
  // On a SPAWNED conversation it does not, so the message would otherwise open with a blank line.
  // Trim leading separators rather than making each section's push conditional: one rule at the end
  // cannot be forgotten by a section added later.
  while (lines.length && lines[0] === '') lines.shift();

  const anyDeployment = DEPLOYMENT_FIELDS.some((f) => contributed.includes(f));
  return {
    content: lines.join('\n'),
    variant: 'oriented',
    contributed,
    // Only meaningful once the deployment opted in by configuring something.
    missingFields: anyDeployment ? DEPLOYMENT_FIELDS.filter((f) => !contributed.includes(f)) : [],
    usedGenericFallback: false,
  };
}

/** The opening an assistant posts: the template's render when it says anything, else the built-in assembly. */
export interface WelcomeOpening {
  /** The text posted. */
  content: string;
  /** The built-in assembly, which also describes the welcome for logging and the intake decision. */
  composition: WelcomeComposition;
  /** The template's render, when a template applies. */
  rendered: ReturnType<typeof renderWelcomeTemplate> | null;
  /** True when the template's render is the text posted. */
  usedTemplate: boolean;
}

/**
 * THE OPENING TEXT FOR ONE ROOM, from the template that applies and the assembled orientation.
 *
 * A template replaces what is said, not what the welcome is: the assembly is always composed, and a
 * template whose every line names a field the room lacks renders empty and the assembly is posted
 * instead. The router posts this and the console previews it, from the same function.
 */
export function composeOpening(
  template: string | undefined,
  orientation: WelcomeOrientation,
  assistant: { role?: string } = {},
  /** The version's variables and the values the welcome holds, for a template that names a variable. */
  vars?: WelcomeVariables,
): WelcomeOpening {
  const composition = composeWelcome(orientation);
  const rendered = template ? renderWelcomeTemplate(template, orientation, assistant, vars) : null;
  const usedTemplate = !!rendered?.content.trim();
  return { content: rendered && usedTemplate ? rendered.content : composition.content, composition, rendered, usedTemplate };
}

/** Copy-only form of {@link composeWelcome}, for surfaces that need the text and nothing else. */
export function composeWelcomeMessage(orientation?: WelcomeOrientation | null): string {
  return composeWelcome(orientation).content;
}
