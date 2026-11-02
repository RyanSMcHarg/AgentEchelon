/**
 * EVERY COMPONENT ALLOWED TO SPEAK AS AN ASSISTANT, DECLARED.
 *
 * Amazon Chime SDK does not bind the `ChimeBearer` to the caller, so whoever can send bearing a bot, or
 * can ask a classification's vend for a session, speaks as an assistant. The set of principals that can
 * is therefore a security property, and it is declared here rather than discovered by reading code:
 *
 * - `test/only-declared-speakers-can-speak.test.ts` synthesizes the stacks and fails on any role that
 *   can invoke a vend, write a routing record, or send or update a message bearing a bot, unless it is
 *   listed here. It also fails on an entry nothing synthesizes, so the list cannot go stale.
 * - The same test fails when a speaking helper (`messagingClientAsAssistant`, `speakAsRoutedAssistant`,
 *   `sessionForRoutedAssistant`, `adoptSessionAsAssistant`, `vendAssistantSession`) or the admin-channel
 *   post (`deliverAdminNotice`) is imported by a file no entry names in `handlers`.
 * - `tests/e2e/no-platform-role-speaks-as-an-assistant.spec.ts` enumerates every deployed role carrying
 *   the stack prefix and refuses a vend invoke from any role outside this list.
 *
 * A role is matched by its construct id: an entry matches every role whose CloudFormation logical id
 * starts with `constructId`, which is also how a deployed role is traced back to its stack resource.
 *
 * A service with a line for a conversation names it to the router as a notice (`sayThroughRouter`) and is
 * not on this list. A new entry needs a reason a reviewer can disagree with.
 *
 * Plain data with no imports, so the Playwright specs can read it without pulling in the CDK.
 */

/**
 * WHY A COMPONENT SPEAKS.
 *
 * - `turn`: answers a person's turn (the processor, and the acting role its session runs on).
 * - `router`: routes a turn and speaks its acknowledgment, every notice, and every line of a duel outside a
 *   turn (a round placeholder, a waiting marker's clear, a closing line). The battle orchestrator speaks
 *   as no assistant: it names those lines to the router.
 * - `queue-edit`: edits the queue notice, which a notice cannot express.
 * - `admin-alert`: posts an alert as the admin assistant in the admin notification channel, through
 *   `deliverAdminNotice`, and as no conversational assistant. One component does: the `AdminServices`
 *   stack's alert poster. Every other alert is raised as an `ae.alert` event (`postAdminNotice`), which
 *   speaks as nobody.
 */
export type SpeakerKind = 'turn' | 'router' | 'queue-edit' | 'admin-alert';

export interface Speaker {
  /** The role's construct id: every role whose logical id starts with it is this speaker. */
  constructId: string;
  kind: SpeakerKind;
  /** One line: what it says, and why it is the component that says it. */
  reason: string;
  /**
   * The source files, relative to `backend/`, that may import a speaking helper on this speaker's
   * behalf. Empty for a speaker whose grant is a bearer statement rather than a vended session.
   */
  handlers: readonly string[];
}

export const SPEAKERS: readonly Speaker[] = [
  {
    constructId: 'AssistantActingRole',
    kind: 'turn',
    reason: 'The one role every assistant of a classification acts through; the vend assumes it for each session it mints.',
    handlers: [],
  },
  {
    constructId: 'ProcessorRole',
    kind: 'turn',
    reason: 'The processor answers a turn on the session the vend mints for the routed assistant. Its error alert is an ae.alert event, which speaks as nobody.',
    handlers: ['lambda/src/lib/async-processor-core.ts'],
  },
  {
    constructId: 'AgentHandlerRole',
    kind: 'router',
    reason: 'The router records each turn and speaks its acknowledgment, every notice, and each duel side\'s round placeholder and marker clears as the routed assistant.',
    handlers: ['lambda/src/router-agent-handler.ts'],
  },
  {
    constructId: 'PostProcessingRole',
    kind: 'queue-edit',
    reason: 'Arrival triage reads and edits the queue notice as the assistant that posted it.',
    handlers: ['lambda/src/lib/triage-on-arrival.ts'],
  },
  {
    constructId: 'AdminAlertPosterFunction',
    kind: 'admin-alert',
    reason: 'The AdminServices stack\'s one rule delivers every ae.alert here, and it posts each into the admin notification channel as the admin assistant.',
    handlers: ['lambda/src/admin-alert-poster.ts'],
  },
];

/** The declared speaker a role's logical id belongs to, or undefined when it is undeclared. */
export function speakerFor(logicalId: string): Speaker | undefined {
  return SPEAKERS.find((s) => logicalId.startsWith(s.constructId));
}
