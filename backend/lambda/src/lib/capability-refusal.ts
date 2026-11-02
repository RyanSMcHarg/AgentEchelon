/**
 * THE REFUSAL A PERSON GETS FOR SOMETHING THIS ASSISTANT DOES NOT OFFER (DESIGN-CAPABILITY-REFUSAL §6).
 *
 * Pure: the router decides THAT a turn is refused (the classifier marked the intent `refused`) and
 * hands this module the facts it already holds. This decides only WHAT the person is told, in two
 * parts, because the parts go to different audiences:
 *
 * - `refusal` - that this assistant does not do it. As visible as the request was.
 * - `access`  - where they could get it. ALWAYS to the person alone (SPEC FR17): it states what
 *               their clearance reaches, which no other member of the conversation should read.
 *
 * WHERE TO POINT THEM comes from deployment declarations, never from another classification's
 * assistant configuration, which this router cannot read (tenets D12 and D13): what each classification
 * `produces`, and what the refused intent `needs`. So:
 *
 * - The intent hands something over (`needs`), clearance resolved: list the classifications the person
 *   reaches, other than this one, that produce it; when there are none, send them to their administrator
 *   without naming any classification.
 * - The intent hands nothing over: nothing can say which classification would serve it. Send them to
 *   their administrator only when they reach no other conversational classification at all (SPEC
 *   FR18); otherwise point nowhere, rather than at a classification that may refuse too.
 * - Clearance unresolved: no access line at all. Telling a person something false about their own
 *   permissions is a larger harm than saying nothing (the onboarding intake's rule, `offerReply`).
 */
import { shippedLineText, templateLine } from './message-lines.js';
import type { AssistantCopy } from './active-profile.js';
import type { IntentNeed } from './intent-pack.js';

/** What the refusal reads from the classification registry. A structural slice, so a test can fake it. */
export interface RefusalRegistry {
  grantsFor(classification: string): string[];
  isConversational(value: string): boolean;
  produces(value: string, output: IntentNeed): boolean;
  displayNameOf(value: string): string;
}

export interface RefusalInput {
  /** What the refused intent hands over; absent when it hands over nothing beyond the reply. */
  need?: IntentNeed;
  /** The conversation's classification, read from its immutable tag. */
  channelClassification: string;
  /** The person's clearance; undefined when it could not be resolved. */
  userClearance?: string;
  copy?: AssistantCopy;
  registry: RefusalRegistry;
}

export interface ComposedRefusal {
  refusal: string;
  /** Present only when there is something true to say about the person's access. */
  access?: string;
}

/** The section of the `capability-refusal` template that says each line. */
const REFUSAL_SECTIONS = {
  capabilityUnavailable: 'chat.unavailable',
  capabilityNotOffered: 'chat.notOffered',
  capabilityHasAccess: 'chat.hasAccess',
  capabilityHasAccessClose: 'chat.hasAccessClose',
  capabilityNeedsAccess: 'chat.needsAccess',
  capabilityNotOfferedNeedsAccess: 'chat.notOfferedNeedsAccess',
  capabilityOutputDocument: 'label.document',
  capabilityOutputImage: 'label.image',
} as const;

type RefusalCopyKey = keyof typeof REFUSAL_SECTIONS;

/**
 * THE SHIPPED LINES, read from the `capability-refusal` message template (ADR-062 decision 6), `{field}`-style, by
 * the key each line is known by.
 */
export const DEFAULT_REFUSAL_COPY: Readonly<Record<RefusalCopyKey, string>> = Object.freeze(Object.fromEntries(
  (Object.entries(REFUSAL_SECTIONS) as Array<[RefusalCopyKey, string]>).map(([key, section]) => [key, shippedLineText('capability-refusal', section)]),
) as Record<RefusalCopyKey, string>);

/** One line of the refusal, from the assistant's `capability-refusal` template, the classification's, or the shipped one. */
function line(copy: AssistantCopy | undefined, key: RefusalCopyKey, values: Record<string, unknown> = {}): string {
  return templateLine('capability-refusal', { copy }, { section: REFUSAL_SECTIONS[key], values });
}

function outputNoun(copy: AssistantCopy | undefined, need: IntentNeed): string {
  return need === 'image' ? line(copy, 'capabilityOutputImage') : line(copy, 'capabilityOutputDocument');
}

export function composeRefusal(input: RefusalInput): ComposedRefusal {
  const { need, channelClassification, userClearance, copy, registry } = input;

  if (!need) {
    const refusal = line(copy, 'capabilityNotOffered');
    if (userClearance === undefined) return { refusal };
    const reachesAnotherConversation = registry.grantsFor(userClearance)
      .some((c) => c !== channelClassification && registry.isConversational(c));
    return reachesAnotherConversation
      ? { refusal }
      : { refusal, access: line(copy, 'capabilityNotOfferedNeedsAccess') };
  }

  const output = outputNoun(copy, need);
  const refusal = line(copy, 'capabilityUnavailable', { output });
  if (userClearance === undefined) return { refusal };

  const offering = registry.grantsFor(userClearance).filter((c) => c !== channelClassification
    && registry.isConversational(c)
    && registry.produces(c, need));
  if (!offering.length) {
    return { refusal, access: line(copy, 'capabilityNeedsAccess', { output }) };
  }
  // One label per line, so no list grammar ("A, B and C"; "which does" against "which do") is built
  // here in one language (tenet D11).
  const labels = offering.map((c) => `- ${registry.displayNameOf(c)}`).join('\n');
  return {
    refusal,
    access: `${line(copy, 'capabilityHasAccess')}\n${labels}\n\n${line(copy, 'capabilityHasAccessClose')}`,
  };
}
