import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';

/**
 * The work a person still owes, across every assistant and every conversation.
 *
 * WHY THIS IS A QUEUE AND NOT A NOTIFICATION. An assistant that needs something from you blocks until
 * you answer. One is a prompt; four, spread over four conversations opened on different days, is a
 * pile - and the one you have forgotten is by definition in the conversation you are not looking at.
 * So this lists them oldest first, names the conversation each belongs to, and takes you there.
 *
 * WHY IT PROMPTS RATHER THAN WAITING TO BE FOUND. A queue nobody opens is a queue that does not exist.
 * It states the count in one line the user cannot miss, and expands on demand rather than occupying
 * the screen: this is an obligation, not a workspace.
 *
 * It renders NOTHING when there is nothing owed, and nothing when the endpoint is unconfigured - a
 * deployment without the queue simply does not have one, which must not look like an error.
 */
export function OpenWorkItems() {
  const {
    openWorkItems, conversations, selectConversation, activeConversation, battleWaitingBots,
  } = useConversations();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // A BATTLE HOLDS THE FLOOR. While a duel is waiting on this person, the only item they can answer is
  // the duel's own: a reply routed at some other workflow would advance that machine while two
  // assistants sit mid-comparison, and the duel cannot proceed until it has its answer.
  //
  // The others stay VISIBLE and become unselectable, which is the whole distinction - hiding them would
  // tell the user their outstanding work had gone away, and they would stop looking for it. They come
  // back the moment the battle resolves or Battle Mode is turned off.
  const battleHoldsTheFloor = battleWaitingBots.length > 0;
  const battleChannelArn = activeConversation?.conversationArn;

  // The conversation each item belongs to, so the queue can say WHERE rather than only WHAT. An item
  // whose conversation this client cannot see still lists - it is still owed - it just cannot be
  // jumped to, which is honest about what the client knows.
  const rows = useMemo(
    () =>
      openWorkItems.map((item) => ({
        item,
        conversation: conversations.find((c) => c.conversationArn === item.channelArn),
      })),
    [openWorkItems, conversations],
  );

  if (rows.length === 0) return null;

  return (
    <section className="open-work-items" aria-label={t('workItems.regionLabel')}>
      <button
        type="button"
        className="open-work-items-summary"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="open-work-items-count">{rows.length}</span>
        <span className="open-work-items-headline">
          {rows.length === 1 ? t('workItems.headlineOne') : t('workItems.headlineMany', { count: rows.length })}
        </span>
      </button>

      {expanded && (
        <ul className="open-work-items-list">
          {rows.map(({ item, conversation }) => {
            // The item you are already looking at is not something to navigate to; say so, so the
            // queue does not send you where you already are.
            const isHere = activeConversation?.conversationArn === item.channelArn;
            // Blocked only when a duel is waiting and this item is not part of it. The duel's own item
            // stays answerable, or the battle could never be resolved from here.
            const blockedByBattle = battleHoldsTheFloor && item.channelArn !== battleChannelArn;
            return (
              <li
                key={item.taskId}
                className={`open-work-items-item${blockedByBattle ? ' open-work-items-item--blocked' : ''}`}
                aria-disabled={blockedByBattle || undefined}
              >
                <div className="open-work-items-item-text">
                  <span className="open-work-items-item-title">{item.title || item.taskType}</span>
                  <span className="open-work-items-item-where">
                    {blockedByBattle
                      ? t('workItems.blockedByBattle')
                      : isHere
                        ? t('workItems.here')
                        : conversation?.title || t('workItems.otherConversation')}
                  </span>
                </div>
                {!isHere && conversation && (
                  <button
                    type="button"
                    className="open-work-items-item-go"
                    onClick={() => selectConversation(conversation.id)}
                    disabled={blockedByBattle}
                    title={blockedByBattle ? t('workItems.blockedByBattle') : undefined}
                  >
                    {t('workItems.finish')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
