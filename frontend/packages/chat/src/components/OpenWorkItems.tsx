import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import { isUnnamedConversation } from '../utils/conversationTitle';

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
/**
 * A task type a person can read, when the item carries no title of its own.
 *
 * The fallback rendered the RAW KEY - a queue row reading `report_generation` rather than "Report
 * generation". Task types are declared per deployment (an intent pack may add its own), so there is no
 * table to look them up in and inventing one would go stale the first time a deployment declared a type
 * it did not know about. Reshaping the key is what the backend already does for the same problem on the
 * status chip, and it degrades gracefully for a type nobody anticipated.
 *
 * A title, when the item has one, always wins: it says what THIS work is, not what kind of work it is.
 */
function readableTaskType(taskType: string | undefined): string {
  if (!taskType) return '';
  const words = taskType.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function OpenWorkItems() {
  const {
    openWorkItems, conversations, selectConversation, activeConversation, battleWaitingBots,
    answerItem, answeringTaskId,
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

  // The conversation each item belongs to, so the queue can say WHERE rather than only WHAT.
  //
  // AN ITEM WHOSE CONVERSATION IS NOT IN THE LOCAL LIST IS STILL REACHABLE. This used to list such an
  // item without a way to open it, on the reasoning that the client should not offer what it cannot
  // do - but it can: `selectConversation` resolves a channel that is not yet listed via DescribeChannel,
  // which is the same deep-link path a drift navigation marker uses. The conversation id is the ARN's
  // last segment. So the queue can always take you there, and the missing entry only costs it a NAME.
  const rows = useMemo(
    () =>
      openWorkItems.map((item) => ({
        item,
        conversation: conversations.find((c) => c.conversationArn === item.channelArn),
        targetId: item.channelArn?.split('/').pop(),
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
          {rows.map(({ item, conversation, targetId }) => {
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
                  <span className="open-work-items-item-title">
                    {/* The reference a person types to answer it, on any channel (ADR-035). */}
                    {item.taskRef ? <span className="open-work-items-item-ref">#{item.taskRef} </span> : null}
                    {item.title || readableTaskType(item.taskType)}
                  </span>
                  <span className="open-work-items-item-where">
                    {blockedByBattle
                      ? t('workItems.blockedByBattle')
                      : isHere
                        ? t('workItems.here')
                        : conversation?.title && !isUnnamedConversation(conversation.title) ? conversation.title : t('workItems.otherConversation')}
                  </span>
                  {/*
                    * WHAT FINISHING IT ACTUALLY INVOLVES, when the step declares it.
                    *
                    * The row said which work was outstanding and never what was being asked for, so a
                    * person had to open the conversation and read back to find out - for every item,
                    * including the ones they opened only to discover they could not answer yet. The
                    * machine already declares this per state and the server sends it only for a state
                    * that awaits somebody, so anything rendered here is genuinely theirs to answer.
                    */}
                  {item.needs?.length ? (
                    <span className="open-work-items-item-needs">
                      <span className="open-work-items-item-needs-label">{t('workItems.needsLabel')}</span>
                      {item.needs.join(', ')}
                    </span>
                  ) : null}
                </div>
                {/*
                  * Offered whenever there is somewhere to go, which is whenever the item names a
                  * channel. It used to require the conversation to be in the local list, so an item in
                  * a conversation this client had not loaded listed with no way to reach it - the one
                  * case where the queue is most useful, since the work you have forgotten is by
                  * definition not in front of you. `selectConversation` resolves an unlisted channel
                  * on its own.
                  */}
                {!isHere && targetId && (
                  <button
                    type="button"
                    className="open-work-items-item-go"
                    onClick={() => {
                      // Going there to finish it IS choosing to answer it, so the composer is ready
                      // with the reference when the conversation opens.
                      answerItem(item);
                      selectConversation(conversation?.id ?? targetId);
                    }}
                    disabled={blockedByBattle}
                    title={blockedByBattle ? t('workItems.blockedByBattle') : undefined}
                  >
                    {t('workItems.finish')}
                  </button>
                )}
                {/*
                  * ANSWER, FOR AN ITEM IN THIS CONVERSATION (ADR-035). The list said "in this
                  * conversation" and offered nothing, so a person with two items here had no way to say
                  * which one their reply was for. This puts the item's reference at the start of the
                  * composer, which is exactly what typing it does on any other channel.
                  */}
                {isHere && (
                  <button
                    type="button"
                    className="open-work-items-item-go"
                    onClick={() => answerItem(item)}
                    disabled={blockedByBattle}
                    aria-pressed={answeringTaskId === item.taskId}
                  >
                    {t('workItems.answer')}
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
