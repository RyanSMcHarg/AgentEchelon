/**
 * WHAT A CONVERSATION'S HEADER SAYS ABOUT ITS CLASSIFICATION AND ITS AUDIENCE.
 *
 * Both come from the classification's definition, as the deployment declares it (`GET /classifications`,
 * `@ae/shared` `config/classifications.ts`), never from its name:
 *
 *  - the badge reads the classification's display name, in the color its `badgeToken` names;
 *  - the audience label says who the conversation is for. An outside-audience conversation (a guest's,
 *    a customer's) says it is visible to the customer, and the header carries a distinct treatment
 *    (`conversation-header--outside`), so a person holding an inside and an outside conversation open
 *    sees which one they are typing into.
 *
 * Display only: what a person may read or post is the channel's immutable classification tag, in IAM.
 */
import { useTranslation } from 'react-i18next';
import { classificationAudience, classificationBadgeStyle, classificationName } from '@ae/shared/config/classifications.ts';

export function ClassificationBadge({ value, title }: { value: string; title?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="conversation-header-tier"
      title={title}
      style={classificationBadgeStyle(value)}
      data-classification={value}
      aria-label={t('conversation.classificationLabel', { name: classificationName(value) })}
    >
      <span className="conversation-header-tier-dot" aria-hidden="true" />
      {classificationName(value)}
    </span>
  );
}

export function AudienceLabel({ value }: { value: string }) {
  const { t } = useTranslation();
  const audience = classificationAudience(value);
  return (
    <span className={audience === 'outside' ? 'conversation-header-audience' : 'conversation-header-audience-members'} data-audience={audience}>
      {t(`conversation.audience.${audience}`)}
    </span>
  );
}

/** The header's own class for a conversation at this classification: outside ones are marked. */
export function headerAudienceClass(value: string | null | undefined): string {
  return classificationAudience(value) === 'outside' ? ' conversation-header--outside' : '';
}
