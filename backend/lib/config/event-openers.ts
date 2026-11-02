/**
 * WHICH EVENTS OPEN WHICH CONVERSATION TYPE: the declaration a type's `openedBy` carries (ADR-053 Phase 1).
 *
 * A conversation type that an event opens says so on itself, in the registry (`openedBy` on
 * {@link ConversationTypeConfig}). Each entry is one EventBridge rule on the classification stack the type
 * permits, and the rule's one target is that classification's typed-conversation creator
 * (`lambda/src/typed-conversation-from-event.ts`). Nothing else decides it: a type with no `openedBy` has no
 * rule, and an event nobody declared reaches no creator.
 *
 * ── WHAT AN OPENER DECLARES, AND WHAT IT CANNOT ──────────────────────────────────────────────────
 *
 *   - THE EVENT, as an EventBridge pattern: `source`, `detailType`, an optional `detail` filter, and the bus
 *     it arrives on (`eventBus`, absent for the account's default bus). A vendor's partner event bus is named
 *     by its event source name, exactly as a connector names one (`connectors.ts`); a CloudWatch alarm
 *     state change is `source: 'aws.cloudwatch'`, `detailType: 'CloudWatch Alarm State Change'` on the
 *     default bus. Neither needs a code change: each is one entry here.
 *   - WHERE THE CREATOR'S INPUT COMES FROM: per field, a path into the event (`fields`) or a fixed value
 *     (`values`). The fields are the person the conversation is for, its label, its one-line summary, and
 *     the conversation it concerns. Nothing else is read from the event.
 *
 * It CANNOT declare a classification for the event to carry, and the event cannot supply one. The
 * classification is the stack's: the rule is built on the stack of the one classification the opener
 * resolves to (`classification`, required only when the type permits several), the creator creates at the
 * classification it was deployed with, and the type it opens is the opener's, named by the rule and never
 * by the event (`openerById`). `assertEventOpeners` refuses a field naming either at synth.
 *
 * ── THE PLATFORM'S OWN OPS EVENT ─────────────────────────────────────────────────────────────────
 *
 * `ae.ops` / `Incident opened` is the event `scripts/send-ops-event.mjs` puts on the default bus, and the
 * shipped `ops` type is opened by it. Like `ae.alert`, it carries `detail.instance`, and the rule matches
 * this deployment's instance only (`matchInstance`), so two deployments in one account do not both open a
 * room for one event.
 */
import type { Classification } from './model-strategy';

/** The source the platform's own operations events carry (`scripts/lib/ops-event.cjs` writes the same). */
export const OPS_EVENT_SOURCE = 'ae.ops';
/** The detail type of an operations event that opens an `ops` conversation. */
export const OPS_INCIDENT_OPENED = 'Incident opened';

/**
 * The creator inputs an opener may fill. The conversation type and the classification are not among them.
 * `watchesAlarm` names the CloudWatch alarm the conversation watches (ADR-061, the incident watch): the conversation it
 * opens runs `alarm-state-changed` when that alarm changes state, and the classification's stack builds the rule that
 * delivers those changes to its router. `service` names the system the event is about (an alarm's metric namespace, a
 * vendor's product) and is read for the room's name alone (`name` on the type, `lambda/src/lib/conversation-name.ts`).
 */
export const OPENER_FIELDS = ['forPerson', 'topicLabel', 'summary', 'concernedChannelArn', 'watchesAlarm', 'service'] as const;
export type OpenerField = (typeof OPENER_FIELDS)[number];

/**
 * One event that opens a conversation of the type it is declared on.
 */
export interface EventOpener {
  /**
   * The bus the rule listens on, by name. Absent: the account's default bus, which is where a custom
   * application event put without a bus name, a CloudWatch alarm state change and every other AWS service
   * event arrive. A vendor's partner event bus is named by its partner event source name.
   */
  eventBus?: string;
  /** The event's `source`, matched exactly. */
  source: string;
  /** The event's `detail-type`, matched exactly. */
  detailType: string;
  /** An EventBridge content filter on `detail`, as an event pattern fragment. It narrows and grants nothing. */
  detail?: Record<string, unknown>;
  /**
   * Match only events whose `detail.instance` names this deployment, as every platform event (`ae.alert`,
   * `ae.ops`) carries. Set for a platform source; a vendor or AWS service event carries no instance.
   */
  matchInstance?: boolean;
  /**
   * The classification the rule is built at. Required when the type permits more than one classification
   * (or declares none), so one event never opens a room at each; absent otherwise, and then the type's one
   * classification. It must be one the type permits.
   */
  classification?: Classification;
  /** Per field, a JSON path into the event (`$.detail.onCall`), read by the creator when the event arrives. */
  fields?: Partial<Record<OpenerField, string>>;
  /** Per field, a fixed value, for what the event does not carry (the person an alarm opens a room for). */
  values?: Partial<Record<OpenerField, string>>;
}

/** Where the platform's own ops event carries each field (`scripts/lib/ops-event.cjs` writes this shape). */
export const PLATFORM_EVENT_FIELDS: Readonly<Record<OpenerField, string>> = {
  forPerson: '$.detail.forPerson',
  topicLabel: '$.detail.topicLabel',
  summary: '$.detail.summary',
  concernedChannelArn: '$.detail.concernedChannelArn',
  watchesAlarm: '$.detail.alarmName',
  service: '$.detail.service',
};

/** Whether an opener can name an alarm its conversation watches, which builds the incident-watch rule at its classification. */
export const openerWatchesAlarms = (opener: EventOpener): boolean => Boolean(opener.fields?.watchesAlarm || opener.values?.watchesAlarm);

/** The shape of a path the creator reads: `$` followed by `.name` or `[index]` steps, nothing else. */
const PATH = /^\$(\.[A-Za-z0-9_-]+|\[\d+\])+$/;

/** The minimal view of a conversation type an opener is checked against. */
export interface OpenedTypeView {
  classifications?: readonly string[];
  initiation?: string;
  openedBy?: readonly EventOpener[];
}

/** One declared opener, resolved: its stable id, the type it opens, and the classification it is built at. */
export interface ResolvedOpener {
  /** `<type key>#<index>`: what the rule names to the creator, and the rule's construct id. */
  id: string;
  typeKey: string;
  classification: string;
  opener: EventOpener;
}

/**
 * EVERY DECLARED OPENER, CHECKED, or a thrown list of what is wrong with them. Run at synth by the stack that
 * builds the rules, and by a unit test over the shipped registry.
 *
 * Refused: a type no event may open (a person opens it, `initiation` absent or `user`); an opener with no
 * source or detail type; a classification the type does not permit, or none where the type permits several;
 * a field outside {@link OPENER_FIELDS} (a classification or a conversation type above all); a path that is
 * not a plain path; a field declared both as a path and as a value; no person; and, for a type that concerns
 * another conversation, no concerned conversation.
 */
export function resolveEventOpeners(types: Readonly<Record<string, OpenedTypeView>>): ResolvedOpener[] {
  const errors: string[] = [];
  const out: ResolvedOpener[] = [];
  for (const [typeKey, type] of Object.entries(types)) {
    (type.openedBy ?? []).forEach((opener, index) => {
      const at = `conversation type "${typeKey}" openedBy[${index}]`;
      const before = errors.length;
      if (!type.initiation || type.initiation === 'user') {
        errors.push(`${at}: a person opens this type (initiation "${type.initiation ?? 'user'}"), so no event may`);
      }
      if (!opener.source?.trim()) errors.push(`${at}: names no source`);
      if (!opener.detailType?.trim()) errors.push(`${at}: names no detail type`);
      const permitted = type.classifications ?? [];
      let classification = opener.classification as string | undefined;
      if (classification) {
        if (permitted.length && !permitted.includes(classification)) {
          errors.push(`${at}: classification "${classification}" is not one the type permits (${permitted.join(', ')})`);
        }
      } else if (permitted.length === 1) {
        classification = permitted[0];
      } else {
        errors.push(`${at}: the type permits ${permitted.length ? permitted.join(', ') : 'any classification'}, so the opener must name the one classification its rule is built at`);
      }
      for (const [kind, map] of [['fields', opener.fields], ['values', opener.values]] as const) {
        for (const [key, value] of Object.entries(map ?? {})) {
          if (!(OPENER_FIELDS as readonly string[]).includes(key)) {
            errors.push(`${at}: ${kind}.${key} is not a field an opener fills (${OPENER_FIELDS.join(', ')}); `
              + 'the classification and the conversation type are never read from an event');
            continue;
          }
          if (typeof value !== 'string' || !value.trim()) errors.push(`${at}: ${kind}.${key} is empty`);
          else if (kind === 'fields' && !PATH.test(value)) errors.push(`${at}: fields.${key} "${value}" is not a plain JSON path ($.detail.name)`);
        }
      }
      for (const key of OPENER_FIELDS) {
        if (opener.fields?.[key] && opener.values?.[key]) errors.push(`${at}: ${key} is declared both as a path and as a value`);
      }
      const has = (key: OpenerField) => Boolean(opener.fields?.[key] || opener.values?.[key]);
      if (!has('forPerson')) errors.push(`${at}: names no person the conversation is for (fields.forPerson or values.forPerson)`);
      if (type.initiation !== 'system' && !has('concernedChannelArn')) {
        errors.push(`${at}: the type concerns another conversation, so the opener must say where it comes from (concernedChannelArn)`);
      }
      if (errors.length === before && classification) {
        out.push({ id: `${typeKey}#${index}`, typeKey, classification, opener });
      }
    });
  }
  if (errors.length) throw new Error(`Event openers are invalid:\n  - ${errors.join('\n  - ')}`);
  return out;
}

/** The openers whose rules a classification's stack builds. */
export function eventOpenersAt(types: Readonly<Record<string, OpenedTypeView>>, classification: string): ResolvedOpener[] {
  return resolveEventOpeners(types).filter((o) => o.classification === classification);
}

/** The declared opener a rule names, or undefined. The type it opens is the opener's, never the event's. */
export function openerById(types: Readonly<Record<string, OpenedTypeView>>, id: string): ResolvedOpener | undefined {
  return resolveEventOpeners(types).find((o) => o.id === id);
}

/** The value at a plain JSON path in an event, as a trimmed string, or undefined when absent or not a string. */
export function valueAtPath(event: unknown, path: string): string | undefined {
  if (!PATH.test(path)) return undefined;
  let at: unknown = event;
  for (const step of path.slice(1).match(/\.[A-Za-z0-9_-]+|\[\d+\]/g) ?? []) {
    if (at === null || typeof at !== 'object') return undefined;
    const key = step.startsWith('[') ? Number(step.slice(1, -1)) : step.slice(1);
    at = (at as Record<string | number, unknown>)[key];
  }
  if (typeof at === 'number' || typeof at === 'boolean') return String(at);
  return typeof at === 'string' && at.trim() ? at.trim() : undefined;
}

/** The creator's input an opener fills from one event: each field from its path, else its fixed value. */
export function openerInput(opener: EventOpener, event: unknown): Partial<Record<OpenerField, string>> {
  const out: Partial<Record<OpenerField, string>> = {};
  for (const key of OPENER_FIELDS) {
    const path = opener.fields?.[key];
    const value = path ? valueAtPath(event, path) : opener.values?.[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}
