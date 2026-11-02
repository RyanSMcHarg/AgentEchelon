import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import { useAuth } from '@ae/shared';
import { classificationAudience } from '@ae/shared/config/classifications.ts';
import { useAwsClient } from '../providers/AwsClientProvider';
import { uploadFile } from '../services/attachmentService';
import FileUploadPreview from './FileUploadPreview';
import { markMessageSent } from '../services/messageLatencyTracker';
import { trackEvent } from '@ae/shared';
import {
  parseMentions,
  mentionValidationMessage,
  privatePrefixAddress,
  canBeAddressedPrivately,
  privatePrefixDraft,
  mentionTokenFor,
  privatePrefixFor,
  stripPrivatePrefixFrom,
} from '../utils/mentionParser';
import { hasMarkdownPrefix, withoutMarkdownPrefix } from '../utils/markdownPrefix';
import { taskReferenceOf, withoutTaskReference } from '../utils/taskReference';
import { useAttachmentCapability } from '../hooks/useAttachmentCapability';
import type { ChannelMember, StickyMentionTarget } from '@ae/shared';
import './MessageInput.css';

/** One open work item, as the conversation context surfaces it. */
type OpenWorkItem = {
  taskId: string;
  /** The reference a person types to answer it (ADR-035). */
  taskRef?: number;
  channelArn?: string;
  assistantId?: string;
  title?: string;
  taskType?: string;
  /** Who the item is for. Absent is read as private - see the composer below. */
  visibility?: 'conversation' | 'private';
};

/**
 * The open item in THIS conversation that the message answers, or null (ADR-035).
 *
 * THE PERSON DECIDES, and nothing else does. The item is the one whose reference the message starts
 * with, or - for an older item that has no reference - the one they chose with its Answer action. This
 * used to pick the oldest open item on its own, which attached a reply to work the person may not
 * have been talking about.
 *
 * `botArn` is set only in a group, where the assistant has to be addressed for the reply to reach it;
 * in a 1:1 the AUTO trigger routes every message to the assistant, and targeting would only make the
 * person's own message private for no reason.
 *
 * Module scope so the memo around it is a single pure call. Inline, the early-return walk defeated the
 * React Compiler's memoization check, which is reported as an error and fails the lint job.
 */
function resolveTaskAnswer(
  channelArn: string | undefined,
  channelMembers: ChannelMember[],
  openWorkItems: OpenWorkItem[],
  typedRef: number | null,
  chosenTaskId: string | null,
): { taskId: string; taskRef?: number; title: string; botArn?: string; visibility?: 'conversation' | 'private' } | null {
  if (!channelArn) return null;
  const here = openWorkItems.filter((i) => i.channelArn === channelArn);
  // THE CHOICE IS HELD BY ID, WHATEVER THE ITEM CARRIES. This read `&& !i.taskRef`, because an item
  // WITH a reference was answered by typing that reference into the composer - the choice was spent
  // the moment it became text. It is not written into the message any more (see the composer), so the
  // choice has to survive until the send, and an item is found by the id the person chose.
  const item = typedRef
    ? here.find((i) => i.taskRef === typedRef)
    : here.find((i) => i.taskId === chosenTaskId);
  if (!item) return null;
  // Resolved against the members this client can SEE, never assembled from an id: an item naming an
  // assistant that is not a member of this conversation addresses nothing, which is honest about what
  // the client knows and cannot produce an ARN for a bot it has never seen.
  const bot = channelMembers.length > 2 && item.assistantId
    ? channelMembers.find((m) => m.isBot && m.userArn.endsWith(`/${item.assistantId}`))
    : undefined;
  return {
    taskId: item.taskId,
    ...(item.taskRef ? { taskRef: item.taskRef } : {}),
    title: item.title || item.taskType || '',
    ...(bot ? { botArn: bot.userArn } : {}),
    // Carried so the composer can address a SHARED item openly rather than targeting it. Absent stays
    // absent and is read as private downstream.
    ...(item.visibility ? { visibility: item.visibility } : {}),
  };
}

const MessageInput: React.FC = () => {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  /**
   * WHICH GRAMMAR THE OPEN PICKER IS COMPLETING: `@` addresses in public, `.` addresses privately
   * (ADR-034). One dropdown serves both, because they ask the same question of the same roster and a
   * second picker would be a second place for "who is in this conversation" to be answered.
   *
   * IT IS WHY THE DOT NEEDS A PICKER AT ALL. An `@` token resolves on word boundaries and tolerates
   * being typed loosely; the dot token IS the whole address and has to equal a member's name exactly
   * or it is not an address. Since an unresolved dot now sends to the ROOM rather than being refused,
   * the cost of a typo is a published message - so picking from a list, rather than typing a name
   * character-perfect, is what keeps the expensive mistake out of reach.
   */
  const [mentionTrigger, setMentionTrigger] = useState<'@' | '.'>('@');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { activeConversation, sendMessage, isSending, sendError, clearSendError, channelMembers, stickyTarget, setStickyTarget, replyingToSides = [], clearReplyingToSides, openWorkItems, refreshOpenWorkItems, answeringTaskId, clearAnswering } = useConversations();
  const { user } = useAuth();
  // THE SENDER IS THE ARN THE MESSAGING CLIENT ACTS AS, the person's AppInstanceUser as the credential
  // exchange returned it. Excluding anything else from the mention list leaves the sender in it.
  const { userArn: senderArn } = useAwsClient();

  /**
   * WHO THIS MESSAGE IS PRIVATE TO, resolved from what is typed RIGHT NOW (ADR-034).
   *
   * A privacy token is not applied until the person can see that it was, so this is derived from the
   * live input rather than from the send: the moment `.name ` completes and resolves to a member,
   * the chip below says so. The two ways to get this wrong cost different amounts - a message meant
   * for the room that reaches one person is recoverable, and a message meant for one person that
   * reaches the room cannot be taken back - so the person must be able to SEE privacy before they
   * commit to it.
   */
  const privateTo = useMemo(() => {
    // BY ID WHEN THE PICKER WROTE ONE, because a display name is not unique and this decoration is
    // what the person checks before committing to privacy. Matching the raw token would fail outright
    // once it carries `Name|id`, and the chip would vanish for exactly the addresses the picker is
    // most sure about.
    const address = privatePrefixAddress(input);
    if (!address) return null;
    const notMe = (m: { userArn?: string }) => m.userArn !== (senderArn || '');
    if (address.id) {
      const byId = channelMembers.find((m) => notMe(m) && m.userArn?.split('/').pop() === address.id);
      if (byId) return byId;
    }
    return channelMembers.find(
      (m) => notMe(m)
        && (m.name?.toLowerCase() === address.name.toLowerCase()
          || m.name?.toLowerCase() === address.raw.toLowerCase()),
    ) || null;
  }, [input, channelMembers, senderArn]);

  /**
   * WHETHER TO OFFER THE PAPERCLIP AT ALL, answered by the deployment rather than by this client.
   *
   * A conversation whose assistant has no attachment-in grant used to accept the file anyway: it
   * uploaded, staged, sent, and came back with a fluent answer drawn from the caption, because the
   * processor's bucket was unset and the branch that would have said so covered a different failure.
   * Nothing told the person their document had not been read.
   *
   * SO IT WARNS RATHER THAN REMOVES, and the difference matters. Attaching a file is not only a way
   * to ask an assistant about it: a person sends a colleague a file in a shared conversation, and
   * that path needs no assistant to read anything. It works today, it is covered by an e2e, and it
   * is the same control. Hiding the paperclip would have closed the silent failure by deleting a
   * working feature for everyone on the profile - fixing an invisible wrong answer with a visible
   * missing capability.
   *
   * The composer cannot know at staging time whether the finished message will address a colleague
   * or the assistant, so it cannot decide FOR the person. It can tell them what this conversation's
   * assistant will do with the file, before they send it, which is the thing that was missing.
   */
  const canAttach = useAttachmentCapability(activeConversation?.conversationArn);

  const everyoneMember: StickyMentionTarget = { userArn: 'EVERYONE', name: 'all', isBot: false, isAll: true };

  const humanCount = channelMembers.filter((m) => !m.isBot).length;
  const isMultiUser = humanCount >= 2;
  // The multi-user hint is shown only where an assistant is present to answer.
  const assistantHere = channelMembers.some((m) => m.isBot);

  // REPLYING TO A DUEL SIDE (DESIGN-BATTLE, "A side parked on the person"). The person chose it on the
  // side's message ("Reply to this side", or "Answer both sides"), so the composer says which side the
  // next send goes to and lets them cancel. The send is targeted at the side (Chime `Target`), which is
  // what reaches that side's Lex and resumes it (`resumeDuelSideIfWaiting`); the rival never sees it.
  // Only sides still waiting on this person are here (the provider resolves the choice against the live
  // markers), so a side that is answered or ends leaves this mode on its own.
  const selectedWaiting = replyingToSides.length > 0 ? replyingToSides[0] : null;
  const botDisplayName = (arn: string) =>
    channelMembers.find((m) => m.userArn === arn)?.name || t('tier.assistant');

  // Choosing a side to reply to puts the person in the composer, which is where they answer it.
  const replyingKey = replyingToSides.map((s) => s.botArn).join('|');
  useEffect(() => {
    if (replyingKey) textareaRef.current?.focus();
  }, [replyingKey]);

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ANSWERING A WORK ITEM (ADR-032).
  //
  // In a shared conversation, a message that addresses nobody reaches no assistant: silence-by-default
  // is the rule, and it is the right one - an assistant must not answer chatter it was not part of.
  // But a person answering a question an assistant asked THEM is not chatter, and they have no reason
  // to know they were supposed to address it. Left alone, their answer lands in the channel, nothing
  // runs, and the work stays blocked with nothing anywhere showing an error.
  //
  // THE COMPOSER IS WHERE THIS IS FIXED, because it is the one component that knows what is being
  // answered: it rendered the item. So when the person's message names an item here - its `#<n>`,
  // typed or put there by the item's Answer action (ADR-035) - the composer addresses it to the
  // assistant that asked and stamps the task it answers. The stream-side repair exists for the cases
  // this misses, and counts them, so this staying correct remains measurable (ADR-032 tenets 3 and 6).
  //
  // ONLY THE PERSON CHOOSES. The composer no longer picks an item on its own: a reply is attached to
  // work only when it names that work.
  //
  // MEMOIZED AROUND A PURE CALL, not around the loop itself. Inline, the early-return walk defeated
  // the React Compiler ("existing memoization could not be preserved") and it reported that as an
  // ERROR, which fails the frontend lint job.
  const typedRef = taskReferenceOf(withoutMarkdownPrefix(input));
  const taskAnswer = useMemo(
    () => resolveTaskAnswer(
      activeConversation?.conversationArn,
      channelMembers,
      openWorkItems,
      typedRef,
      answeringTaskId ?? null,
    ),
    [openWorkItems, activeConversation?.conversationArn, channelMembers, typedRef, answeringTaskId],
  );

  // THE ANSWER ACTION NO LONGER TYPES ANYTHING INTO THE MESSAGE.
  //
  // It used to put the item's `#<n>` at the start of the composer, so the reference was both the
  // person's words and the client's routing instruction. Two jobs on one string, and the person got
  // the worse half of it: they sent "#4 yes, EMEA only" to a room that reads every message, and the
  // assistant, seeing a syntax it had to teach, asked them to keep typing it.
  //
  // The item travels as `{ task: { id } }` in the message Metadata instead (the send below), which is
  // the client saying something ABOUT the message rather than inside it. The choice therefore has to
  // SURVIVE until the send - it is cleared when the message goes, or when the person dismisses the
  // chip, not the instant it is made.
  //
  // The focus move stays: choosing an item puts the person in the composer, which is the whole point
  // of the action. It is the text insertion that is gone, not the affordance.
  const chosenHere = answeringTaskId
    ? openWorkItems.find((i) => i.taskId === answeringTaskId
      && i.channelArn === activeConversation?.conversationArn)
    : undefined;
  const chosenTaskId = chosenHere?.taskId;
  useEffect(() => {
    if (!chosenTaskId) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [chosenTaskId]);

  // Build mention options: filter out current user, add @all when there are two or more humans
  const getMentionOptions = useCallback((): (ChannelMember & { isAll?: boolean })[] => {
    const userArn = senderArn;
    const others = channelMembers.filter((m) => m.userArn !== userArn);

    const options: (ChannelMember & { isAll?: boolean })[] = [];

    // NO `all` WHEN COMPLETING A PRIVATE ADDRESS. `Target` holds exactly one member, so "privately to
    // everyone" is not expressible at all (ADR-034) - offering it would present a choice the platform
    // cannot honour, and the composer already refuses `.member` combined with `@all` as a
    // contradiction. Public mentions keep it.
    if (mentionTrigger === '@') {
      // Add @all when 3+ members (user + bot + at least 1 shared user)
      const humanMembers = channelMembers.filter((m) => !m.isBot);
      if (humanMembers.length >= 2) {
        options.push({ userArn: 'EVERYONE', name: 'all', isBot: false, isAll: true });
      }
    }

    // ONLY MEMBERS A DOT CAN ACTUALLY ADDRESS. The token grammar is narrower than a display name, and
    // on a deployment where members are named by email `.someone@example.com hello` produces no token
    // at all - so the message is NOT private and goes to the room. Offering that member would be
    // offering an action the platform cannot perform. `@` is unaffected: it matches on word
    // boundaries and addresses any name.
    options.push(...(mentionTrigger === '.'
      ? others.filter((m) => canBeAddressedPrivately(m.name))
      : others));

    if (!mentionFilter) return options;
    const filter = mentionFilter.toLowerCase();
    return options.filter((m) => m.name.toLowerCase().includes(filter));
  }, [channelMembers, senderArn, mentionFilter, mentionTrigger]);

  const insertMention = useCallback((member: ChannelMember & { isAll?: boolean }) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBefore = input.substring(0, cursorPos);
    const textAfter = input.substring(cursorPos);

    // Find the token that triggered the dropdown. A `.` prefix is ANCHORED - it only means anything
    // at the start of the message - so it is found from the front; an `@` can appear anywhere, so it
    // is the last one before the cursor.
    const atIndex = mentionTrigger === '.'
      ? input.indexOf('.')
      : textBefore.lastIndexOf('@');
    if (atIndex === -1) return;

    // THE TRAILING SPACE IS WHAT MAKES THE TOKEN FINISHED, and for `.` that is not cosmetic: the
    // parser requires it before the token resolves, which is also when the "Private to" chip appears.
    // Inserting without it would leave the person looking at an address that is not yet an address.
    // THE PICKER WRITES THE FORM THE NAME REQUIRES, so nobody types a bracket. `privatePrefixFor`
    // delimits only when the bare token could not carry the name, which keeps an ordinary address
    // reading as `.Alice hello` in the message the recipient sees.
    const mention = member.isAll
      ? '@all '
      : mentionTrigger === '.'
        ? privatePrefixFor(member.name, member.userArn)
        // `@` CARRIES THE ID TOO, for the same reason `.` does and through the same
        // helper shape. `@all` is deliberately excluded: it names no member, so there is no id.
        : mentionTokenFor(member.name, member.userArn);
    const newText = textBefore.substring(0, atIndex) + mention + textAfter;
    setInput(newText);
    setShowMentionDropdown(false);
    setMentionFilter('');
    setSelectedMentionIndex(0);

    // Restore cursor position after React re-render
    requestAnimationFrame(() => {
      const newPos = atIndex + mention.length;
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus();
    });
  }, [input, mentionTrigger]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    const cursorPos = e.target.selectionStart;
    const textBefore = value.substring(0, cursorPos);

    // THE PRIVATE PREFIX, CHECKED FIRST AND ANCHORED TO THE START. `.` means an address only as the
    // first thing in the message (ADR-034), which is what stops a decimal, a file extension or an
    // ellipsis mid-sentence from opening a privacy picker - "call me at 5.sam" is not addressing Sam.
    // The token is still being typed here, so there is no trailing space to match yet.
    const privateDraft = privatePrefixDraft(textBefore);
    // An `@` can appear anywhere in a sentence, so it is matched from the cursor backwards.
    const mentionMatch = textBefore.match(/@([\w ]*)$/);

    if (privateDraft !== null) {
      setMentionTrigger('.');
      setMentionFilter(privateDraft);
      setShowMentionDropdown(true);
      setSelectedMentionIndex(0);
    } else if (mentionMatch) {
      setMentionTrigger('@');
      setMentionFilter(mentionMatch[1] || '');
      setShowMentionDropdown(true);
      setSelectedMentionIndex(0);
    } else {
      setShowMentionDropdown(false);
      setMentionFilter('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !stagedFile) || !activeConversation || !user) return;

    try {
      setUploadError(null);
      setMentionError(null);
      let attachment;

      if (stagedFile) {
        setIsUploading(true);
        attachment = await uploadFile(stagedFile, activeConversation.id, user.id);
        setStagedFile(null);
        setIsUploading(false);
      }

      if (selectedWaiting) {
        // A reply to a waiting duel side: the raw text TARGETED at each chosen side, so only that side's
        // Lex receives it and the router resumes the side (ADR-029). A `Target` holds one member, so
        // "Answer both sides" is one targeted send per side, the same words to each. No sticky prefix and
        // no @-mention parsing.
        const battleContent = input.trim() || `[Attached: ${attachment?.name}]`;
        for (const side of replyingToSides) {
          await sendMessage(battleContent, attachment, { targetArn: side.botArn });
        }
        clearReplyingToSides?.();
      } else {
        // If a sticky target is set and the user didn't type their own @-mention,
        // prepend the sticky mention so it carries over to the next send.
        //
        // A slash command is exempt. `/battle` is a START-OF-MESSAGE command, so a prepended
        // mention turns it into ordinary prose addressed to one assistant: the router reads
        // `invokesBattle: false` and answers normally, with no duel and nothing to explain why.
        // The sticky target is also semantically wrong for a battle, which fans out to two bots
        // rather than to the one the mention names. Once a sticky target was set - and it persists
        // across sends - every later slash command in that conversation was silently swallowed.
        // `/md` IS A RENDERING INSTRUCTION, NOT A ROUTING ONE, so it is lifted off before any of the
        // decisions below and put back at the end. Every check here that asks "is this a command?"
        // means "does this address somebody or invoke a process", and `/md` does neither - left in
        // place it would suppress the sticky mention and disqualify the message from answering a work
        // item, purely because of how it is spelled. It also has to stay at the START to mean
        // anything, so the sticky prefix must land after it rather than in front of it.
        // Re-attached in its canonical spelling rather than as the person typed it, so `/MD` and a
        // ragged amount of leading space both come back as one known form the renderer will match.
        const wantsMarkdown = hasMarkdownPrefix(input);
        let effectiveContent = withoutMarkdownPrefix(input.trim()).trim();
        // THE CHIP AND THE SEND MUST AGREE. The banner above renders `taskAnswer` BEFORE
        // `stickyTarget`, so when both exist the person is told "Answering <work item>" - and the
        // sticky prefix must therefore stand down: prepending it here set `mentions.targetArn` to the
        // sticky human, which forced `answersTask` false below, and the message routed to that person
        // with no taskId while the UI said the opposite. The work item stayed blocked. The sticky
        // target is not cleared, only skipped: it comes back once the work item is answered or
        // dismissed, exactly as the banner does.
        if (stickyTarget && !taskAnswer && !effectiveContent.startsWith('@') && !effectiveContent.startsWith('/')
          && !effectiveContent.startsWith('.')) {
          const prefix = stickyTarget.isAll ? '@all' : `@${stickyTarget.name}`;
          effectiveContent = effectiveContent ? `${prefix} ${effectiveContent}` : prefix;
        }

        const fallbackContent = effectiveContent || `[Attached: ${attachment?.name}]`;
        const userArn = senderArn || '';
        const mentions = parseMentions(fallbackContent, channelMembers, userArn);

        // Enforce single-target-or-@all on the frontend (Chime's
        // SendChannelMessage.Target is fixed at 1 item — see
        // reference_chime_target_fixed_one). When the user typed multiple
        // distinct mentions or mixed @all with explicit mentions, show
        // the violation inline and stop here; don't silently drop the
        // extras and send a half-targeted message.
        if (mentions.error) {
          setMentionError(mentionValidationMessage(mentions.error));
          return;
        }

        // ANSWERING A WORK ITEM, when the person addressed nobody themselves. The assistant that asked
        // is addressed for them and the task is named, so the message reaches the work it answers
        // instead of reaching nobody (ADR-032).
        //
        // WHAT THE PERSON TYPED ALWAYS WINS. An explicit mention, `@all` and a slash command each take
        // this branch away: a mention is the person naming who they are talking to, and ADR-030 makes
        // that a supported path in its own right - the turn resolves the chain from the task, so no
        // reference needs to ride the message. A `/battle` is a new instruction, not an answer.
        //
        // TESTED ON `mentionedArns`, NOT ON WHAT A MENTION HAPPENS TO ROUTE. The three original terms
        // stood in for "did the person address somebody", which they did while every `@` set a
        // `targetArn` or a `mentionBotArn`. ADR-034 removed both for a HUMAN mention - that is the
        // whole point of it - so "@Sam can you check this?" with a work item pending set none of them
        // and took this branch: the message went to the ASSISTANT, privately if the item was private,
        // and Sam was never mentioned at all. The comment above was still true as written and the code
        // under it had stopped implementing it.
        const answersTask = taskAnswer && taskAnswer.botArn && !mentions.isAtAll && !mentions.targetArn
          && !mentions.mentionBotArn && mentions.mentionedArns.length === 0
          && !fallbackContent.startsWith('/');

        // ADDRESSING IS NOT PRIVATISING, and until now this was one act. Reaching the assistant with
        // a `targetArn` sets a Chime Target, and a Target is what makes a message unreadable to the
        // rest of the room - so answering work the room can SEE made the exchange invisible to the
        // people waiting on it, and the outcome changed under them with no way to know why. The
        // convenience feature was doing the concealing, not the person.
        //
        // A shared item is therefore answered by MENTIONING the assistant, which is public text, with
        // the task id riding alongside as metadata for precision. A private item keeps the target,
        // because it is nobody else's.
        //
        // ABSENT VISIBILITY COUNTS AS PRIVATE. It means a row written before the server sent the
        // field, and of the two ways to be wrong only one publishes something.
        const answersSharedItem = answersTask && taskAnswer.visibility === 'conversation';

        const sendOptions = mentions.isAtAll
          ? undefined
          : answersSharedItem
            // THE METADATA ROUTES IT, SO NOTHING ELSE MAY. The channel flow reads `task.id` off the
            // message and dispatches the turn itself (`resolveReferenceTarget`), so a mention on the
            // same message is a SECOND entry for one message - measured live, the second found the
            // turn busy, queued the message behind its own answer and posted a "folding that in"
            // notice.
            //
            // AND IDEMPOTENCY DOES NOT CATCH IT, which is why this has to be right here rather than
            // being left for the dedup to absorb. The two entries derive their correlation ids
            // differently - the flow from the inbound `MessageId`, the Lex path from a hash of the
            // message text and a time bucket - so one message produces two ids that never collide.
            // The claim sees two turns, not a repeat of one, and denies nothing. Idempotency covers a
            // retry of ONE entry; it cannot see two.
            //
            // This used to depend on `taskAnswer.taskRef`, because only an item with a reference had
            // something in the text for the flow to route on. Every shared item has an id.
            ? { taskId: taskAnswer.taskId }
            : answersTask
              ? { targetArn: taskAnswer.botArn!, taskId: taskAnswer.taskId }
              : (mentions.targetArn || mentions.mentionBotArn || mentions.mentionedArns.length > 0)
                // `mentionedArns` is what makes an `@` mention of a PERSON reach them (ADR-034).
                // Without it the send carried the bot ARN alone, so naming a colleague produced no
                // platform mention and no push - it was plain text starting with an `@`, and the
                // promise that `@` notifies the member it names held only for assistants.
                //
                // NOT ON A PRIVATE MESSAGE. The `.` branch reports the targeted member in
                // `mentionedArns` too, and a `Target` already routes that message - to an assistant's
                // Lex through `TargetedMessages: ALL`, and to that person's client through delivery.
                // Adding the attribute as well would give a targeted assistant a second way in, which
                // is the duplicate-responder shape, and it would mention a member the sender never
                // named in the text.
                ? {
                  targetArn: mentions.targetArn,
                  mentionBotArn: mentions.mentionBotArn,
                  ...(mentions.privateToArn ? {} : { mentionArns: mentions.mentionedArns }),
                }
                : undefined;

        // The command goes back on only for the SEND. Everything above - the mention parse, the
        // task-answer decision, the sticky prefix - reasoned about the message itself, which is what
        // those decisions are about; the renderer is the only thing that needs the instruction.
        await sendMessage(wantsMarkdown ? `/md ${fallbackContent}` : fallbackContent, attachment, sendOptions);

        // Update sticky target from what the user just sent so the next
        // message carries the same mention forward.
        if (mentions.isAtAll) {
          setStickyTarget(everyoneMember);
        } else if (mentions.mentionedArns.length > 0 && !mentions.privateToArn) {
          // ADDRESSING IS STICKY; PRIVACY IS NOT (ADR-034).
          //
          // Carrying an @-mention forward saves retyping and costs nothing if it is wrong: the next
          // message reaches one more person than intended. Carrying PRIVACY forward is a mode that
          // outlives the message, and the cost of forgetting you are in it is a message the room was
          // supposed to see going to one person - or worse, the reverse read of the chip. So a
          // `.member` send deliberately leaves the sticky target alone: privacy is re-stated per
          // message, every time.
          const targeted = channelMembers.find((m) => m.userArn === mentions.mentionedArns[0]);
          if (targeted) setStickyTarget(targeted);
        }
      }

      // Track message send for latency measurement and analytics
      try {
        if (activeConversation.conversationArn) {
          markMessageSent(activeConversation.conversationArn);
        }
        trackEvent('message_sent', {
          hasAttachment: !!attachment,
          conversationId: activeConversation.id,
        });
      } catch {
        // Tracking must never break message sending
      }

      setInput('');
      clearAnswering?.();
      setShowMentionDropdown(false);
      // Answering is what closes an item, so re-read the queue rather than waiting for the poll. The
      // assistant advances the task a moment later, so this can still show the item briefly; the poll
      // settles it, and a queue that lags by seconds is better than one that lags by a minute.
      refreshOpenWorkItems();
    } catch (err) {
      setIsUploading(false);
      setUploadError(err instanceof Error ? err.message : 'Failed to send');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionDropdown) {
      const options = getMentionOptions();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIndex((prev) => (prev + 1) % options.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIndex((prev) => (prev - 1 + options.length) % options.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && options.length > 0) {
        e.preventDefault();
        insertMention(options[selectedMentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionDropdown(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      setStagedFile(files[0]);
      setUploadError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  // Archived conversations are read-only (the backend also denies SendChannelMessage
  // via IAM; this disables the composer so the UI matches).
  const isArchived = !!activeConversation?.archived;
  const isDisabled = !activeConversation || isSending || isUploading || isArchived;
  const displayError = mentionError || uploadError || sendError;
  const mentionOptions = showMentionDropdown ? getMentionOptions() : [];

  return (
    <div className="message-input-container">
      {isArchived && (
        <div className="message-input-archived-notice" role="status">
          {t('conversation.readOnlyNotice')}
        </div>
      )}
      {stagedFile && (
        <FileUploadPreview
          file={stagedFile}
          onRemove={() => setStagedFile(null)}
          isUploading={isUploading}
        />
      )}
      {/* SAID BEFORE THE SEND, not after it. This is the whole fix: the turn will answer from the
          caption alone and read nothing, and previously the only signal of that was a reply that
          sounded right. Rendered next to the staged file so it is attached to the decision being
          made, and only when a file is actually staged - a standing warning on an empty composer
          would be noise in every conversation on the profile. `role="status"` so a screen reader is
          told too, matching the read-only notice above. Wording is a translation key: what a person
          reads is deployment copy, never English compiled into a component. */}
      {/* ONLY ON A DEFINITE `false`. `canAttach` is undefined while the capability is in flight and
          undefined if the request failed, and this line is a statement of fact about the assistant -
          so `!canAttach` told anyone who staged a file quickly, or whose config call hit a transient
          error, that their assistant cannot read files when it can. Withholding the claim costs a
          notice somebody might have wanted; making it wrongly costs their trust in the rest. */}
      {stagedFile && canAttach === false && (
        <div className="message-input-attachment-notice" role="status">
          {t('conversation.assistantCannotReadFiles')}
        </div>
      )}
      {displayError && (
        <div className="message-input-error">
          <span>{displayError}</span>
          <button onClick={() => { setUploadError(null); setMentionError(null); clearSendError(); }}>&times;</button>
        </div>
      )}
      {selectedWaiting ? (
        <div className="message-input-sticky-target message-input-sticky-target--battle-side" role="status">
          <span className="message-input-sticky-target-label">{t('conversation.replyingTo')}</span>
          {replyingToSides.map((side) => (
            <span key={side.botArn} className="message-input-sticky-target-chip message-input-sticky-target-chip--bot">
              @{botDisplayName(side.botArn)}
            </span>
          ))}
          <span className="message-input-sticky-target-hint">
            {replyingToSides.length === 1
              ? t('conversation.battleWaitingOne', { name: botDisplayName(selectedWaiting.botArn) })
              : t('conversation.battleReplyBoth')}
          </span>
          <button
            type="button"
            className="message-input-sticky-target-clear"
            onClick={() => clearReplyingToSides?.()}
            aria-label={t('conversation.clearReplyingToSide')}
            title={t('conversation.clearReplyingToSide')}
          >
            &times;
          </button>
        </div>
      ) : privateTo ? (
        /* The token became a decoration: this is the moment privacy is applied, and the person can
           see it before they send. Stated in words rather than in the token, because the chip is the
           last thing read before sending something believed to be unreadable by the room. */
        <div className="message-input-sticky-target" role="status">
          <span className="message-input-sticky-target-label">{t('conversation.privateTo')}</span>
          <span className="message-input-sticky-target-chip message-input-sticky-target-chip--private">
            {privateTo.name}
          </span>
          <span className="message-input-sticky-target-hint">{t('conversation.privateToHint')}</span>
          <button
            type="button"
            className="message-input-sticky-target-clear"
            onClick={() => setInput(stripPrivatePrefixFrom(input))}
            aria-label={t('conversation.clearPrivate')}
            title={t('conversation.clearPrivate')}
          >
            &times;
          </button>
        </div>
      ) : taskAnswer ? (
        /* The message answers an item here, and says so before it is sent - which is the ONLY place
           that is now visible, since the item no longer writes itself into the message text. The
           dismiss drops the choice, so a person who changes their mind sends an ordinary message. */
        <div className="message-input-sticky-target" role="status">
          <span className="message-input-sticky-target-label">{t('conversation.answering')}</span>
          <span className="message-input-sticky-target-chip message-input-sticky-target-chip--bot">
            {taskAnswer.taskRef ? `#${taskAnswer.taskRef}: ` : ''}{taskAnswer.title}
          </span>
          {taskAnswer.botArn && (
            <span className="message-input-sticky-target-hint">
              {t('conversation.answeringHint', { name: botDisplayName(taskAnswer.botArn) })}
            </span>
          )}
          <button
            type="button"
            className="message-input-sticky-target-clear"
            onClick={() => {
              // Stops answering. The choice is the only thing holding the item now, so clearing it is
              // the whole dismiss - except for a reference the person typed THEMSELVES, which is their
              // text and comes out only because it is what the chip is reporting.
              if (typedRef) setInput((prev) => withoutTaskReference(prev));
              clearAnswering?.();
            }}
            aria-label={t('conversation.clearAnswering')}
            title={t('conversation.clearAnswering')}
          >
            &times;
          </button>
        </div>
      ) : stickyTarget ? (
        <div className="message-input-sticky-target" role="status">
          <span className="message-input-sticky-target-label">{t('conversation.replyingTo')}</span>
          <span
            className={`message-input-sticky-target-chip${stickyTarget.isAll ? ' message-input-sticky-target-chip--all' : ''}${stickyTarget.isBot ? ' message-input-sticky-target-chip--bot' : ''}`}
          >
            @{stickyTarget.name}
          </span>
          <button
            type="button"
            className="message-input-sticky-target-clear"
            onClick={() => setStickyTarget(null)}
            aria-label={t('conversation.clearStickyTarget')}
            title={t('conversation.clearStickyTarget')}
          >
            &times;
          </button>
        </div>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className={`message-input-form ${isDragOver ? 'message-input-form--drag-over' : ''}${privateTo ? ' message-input-form--private' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          ref={fileInputRef}
          className="file-input-hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
          tabIndex={-1}
        />
        <button
          type="button"
          className="attach-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isDisabled}
          title={t('conversation.attachFile')}
          aria-label={t('conversation.attachFile')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M15.621 4.379a3 3 0 00-4.242 0l-7 7a3 3 0 004.241 4.243h.001l.497-.5a.75.75 0 011.064 1.057l-.498.501-.002.002a4.5 4.5 0 01-6.364-6.364l7-7a4.5 4.5 0 016.368 6.36l-3.455 3.553A2.625 2.625 0 119.52 9.52l3.45-3.451a.75.75 0 111.061 1.06l-3.45 3.451a1.125 1.125 0 001.587 1.595l3.454-3.553a3 3 0 000-4.242z" clipRule="evenodd" />
          </svg>
        </button>
        <div className="message-input-wrapper">
          {showMentionDropdown && mentionOptions.length > 0 && (
            <div className={`mention-dropdown${mentionTrigger === '.' ? ' mention-dropdown--private' : ''}`}>
              {/* WHICH ACT THIS LIST IS COMPLETING, said in words before the names. The two grammars
                  differ in who can READ the message, which is the consequence a person cannot undo -
                  so the list that applies privacy must not look like the list that does not. */}
              {mentionTrigger === '.' && (
                <div className="mention-dropdown-heading">
                  {t('conversation.privateTo', { defaultValue: 'Send privately to' })}
                </div>
              )}
              {mentionOptions.map((member, index) => (
                <button
                  key={member.userArn}
                  type="button"
                  className={`mention-option ${index === selectedMentionIndex ? 'mention-option--active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(member);
                  }}
                  onMouseEnter={() => setSelectedMentionIndex(index)}
                >
                  <span className="mention-option-name">{member.isAll ? '@' : mentionTrigger}{member.name}</span>
                  {member.isBot && <span className="mention-option-badge">BOT</span>}
                  {'isAll' in member && member.isAll && <span className="mention-option-badge mention-option-badge--all">ALL</span>}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="message-textarea"
            placeholder={
              !activeConversation
                ? 'Select a conversation to start messaging'
                : isArchived
                  ? t('conversation.readOnlyNotice')
                  // WHO IS THIS REPLY FOR. The chips above the field route the send, but the field
                  // itself said "Type your message…", so a user typing into it had nothing telling
                  // them where it lands - and with two sides waiting, the routing decision is the one
                  // thing they most need to see. Name the recipient in the field they are looking at.
                  : selectedWaiting
                    ? (replyingToSides.length === 1
                        ? t('conversation.placeholderBattleReply', { name: botDisplayName(selectedWaiting.botArn) })
                        : t('conversation.placeholderBattleReplyBoth'))
                    // AN OUTSIDE-AUDIENCE CONVERSATION SAYS SO WHERE THE PERSON TYPES: a person with an
                    // inside and an outside conversation open reads, in the field itself, that this one
                    // is seen by the customer.
                    : classificationAudience(activeConversation.modelTier) === 'outside'
                      ? t('conversation.placeholderOutside')
                      : isMultiUser && assistantHere
                        ? t('conversation.placeholderMultiUser')
                        : t('conversation.placeholder')
            }
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            rows={1}
          />
        </div>
        <button
          type="submit"
          className="send-button"
          disabled={isDisabled || (!input.trim() && !stagedFile)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="send-icon"
          >
            <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
          </svg>
        </button>
      </form>
    </div>
  );
};

export default MessageInput;
