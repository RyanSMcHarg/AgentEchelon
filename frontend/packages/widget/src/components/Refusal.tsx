/**
 * A settled refusal state (D-4): a heading, what happened, and what to do next, for each reason code the
 * server gives. Never a raw error, never an empty widget. Announced with `role="alert"`.
 */
import { useTranslation } from 'react-i18next';
import type { RefusalCode } from '../session/personApi';

/** The refusals whose way forward is a new conversation rather than another try. */
const RELOAD: ReadonlySet<RefusalCode> = new Set(['replayed', 'revoked', 'expired', 'ended']);
/** The refusals with no action the person can take from the widget. */
const NO_ACTION: ReadonlySet<RefusalCode> = new Set(['paused', 'not_provisioned', 'refused']);
/** The refusals whose way forward, beside any retry, is the host's declared contact route. */
const CONTACT: ReadonlySet<RefusalCode> = new Set(['paused', 'unavailable']);

export function Refusal({
  code,
  retryAfterSeconds,
  onRetry,
  onReload,
  contact,
}: {
  code: RefusalCode;
  retryAfterSeconds?: number;
  onRetry?: () => void;
  onReload?: () => void;
  /** The host's declared contact route (`contactRoute`), shown where waiting is the only other answer. */
  contact?: string | null;
}) {
  const { t } = useTranslation();
  const action = NO_ACTION.has(code)
    ? null
    : RELOAD.has(code)
      ? onReload && { label: t('widget.actions.reload'), run: onReload }
      : onRetry && { label: t('widget.actions.retry'), run: onRetry };
  return (
    <div className="aeaw__refusal" role="alert" data-code={code}>
      <h3 className="aeaw__refusal-title">{t(`widget.refused.${code}.title`)}</h3>
      <p className="aeaw__refusal-body">{t(`widget.refused.${code}.body`, { seconds: retryAfterSeconds ?? 60 })}</p>
      {action && (
        <button type="button" className="aeaw__action" onClick={action.run}>
          {action.label}
        </button>
      )}
      {contact && CONTACT.has(code) && (
        <a className="aeaw__secondary aeaw__link-action" href={contact} target="_blank" rel="noopener noreferrer">
          {t('widget.actions.contact')}
        </a>
      )}
    </div>
  );
}
