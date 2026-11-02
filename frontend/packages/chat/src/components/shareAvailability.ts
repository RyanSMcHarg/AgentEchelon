/**
 * Why Share is unavailable in a conversation, or '' when it is available.
 *
 * A conversation whose people come from a group (or a fixed list) is kept equal to that source by the
 * membership reconcile, so a person invited through Share would be silently removed. The button shows
 * disabled with this reason as its tooltip. `membershipSource` is a DISPLAY HINT from channel Metadata
 * (`group:ops`, `list`, `group:ops+list`); the share API refuses from its own server-side record whatever
 * this returns.
 */
export function shareDisabledReason(
  membershipSource: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!membershipSource) return '';
  const group = /group:([^+]+)/.exec(membershipSource)?.[1];
  return group ? t('conversation.shareDisabledGroup', { group }) : t('conversation.shareDisabledList');
}
