/**
 * THE ONE PLACE AN `ae.alert` BECOMES A MESSAGE: the `AdminServices` stack's rule on the default bus
 * delivers each platform alert here, and it is posted into the admin notification channel as the admin
 * assistant (`lib/admin-channel-post.ts`). The channel flow's `notify` directive then emails the admin roster.
 *
 * The rule matches this instance's alerts only (`detail.instance`), so the check here is the second
 * layer: an event from another instance, or one that is not a notice, is dropped and logged.
 *
 * SAID IN THE ADMIN ASSISTANT'S WORDS (ADR-062 decision 6). A notice that names its template (`words`) is said from the admin
 * assistant's own template of that name, `templates/admin/_assistants/admin-agent/<name>/`, else the shipped one
 * (`admin-notice-templates.ts`); this function's role reads that one family and no other. The wording the event carries
 * is the shipped one, said when no template of the admin assistant's can say it.
 *
 * A failed post throws, so EventBridge retries it: the post is the whole of this function's job, and a
 * notice that never reached the channel is the failure an operator must not have to infer.
 */
import type { EventBridgeEvent } from 'aws-lambda';
import { deliverAdminNotice } from './lib/admin-channel-post.js';
import { ALERT_SOURCE, type AdminNotice, type AlertDetail } from './lib/admin-notice.js';
import {
  ADMIN_NOTICE_ASSISTANT, ADMIN_NOTICE_CLASSIFICATION, adminNoticeTemplate, renderAdminNotice, shippedAdminNotices, type AdminFamilyReader,
} from './lib/admin-notice-templates.js';
import { loadTemplate, TemplateNotActiveError } from './lib/template-store.js';

/** The admin assistant's own template of a name, or undefined when its family holds none active. */
const readAdminFamily: AdminFamilyReader = async (name) => {
  try {
    const loaded = await loadTemplate(ADMIN_NOTICE_CLASSIFICATION, { name }, undefined, {
      owner: { family: 'assistant', assistant: ADMIN_NOTICE_ASSISTANT }, kind: 'message',
    });
    return loaded.template;
  } catch (err) {
    if (err instanceof TemplateNotActiveError) return undefined;
    throw err;
  }
};

/**
 * THE NOTICE IN THE WORDS IT IS SAID IN: from the template it names, the admin assistant's own before the shipped one, with
 * its values. A notice that names no template the platform ships, or whose template cannot say it, keeps the wording it
 * carries.
 */
export async function wordedNotice(notice: AdminNotice, readOwn: AdminFamilyReader = readAdminFamily): Promise<AdminNotice> {
  const words = notice.words;
  if (!words || typeof words.name !== 'string' || !shippedAdminNotices().has(words.name)
    || !words.values || typeof words.values !== 'object' || Array.isArray(words.values)) return notice;
  const { template, origin } = await adminNoticeTemplate(words.name, readOwn);
  const said = renderAdminNotice(template, words);
  if (!said) {
    console.warn('[admin-alert-poster] the notice\'s template could not say it; its carried wording is posted', { template: words.name, origin });
    return notice;
  }
  return { ...notice, ...said };
}

/** The handler's body, with the admin assistant's family reader injectable for a test. */
export async function postAlert(
  event: EventBridgeEvent<string, AlertDetail>,
  readOwn: AdminFamilyReader = readAdminFamily,
): Promise<{ posted: boolean }> {
  const notice = event?.detail?.notice;
  if (event?.source !== ALERT_SOURCE || event?.detail?.instance !== process.env.ALERT_INSTANCE
    || !notice || typeof notice.content !== 'string' || typeof notice.subject !== 'string' || typeof notice.messageType !== 'string') {
    console.warn('[admin-alert-poster] not an alert for this instance; dropped', { source: event?.source, detailType: event?.['detail-type'] });
    return { posted: false };
  }
  const worded = await wordedNotice(notice, readOwn);
  const posted = await deliverAdminNotice(worded);
  if (!posted) throw new Error(`the ${notice.messageType} alert was not posted to the admin channel`);
  // THE RECEIPT an operator (and the e2e) reads to tell a posted alert from a dropped one.
  console.log(`[admin-alert-poster] posted ${notice.messageType} to the admin channel`, { subject: worded.subject });
  return { posted };
}

export const handler = (event: EventBridgeEvent<string, AlertDetail>): Promise<{ posted: boolean }> => postAlert(event);
