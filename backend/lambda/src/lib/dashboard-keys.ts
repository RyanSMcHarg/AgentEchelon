/**
 * THE ONE KEY FAMILY A CONVERSATION'S DASHBOARD LIVES UNDER (DESIGN-CONVERSATION-DASHBOARDS section 3), and the one place
 * it is spelled. The tool that writes it, the exchange that vends a member's read, the link that signs a page, the grants
 * and the page distribution all name their objects through here, so a writer and a reader can never name different keys.
 *
 * `dashboards/<classification>/<conversation id>/snapshot.json` and `.../page.html`: the classification is in the key, so
 * every grant on it names the classification from the session's tag and IAM refuses the crossing case (tenet D15).
 */

/** A conversation id: the alphabet the platform mints channel ids in, a deployer's type key's underscore included. */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A classification as a key segment. */
const CLASSIFICATION = /^[a-z0-9-]{1,32}$/;

/** The family's root, which its lifecycle rule and its grants are scoped to. */
export const DASHBOARDS_FAMILY = 'dashboards/';

/** The two objects a conversation's dashboard is: the in-app snapshot and the hosted page. */
export type DashboardMode = 'snapshot' | 'page';
const OBJECT: Readonly<Record<DashboardMode, string>> = { snapshot: 'snapshot.json', page: 'page.html' };

/** A classification's dashboards, the prefix an assistant's write and a member's read are each scoped to. */
export const dashboardPrefix = (classification: string): string => `${DASHBOARDS_FAMILY}${classification}/`;

/** Every classification's dashboard pages, the one kind of object the page distribution may read. */
export const DASHBOARD_PAGE_OBJECTS = `${DASHBOARDS_FAMILY}*/${OBJECT.page}`;

/** The conversation's id from its channel ARN. */
export const conversationIdOf = (channelArn: string): string => channelArn.split('/').pop() ?? '';

/** One dashboard object's key, or null when the classification or the conversation id is not one. */
export function dashboardKey(classification: string, conversationId: string, mode: DashboardMode): string | null {
  if (!CLASSIFICATION.test(classification) || !CONVERSATION_ID.test(conversationId)) return null;
  return `${dashboardPrefix(classification)}${conversationId}/${OBJECT[mode]}`;
}

/** The page's address on the dashboard distribution, or null when it names no page. */
export function dashboardPageUrl(domain: string, classification: string, conversationId: string): string | null {
  const key = domain ? dashboardKey(classification, conversationId, 'page') : null;
  return key ? `https://${domain}/${key}` : null;
}
