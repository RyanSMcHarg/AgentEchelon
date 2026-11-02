/**
 * WHAT THE PERSON ARRIVED WITH CAME TO: a sign-in invitation (M-10) or a visit kept from the widget (paths A
 * and B). One settled, localized notice above the conversations, never a raw error, each with what to do next:
 *
 *  - an invitation that joined: its conversation is open; one refused: why, and for `wrong_account` (an
 *    account that already exists signed in) "Sign out and continue", which makes the invitation pending
 *    again for a new account and never binds this one;
 *  - a visit kept: its conversation is open (a bind's continuation, `bound.conversationArn`, or a claim's
 *    conversation); one whose conversation could not be opened yet: "Try again", which makes the same call;
 *    one refused: why, and where to go (an existing account is pointed at path B in the widget).
 *
 * The notice is a `status` region, so it is announced without taking focus.
 */
import { useTranslation } from 'react-i18next';
import type { InvitationOutcome, UpgradeOutcome } from '@ae/shared';

export function ArrivalNotice({
  invitation,
  upgrade,
  retrying,
  onRetry,
  onSignOutAndContinue,
  onDismiss,
}: {
  invitation: InvitationOutcome | null;
  upgrade: UpgradeOutcome | null;
  retrying?: boolean;
  onRetry: () => void;
  onSignOutAndContinue: (invitationToken: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  if (!invitation && !upgrade) return null;

  let tone: 'success' | 'warning' = 'success';
  let message = '';
  let action: { label: string; run: () => void; busy?: boolean } | null = null;
  let code = '';
  if (upgrade) {
    if ('opened' in upgrade) {
      message = t(`upgrade.opened.${upgrade.path}`);
      code = 'opened';
    } else if ('pending' in upgrade) {
      tone = 'warning';
      message = t(`upgrade.pending.${upgrade.pending}`);
      action = { label: retrying ? t('upgrade.retrying') : t('upgrade.retry'), run: onRetry, busy: retrying };
      code = 'pending';
    } else {
      tone = 'warning';
      message = t(`upgrade.refused.${upgrade.refused}`, { defaultValue: t('upgrade.refused.unknown') });
      code = upgrade.refused;
    }
  } else if (invitation) {
    if ('joined' in invitation) {
      message = t('invitation.joined');
      code = 'joined';
    } else {
      tone = 'warning';
      message = t(`invitation.refused.${invitation.refused}`, { defaultValue: t('invitation.refused.unknown') });
      code = invitation.refused;
      const token = invitation.retryToken;
      if (invitation.refused === 'wrong_account' && token) action = { label: t('invitation.signOutAndContinue'), run: () => onSignOutAndContinue(token) };
    }
  }

  return (
    <div className={`alert alert-${tone} arrival-notice`} role="status" data-code={code}>
      <span>{message}</span>
      {action && (
        <button type="button" className="btn btn-primary" onClick={action.run} disabled={action.busy} aria-busy={action.busy || undefined}>
          {action.label}
        </button>
      )}
      <button type="button" className="btn btn-secondary" onClick={onDismiss}>{t('invitation.dismiss')}</button>
    </div>
  );
}
