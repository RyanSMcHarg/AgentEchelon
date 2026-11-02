/**
 * THE PEOPLE AN EVENT-OPENED CONVERSATION WAS OPENED FOR ARE TOLD SO, BY EMAIL, BY ITS ASSISTANT.
 *
 * When the typed-conversation creator opens a room, the person the event named and every person the type
 * admitted are welcomed into it privately, and the welcome carries their email: the same `memberWelcome`
 * notice a share and a member add name (`share-conversation`, `conversation-management.ts`). The creator
 * names the notice and the router of the room's classification says it as the room's primary, from that
 * assistant's own copy (`sayThroughRouter`, `sayNotice`). So this composes no words and sends no mail: the
 * notification bridge reads the notice's directive off the message stream and sends the email in the
 * assistant's voice, as a `conversation-shared` notice each person can mute, with the unsubscribe and the
 * deep link into the room every addressed notice carries (`emailPeople`).
 *
 * The subject is the conversation's own label, which the event or its declaration supplied, so no copy
 * here is fixed English.
 *
 * NEVER THROWS, and never fails the creation it follows: a welcome that could not be said is logged by kind
 * and counted, and the room stands.
 */
import { sayThroughRouter } from './say-through-router.js';
import type { NoticeOutcome, NoticeRequest } from './assistant-notice.js';

/** The most people one creation welcomes, so a large group cannot outlast the function's timeout. */
export const MAX_WELCOMED = 40;
/** How many welcomes are asked of the router at once. */
const CONCURRENCY = 5;

export interface WelcomeDeps {
  say?: (classification: string, notice: NoticeRequest) => Promise<NoticeOutcome>;
  /** A display name for a person, never an address; null when nobody names them. */
  nameOf?: (personArn: string) => Promise<string | null>;
}

/**
 * WHO A CREATION NAMES IN `person-joined` (ADR-061 decision 5, one welcome per person per arrival): everyone the room
 * admitted, the lead first, once each, except the people the `conversation-opened` run owns. The lead arrives with the
 * opening, and where the room's assistant runs a workflow on it, that run is the lead's welcome; naming them again
 * would start a second welcome, and a second email, for the same arrival.
 */
export function peopleJoiningAfterOpening(leadArn: string, people: readonly string[], ownedByOpening: ReadonlySet<string>): string[] {
  return [...new Set([leadArn, ...people])].filter((arn) => !ownedByOpening.has(arn));
}

/**
 * Welcome each person into the room, the lead first, once each. Returns how many welcomes were said and
 * how many were not (with the people left out over {@link MAX_WELCOMED} counted as not said).
 */
export async function welcomeIntoOpenedConversation(
  args: {
    classification: string;
    channelArn: string;
    /** The room's primary, which says every welcome. */
    botArn: string;
    /** The person the event named. */
    leadArn: string;
    /** Everyone else the type admitted. */
    people: string[];
    /** The conversation's label: the recap the welcome names and the email's subject. */
    topicLabel: string;
    /**
     * The people a `person-joined` run already welcomed (ADR-061 decision 5), who are sent no second welcome. They are
     * counted neither said nor not said: their welcome is the run's.
     */
    welcomedByRun?: ReadonlySet<string>;
  },
  deps: WelcomeDeps = {},
): Promise<{ said: number; notSaid: number }> {
  const say = deps.say ?? sayThroughRouter;
  const ordered = [...new Set([args.leadArn, ...args.people])]
    .filter((arn) => arn.includes('/user/') && !args.welcomedByRun?.has(arn));
  const welcomed = ordered.slice(0, MAX_WELCOMED);
  let said = 0;
  let notSaid = ordered.length - welcomed.length;
  if (notSaid > 0) {
    console.warn('[typed-conversation] more people than one creation welcomes; the rest are not emailed', {
      people: ordered.length, welcomed: welcomed.length,
    });
  }
  const welcomeOne = async (personArn: string) => {
    try {
      const name = (await deps.nameOf?.(personArn).catch(() => null)) || '';
      const outcome = await say(args.classification, {
        kind: 'memberWelcome',
        channelArn: args.channelArn,
        botArn: args.botArn,
        to: [personArn],
        vars: { name, recap: args.topicLabel, notifyPerson: personArn, notifySubject: args.topicLabel },
      });
      if (outcome.posted) said += 1;
      else notSaid += 1;
    } catch (err) {
      notSaid += 1;
      console.warn('[typed-conversation] a welcome could not be asked for', { err: (err as Error)?.name });
    }
  };
  for (let i = 0; i < welcomed.length; i += CONCURRENCY) {
    await Promise.all(welcomed.slice(i, i + CONCURRENCY).map(welcomeOne));
  }
  return { said, notSaid };
}
