/**
 * THE MESSAGE AND PROMPT TEMPLATES THE PLATFORM SHIPS (ADR-062 decisions 1 and 6, build order slice 1).
 *
 * Each is a template in the document template format with `kind: message` or `kind: prompt`, `language: en`
 * and the `platform` fill, written here as its sections and declared fields and rendered to the same
 * Markdown-with-front-matter source an operator puts with `npm run template`. The shipped family is the last
 * step of selection (`message-template-selection.ts`): an assistant's own template, then the
 * classification's, then this one.
 *
 * WHAT A SHIPPED TEMPLATE SAYS IS WHAT THE PLATFORM SAID BEFORE IT WAS A TEMPLATE, word for word, so a
 * deployment that rewords nothing reads exactly what it read. Each section names the legacy `copy` key it
 * replaces (`legacy`), which is how a version's existing wording is read as the assistant's own template
 * until one is saved (decision 3), and how the console shows each line beside the shipped text.
 *
 * PURE and dependency-light, so the console imports it for its editor and preview (`backendTypeScriptSource`
 * in the admin package's Vite config), as it imports `welcome-orientation.ts`.
 */
import { DEFAULT_NOTICE_COPY, NOTICE_AUDIENCE, NOTICE_VARIABLES, type NoticeCopyKey } from './notice-copy.js';
import { parseTemplate, type MessageValueType, type ParsedTemplate } from './document-template.js';

/** One section of a shipped template: its English text and the `copy` key it replaces, where there is one. */
export interface ShippedSection {
  text: string;
  /** `memberWelcome` for a single-line copy key, `email.greeting` for a key of the `email` group. */
  legacy?: string;
}

export interface ShippedMessageEntry {
  name: string;
  kind: 'message' | 'prompt';
  description: string;
  fields: Record<string, string>;
  sections: Record<string, ShippedSection>;
  /**
   * SAID WHERE A MODEL CALL MAY BE AWAITED (ADR-062 decision 4): a targeted workflow send, so an assistant may save its own
   * `fill: voice` template of this name. Every other message is said on a path that is instant (a notice on the reply
   * path, a room welcome, a placeholder, a refusal, a fallback; SPEC-BILINGUAL-CONVERSATIONS FR8), where a `voice`
   * template is refused when saved.
   */
  voiceable?: boolean;
}

// ── The notification templates (decision 6) ────────────────────────────────────────────────────

const LINK = 'value:link';

/** The words every notice email is wrapped in, each a named part. Sends nothing of its own. */
const NOTIFICATION_EMAIL: ShippedMessageEntry = {
  name: 'notification-email',
  kind: 'message',
  description: 'The words every notice email is wrapped in: its greeting, sign-off, conversation button, reply hint and preference line',
  fields: { name: 'person:displayName', link: LINK },
  sections: {
    'email.greeting': { text: 'Hi {{name}},', legacy: 'email.greeting' },
    'email.unnamedRecipient': { text: 'there', legacy: 'email.unnamedRecipient' },
    'email.signOff': { text: 'Best regards,', legacy: 'email.signOff' },
    'email.unnamedAssistant': { text: 'Your assistant', legacy: 'email.unnamedAssistant' },
    'email.openConversation': { text: 'Open conversation', legacy: 'email.openConversation' },
    'email.viewItHere': { text: 'View it here: {{link}}', legacy: 'email.viewItHere' },
    'email.replyHint': { text: 'You can reply to this email to answer in the conversation.', legacy: 'email.replyHint' },
    'email.manageEmail': { text: 'Manage which emails you receive: {{link}}', legacy: 'email.manageEmail' },
    'email.defaultSubject': { text: 'An update from your assistant', legacy: 'email.defaultSubject' },
  },
};

/** The page a person manages their email from, reached from every email they can stop. */
const EMAIL_PREFERENCES: ShippedMessageEntry = {
  name: 'email-preferences',
  kind: 'message',
  description: 'The email preference page: its title, the label of each kind of email and its actions',
  fields: { kind: 'value:text' },
  sections: {
    'page.preferencesTitle': { text: 'Email preferences', legacy: 'email.preferencesTitle' },
    'page.preferenceKind': { text: '{{kind}}', legacy: 'email.preferenceKind' },
    'page.stopKind': { text: 'Stop these emails', legacy: 'email.stopKind' },
    'page.resumeKind': { text: 'Send these emails again', legacy: 'email.resumeKind' },
    'page.stopAll': { text: 'Stop every email I can stop', legacy: 'email.stopAll' },
    'page.saved': { text: 'Your preferences are saved.', legacy: 'email.saved' },
    'page.linkInvalid': { text: 'This link has expired or is not recognized. Use the link in a more recent email.', legacy: 'email.linkInvalid' },
    'page.expiredOffer': { text: 'This link has expired, but it can still stop the emails it came with.', legacy: 'email.expiredOffer' },
    'page.expiredStopped': { text: 'These emails are stopped.', legacy: 'email.expiredStopped' },
    'page.expiredSignIn': { text: 'To see or change your other email preferences, sign in to the app.', legacy: 'email.expiredSignIn' },
    'page.openPreferences': { text: 'Open your email preferences', legacy: 'email.openPreferences' },
    'page.transactionalNote': { text: 'Invitations and other messages you need to act on are always sent.', legacy: 'email.transactionalNote' },
    'page.kindConversation': { text: 'Messages from conversations you are in', legacy: 'email.kindConversation' },
    'page.kindConversationShared': { text: 'Someone adds you to a conversation', legacy: 'email.kindConversationShared' },
    'page.kindBriefing': { text: 'Proactive briefings', legacy: 'email.kindBriefing' },
    'page.kindAlarm': { text: 'Operational alarms', legacy: 'email.kindAlarm' },
    'page.kindNudge': { text: 'Reminders about an invitation you have not opened', legacy: 'email.kindNudge' },
    'page.kindTask': { text: 'A workflow assigns you a task', legacy: 'email.kindTask' },
  },
};

const INVITATION: ShippedMessageEntry = {
  name: 'invitation',
  kind: 'message',
  description: 'Invites a person to a conversation, with a link they use once',
  fields: { sender: 'value:text', title: 'conversation:title', link: LINK, note: 'value:longText' },
  sections: {
    'email.subject': { text: '{{sender}} invited you to a conversation', legacy: 'email.invitationSubject' },
    'email.body': { text: '{{sender}} has invited you to join the conversation "{{title}}".', legacy: 'email.invitationBody' },
    'email.openInvitation': { text: 'Open the invitation', legacy: 'email.openInvitation' },
    'email.linkLine': { text: 'Open the invitation here: {{link}}', legacy: 'email.invitationLinkLine' },
    'email.once': { text: 'The invitation can be used once. If you did not expect it, you can ignore this email.', legacy: 'email.invitationOnce' },
    'label.someone': { text: 'Someone', legacy: 'email.someone' },
    'label.untitled': { text: 'Untitled', legacy: 'email.untitled' },
    // THE REMINDER the inviter confirms when the invitation is still unopened (ADR-061, `send_nudge`): a mail the invitee
    // can stop (`nudge`), carrying a fresh link that replaces the first one.
    'email.nudgeSubject': { text: 'A reminder: {{sender}} invited you to a conversation', legacy: 'email.nudgeSubject' },
    'email.nudgeBody': { text: '{{sender}} is still hoping you will join the conversation "{{title}}".', legacy: 'email.nudgeBody' },
    'email.nudgeNote': { text: '{{note}}', legacy: 'email.nudgeNote' },
  },
};

const CLAIM: ShippedMessageEntry = {
  name: 'claim',
  kind: 'message',
  description: 'Sends a registered visitor the sign-in link that carries their conversation into their account',
  fields: { link: LINK },
  sections: {
    'email.subject': { text: 'Continue your conversation', legacy: 'email.claimSubject' },
    'email.body': {
      text: 'Thank you for registering. Sign in from the link below and your conversation continues in your account, with everything we discussed.',
      legacy: 'email.claimBody',
    },
    'email.openClaim': { text: 'Sign in and continue', legacy: 'email.openClaim' },
    'email.linkLine': { text: 'Sign in and continue here: {{link}}', legacy: 'email.claimLinkLine' },
    'email.once': { text: 'The link can be used once. If you did not register, you can ignore this email.', legacy: 'email.claimOnce' },
  },
};

const BRIEFING = (): ShippedMessageEntry => ({
  name: 'briefing',
  kind: 'message',
  description: 'Says a proactive briefing is ready, in its conversation and by email',
  fields: { source: 'value:text', date: 'value:id' },
  sections: {
    chat: { text: DEFAULT_NOTICE_COPY_REF('briefingReady'), legacy: 'briefingReady' },
    'email.subject': { text: 'Proactive briefing for {{date}}', legacy: 'email.briefingSubject' },
    'email.body': {
      text: 'A proactive briefing is ready, and a new conversation has been created for it. Open the conversation to read it and ask follow-up questions.',
      legacy: 'email.briefingBody',
    },
  },
});

/**
 * THE NAME A ROOM THE PLATFORM OPENS FOR A PURPOSE IS CREATED WITH, per kind of room (`conversation-name.ts`). A
 * conversation type's own `name` comes first, and an opening's label before the alarm and service forms; a room an event
 * opened with nothing else to go on is named by its type (`label.opened`). A person's own conversation is not named
 * here: it opens with the placeholder and is named from its first message.
 *
 * ONE STYLE FOR EVERY KIND: a short noun phrase in Title Case, the style a room named from its first message takes, that
 * says what the room is for, with the most specific context first (the alarm, then its service; the date; the type) and
 * the kind of room last. `label.openedSubject` is what such a room is about, the noun phrase a welcome says, so it carries the
 * type alone.
 */
const CONVERSATION_NAME: ShippedMessageEntry = {
  name: 'conversation-name',
  kind: 'message',
  description: 'The name a room the platform opens for a purpose is created with: a room an event opened, by its label, its alarm or its type, a visitor\'s, a continued visit\'s, a briefing\'s and the admin notification channel',
  fields: { label: 'value:text', alarm: 'value:text', service: 'value:text', date: 'value:id', type: 'value:text' },
  sections: {
    'label.event': { text: '{{label}}' },
    'label.alarm': { text: '{{alarm}} Alarm' },
    'label.alarm.service': { text: '{{alarm}} Alarm on {{service}}' },
    'label.opened': { text: '{{type}} Room' },
    'label.openedSubject': { text: '{{type}}' },
    'label.visitor': { text: 'Visitor Chat' },
    'label.customer': { text: 'Continued Visitor Chat' },
    'label.briefing': { text: '{{date}} Briefing' },
    'label.adminNotifications': { text: 'Admin Notifications' },
  },
};

const MEMBER_WELCOME = (): ShippedMessageEntry => ({
  name: 'member-welcome',
  kind: 'message',
  description: 'Tells a person, privately, that they were added to a conversation, and emails it to them',
  fields: { name: 'person:displayName', recap: 'value:text', title: 'conversation:title' },
  sections: {
    chat: { text: DEFAULT_NOTICE_COPY_REF('memberWelcome'), legacy: 'memberWelcome' },
    'email.subject': { text: "You've been added to {{title}}" },
  },
});

/** The label a task notice names a task by when its details carry none. */
const TASK_LABELS: Record<string, ShippedSection> = {
  'label.actionItem': { text: 'an action item' },
  'label.workItem': { text: 'a work item' },
  'label.item': { text: 'an item' },
};
const TASK_FIELDS = { what: 'value:text', dueBy: 'value:id' };

const TASK_ASSIGNED: ShippedMessageEntry = {
  name: 'task-assigned',
  kind: 'message',
  description: 'Tells a person a work item is theirs to act on, in the conversation and by email',
  fields: TASK_FIELDS,
  sections: {
    chat: { text: "You're down to handle {{what}}[[ by {{dueBy}}]]. Open the conversation and I'll walk you through the steps — I'll keep the details with the work item." },
    'email.subject': { text: "You're set to handle {{what}}" },
    ...TASK_LABELS,
  },
};

/**
 * A TASK A WORKFLOW STEP ASSIGNED (ADR-063 decision 2): told privately to the person who holds its first step, with the
 * task's card beside it when the step offers choices, and emailed to them as a `task` notice they can mute.
 */
const WORKFLOW_TASK_ASSIGNED: ShippedMessageEntry = {
  name: 'workflow-task-assigned',
  kind: 'message',
  description: 'Tells a person privately that a workflow assigned them a task, in the conversation and by email',
  fields: { name: 'person:displayName' },
  sections: {
    chat: { text: 'There is a task for you here[[, {{name}}]]. Answer it below, or reply in this conversation.' },
    'email.subject': { text: 'A task is waiting for you' },
  },
};

/**
 * WHAT AN IDLE ASSISTANT IS ASKED WHEN IT TAKES UP A TASK ASSIGNED TO IT (ADR-063 decision 5). The step's own instructions
 * are the task state's prompt, already in the turn's system prompt; this is the one line that starts the turn, with no
 * person's message. An assistant or its classification saves its own of this name to change it.
 */
const TASK_PICKUP: ShippedMessageEntry = {
  name: 'task-pickup',
  kind: 'prompt',
  description: 'What an idle assistant is asked when it takes up a task assigned to it, with nobody having written to it',
  fields: {},
  sections: {
    prompt: {
      text: 'Take up the current step of your task now, on your own: do the work its instructions describe, then advance the '
        + 'task with the task tool when the step is done. Nobody has written to you; post only what the people this task '
        + 'concerns should read, and keep it short.',
    },
  },
};

// ── The keyed lines and the code literals (decision 6, build order slice 2) ───────────────────

/** A message with one chat line, worded by a legacy \`copy\` key where the version had one. */
const line = (name: string, description: string, text: string, legacy?: string, fields: Record<string, string> = {}): ShippedMessageEntry => ({
  name, kind: 'message', description, fields, sections: { chat: { text, ...(legacy ? { legacy } : {}) } },
});

/** A message whose line has a form per count: \`one\` and \`other\`, and \`none\` where none is its own case. */
const counted = (name: string, description: string, forms: { none?: string; one: string; other: string }, legacy?: string, fields: Record<string, string> = {}): ShippedMessageEntry => ({
  name, kind: 'message', description, fields: { count: 'value:count', ...fields },
  sections: Object.fromEntries(Object.entries(forms).filter(([, t]) => t !== undefined)
    .map(([form, text]) => [`chat.${form}`, { text: text as string, ...(legacy ? { legacy } : {}) }])),
});

const COUNT = { count: 'value:count' };

const SLICE_2 = (): ShippedMessageEntry[] => [
  // The queue (`turn-queue-notice.ts`).
  line('queued-one', 'Says one message is waiting behind the answer in progress', 'Still working on your earlier message. I will read this one as soon as it is done.', 'queuedOne', COUNT),
  line('queued-many', 'Says several messages are waiting behind the answer in progress', 'Still working on your earlier message. I will read all {{count}} of these when it is done.', 'queuedMany', COUNT),
  line('queued-overflow', 'Says the queue was full and the oldest waiting message was dropped', 'I am still working on your last message. I am holding your newest ones, but I had to drop the oldest one that was waiting - please send it again if you still need it.', 'queuedOverflow', COUNT),
  counted('queue-settled', 'Says the waiting messages have been read', { none: 'Caught up.', one: 'Caught up - I have read that message.', other: 'Caught up - I have read those {{count}} messages.' }, 'queueSettled'),
  line('queue-write-failed', 'Says a message could not be held in the queue and asks for it again', 'Something went wrong holding on to that message, so it is not waiting and I will not get to it. Please send it again.', 'queueWriteFailed'),
  line('turn-already-owed', 'Says an answer on this work is already on its way', "I'm still working on that - I'll post it here when it's ready. Send `/stop` if you want to cancel it, or ask me about something else and I will pick that up instead."),
  line('turn-error', 'Said when a turn fails before it starts', 'I encountered an issue. Could you try rephrasing?'),
  // Stop (`router-agent-handler.ts`).
  line('stop-must-be-public', 'Says a stop sent privately in a group was not carried out', 'Nothing has been stopped. A stop pauses me for everyone in this conversation, so send /stop to the whole conversation rather than privately.', 'stopMustBePublic'),
  line('stop-ambiguous', 'Says a stop named no assistant in a room with several', 'There is more than one assistant working here, so I have not stopped anything yet. Mention the one you want to stop and send `/stop` again.', 'stopAmbiguous'),
  counted('stop-cancel-failed', 'Says a stop could not cancel the work in progress', { one: 'Stopped, but I could not cancel that. Send /stop again to try once more.', other: 'Stopped, but I could not cancel those {{count}}. Send /stop again to try once more.' }, 'stopCancelFailed'),
  line('stop-nothing-to-stop', 'Says there was nothing to stop', "There's nothing in progress here to stop.", 'stopNothingToStop'),
  counted('stopped', 'Says the work was cancelled and a question follows', { one: "Stopped, and I've cancelled that. I'll ask how you want to proceed.", other: "Stopped, and I've cancelled those {{count}}. I'll ask how you want to proceed." }, 'stopped'),
  counted('stop-cancelled-but-not-asked', 'Says the work was cancelled when no question could be arranged', { one: "Stopped, and I've cancelled that. Ask me again whenever you want it.", other: "Stopped, and I've cancelled those {{count}}. Ask me again whenever you want it." }, 'stopCancelledButNotAsked'),
  line('stop-left-cancelled', 'Confirms cancelled work stays cancelled', 'All right, it stays cancelled.', 'stopLeftCancelled'),
  line('turn-stopped', 'Replaces the answer in progress when a stop arrived while it was being written', 'Stopped - I did not finish that.'),
  // Handover between assistants (`router-agent-handler.ts`).
  line('handover-owner-unavailable', 'Says the assistant that owns the work could not be reached', "That answers work {{name}} is handling, and I couldn't reach them just now, so I haven't answered in their place. Send it again in a moment and I will pass it along.", 'handoverOwnerUnavailable', { name: 'assistant:displayName' }),
  line('handover-receipt', 'Says a message answering another assistant\'s work was passed to it', 'Thanks - that answers work {{name}} is handling, so I have passed it along. Their reply will follow in the conversation.', undefined, { name: 'assistant:displayName' }),
  line('handed-to-roommate', 'Says a new question was passed to the assistant it belongs to', "That one is {{name}}'s - I have passed it along, and their reply will follow here.", undefined, { name: 'assistant:displayName' }),
  {
    name: 'roommates-ambiguous',
    kind: 'message',
    description: 'Says more than one assistant here can help, and names them',
    fields: { names: 'value:longText' },
    sections: {
      chat: { text: 'More than one assistant here can help with that: {{names}}. Address whichever you want with an @ mention and they will pick it up.' },
      'label.and': { text: 'and' },
    },
  },
  line('handover-unresolved', 'Said by an assistant handed a question it could not read', 'This came to me but I could not pick up the question - could you ask it again here and I will take it from there?'),
  // Conversations and work items.
  line('split-refused', 'Says subjects could not be moved to conversations of their own', 'I could not open a separate conversation for: {{subjects}}. They are still here, and you can ask me to try again.', 'splitRefused', { subjects: 'value:longText' }),
  line('topic-moved', 'Says a subject moved to its own conversation', 'Moved {{title}} to its own conversation. This one stays open for anything else.', 'topicMoved', { title: 'value:longText' }),
  line('task-ref-not-found', 'Says a reference names no item waiting on the person, and lists the ones that do', "I couldn't find #{{ref}} among the items waiting on you here. Start your reply with one of these:\n{{items}}", 'taskRefNotFound', { ref: 'value:count', items: 'value:longText' }),
  line('task-ref-nothing-open', 'Says a reference names no item, and nothing is open for the person', "I couldn't find #{{ref}} among the items waiting on you here, and nothing else is open for you right now.", 'taskRefNothingOpen', { ref: 'value:count' }),
  line('task-ref-hint', 'Tells a person which reference to start a reply with', 'Start your reply with #{{ref}} so I know it answers this one.', 'taskRefHint', { ref: 'value:count' }),
  {
    name: 'task-still-open',
    kind: 'message',
    description: 'Says work advanced this turn and is not finished',
    fields: { state: 'value:text', next: 'value:longText' },
    sections: {
      chat: { text: 'This is still open: it is at {{state}} now, and {{next}} comes next.', legacy: 'taskStillOpen' },
      'label.or': { text: 'or' },
    },
  },
  // Private requests and resumed work.
  line('answered-privately', 'Says the reply went to the person privately', 'I have replied to you privately.', 'answeredPrivately'),
  line('addressing-privately', 'What the room sees while private requests are handled', 'Addressing private requests.', 'addressingPrivately'),
  counted('private-follow-up', 'Asks a person, privately, how to handle their private requests', { one: 'About your private request: {{labels}}. Tell me how you would like me to handle this.', other: 'About your private requests: {{labels}}. Tell me how you would like me to handle these.' }, 'privateFollowUp', { labels: 'value:longText' }),
  line('resumed-chain-answered', 'The receipt for an answer that picked up waiting work, when the turn answered', 'Thanks - picking that back up. My answer is in the conversation.', 'resumedChainAnswered'),
  line('resumed-chain-asked', 'The receipt for an answer that picked up waiting work, when the turn asked something', 'Thanks - picking that back up. I have asked you something in the conversation.', 'resumedChainAsked'),
  line('attachment-too-large-to-read', 'Says an attached file was too large to read', 'I could not read the file you attached: it is larger than I can take in. Everything below answers your message without it. A smaller version, or the part that matters as text, and I can read it.', 'attachmentTooLargeToRead', { name: 'value:text' }),
  // The guardrail's own message stands first; this is said when it returns none, and names nothing it refused.
  line('input-guardrail-fallback', 'Said when the input guardrail refused a message and gave no message of its own', 'I cannot process that request. Please rephrase your message.'),
  // Placeholders (`delivery-options.ts`): a workflow state's declared `placeholder` comes first.
  {
    name: 'task-placeholder',
    kind: 'message',
    description: 'The placeholder a reply in progress shows, by workflow and step',
    fields: {},
    sections: {
      chat: { text: 'One moment...' },
      'label.task_update_in_place': { text: 'Analyzing...' },
      'label.task_multi_step': { text: 'Working on that...' },
      'label.guided_troubleshooting': { text: 'Looking into that...' },
      'label.guided_troubleshooting.collecting_symptoms': { text: 'Let me understand the issue...' },
      'label.guided_troubleshooting.diagnosing': { text: 'Analyzing the problem...' },
      'label.guided_troubleshooting.proposing_solutions': { text: 'Finding solutions...' },
      'label.data_extraction': { text: 'Processing your request...' },
      'label.data_extraction.collecting_requirements': { text: 'Understanding your data needs...' },
      'label.data_extraction.extracting': { text: 'Extracting data...' },
      'label.data_extraction.validating': { text: 'Validating results...' },
      'label.report_generation': { text: 'Working on the report...' },
      'label.report_generation.collecting_requirements': { text: 'Understanding your report needs...' },
      'label.report_generation.drafting_outline': { text: 'Drafting outline...' },
      'label.report_generation.generating': { text: 'Generating report...' },
    },
  },
  // Quick replies, chosen by the intent the classifier returned (decision 7).
  line('quick-greeting', 'The reply to a greeting', 'Hey, what can I help you with?'),
  {
    name: 'quick-acknowledgment',
    kind: 'message',
    description: 'The reply to an acknowledgment, by the kind the classifier returned',
    fields: {},
    sections: {
      chat: { text: 'Let me know if you have other questions.' },
      'chat.thanks': { text: 'Happy to help. Let me know if you have other questions.' },
      'chat.farewell': { text: 'Goodbye! Feel free to reach out anytime.' },
    },
  },
  // Drift (composed by the router from the template drift detection names).
  line('drift-offer', 'Offers to move a new subject to a conversation of its own', "It looks like you're shifting topics. Want me to start a separate conversation for this so we keep both threads clean? Reply 'yes' to create one, or anything else to keep going here."),
  line('drift-redirect-offer', 'Offers to go to the conversation a subject was covered in', "It looks like you're shifting to something we covered in another conversation. Want me to take you there? Reply 'yes' to switch, or 'no' to keep going here."),
  {
    name: 'drift-created',
    kind: 'message',
    description: 'Says the new conversation was created; its link follows',
    fields: {},
    sections: { chat: { text: "Done — I've created a new conversation." }, 'label.link': { text: 'Drift Follow-up' } },
  },
  {
    name: 'drift-redirected',
    kind: 'message',
    description: 'Says the person is being taken to the earlier conversation; its link follows',
    fields: {},
    sections: { chat: { text: 'Taking you there.' }, 'label.link': { text: 'Existing conversation' } },
  },
  {
    name: 'drift-battle-refusal',
    kind: 'message',
    description: 'Says a subject cannot be moved while a battle runs, and how to end it',
    fields: {},
    sections: {
      'chat.starter': { text: "I can't split that off while a battle is running here - moving you across would leave the battle behind. Send `/battle end` to end the battle, and anything it was collecting, or tell me again once it finishes and I will move it across." },
      'chat.member': { text: "I can't split that off while a battle is running here - moving you across would leave the battle behind. Whoever started the battle can end it, or a moderator can turn Battle Mode off, or tell me again once it finishes and I will move it across." },
    },
  },
  // The refusal of a capability the conversation does not offer (`capability-refusal.ts`).
  {
    name: 'capability-refusal',
    kind: 'message',
    description: 'Says what this conversation does not do, and where the person can get it',
    fields: { output: 'value:text' },
    sections: {
      'chat.unavailable': { text: "I don't produce {{output}} in this conversation.", legacy: 'capabilityUnavailable' },
      'chat.notOffered': { text: "That isn't something I do in this conversation.", legacy: 'capabilityNotOffered' },
      'chat.hasAccess': { text: 'You have access to conversations that do:', legacy: 'capabilityHasAccess' },
      'chat.hasAccessClose': { text: 'Start a new conversation there and ask again.', legacy: 'capabilityHasAccessClose' },
      'chat.needsAccess': { text: 'If you need {{output}}, ask your administrator for access.', legacy: 'capabilityNeedsAccess' },
      'chat.notOfferedNeedsAccess': { text: 'If you need it, ask your administrator for access.', legacy: 'capabilityNotOfferedNeedsAccess' },
      'label.document': { text: 'report documents', legacy: 'capabilityOutputDocument' },
      'label.image': { text: 'images', legacy: 'capabilityOutputImage' },
    },
  },
  // The stage a queue being worked is shown at (`turn-queue-status.ts`).
  {
    name: 'queue-status',
    kind: 'message',
    description: 'The stage shown while the messages that arrived during an answer are worked through',
    fields: {},
    sections: {
      'label.waiting': { text: 'Waiting', legacy: 'queueStatus.waiting' },
      'label.reviewing': { text: 'Reviewing what arrived', legacy: 'queueStatus.reviewing' },
      'label.clarifying': { text: 'Checking what you meant', legacy: 'queueStatus.clarifying' },
      'label.addressing_private': { text: 'Addressing private requests', legacy: 'queueStatus.addressing_private' },
      'label.clearing': { text: 'Clearing the queue', legacy: 'queueStatus.clearing' },
      'label.settled': { text: 'Done', legacy: 'queueStatus.settled' },
    },
  },
  // Onboarding (`onboarding-intake.ts`); a deployment's intake configuration words its greeting and completion first.
  {
    name: 'onboarding-intake',
    kind: 'message',
    description: 'The lines that frame an onboarding intake: the greeting, corrections, the summary and the completion',
    fields: { example: 'value:text', name: 'person:displayName' },
    sections: {
      'chat.greeting': { text: 'Welcome! I just need a few details before we begin.' },
      'chat.redo': { text: "No problem — let's redo it." },
      'chat.confirmAgain': { text: 'Please reply "yes" to confirm or "no" to start over.' },
      'chat.required': { text: 'That one is required.' },
      'chat.invalid': { text: "That doesn't look right[[ (for example: {{example}})]]." },
      'chat.summary': { text: 'Here is what I have:' },
      'chat.confirm': { text: 'Is this correct? (yes / no)' },
      'chat.complete': { text: "Thanks[[, {{name}}]] — you're all set. How can I help?" },
      'label.skipped': { text: '(skipped)' },
    },
  },
];

// ── The prompt templates ADR-061's first slice needs ──────────────────────────────────────────

/**
 * The request a join recap answers. What the MODEL reads, not what the room reads: the assistant answers it
 * in its own voice and the conversation's language. Written as a plain request rather than a contract of
 * instructions, because the input guardrail screens a turn's message and its prompt-attack filter fires on
 * instruction-shaped scaffolding (`turn-triage.ts`, `stop-evaluation.ts`).
 */
const JOIN_RECAP: ShippedMessageEntry = {
  name: 'join-recap',
  kind: 'prompt',
  description: 'What the room\'s assistant is asked when a person joins: catch them up on the conversation',
  fields: {},
  sections: {
    prompt: {
      text: 'The person you are answering has just joined this conversation and cannot see what came before. '
        + 'Catch them up in a few sentences: what the conversation is about, where it stands now, and anything '
        + 'that was decided or is still open. If nothing has been discussed yet, say so briefly.',
      legacy: 'joinRecapRequest',
    },
  },
};

/**
 * The instructions a `prompt` welcome runs from when a version names this one (SPEC-WELCOME-AND-CONTEXT FR24): what
 * the joining assistant is asked after its opening is already in the room. Its fields reach the model as data.
 */
const WELCOME_GREETING: ShippedMessageEntry = {
  name: 'welcome-greeting',
  kind: 'prompt',
  description: 'What the joining assistant is asked after its opening, in a prompt welcome',
  fields: { topic: 'value:text', event: 'value:longText', people: 'value:longText', role: 'value:text' },
  sections: {
    prompt: {
      text: 'You have just joined this conversation, and your opening is already posted above. Follow it with a short, '
        + 'specific greeting for the people here: say what you can help them with in this conversation, drawing on the '
        + 'company documents and context you can read and on the data below. Address people by name where the data names '
        + 'them. Do not repeat the opening, do not ask more than one question, and keep it to a few sentences.',
    },
  },
};

// ── The platform's event workflows (ADR-061, slice 1, `event-workflow.ts`) ───────────────────────────
//
// Each step's words, which an assistant replaces with its own as it does any message.

const OPS_ROOM_OPENING: ShippedMessageEntry = {
  name: 'ops-room-opening',
  kind: 'message',
  description: 'The ops room\'s opening, posted when an event opens it',
  fields: { label: 'value:text', lead: 'person:displayName' },
  sections: {
    chat: { text: 'This room is open for {label}.\n[[{{lead}} is leading it.]]\nThe ops assistant reads the deployment\'s health and posts its first look here.' },
  },
};

const OPS_LEAD_WELCOME: ShippedMessageEntry = {
  name: 'ops-lead-welcome',
  kind: 'message',
  voiceable: true,
  description: 'Told privately to the person an ops room was opened for',
  fields: { label: 'value:text' },
  sections: {
    chat: { text: 'This room was opened for you, for {label}. Everyone the ops team admits can join it, and the ops assistant posts the deployment\'s health here.' },
  },
};

/**
 * THE OPS ROOM'S FIRST LOOK: what the ops assistant is asked once the room is open (ADR-061 example (a)). The
 * shipped default; an assistant or its classification saves its own of this name to change it.
 */
const OPS_FIRST_LOOK: ShippedMessageEntry = {
  name: 'ops-first-look',
  kind: 'prompt',
  description: 'What the ops assistant is asked when an event opens an ops room: a first look at the deployment\'s health',
  fields: { label: 'value:text', lead: 'value:text' },
  sections: {
    prompt: {
      text: 'An event has just opened this ops room, and the room\'s opening is already posted above. Read the '
        + 'deployment\'s health with the tool you have, then post a short first look for the people here: which '
        + 'alarms are firing or recently changed state, what they point at, and the one thing worth checking first. '
        + 'Say plainly when the health read shows nothing wrong or could not be read. Do not guess at causes the '
        + 'data does not show, and keep it to a few short lines.',
    },
  },
};

const OPS_FIRST_LOOK_UNAVAILABLE: ShippedMessageEntry = {
  name: 'ops-first-look-unavailable',
  kind: 'message',
  description: 'Posted in the ops room when the first look could not be made',
  fields: {},
  sections: {
    chat: { text: 'The deployment\'s health could not be read just now. Ask the ops assistant to check it when you are ready.' },
  },
};

/**
 * SAID WHEN NO OPS ASSISTANT IS IN THE ROOM to read the deployment's health (`as: { role: 'ops' }`, ADR-061 decision 1).
 * Reading it is the ops assistant's grant alone, so the room's primary says plainly that nobody here has read it.
 */
const OPS_ASSISTANT_ABSENT: ShippedMessageEntry = {
  name: 'ops-assistant-absent',
  kind: 'message',
  description: 'Posted in the ops room when no ops assistant is in it to read the deployment\'s health',
  fields: {},
  sections: {
    chat: { text: 'No ops assistant is in this room, so nobody here has read the deployment\'s health. Reading it is the ops assistant\'s alone; once one is added to the room, ask it to check.' },
  },
};

/** Said privately to a person who joined when the join recap could not be written (ADR-061 decision 5). */
const JOIN_RECAP_UNAVAILABLE: ShippedMessageEntry = {
  name: 'join-recap-unavailable',
  kind: 'message',
  description: 'Told privately to a person who joined when the catch-up on the conversation could not be written',
  fields: {},
  sections: {
    chat: { text: 'Welcome. I could not write a catch-up on this conversation just now; the messages above are the whole of it, and I can summarize them when you ask.' },
  },
};

// ── The incident watch (ADR-061 slice 5): the alarm an ops room watches changed state ────────────────

const INCIDENT_ALARM_CHANGED: ShippedMessageEntry = {
  name: 'incident-alarm-changed',
  kind: 'message',
  description: 'Posted in the ops room when the alarm it watches changes state',
  fields: { alarm: 'value:text', alarmState: 'value:text' },
  sections: {
    chat: { text: "The alarm this room is watching, {alarm}, is now {alarmState}. The ops assistant reads the deployment's health again and says what changed." },
  },
};

/** What the ops assistant is asked when the alarm its room watches changes state: what changed since the room last looked. */
const OPS_INCIDENT_RECHECK: ShippedMessageEntry = {
  name: 'ops-incident-recheck',
  kind: 'prompt',
  description: 'What the ops assistant is asked when the alarm its room watches changes state: read the health again and say what changed',
  fields: { alarm: 'value:text', alarmState: 'value:text' },
  sections: {
    prompt: {
      text: "The alarm this ops room is watching has changed state, as the message above says. Read the deployment's "
        + 'health again with the tool you have, compare it with what was said in this room before, and post a short '
        + 'update: what changed, what it points at now, and whether the incident looks to be recovering or spreading. '
        + 'Say plainly when the health read could not be made, and do not guess at causes the data does not show.',
    },
  },
};

// ── An invitation nobody has opened, and the proposals an agent step offers (ADR-061 decision 8) ─────

/** What the assistant is asked when an invitation is still unopened at its deadline: a reminder the inviter confirms. */
const INVITATION_NUDGE_DRAFT: ShippedMessageEntry = {
  name: 'invitation-nudge-draft',
  kind: 'prompt',
  description: 'What the assistant is asked when an invitation is still unopened at its deadline: a short reminder for the invitee, which the inviter confirms before it is emailed',
  fields: { invitee: 'value:text', inviter: 'value:text', title: 'value:text', reason: 'value:longText' },
  sections: {
    prompt: {
      text: 'An invitation to a conversation has not been opened yet. Write a short, friendly note of two or three '
        + 'sentences, from the person who sent the invitation to the person invited, encouraging them to open it. '
        + "Use only the names, the conversation's title and the reason given here. Do not include a link, an email "
        + "address or any instructions; the platform adds the invitation's link. Reply with the note alone.",
    },
  },
};

/** Told privately to the inviter: the reminder the assistant drafted, which they confirm or decline. */
const INVITATION_NUDGE_PROPOSAL: ShippedMessageEntry = {
  name: 'invitation-nudge-proposal',
  kind: 'message',
  description: 'Told privately to an inviter whose invitation is still unopened: a drafted reminder they confirm before it is emailed',
  fields: { invitee: 'value:text', draft: 'value:longText' },
  sections: {
    chat: { text: '[[{{invitee}} has not opened your invitation yet. ]]I drafted a reminder you can send them:\n\n{{draft}}\n\nEnter their email address and confirm to send it, or decline.' },
  },
};

/** Told privately to the inviter when no reminder could be drafted. */
const INVITATION_UNREDEEMED_REMINDER: ShippedMessageEntry = {
  name: 'invitation-unredeemed-reminder',
  kind: 'message',
  description: 'Told privately to an inviter whose invitation is still unopened, when no reminder could be drafted',
  fields: { invitee: 'value:text' },
  sections: {
    chat: { text: "[[{{invitee}} has not opened your invitation yet. ]]You can revoke it and invite them again from the conversation's invitations." },
  },
};

/** Told privately to the person a proposal to open a conversation is addressed to. */
const OPEN_CONVERSATION_PROPOSAL: ShippedMessageEntry = {
  name: 'open-conversation-proposal',
  kind: 'message',
  description: 'Told privately to the person an agent step proposes to open a conversation for, which they confirm or decline',
  fields: { draft: 'value:text' },
  sections: {
    chat: { text: 'I can open a new conversation for you[[: {{draft}}]]. Confirm to open it, or decline.' },
  },
};

const WORKFLOW_OPENING: ShippedMessageEntry = {
  name: 'workflow-opening',
  kind: 'message',
  description: 'A workflow welcome\'s opening, posted to the room when the assistant joins',
  fields: { topic: 'value:text', role: 'value:text' },
  sections: {
    chat: { text: 'Hi, I\'m here to help.\n[[This conversation is about {{topic}}.]]' },
  },
};

const WORKFLOW_SUBJECT_WELCOME: ShippedMessageEntry = {
  name: 'workflow-subject-welcome',
  kind: 'message',
  voiceable: true,
  description: 'Told privately to the person a conversation was opened for, after a workflow welcome\'s opening',
  fields: { name: 'person:displayName' },
  sections: {
    chat: { text: 'Welcome[[, {{name}}]]. Ask me anything when you are ready.' },
  },
};

// ── The notices the router says ───────────────────────────────────────────────────────────────

/** A notice key's shipped line, read when the catalog is first built (the notice table is its source). */
function DEFAULT_NOTICE_COPY_REF(key: NoticeCopyKey): string {
  return DEFAULT_NOTICE_COPY[key];
}

/** Notice keys whose line is a section of a wider template rather than a template of its own. */
const NOTICE_HOMES: Partial<Record<NoticeCopyKey, string>> = { memberWelcome: 'member-welcome', briefingReady: 'briefing' };

/** `battleNeedsPrompt` -> `battle-needs-prompt`. */
export function noticeTemplateName(key: NoticeCopyKey): string {
  return NOTICE_HOMES[key] ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Who reads a named message, which a condition choosing its template is held to (ADR-060 decision 7): a notice's declared
 * audience (`NOTICE_AUDIENCE`), else the room, the audience that permits least. Validation and the console read this one rule.
 */
export function messageAudience(message: string): 'room' | 'addressed' {
  const kind = (Object.keys(NOTICE_AUDIENCE) as NoticeCopyKey[]).find((k) => noticeTemplateName(k) === message);
  return (kind ? NOTICE_AUDIENCE[kind] : undefined) ?? 'room';
}

/** The binding of a notice's placeholder: its declaration (`NOTICE_VARIABLES`), else the type its name has always carried. */
function noticeFieldBinding(key: NoticeCopyKey, field: string): string {
  const declared = NOTICE_VARIABLES[key]?.[field]?.binding;
  if (declared) return declared;
  const byName: Record<string, MessageValueType> = { count: 'count', label: 'longText' };
  return `value:${byName[field] ?? 'text'}`;
}

function noticeEntry(key: NoticeCopyKey): ShippedMessageEntry {
  const text = DEFAULT_NOTICE_COPY[key];
  const placeholders = [...new Set([...text.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]))];
  return {
    name: noticeTemplateName(key),
    kind: 'message',
    description: `The line the assistant says for \`${key}\``,
    fields: Object.fromEntries(placeholders.map((f) => [f, noticeFieldBinding(key, f)])),
    sections: { chat: { text, legacy: key } },
  };
}

// ── The catalog ────────────────────────────────────────────────────────────────────────────────

/** A shipped template, parsed, with its source. */
export interface ShippedMessageTemplate {
  entry: ShippedMessageEntry;
  source: string;
  template: ParsedTemplate;
}

/** `{name}` naming a declared field, and not already inside `{{...}}`. */
const SINGLE_BRACE = /(?<!\{)\{([A-Za-z][A-Za-z0-9_]*)\}(?!\})/g;

/** The Markdown-with-front-matter source of a shipped entry, the format `npm run template` puts. */
export function shippedMessageSource(entry: ShippedMessageEntry): string {
  const front = { kind: entry.kind, name: entry.name, description: entry.description, language: 'en', fields: entry.fields };
  const body = Object.entries(entry.sections)
    .map(([section, s]) => `# ${section}\n${s.text.replace(SINGLE_BRACE, (m, f: string) => (f in entry.fields ? `{{${f}}}` : m))}\n`)
    .join('\n');
  return `---\n${JSON.stringify(front)}\n---\n${body}`;
}

let catalog: Map<string, ShippedMessageTemplate> | undefined;

/**
 * Every shipped message and prompt template, by name, in the order the console lists them. Built once, on
 * first use, and parsed, so a shipped template that the store would refuse fails its first reader and the
 * catalog's test rather than a send.
 */
export function shippedMessageTemplates(): Map<string, ShippedMessageTemplate> {
  if (catalog) return catalog;
  const notices = (Object.keys(DEFAULT_NOTICE_COPY) as NoticeCopyKey[]).filter((k) => !NOTICE_HOMES[k]).map(noticeEntry);
  const entries = [
    NOTIFICATION_EMAIL, EMAIL_PREFERENCES, MEMBER_WELCOME(), INVITATION, CLAIM, BRIEFING(), CONVERSATION_NAME,
    TASK_ASSIGNED, WORKFLOW_TASK_ASSIGNED, TASK_PICKUP, JOIN_RECAP, WELCOME_GREETING, OPS_ROOM_OPENING, OPS_LEAD_WELCOME, OPS_FIRST_LOOK, OPS_FIRST_LOOK_UNAVAILABLE, OPS_ASSISTANT_ABSENT, WORKFLOW_OPENING, WORKFLOW_SUBJECT_WELCOME,
    JOIN_RECAP_UNAVAILABLE, INCIDENT_ALARM_CHANGED, OPS_INCIDENT_RECHECK,
    INVITATION_NUDGE_DRAFT, INVITATION_NUDGE_PROPOSAL, INVITATION_UNREDEEMED_REMINDER, OPEN_CONVERSATION_PROPOSAL, ...SLICE_2(), ...notices,
  ];
  const out = new Map<string, ShippedMessageTemplate>();
  for (const entry of entries) {
    if (out.has(entry.name)) throw new Error(`shipped-message-templates: two entries declare "${entry.name}"`);
    const source = shippedMessageSource(entry);
    out.set(entry.name, { entry, source, template: parseTemplate(source) });
  }
  catalog = out;
  return out;
}

/** Whether a message the platform ships may be said in the assistant's voice: its call site may await a model. */
export function voiceAllowed(name: string): boolean {
  return shippedMessageTemplates().get(name)?.entry.voiceable === true;
}

/** One shipped template, parsed. Throws for a name the platform does not ship. */
export function shippedMessageTemplate(name: string): ParsedTemplate {
  const t = shippedMessageTemplates().get(name);
  if (!t) throw new Error(`the platform ships no message template "${name}"`);
  return t.template;
}

/**
 * A shipped template's source with some sections' text replaced (each in `{{field}}` form): what an assistant's
 * rewording starts from, its legacy lines included, in the format the store takes.
 */
export function shippedSourceWith(name: string, sections: Record<string, string>): string {
  const t = shippedMessageTemplates().get(name);
  if (!t) throw new Error(`the platform ships no message template "${name}"`);
  const next: Record<string, ShippedSection> = {};
  for (const [section, s] of Object.entries(t.entry.sections)) next[section] = { ...s, text: sections[section] ?? t.template.messageSections?.[section] ?? s.text };
  return shippedMessageSource({ ...t.entry, sections: next });
}

/**
 * Where a legacy `copy` key's wording now lives: the template and the section. `email.<key>` names a key of
 * the `email` group. Undefined for a key that has no template yet (ADR-062 build order slice 2).
 */
export function legacyHomeOf(copyKey: string): { name: string; section: string } | undefined {
  for (const [name, t] of shippedMessageTemplates()) {
    for (const [section, s] of Object.entries(t.entry.sections)) if (s.legacy === copyKey) return { name, section };
  }
  return undefined;
}

/**
 * The legacy lines a version's `copy` holds for one template, by section. A blank or non-string value is
 * not a wording, so it is not read.
 */
export function legacyLinesOf(name: string, copy: Record<string, unknown> | undefined | null): Record<string, string> {
  const t = shippedMessageTemplates().get(name);
  if (!t || !copy || typeof copy !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [section, s] of Object.entries(t.entry.sections)) {
    if (!s.legacy) continue;
    // `<group>.<key>` names a key of a grouped copy field (`email`, `queueStatus`); a bare key a single line.
    const dot = s.legacy.indexOf('.');
    const group = dot > 0 ? (copy as Record<string, unknown>)[s.legacy.slice(0, dot)] : undefined;
    const raw = dot > 0
      ? (group && typeof group === 'object' ? (group as Record<string, unknown>)[s.legacy.slice(dot + 1)] : undefined)
      : (copy as Record<string, unknown>)[s.legacy];
    if (typeof raw === 'string' && raw.trim()) out[section] = t.entry.kind === 'prompt' ? raw.trim() : raw;
  }
  return out;
}
