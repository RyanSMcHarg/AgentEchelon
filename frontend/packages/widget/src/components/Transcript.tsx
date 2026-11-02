/**
 * The conversation, as an ARIA live region: `role="log"` with `aria-live="polite"`, so a screen reader
 * announces each new message (the assistant's answer included) without moving focus, and the status
 * line beside it is a `role="status"` region of its own.
 *
 * It scrolls by the chat app's rule (`useFollowBottom`): at the bottom it follows new messages and any
 * message that grows, and scrolled up it stays where the visitor is and offers a jump to the newest.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFollowBottom } from '@ae/shared/hooks/useFollowBottom.ts';
import type { ChannelStatus, TranscriptMessage } from '../messaging/useChannel';
import { renderMarkdown } from '../messaging/markdown';

export function Transcript({ messages, status }: { messages: TranscriptMessage[]; status: ChannelStatus }) {
  const { t, i18n } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The widget holds one conversation, so it opens following and never changes conversation.
  const { showJump, jumpToBottom, onScroll } = useFollowBottom({ containerRef: listRef, contentRef, changeKey: messages, resetKey: 'widget' });

  const statusText = status === 'connecting'
    ? t('widget.status.connecting')
    : status === 'reconnecting'
      ? t('widget.status.reconnecting')
      : status === 'sendFailed'
        ? t('widget.status.sendFailed')
        : '';

  return (
    <>
      <div
        ref={listRef}
        className="aeaw__messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={t('widget.transcript')}
        tabIndex={0}
        onScroll={onScroll}
      >
        <div ref={contentRef} className="aeaw__messages-content">
          {messages.map((m) => {
            const who = m.mine ? t('widget.you') : m.fromAssistant ? t('widget.assistant') : m.senderName || t('widget.someone');
            const time = m.createdAt
              ? new Date(m.createdAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
              : '';
            return (
              <div key={m.id} className={'aeaw__row ' + (m.mine ? 'aeaw__row--mine' : 'aeaw__row--other')}>
                <div className="aeaw__meta">{[who, time].filter(Boolean).join(' · ')}</div>
                {m.text && <div className={'aeaw__msg ' + (m.mine ? 'aeaw__msg--mine' : 'aeaw__msg--other')}>{renderMarkdown(m.text)}</div>}
              </div>
            );
          })}
        </div>
      </div>
      {showJump && (
        <button type="button" className="aeaw__jump" onClick={jumpToBottom}>
          {t('widget.jumpToNewest')}
        </button>
      )}
      <div className="aeaw__status" role="status">{statusText}</div>
    </>
  );
}
