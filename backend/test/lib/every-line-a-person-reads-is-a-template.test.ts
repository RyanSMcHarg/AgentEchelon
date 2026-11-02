/**
 * EVERY LINE A PERSON READS IS A MESSAGE TEMPLATE (ADR-062 decisions 6 and 7, build order slice 2).
 *
 * The 26 keyed lines that had no shipped text in the console, and the lines that were literals in code (the
 * handover receipts, the roommate question, the placeholders, the quick replies, drift, the guardrail fallback,
 * onboarding), are shipped templates. Each says word for word what the code said before, with the old composition
 * kept here as the oracle; a version's retired `copy` line no longer words it; a template stored for the assistant
 * reaches it through the set a turn reads once; a count chooses a CLDR plural form; and a quick reply is chosen by
 * the intent and the acknowledgment kind the classifier recorded, never by the person's words.
 */
import { templateLine, withMessageTemplates, pluralCategory, shippedLineText, type MessageTemplateSet } from '../../lambda/src/lib/message-lines';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { parseTemplate } from '../../lambda/src/lib/document-template';
import { noticeText } from '../../lambda/src/lib/turn-queue-notice';
import { formatReferenceNotFound, taskStillOpenLine, taskRefHintLine } from '../../lambda/src/lib/task-reference';
import { resumedChainReceipt, ANSWERED_PRIVATELY } from '../../lambda/src/lib/resumed-chain-delivery';
import { attachmentTooLargeLine } from '../../lambda/src/lib/attachment-budget';
import { addressingPrivatelyLine } from '../../lambda/src/lib/turn-private-followup';
import { topicMovedLink } from '../../lambda/src/lib/channel-creation';
import { quickReply, getTaskPlaceholder, DeliveryOption } from '../../lambda/src/lib/delivery-options';
import { fastPathIntent } from '../../lambda/src/lib/intent-classifier';
import { noticeLine } from '../../lambda/src/lib/assistant-notice';
import { GUARDRAIL_BLOCK_FALLBACK } from '../../lambda/src/lib/async-processor-core';
import { legacyCopyPlan } from '../../lambda/src/lib/legacy-copy-migration';
import { legacyHomeOf } from '../../lambda/src/lib/shipped-message-templates';
import { putTemplate, activateTemplate, _resetTemplateCache } from '../../lambda/src/lib/template-store';
import { loadMessageTemplateSet, _resetMessageTemplateSets } from '../../lambda/src/lib/message-template-selection';

/** The keyed lines of decision 6 that had no shipped text in the console, less the one that became a prompt. */
const KEYED = [
  'queuedOne', 'queuedMany', 'queuedOverflow', 'queueSettled', 'queueWriteFailed', 'stopMustBePublic', 'stopAmbiguous',
  'stopCancelFailed', 'stopNothingToStop', 'stopped', 'stopCancelledButNotAsked', 'stopLeftCancelled',
  'handoverOwnerUnavailable', 'splitRefused', 'topicMoved', 'taskRefNotFound', 'taskRefNothingOpen', 'taskRefHint',
  'taskStillOpen', 'answeredPrivately', 'addressingPrivately', 'privateFollowUp', 'resumedChainAnswered',
  'resumedChainAsked', 'attachmentTooLargeToRead',
];

describe('the keyed lines are templates, and a version\'s retired line for each migrates to it', () => {
  it.each(KEYED)('%s has a template, and `npm run migrate-legacy-copy` writes its line there', (key) => {
    const home = legacyHomeOf(key);
    expect(home).toBeDefined();
    expect(legacyCopyPlan({ [key]: 'A line.' }).templates).toEqual([expect.objectContaining({ name: home!.name, keys: [key] })]);
  });
});

describe('each line says word for word what the code said before', () => {
  it('the queue notices', () => {
    expect(noticeText({ depth: 1, overflowed: false })).toBe('Still working on your earlier message. I will read this one as soon as it is done.');
    expect(noticeText({ depth: 4, overflowed: false })).toBe('Still working on your earlier message. I will read all 4 of these when it is done.');
    expect(noticeText({ depth: 9, overflowed: true })).toBe('I am still working on your last message. I am holding your newest ones, but I had to drop the oldest one that was waiting - please send it again if you still need it.');
    // The settle: none, one and several, each its own form.
    expect(templateLine('queue-settled', {}, { count: 0 })).toBe('Caught up.');
    expect(templateLine('queue-settled', {}, { count: 1 })).toBe('Caught up - I have read that message.');
    expect(templateLine('queue-settled', {}, { count: 3 })).toBe('Caught up - I have read those 3 messages.');
  });

  it('the stop lines, with "that" for one item and "those N" for several', () => {
    const noun = (n: number) => (n === 1 ? 'that' : `those ${n}`);
    for (const n of [1, 2, 5]) {
      expect(templateLine('stopped', {}, { count: n })).toBe(`Stopped, and I've cancelled ${noun(n)}. I'll ask how you want to proceed.`);
      expect(templateLine('stop-cancelled-but-not-asked', {}, { count: n })).toBe(`Stopped, and I've cancelled ${noun(n)}. Ask me again whenever you want it.`);
      expect(templateLine('stop-cancel-failed', {}, { count: n })).toBe(`Stopped, but I could not cancel ${noun(n)}. Send /stop again to try once more.`);
    }
    expect(templateLine('stop-nothing-to-stop')).toBe("There's nothing in progress here to stop.");
    expect(templateLine('stop-left-cancelled')).toBe('All right, it stays cancelled.');
    expect(templateLine('stop-must-be-public')).toBe('Nothing has been stopped. A stop pauses me for everyone in this conversation, so send /stop to the whole conversation rather than privately.');
    expect(templateLine('stop-ambiguous')).toBe('There is more than one assistant working here, so I have not stopped anything yet. Mention the one you want to stop and send `/stop` again.');
    expect(templateLine('queue-write-failed')).toBe('Something went wrong holding on to that message, so it is not waiting and I will not get to it. Please send it again.');
  });

  it('the handover lines', () => {
    expect(templateLine('handover-owner-unavailable', {}, { values: { name: 'Ops' } })).toBe("That answers work Ops is handling, and I couldn't reach them just now, so I haven't answered in their place. Send it again in a moment and I will pass it along.");
    expect(templateLine('handover-receipt', {}, { values: { name: 'Ops' } })).toBe('Thanks - that answers work Ops is handling, so I have passed it along. Their reply will follow in the conversation.');
    expect(templateLine('handed-to-roommate', {}, { values: { name: 'Ops' } })).toBe("That one is Ops's - I have passed it along, and their reply will follow here.");
    const and = templateLine('roommates-ambiguous', {}, { section: 'label.and' });
    expect(templateLine('roommates-ambiguous', {}, { values: { names: ['Ops', 'Advisor'].join(` ${and} `) } }))
      .toBe('More than one assistant here can help with that: Ops and Advisor. Address whichever you want with an @ mention and they will pick it up.');
    expect(templateLine('handover-unresolved')).toBe('This came to me but I could not pick up the question - could you ask it again here and I will take it from there?');
    expect(templateLine('turn-already-owed')).toBe("I'm still working on that - I'll post it here when it's ready. Send `/stop` if you want to cancel it, or ask me about something else and I will pick that up instead.");
    expect(templateLine('turn-error')).toBe('I encountered an issue. Could you try rephrasing?');
  });

  it('the work item lines', () => {
    const answerable = [{ taskRef: 2, taskType: 'action_item', details: { title: 'Vendor sign-off' } }, { taskRef: 5, taskType: 'action_item', details: { title: 'Budget' } }] as never;
    expect(formatReferenceNotFound({}, 9, answerable)).toMatch(/^I couldn't find #9 among the items waiting on you here\. Start your reply with one of these:\n#2 .+\n#5 .+$/);
    expect(formatReferenceNotFound({}, 9, [])).toBe("I couldn't find #9 among the items waiting on you here, and nothing else is open for you right now.");
    expect(taskRefHintLine({ taskRef: 3, awaitsPerson: true, openItemCount: 2, response: 'Done.' })).toBe('Start your reply with #3 so I know it answers this one.');
    expect(taskStillOpenLine({ advanced: true, state: 'in_review', nextStates: ['approved', 'needs_changes'] }))
      .toBe('This is still open: it is at in review now, and approved or needs changes comes next.');
    expect(templateLine('split-refused', {}, { values: { subjects: ['Budget', 'Hiring'].join(', ') } }))
      .toBe('I could not open a separate conversation for: Budget, Hiring. They are still here, and you can ask me to try again.');
    expect(topicMovedLink('Budget', 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c').content).toBe('Moved Budget to its own conversation. This one stays open for anything else.');
  });

  it('the private and resumed lines', () => {
    expect(ANSWERED_PRIVATELY).toBe('I have replied to you privately.');
    expect(addressingPrivatelyLine()).toBe('Addressing private requests.');
    expect(templateLine('private-follow-up', {}, { count: 1, values: { labels: 'Budget' } })).toBe('About your private request: Budget. Tell me how you would like me to handle this.');
    expect(templateLine('private-follow-up', {}, { count: 2, values: { labels: 'Budget, Hiring' } })).toBe('About your private requests: Budget, Hiring. Tell me how you would like me to handle these.');
    expect(resumedChainReceipt('answer')).toBe('Thanks - picking that back up. My answer is in the conversation.');
    expect(resumedChainReceipt('question')).toBe('Thanks - picking that back up. I have asked you something in the conversation.');
    expect(attachmentTooLargeLine({ name: 'q3.pdf' })).toBe('I could not read the file you attached: it is larger than I can take in. Everything below answers your message without it. A smaller version, or the part that matters as text, and I can read it.');
    expect(GUARDRAIL_BLOCK_FALLBACK).toBe('I cannot process that request. Please rephrase your message.');
  });

  it('the placeholders, by workflow and step, then by delivery', () => {
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'collecting_requirements')).toBe('Understanding your report needs...');
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'unknown_state')).toBe('Working on the report...');
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'guided_troubleshooting', 'diagnosing')).toBe('Analyzing the problem...');
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'data_extraction', 'validating')).toBe('Validating results...');
    expect(getTaskPlaceholder(DeliveryOption.TASK_UPDATE_IN_PLACE)).toBe('Analyzing...');
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'action_item')).toBe('Working on that...');
    expect(getTaskPlaceholder(DeliveryOption.PLACEHOLDER_UPDATE)).toBe('One moment...');
  });

  it('the drift lines', () => {
    expect(templateLine('drift-offer')).toBe("It looks like you're shifting topics. Want me to start a separate conversation for this so we keep both threads clean? Reply 'yes' to create one, or anything else to keep going here.");
    expect(templateLine('drift-redirect-offer')).toBe("It looks like you're shifting to something we covered in another conversation. Want me to take you there? Reply 'yes' to switch, or 'no' to keep going here.");
    expect(`${templateLine('drift-created')} | ${templateLine('drift-created', {}, { section: 'label.link' })}`).toBe("Done — I've created a new conversation. | Drift Follow-up");
    expect(templateLine('drift-battle-refusal', {}, { form: 'starter' })).toBe("I can't split that off while a battle is running here - moving you across would leave the battle behind. Send `/battle end` to end the battle, and anything it was collecting, or tell me again once it finishes and I will move it across.");
    expect(templateLine('drift-battle-refusal', {}, { form: 'member' })).toBe("I can't split that off while a battle is running here - moving you across would leave the battle behind. Whoever started the battle can end it, or a moderator can turn Battle Mode off, or tell me again once it finishes and I will move it across.");
  });

  it('the onboarding lines, the example hint and the name each left out when there is none', () => {
    const say = (form: string, values: Record<string, unknown> = {}) => templateLine('onboarding-intake', {}, { form, values });
    expect(say('greeting')).toBe('Welcome! I just need a few details before we begin.');
    expect(say('redo')).toBe("No problem — let's redo it.");
    expect(say('required')).toBe('That one is required.');
    expect(say('invalid')).toBe("That doesn't look right.");
    expect(say('invalid', { example: 'jane@acme.com' })).toBe("That doesn't look right (for example: jane@acme.com).");
    expect(say('complete', { name: 'Riley' })).toBe("Thanks, Riley — you're all set. How can I help?");
    expect(say('complete')).toBe("Thanks — you're all set. How can I help?");
  });
});

describe('a count chooses the form by the template language\'s plural rules, never by English', () => {
  it('uses Intl.PluralRules, so a language with more categories gets its own forms', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('other');
    // Polish has `few` and `many`: a template written in Polish names those forms and gets them.
    expect(pluralCategory('pl', 3)).toBe('few');
    expect(pluralCategory('pl', 5)).toBe('many');
    const polish = parseTemplate(`---\n${JSON.stringify({ kind: 'message', name: 'queue-settled', description: 'd', language: 'pl', fields: { count: 'value:count' } })}\n---\n# chat.one\nJedna.\n# chat.few\n{{count}} wiadomości (few).\n# chat.many\n{{count}} wiadomości (many).\n# chat.other\n{{count}}.\n`);
    const set: MessageTemplateSet = { own: new Map([['queue-settled', polish]]), classwide: new Map() };
    expect(templateLine('queue-settled', { templates: set }, { count: 3 })).toBe('3 wiadomości (few).');
    expect(templateLine('queue-settled', { templates: set }, { count: 5 })).toBe('5 wiadomości (many).');
  });
});

describe('the stored templates reach every line, and a version\'s retired copy reaches none', () => {
  beforeEach(() => { _resetTemplateCache(); _resetMessageTemplateSets(); });

  it('a retired copy line is not read: the shipped line is said, for every form of a counted one', () => {
    expect(noticeText({ depth: 3, overflowed: false, copy: { queuedMany: '{count} waiting.' } })).toBe(noticeText({ depth: 3, overflowed: false }));
    expect(templateLine('stopped', { copy: { stopped: 'Halted.' } }, { count: 1 })).toBe(templateLine('stopped', {}, { count: 1 }));
    expect(templateLine('stopped', { copy: { stopped: 'Halted.' } }, { count: 4 })).toBe(templateLine('stopped', {}, { count: 4 }));
  });

  it('a template saved for the assistant reaches a line through the set a turn reads once, and its copy carries the set', async () => {
    const objects = new Map<string, string>();
    const params = new Map<string, string>();
    const deps = {
      bucket: 'b', ssmRoot: '/ae', now: () => 1,
      s3: { send: jest.fn(async (cmd: any) => {
        const i = cmd.input;
        if (cmd.constructor.name === 'PutObjectCommand') { objects.set(i.Key, i.Body); return {}; }
        if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key })) };
        if (!objects.has(i.Key)) throw Object.assign(new Error('nk'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => objects.get(i.Key) } };
      }) } as any,
      ssm: { send: jest.fn(async (cmd: any) => {
        const i = cmd.input;
        if (cmd.constructor.name === 'PutParameterCommand') { params.set(i.Name, i.Value); return {}; }
        if (!params.has(i.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: params.get(i.Name) } };
      }) } as any,
    };
    const { source, template } = shippedMessageTemplates().get('stop-left-cancelled')!;
    const reworded = source.replace(template.messageSections!.chat, 'Understood: it stays cancelled.');
    const owner = { family: 'assistant' as const, assistant: 'advisor' };
    const put = await putTemplate('basic', reworded, deps, { owner });
    await activateTemplate('basic', put.name, put.contentHash, deps, { owner });

    const set = await loadMessageTemplateSet({ classification: 'basic', assistant: 'advisor' }, deps);
    expect(templateLine('stop-left-cancelled', { templates: set })).toBe('Understood: it stays cancelled.');
    const copy = withMessageTemplates(set);
    // The saved template reaches the line through the words object the turn passes everywhere.
    expect(templateLine('stop-left-cancelled', { copy })).toBe('Understood: it stays cancelled.');
    // The words object carries the set and nothing else: no line a version stored rides on it.
    expect(Object.keys(copy)).toEqual([]);
    // And a notice said from the same copy reads the same set.
    expect(noticeLine(copy, 'turnFailed')).toBe(noticeLine(undefined, 'turnFailed'));
    // Another assistant reads none of it.
    const other = await loadMessageTemplateSet({ classification: 'basic', assistant: 'concierge' }, deps);
    expect(templateLine('stop-left-cancelled', { templates: other })).toBe('All right, it stays cancelled.');
  });
});

describe('a quick reply is chosen by intent (decision 7)', () => {
  it('a greeting, and each kind of acknowledgment the classifier records', () => {
    expect(quickReply({ intent: 'greeting' })).toBe('Hey, what can I help you with?');
    expect(quickReply({ intent: 'acknowledgment', acknowledgment: 'thanks' })).toBe('Happy to help. Let me know if you have other questions.');
    expect(quickReply({ intent: 'acknowledgment', acknowledgment: 'farewell' })).toBe('Goodbye! Feel free to reach out anytime.');
    expect(quickReply({ intent: 'acknowledgment', acknowledgment: 'confirmation' })).toBe('Let me know if you have other questions.');
    expect(quickReply({ intent: 'acknowledgment' })).toBe('Let me know if you have other questions.');
    expect(quickReply({ intent: 'general' })).toBeNull();
  });

  it('the classifier records the kind, so the reply never reads the person\'s words', () => {
    expect(fastPathIntent('thanks')).toEqual(expect.objectContaining({ intent: 'acknowledgment', acknowledgment: 'thanks' }));
    expect(fastPathIntent('goodbye')).toEqual(expect.objectContaining({ intent: 'acknowledgment', acknowledgment: 'farewell' }));
    expect(fastPathIntent('got it')).toEqual(expect.objectContaining({ intent: 'acknowledgment', acknowledgment: 'confirmation' }));
  });

  it('a workflow state\'s declared placeholder comes before the template', () => {
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'generating', { declared: 'Writing it up...' })).toBe('Writing it up...');
  });

  it('a shipped line read as a constant is the template\'s, in the legacy form', () => {
    expect(shippedLineText('task-ref-hint')).toBe('Start your reply with #{ref} so I know it answers this one.');
  });
});

describe('the capability refusal and the queue stages are templates too', () => {
  it('the refusal lines, word for word, and a retired key no longer words its line', () => {
    const { DEFAULT_REFUSAL_COPY } = require('../../lambda/src/lib/capability-refusal');
    expect(DEFAULT_REFUSAL_COPY).toEqual({
      capabilityUnavailable: "I don't produce {output} in this conversation.",
      capabilityNotOffered: "That isn't something I do in this conversation.",
      capabilityHasAccess: 'You have access to conversations that do:',
      capabilityHasAccessClose: 'Start a new conversation there and ask again.',
      capabilityNeedsAccess: 'If you need {output}, ask your administrator for access.',
      capabilityNotOfferedNeedsAccess: 'If you need it, ask your administrator for access.',
      capabilityOutputDocument: 'report documents',
      capabilityOutputImage: 'images',
    });
    expect(templateLine('capability-refusal', {}, { section: 'chat.unavailable', values: { output: 'images' } })).toBe("I don't produce images in this conversation.");
    // A retired `copy` key no longer words its line: the shipped one is said until a template is saved.
    expect(templateLine('capability-refusal', { copy: { capabilityUnavailable: 'No {output} here.' } }, { section: 'chat.unavailable', values: { output: 'images' } })).toBe("I don't produce images in this conversation.");
  });

  it('the queue stage labels, word for word; only chosen words are sent beside the stage token', () => {
    const { queueStatusLabel, configuredQueueStatusLabel } = require('../../lambda/src/lib/turn-queue-status');
    expect(['waiting', 'reviewing', 'clarifying', 'addressing_private', 'clearing', 'settled'].map((s) => queueStatusLabel(s)))
      .toEqual(['Waiting', 'Reviewing what arrived', 'Checking what you meant', 'Addressing private requests', 'Clearing the queue', 'Done']);
    expect(configuredQueueStatusLabel('waiting')).toBeUndefined();
    // A retired `queueStatus` key is not chosen words: only a saved template is.
    expect(configuredQueueStatusLabel('waiting', { queueStatus: { waiting: 'Held' } })).toBeUndefined();
    const { source } = shippedMessageTemplates().get('queue-status')!;
    const own = parseTemplate(source.replace('Reviewing what arrived', 'Reading what came in'));
    const copy = withMessageTemplates({ own: new Map([['queue-status', own]]), classwide: new Map() });
    expect(configuredQueueStatusLabel('reviewing', copy)).toBe('Reading what came in');
  });
});
