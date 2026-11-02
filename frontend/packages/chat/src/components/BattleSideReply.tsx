import { useTranslation } from 'react-i18next';

/**
 * The answer control on a duel side's message while that side waits on the person (DESIGN-BATTLE,
 * "A side parked on the person").
 *
 * A side parks when its own task chain needs input: an image brief's confirm step, a report's
 * requirements, or a clarifying question. It resumes only on a reply targeted at it from the person who
 * ran `/battle`. For that person this offers "Reply to this side", which puts the composer into a
 * reply-to-side mode the composer labels with the side's name and lets them cancel, and, when both sides
 * wait, "Answer both sides". Everyone else reads whom the side is waiting on, so a member who did not
 * start the duel is told it is not theirs to answer rather than being offered a reply that resumes
 * nothing.
 */
export interface BattleSideReplyProps {
  /** The side's assistant ARN, stamped on the control so a test or a tool can find this side's control. */
  sideArn?: string;
  /** The side's display name, as its message header shows it. */
  sideName: string;
  /** Whether this viewer is the person the side waits on (`mayAnswerSide`). */
  canAnswer: boolean;
  /** The name of the person the side waits on, for the note everyone else reads. */
  ownerName?: string;
  /** This side is the one the composer is replying to right now. */
  replying: boolean;
  /** Offer "Answer both sides": every side of this duel waits on this viewer. */
  offerBoth: boolean;
  /** Reply to this side alone. */
  onReply: () => void;
  /** Reply to every waiting side at once. */
  onReplyBoth: () => void;
}

export function BattleSideReply({
  sideArn, sideName, canAnswer, ownerName, replying, offerBoth, onReply, onReplyBoth,
}: BattleSideReplyProps) {
  const { t } = useTranslation();

  if (!canAnswer) {
    return (
      <p className="battle-side-reply-note" role="status" data-side-arn={sideArn}>
        {ownerName
          ? t('conversation.battleSide.waitingOn', { name: ownerName })
          : t('conversation.battleSide.waitingOnOwner')}
      </p>
    );
  }

  return (
    <div className="battle-side-reply" data-side-arn={sideArn} role="group" aria-label={t('conversation.battleSide.groupLabel', { name: sideName })}>
      <button
        type="button"
        className="btn btn-secondary btn-sm battle-side-reply-button"
        onClick={onReply}
        aria-pressed={replying}
        aria-label={t('conversation.battleSide.replyAria', { name: sideName })}
      >
        {t('conversation.battleSide.reply')}
      </button>
      {offerBoth && (
        <button
          type="button"
          className="btn btn-ghost btn-sm battle-side-reply-both"
          onClick={onReplyBoth}
          aria-label={t('conversation.battleSide.replyBothAria')}
        >
          {t('conversation.battleSide.replyBoth')}
        </button>
      )}
    </div>
  );
}

export default BattleSideReply;
