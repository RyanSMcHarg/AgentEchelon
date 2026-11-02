/**
 * THE SYSTEM PROMPT AN ANSWER IS GIVEN, COMPOSED IN ONE PLACE (ADR-065, shared item 1).
 *
 * A live turn and a draft's run against the golden set both call this, so the run measures the prompt that ships. The
 * order is the turn's: the persona and the version's addendum with the host's sections (the stable, cacheable prefix),
 * then the per-turn suffix: how to answer this intent, the first-turn greeting, who the person is, how they asked to be
 * answered, the held question, what the transcript's speaker labels mean, and who is here.
 *
 * What is per person or per conversation is an INPUT, never read here. A live turn passes what the router settled; a
 * golden run passes `goldenRunContext`, the entry's recorded reply preferences and preceding turns, with every
 * per-person section neutral: a pseudonymous speaker is not greeted or named, no roster, no held question.
 *
 * The catalog context sources are not composed here. They are read per turn, for the person the turn settles, on the
 * assistant's credentials (`assistant-async-processor.ts`), and a run has no person to read them for.
 */
import { buildSystemPrompt } from './context-framework.js';
import { personaAddendumBlock } from './active-profile.js';
import { intentAnswerPrompt } from './intent-answer.js';
import type { IntentPack } from './intent-pack.js';
import { firstTurnGreetingDirective, userIdentityDirective } from './async-processor-core.js';
import { replyPreferencesDirective, preferenceTurnDirective } from './reply-preferences-runtime.js';
import { heldQuestionDirective } from './held-question.js';
import { transcriptConventionDirective } from './transcript-attribution.js';

/** Everything about the person and the conversation that the prompt says, settled by the caller. */
export interface AnswerContext {
  /** The person's resolved display name, or absent where there is none to anchor to (a guest, a golden run). */
  senderDisplayName?: string;
  /** Greet the person by name on this turn: their first message, and no event run greeted them already. */
  greet: boolean;
  /** The reply-preference keys this person chose (registry values, `lib/config/reply-preferences.ts`). */
  replyPreferences?: Record<string, string>;
  preferenceTurn?: Parameters<typeof preferenceTurnDirective>[0];
  heldQuestion?: { text: string };
  /** The sections that change within a conversation (who is here), already rendered. */
  turnSections: string[];
}

export interface AnswerPromptInput {
  persona: string;
  addendum?: string;
  /** The host's per-turn context sections (domain context, participant profile), already rendered. */
  hostSections: string[];
  intent: string;
  pack: IntentPack;
  /** The transcript the model is given, which decides whether the speaker-label convention is stated. */
  transcript: Array<{ content: string }>;
  context: AnswerContext;
}

export interface ComposedAnswerPrompt {
  systemPrompt: string;
  /** The length of the stable prefix, after which the per-turn suffix begins (the Bedrock cache point). */
  cacheablePrefixLength: number;
}

export function composeAnswerPrompt(input: AnswerPromptInput): ComposedAnswerPrompt {
  let systemPrompt = buildSystemPrompt(input.persona + personaAddendumBlock(input.addendum), input.hostSections);
  const cacheablePrefixLength = systemPrompt.length;
  const c = input.context;
  systemPrompt += intentAnswerPrompt(input.intent, input.pack);
  if (c.greet) systemPrompt += firstTurnGreetingDirective(c.senderDisplayName);
  systemPrompt += userIdentityDirective(c.senderDisplayName);
  systemPrompt += replyPreferencesDirective(c.replyPreferences);
  systemPrompt += preferenceTurnDirective(c.preferenceTurn);
  systemPrompt += heldQuestionDirective(c.heldQuestion);
  systemPrompt += transcriptConventionDirective(input.transcript);
  systemPrompt += buildSystemPrompt('', c.turnSections);
  return { systemPrompt, cacheablePrefixLength };
}

/**
 * THE CONTEXT A GOLDEN RUN ANSWERS UNDER: the entry's recorded reply preferences, and nothing else about a person. The
 * same for both sides of a run, so the paired difference compares versions, not contexts.
 */
export function goldenRunContext(replyPreferences: Record<string, string> | null | undefined): AnswerContext {
  return {
    greet: false,
    ...(replyPreferences && Object.keys(replyPreferences).length ? { replyPreferences } : {}),
    turnSections: [],
  };
}
