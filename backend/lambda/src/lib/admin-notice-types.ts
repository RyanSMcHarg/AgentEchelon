/**
 * THE PLATFORM'S NOTICE TYPES (DESIGN-EVENT-TARGETS section 12): every `ae.alert` a component raises, by the `messageType` it
 * carries as its `detail-type`, the templates the admin assistant words it from, and whether it is a security notice.
 *
 * AdminServices owns one rule per entry, each posting into the admin notifications conversation. A security notice's rule is
 * always enabled: the trigger service holds no grant on it and refuses a request naming it. An operational notice's rule is
 * switched on or off by an administrator through the trigger service, and the switch survives a deploy because the rule's
 * state is read from a parameter no stack owns (`adminNoticeStateParam`).
 *
 * A raiser's `messageType` and template are checked against this catalog by `every-admin-notice-type-is-catalogued.test.ts`,
 * so a notice never goes unrouted.
 */

/** The boundary refusal alarm's name ends with this (`AssistantRefusedByClassificationAlarm`, the Archive stack, ADR-045). */
export const BOUNDARY_REFUSAL_ALARM_SUFFIX = '-assistant-refused-by-classification';

/** The `messageType` every CloudWatch alarm's notice carries (`alarm-to-admin-channel.ts`). */
export const ALARM_MESSAGE_TYPE = 'cloudwatch_alarm';

export interface AdminNoticeType {
  /** The entry's own key: its rule's construct id, its state parameter and the form's row. */
  key: string;
  /** The `detail-type` the raiser's `ae.alert` carries. */
  messageType: string;
  /** The admin assistant's templates (`admin-notice-templates.ts`) the notice is worded from. */
  templates: readonly string[];
  /** Always on: the trigger service can neither switch nor change its rule. */
  security: boolean;
  /** For an alarm notice, which alarms the rule takes, by the alarm's name in `detail.notice.extra.alarmName`. */
  alarms?: 'boundary-refusal' | 'every-other';
}

export const ADMIN_NOTICE_TYPES: readonly AdminNoticeType[] = [
  { key: 'membership-audit', messageType: 'membership_audit_finding', templates: ['uncleared-membership', 'recorded-clearance-mismatch'], security: true },
  { key: 'activated-past-golden-gate', messageType: 'activated-past-golden-gate', templates: ['activated-past-golden-gate'], security: true },
  { key: 'boundary-refusal-alarm', messageType: ALARM_MESSAGE_TYPE, templates: ['cloudwatch-alarm'], security: true, alarms: 'boundary-refusal' },
  { key: 'alarm', messageType: ALARM_MESSAGE_TYPE, templates: ['cloudwatch-alarm'], security: false, alarms: 'every-other' },
  { key: 'assistant-error', messageType: 'assistant_error', templates: ['assistant-error'], security: false },
  { key: 'turn-not-started', messageType: 'turn_not_started', templates: ['turn-not-started'], security: false },
  { key: 'connector-grant-unrevoked', messageType: 'connector_grant_unrevoked', templates: ['connector-grant-unrevoked'], security: false },
  { key: 'guest-unavailable', messageType: 'guest-unavailable', templates: ['guest-unavailable'], security: false },
  { key: 'clean-copy-run', messageType: 'clean_copy_run', templates: ['clean-copy-run'], security: false },
];

/** An operational notice by its key, or undefined for a security notice or an unknown key. */
export function switchableNotice(key: unknown): AdminNoticeType | undefined {
  return ADMIN_NOTICE_TYPES.find((t) => t.key === key && !t.security);
}

/** The parameter holding an operational notice's rule state, `ENABLED` or `DISABLED`, which no stack owns. */
export function adminNoticeStateParam(ssmRoot: string, key: string): string {
  return `${ssmRoot}/admin-notices/${key}/state`;
}

/** The name of a notice's rule, outside the trigger service's rule prefix (`<prefix>-*-trigger-*`). */
export function adminNoticeRuleName(stackPrefix: string, key: string): string {
  return `${stackPrefix}-admin-notice-${key}`;
}

export const NOTICE_STATES = ['ENABLED', 'DISABLED'] as const;
