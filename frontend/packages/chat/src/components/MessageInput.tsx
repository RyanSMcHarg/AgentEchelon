import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import { useAuth } from '@ae/shared';
import { uploadFile } from '../services/attachmentService';
import FileUploadPreview from './FileUploadPreview';
import { markMessageSent } from '../services/messageLatencyTracker';
import { trackEvent } from '@ae/shared';
import { parseMentions, mentionValidationMessage } from '../utils/mentionParser';
import type { ChannelMember, StickyMentionTarget } from '@ae/shared';
import './MessageInput.css';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { activeConversation, sendMessage, isSending, sendError, clearSendError, channelMembers, stickyTarget, setStickyTarget, battleWaitingBots } = useConversations();
  const { user } = useAuth();

  const everyoneMember: StickyMentionTarget = { userArn: 'EVERYONE', name: 'all', isBot: false, isAll: true };

  const humanCount = channelMembers.filter((m) => !m.isBot).length;
  const isMultiUser = humanCount >= 2;

  // /battle "Replying to:" — when a bot is blocked on the user, the next
  // send is routed targeted to it (Chime Target → continuation router,
  // 2B-x-b/c). I (FIFO): in a multi-turn battle, queue clarifications in
  // the order they arrived so the user answers them oldest-first. The
  // battleWaitingBots array is derived from a Map (insertion-ordered) so
  // index 0 is the oldest waiter. User can still switch via the picker.
  const [pickedWaitingBot, setPickedWaitingBot] = useState<string | null>(null);
  const selectedWaiting =
    battleWaitingBots.length > 0
      ? (battleWaitingBots.find((w) => w.botArn === pickedWaitingBot)
          ?? battleWaitingBots[0])
      : null;
  const botDisplayName = (arn: string) =>
    channelMembers.find((m) => m.userArn === arn)?.name || 'assistant';

  // Build mention options: filter out current user, add @all when 3+ members
  const getMentionOptions = useCallback((): (ChannelMember & { isAll?: boolean })[] => {
    const userArn = user?.userArn;
    const others = channelMembers.filter((m) => m.userArn !== userArn);

    const options: (ChannelMember & { isAll?: boolean })[] = [];

    // Add @all when 3+ members (user + bot + at least 1 shared user)
    const humanMembers = channelMembers.filter((m) => !m.isBot);
    if (humanMembers.length >= 2) {
      options.push({ userArn: 'EVERYONE', name: 'all', isBot: false, isAll: true });
    }

    options.push(...others);

    if (!mentionFilter) return options;
    const filter = mentionFilter.toLowerCase();
    return options.filter((m) => m.name.toLowerCase().includes(filter));
  }, [channelMembers, user?.userArn, mentionFilter]);

  const insertMention = useCallback((member: ChannelMember & { isAll?: boolean }) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBefore = input.substring(0, cursorPos);
    const textAfter = input.substring(cursorPos);

    // Find the @ that triggered the dropdown
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex === -1) return;

    const mention = member.isAll ? '@all ' : `@${member.name} `;
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
  }, [input]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    // Detect @ mention pattern
    const cursorPos = e.target.selectionStart;
    const textBefore = value.substring(0, cursorPos);
    const match = textBefore.match(/@([\w ]*)$/);

    if (match) {
      setMentionFilter(match[1] || '');
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
        // /battle clarification reply: send the raw text TARGETED to the
        // waiting bot. Targeting is structural (Chime Target → the
        // 2B-x-b/c continuation router), so no sticky prefix and no
        // @-mention parsing; the rival bot never sees it.
        const battleContent = input.trim() || `[Attached: ${attachment?.name}]`;
        await sendMessage(battleContent, attachment, { targetArn: selectedWaiting.botArn });
      } else {
        // If a sticky target is set and the user didn't type their own @-mention,
        // prepend the sticky mention so it carries over to the next send.
        let effectiveContent = input.trim();
        if (stickyTarget && !effectiveContent.startsWith('@')) {
          const prefix = stickyTarget.isAll ? '@all' : `@${stickyTarget.name}`;
          effectiveContent = effectiveContent ? `${prefix} ${effectiveContent}` : prefix;
        }

        const fallbackContent = effectiveContent || `[Attached: ${attachment?.name}]`;
        const userArn = user.userArn || '';
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

        const sendOptions = mentions.isAtAll
          ? undefined
          : (mentions.targetArn || mentions.mentionBotArn)
            ? { targetArn: mentions.targetArn, mentionBotArn: mentions.mentionBotArn }
            : undefined;

        await sendMessage(fallbackContent, attachment, sendOptions);

        // Update sticky target from what the user just sent so the next
        // message carries the same mention forward.
        if (mentions.isAtAll) {
          setStickyTarget(everyoneMember);
        } else if (mentions.targetArn) {
          const targeted = channelMembers.find((m) => m.userArn === mentions.targetArn);
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
      setShowMentionDropdown(false);
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
      {displayError && (
        <div className="message-input-error">
          <span>{displayError}</span>
          <button onClick={() => { setUploadError(null); setMentionError(null); clearSendError(); }}>&times;</button>
        </div>
      )}
      {selectedWaiting ? (
        <div className="message-input-sticky-target" role="status">
          <span className="message-input-sticky-target-label">{t('conversation.replyingTo')}</span>
          {battleWaitingBots.length === 1 ? (
            <span className="message-input-sticky-target-chip message-input-sticky-target-chip--bot">
              @{botDisplayName(selectedWaiting.botArn)}
            </span>
          ) : (
            battleWaitingBots.map((w) => (
              <button
                key={w.botArn}
                type="button"
                className={`message-input-sticky-target-chip message-input-sticky-target-chip--bot message-input-sticky-target-chip--button${w.botArn === selectedWaiting.botArn ? ' message-input-sticky-target-chip--active' : ''}`}
                onClick={() => setPickedWaitingBot(w.botArn)}
                aria-pressed={w.botArn === selectedWaiting.botArn}
              >
                @{botDisplayName(w.botArn)}
              </button>
            ))
          )}
          <span className="message-input-sticky-target-hint">
            {battleWaitingBots.length === 1
              ? t('conversation.battleWaitingOne')
              : t('conversation.battleWaitingMany', { count: battleWaitingBots.length })}
          </span>
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
        className={`message-input-form ${isDragOver ? 'message-input-form--drag-over' : ''}`}
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
            <div className="mention-dropdown">
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
                  <span className="mention-option-name">@{member.name}</span>
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
                  : isMultiUser
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
