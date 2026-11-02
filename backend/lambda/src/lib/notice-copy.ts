/**
 * THE NOTICES AN ASSISTANT SAYS, AND THE VARIABLES EACH TAKES: the shipped English of every notice and the
 * declaration of its values, with no dependency, so the shipped message templates (`shipped-message-templates.ts`)
 * and the console's editor read them without the notice path's clients. The notice path is `assistant-notice.ts`,
 * which re-exports both.
 */
export const DEFAULT_NOTICE_COPY = {
  /** `/battle` with no prompt after it. */
  battleNeedsPrompt:
    'Add a prompt after /battle and both assistants will answer it, for example: /battle what should we prioritise next quarter?',
  /** `/battle end` with no duel running. */
  battleNoneRunning: 'There is no battle running in this conversation, so there is nothing to end.',
  /** `/battle end` from someone who neither started the duel nor moderates the room. */
  battleNotYours:
    'This battle belongs to the person who started it, so only they can end it - or a moderator can turn Battle Mode off.',
  /** `/battle end` for a duel that had already finished. */
  battleAlreadyDone: 'That battle is done. The conversation is clear for a new one.',
  /** A duel ended before its rebuttal was dispatched. */
  battleEnded:
    'Battle ended. Nothing from it is counted, and anything it was collecting has stopped. Send `/battle <your question>` whenever you want to start a new one.',
  /** A duel ended while a rebuttal was already on its way; must not promise that no reply follows. */
  battleEndedReplyInFlight:
    'Battle ended. A final reply was already on its way and may still arrive - nothing from this battle is counted either way. Send `/battle <your question>` to start a new one.',
  /** The person starting the duel could not be identified, so none was started. */
  battleStarterUnknown:
    "I couldn't tell who is starting this battle, so I haven't started one. Try again, and if it keeps happening let an administrator know.",
  /** This conversation's classification offers no Battle Mode. */
  battleUnavailable: "Battle Mode isn't available in this conversation. Reply normally and I'll respond as usual.",
  /** Battle Mode is offered but the room's toggle is off. */
  battleNotEnabled:
    "Battle Mode isn't enabled on this channel. Ask a moderator to flip the toggle in the members panel, then try /battle again.",
  /** The experiment the room was battling for has ended. */
  battleExperimentEnded:
    'The experiment this channel was battling for has ended, so there is nothing left to compare. A moderator can turn Battle Mode off, or start a new experiment and enable it again.',
  /** A duel is running and the sender started it. */
  battleAlreadyRunningYours:
    'A battle is already running in this conversation. Send `/battle end` to end it and start this one instead, or let it finish and ask again.',
  /** A duel is running and someone else started it. */
  battleAlreadyRunningTheirs:
    'A battle is already running in this conversation, and it stays with the person who started it. They can end it with `/battle end`, or a moderator can turn Battle Mode off. Then this one can start.',
  /** The duel could not be recorded, so it did not start. */
  battleStartFailed: "I couldn't start that battle just now. Please try /battle again.",
  /** The classification's battle wiring is incomplete. */
  battleNotConfigured:
    "Battle Mode isn't fully configured for this conversation's classification. Ask an operator to check the deployment.",
  /** One side of a duel could not be started. Said by that side. */
  battleSideStartFailed: "I couldn't start on that just now.",
  /** A side did not finish round 1, so it runs no rebuttal. Said by that side. `{name}` is its display name in the duel. */
  battleSideDidNotFinish: "{name} didn't finish in time.",
  /** The same, when the side's display name in the duel cannot be read. Said by that side. */
  battleSideDidNotFinishUnnamed: "One assistant didn't finish in time.",
  /** No side finished round 1, so the duel closes. Said by the room's primary. */
  battleNoneFinished: "This battle couldn't be completed. No assistant finished in time. Try /battle again.",
  /**
   * A private address (`.<member>`) naming a PERSON arrived without a `Target`. The message is KEPT, so
   * this must say the room can see it and must not say it was dropped or ask for it again.
   */
  privateMessageNotPrivate:
    'Heads up: that message began with a private address but arrived without a private target, so everyone here can see it rather than only the person you named. It is still in the conversation; you can delete it if you would like.',
  /** The same, where the address named an ASSISTANT, so an answer is coming privately. */
  privateMessageNotPrivateAnswering:
    'Heads up: that message began with a private address but arrived without a private target, so everyone here can see it. I am answering you privately. The original message is still in the conversation; you can delete it if you would like.',
  /** A private message whose `Target` named a different member, so it reached the wrong person. */
  privateMessageWrongTarget:
    'That message did not reach the person you named. It was sent privately to somebody else, so they received it and the person you named did not. It is still in the conversation and only they can see it; please send it again.',
  /** The person reached their hourly message limit. `{minutes}` is the minutes until it resets. */
  rateLimited: "You've reached your message limit for this hour. It resets in about {minutes} min.",
  /**
   * The assistant a person addressed cannot take a turn (no active version, no record, or a refused session).
   * Said by the conversation's primary, to that person. `{name}` is the assistant they addressed.
   */
  assistantUnavailable:
    "{name} can't answer right now, so nothing is on its way from it. An administrator has been told. You can ask me instead.",
  /** The spend budget refused the turn. A deployment's `budgetCannedResponse` stands in below a profile's line. */
  budgetExhausted: 'We are experiencing unusually high demand right now. Please try again in a little while.',
  // ── LINES OTHER SERVICES NAME, SAID BY THE ROUTER ──────────────────────────────
  /** A moderator turned Battle Mode on. `{variant}` is the challenger's display name. */
  battleModeOn: 'Battle Mode is now ON. {variant} has joined the channel. Try `/battle <your prompt>` to compare both assistants.',
  /** The same, when the experiment carries a written brief for the people battling. `{briefing}` is that brief. */
  battleModeBriefing: '{briefing}',
  /** A moderator turned Battle Mode off. */
  battleModeOff: 'Battle Mode is now OFF.',
  /** The same, and a duel was running. */
  battleModeOffEnded: 'Battle Mode is now OFF. The battle that was running has ended, along with anything it was collecting.',
  /** A moderator archived the conversation. `{who}` archived it on `{date}`; must say it is now read-only. */
  conversationArchived: 'Conversation archived by {who} on {date}. It is now read-only.',
  /** Someone joined. `{name}` is who. */
  memberJoined: '**{name}** joined this conversation. Mention **@assistant** or **@all** to bring in the assistant.',
  /** To the person who joined, privately. `{name}` is them; `{recap}` names what they joined. */
  memberWelcome: "Welcome, {name}. You've been added to {recap}.\n\n_Only you can see this message. Mention **@assistant** or **@all** to bring in the assistant; other messages are visible to everyone here, but I won't reply unless I'm mentioned._",
  /** A proactive briefing is ready, in this conversation. `{source}` is what produced it. */
  briefingReady: 'I generated a proactive briefing for you (no request needed, triggered by {source}). Ask me anything about it here.',
  // A turn died and its retries are spent. Says the work did not finish and that sending it again is worth
  // doing, and names no internals (`AssistantCopy.turnFailed`).
  turnFailed: 'Something went wrong while I was working on your last message, and I could not finish it. Please send it again.',
  // A tool loop changed something and the model wrote no summary of it (`AssistantCopy.completedWithoutSummary`).
  completedWithoutSummary: 'That is done.',
  // A tool loop changed nothing and produced no answer (`AssistantCopy.nothingChanged`).
  nothingChanged: 'I was not able to produce an answer to that, and nothing was changed. Please try again.',
  // A battle side declined round 2; its placeholder resolves to this (`AssistantCopy.battleNoRebuttal`).
  battleNoRebuttal: 'No rebuttal.',
  // A long answer was cut short because a later part could not be posted (`AssistantCopy.answerTruncated`).
  answerTruncated: '*(Additional content could not be delivered)*',
  // A task's failure reason when its answer could not be delivered (`AssistantCopy.answerUndelivered`).
  answerUndelivered: 'The answer could not be delivered',
  // A battle challenger whose name matches the live assistant's, so the two read differently in the room
  // and on the scorecard (`AssistantCopy.battleAltName`; `battleSideNames`).
  battleAltName: '{name} (alt)',
  // The challenger, when its profile's name cannot be read, so a person never reads its assistant id in its
  // place (`AssistantCopy.battleChallengerUnnamed`; `channel-battle.ts`).
  battleChallengerUnnamed: 'The challenger',
  // Nothing queued could be read back from the channel, so the queue is left for the next message
  // (`AssistantCopy.triageUnreadable`).
  triageUnreadable: 'I could not read the messages that arrived while I was busy. I will pick them up on your next message.',
  // The reading was refused and one was derived per message; an invitation to correct it (`AssistantCopy.triageDerived`).
  triageDerived: 'I have captured each of those separately rather than grouping them, because I could not read them confidently. Tell me if that is not what you meant and I will redo it.',
  // ── THE QUEUE-TRIAGE MESSAGE (`lib/turn-triage-proposal.ts`), composed when the model's own words cannot be used ──
  // The whole reading was unclear, so it asks rather than lists (`AssistantCopy.triageUnclear`).
  triageUnclear: 'These arrived while I was busy and I could not work out what they are asking for. Could you tell me which one you would like me to start with?',
  // Opens the composed reading of the queue (`AssistantCopy.triageUnderstood`).
  triageUnderstood: 'Here is what I understood from the messages that arrived while I was busy.',
  // Heads the queued messages that change the work in flight (`AssistantCopy.triageAmendsHeading`).
  triageAmendsHeading: 'Changes to what I was already doing:',
  // Heads the queued messages whose request could not be made out (`AssistantCopy.queuedUnclear`).
  queuedUnclear: 'I have these, but I could not tell what they are asking for:',
  // Heads the merged order when work is already open here (`AssistantCopy.triageOrderAgainstOpen`).
  triageOrderAgainstOpen: 'Where the new work falls against what is already open here:',
  // Heads the order when nothing else is open (`AssistantCopy.triageOrderNew`).
  triageOrderNew: 'New, which I would take in this order:',
  // One arriving item in a merged order. `{label}` is the item (`AssistantCopy.triageNewItem`).
  triageNewItem: '{label} (new)',
  // An open private task's place in the order; names nothing about it (`AssistantCopy.triagePrivateTaskLabel`).
  triagePrivateTaskLabel: 'a private task (details not visible to you)',
  // The label for a queued message with no text to take one from (`AssistantCopy.triageDerivedLabel`).
  triageDerivedLabel: 'A request that arrived while the assistant was busy',
  // A count of the queue's private requests; never a person or subject. `{count}` (`AssistantCopy.queuedPrivateCount`).
  queuedPrivateCount: 'Requests I will take up privately with whoever sent them: {count}.',
  // Offers to work through outstanding clarifications. `{count}` (`AssistantCopy.clarificationsOffer`).
  clarificationsOffer: 'Earlier questions still waiting on an answer: {count}. Would you like me to work through them now?',
  // Announces it is taking outstanding clarifications up. `{count}` (`AssistantCopy.clarificationsWorkingThrough`).
  clarificationsWorkingThrough: 'Earlier questions still waiting on an answer: {count}. I have nothing else open, so I will pick them up now unless you would rather I did not.',
  // Heads the requests whose task write failed. `{count}` (`AssistantCopy.triageCouldNotRecord`).
  triageCouldNotRecord: 'Requests I could not record: {count}.',
  // Counts the failed ones that were private, without naming them. `{count}` (`AssistantCopy.triageCouldNotRecordPrivate`).
  triageCouldNotRecordPrivate: 'Private requests among them: {count}',
  // Asks for the unrecorded requests again (`AssistantCopy.triageResendLost`).
  triageResendLost: 'Please send anything listed here again.',
  // Asks whether to finish the work in flight, when triage could not tell (`AssistantCopy.triageAskInFlight`).
  triageAskInFlight: 'Before I start: do you still want me to finish what I was working on, or drop it?',
  // Closes the reading by inviting a correction (`AssistantCopy.triageInviteCorrection`).
  triageInviteCorrection: 'Tell me if you want a different order, or something dropped.',
} as const;

export type NoticeCopyKey = keyof typeof DEFAULT_NOTICE_COPY;

/**
 * WHAT A NOTICE'S VARIABLES ARE, per kind, declared in the one grammar every template field binds in (ADR-060,
 * slice 1c): a value the caller supplies is `value:<type>`; a value that is a variable source names it
 * (`person:displayName`, `conversation:title`), and one the caller supplies about an assistant is
 * `assistant:displayName`. A caller names a notice and supplies its variables; it never supplies text the assistant
 * would say. So every variable is declared, typed and capped, an undeclared one is refused, and text is stripped of
 * the markers this system reads back out of messages before it is spliced in.
 *
 * `mention` marks a person's display name in a notice the ROOM reads: it renders as an inert mention (ADR-060
 * decision 7), the one fact about a person a room message may carry. `NOTICE_AUDIENCE` says who reads the notices
 * that name a person, which is what their template's insertions are checked against.
 */
export interface NoticeVariable {
  binding: string;
  mention?: true;
}
export const NOTICE_VARIABLES: Partial<Record<NoticeCopyKey, Record<string, NoticeVariable>>> = {
  rateLimited: { minutes: { binding: 'value:id' } },
  battleModeOn: { variant: { binding: 'assistant:displayName' } },
  battleModeBriefing: { briefing: { binding: 'value:longText' } },
  conversationArchived: { who: { binding: 'person:displayName', mention: true }, date: { binding: 'value:id' } },
  memberJoined: { name: { binding: 'person:displayName', mention: true } },
  memberWelcome: {
    name: { binding: 'person:displayName' },
    recap: { binding: 'value:text' },
    title: { binding: 'conversation:title' },
    notifyPerson: { binding: 'value:arn' },
    notifySubject: { binding: 'value:text' },
  },
  briefingReady: { source: { binding: 'value:text' } },
  assistantUnavailable: { name: { binding: 'assistant:displayName' } },
  battleSideDidNotFinish: { name: { binding: 'assistant:displayName' } },
};

/** Who reads each notice that names a person: the room, or the one person it is addressed to. */
export const NOTICE_AUDIENCE: Partial<Record<NoticeCopyKey, 'room' | 'addressed'>> = {
  conversationArchived: 'room',
  memberJoined: 'room',
  memberWelcome: 'addressed',
};

/**
 * The type each notice variable is checked, capped and stripped as, derived from its binding: a `value:<type>` is
 * that type, and a named source or an assistant's name is text, as `MESSAGE_FIELD_SOURCES` types them.
 */
export type NoticeVarType = 'text' | 'longText' | 'arn' | 'id';
const noticeVarType = (binding: string): NoticeVarType => {
  const t = binding.startsWith('value:') ? binding.slice('value:'.length) : 'text';
  return (t === 'longText' || t === 'arn' || t === 'id' ? t : 'text');
};
export const NOTICE_VARS: Partial<Record<NoticeCopyKey, Record<string, NoticeVarType>>> = Object.fromEntries(
  Object.entries(NOTICE_VARIABLES).map(([kind, vars]) => [kind, Object.fromEntries(Object.entries(vars ?? {}).map(([v, d]) => [v, noticeVarType(d.binding)]))]),
);
