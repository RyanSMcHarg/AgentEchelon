/**
 * THE `prompt` WELCOME'S ONE MODEL TURN (SPEC-WELCOME-AND-CONTEXT FR24, ADR-061 decision 9).
 *
 * The structured opening is already in the room when this runs: the router posted it instantly at
 * `assistant-joined` (FR2) and dispatched this turn after it, on the joining assistant's own vended session. The
 * turn asks the model the version's prompt template, with what the conversation knows passed as delimited data
 * after the instructions (`renderPromptTemplate`), and posts what the model wrote as a new message, once.
 *
 * NOTHING MORE IS POSTED WHEN THE TURN DOES NOT DELIVER. On a refused meter, past its deadline, on a model error, a
 * guardrail intervention on what it was given or what it wrote, or an empty reply, it posts nothing: the structured
 * opening is the welcome, and the room is never shown a half-made greeting, a placeholder or an apology. Every
 * outcome is recorded (`posted` or `fallback:<reason>`).
 *
 * EVERYTHING THAT CAN WAIT IS HERE, NOT IN THE ROUTER. The meter, who is here and the template are read by this
 * turn, after the router has answered with the opening, so the opening waits only on the dispatch (FR2).
 *
 * The model call, the post and the record are injected, so each outcome is a unit test.
 */
import type { ParsedTemplate } from './document-template.js';
import { renderPromptTemplate } from './message-template.js';
import { stripMessageMarkers } from './message-markers.js';
import { botIdFromArn } from './person-arn.js';
import { holdSessionFor } from './assistant-session.js';

/** What the router hands the processor to run (`AsyncProcessorEvent.welcomePrompt`). */
export interface WelcomePromptRequest {
  /** The prompt template the version names. */
  template: string;
  /** The read tools the turn may use, as the version names them. */
  tools: string[];
  /** The conversation's fields the template's declared fields are filled from, passed as data. */
  values: Record<string, string>;
  /** How long the turn may take before the opening stands alone. */
  deadlineMs?: number;
}

export const WELCOME_PROMPT_DEADLINE_MS = 11_000;

export type WelcomePromptFallback = 'deadline' | 'model-error' | 'guardrail' | 'empty' | 'template' | 'meter' | 'post-failed';
export type WelcomePromptOutcome = 'posted' | `fallback:${WelcomePromptFallback}`;

/** What a model call for the turn returns: the reply, and whether a guardrail intervened on either side. */
export interface WelcomePromptModelResult {
  response: string;
  inputGuardBlocked?: boolean;
  guardrailFindings?: string[];
}

export interface WelcomePromptDeps {
  /** The global budget, metered `machineWritten` (no person asked for it). False refuses the turn. */
  meter?: () => Promise<boolean>;
  /** Who is here, as display names, passed as data beside the conversation's fields. */
  people?: () => Promise<string[]>;
  /** The model call: the joining assistant's persona and context, with the rendered prompt as its one message. */
  invoke: (userMessage: string) => Promise<WelcomePromptModelResult>;
  /** Post the greeting as a new message from the joining assistant. */
  post: (content: string) => Promise<void>;
  /** Record the turn's outcome. Never throws. */
  record: (outcome: WelcomePromptOutcome, detail?: Record<string, unknown>) => void;
  /** A reply the model loop substitutes for an empty one, which is not a greeting. */
  emptyReplies?: string[];
}

class Deadline extends Error {}

/** Run the turn and report its outcome. Never throws: a welcome that cannot be added leaves the opening standing. */
export async function runWelcomePromptTurn(
  request: WelcomePromptRequest,
  template: ParsedTemplate | undefined,
  deps: WelcomePromptDeps,
): Promise<WelcomePromptOutcome> {
  const done = (outcome: WelcomePromptOutcome, detail: Record<string, unknown> = {}): WelcomePromptOutcome => {
    try { deps.record(outcome, { template: request.template, ...detail }); } catch { /* recording never fails the turn */ }
    return outcome;
  };
  if (!template || template.kind !== 'prompt') return done('fallback:template');
  if (deps.meter && !(await deps.meter().catch(() => false))) return done('fallback:meter');
  const people = deps.people ? (await deps.people().catch(() => [] as string[])).filter(Boolean) : [];
  const rendered = renderPromptTemplate(template, { ...request.values, ...(people.length ? { people: people.join(', ') } : {}) });
  if (!rendered.ok) return done('fallback:template', { refused: rendered.refused });

  const deadlineMs = request.deadlineMs ?? WELCOME_PROMPT_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: WelcomePromptModelResult;
  const started = Date.now();
  const call = deps.invoke(rendered.prompt);
  try {
    result = await Promise.race([
      call,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Deadline()), deadlineMs); }),
    ]);
  } catch (err) {
    // THE LATE CALL FINISHES ON THIS TURN'S SESSION: its guardrail still runs as the assistant, and its reply is discarded.
    if (err instanceof Deadline) holdSessionFor(call);
    return err instanceof Deadline
      ? done('fallback:deadline', { deadlineMs })
      : done('fallback:model-error', { err: (err as Error)?.name });
  } finally {
    if (timer) clearTimeout(timer);
  }
  // ANY INTERVENTION IS A FALLBACK: a masked greeting is not one the assistant chose, and the opening already stands.
  if (result.inputGuardBlocked || (result.guardrailFindings ?? []).some((f) => f.startsWith('guardrail.output.'))) {
    return done('fallback:guardrail');
  }
  const text = stripMessageMarkers(result.response ?? '').trim();
  if (!text || (deps.emptyReplies ?? []).includes(text)) return done('fallback:empty');
  try {
    await deps.post(text);
  } catch (err) {
    return done('fallback:post-failed', { err: (err as Error)?.name });
  }
  return done('posted', { ms: Date.now() - started });
}

/**
 * THE TURN'S CORRELATION: the conversation and the joining assistant. A redelivered `WelcomeIntent` derives the same
 * id and collapses on the processor's own claim, so the room is greeted once by each assistant that joins it.
 */
export function welcomePromptCorrelationId(channelArn: string, botArn: string): string {
  const conversation = channelArn.split('/channel/')[1] ?? '';
  const bot = botIdFromArn(botArn) ?? '';
  return `welcome-${conversation}-${bot}`.slice(0, 120);
}

export type WelcomePromptDispatch = 'dispatched' | 'not-dispatched';

/**
 * HOW THE ROUTER ASKS FOR THE TURN, after the structured opening: one asynchronous invoke of the processor, the same
 * `invokeAsync` the drift-spawned welcome uses, which records the turn routing the joining assistant's session is
 * vended from. That invoke is the only thing the opening waits on; the meter and the roster are the turn's own.
 */
export async function dispatchWelcomePromptTurn(
  args: { channelArn: string; botArn: string; classification: string; request: WelcomePromptRequest },
  deps: {
    processorArn: () => Promise<string | undefined>;
    invoke: (processorArn: string, payload: Record<string, unknown>) => Promise<boolean>;
    now?: () => number;
  },
): Promise<WelcomePromptDispatch> {
  const processorArn = await deps.processorArn();
  if (!processorArn) return 'not-dispatched';
  const dispatched = await deps.invoke(processorArn, {
    channelArn: args.channelArn,
    correlationId: welcomePromptCorrelationId(args.channelArn, args.botArn),
    userMessage: '',
    userContent: '',
    classification: args.classification,
    botArn: args.botArn,
    trigger: 'welcome',
    triggerAtMs: (deps.now ?? Date.now)(),
    welcomePrompt: args.request,
  });
  return dispatched ? 'dispatched' : 'not-dispatched';
}
