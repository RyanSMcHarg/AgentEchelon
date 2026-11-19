/**
 * THE PLATFORM'S OPS EVENT, as `send-ops-event.mjs` and the demo cast mail e2e put it on the bus.
 *
 * The shipped `ops` conversation type declares that this event opens it (`openedBy` in
 * `lib/config/conversation-types.ts`, `lib/config/event-openers.ts`): source `ae.ops`, detail type
 * `Incident opened`, on the default bus, matched only when `detail.instance` names the deployment. The
 * detail carries the fields the declaration reads (`PLATFORM_EVENT_FIELDS`), and nothing else is read from
 * it: no classification and no conversation type, which the rule and the deployment decide.
 *
 * CommonJS so the operator script and the Playwright specs share one builder, and
 * `test/lib/an-event-opens-only-the-type-it-is-declared-on.test.ts` holds the source and detail type equal to the
 * declaration's.
 */
const OPS_EVENT_SOURCE = 'ae.ops';
const OPS_INCIDENT_OPENED = 'Incident opened';

/**
 * One PutEvents entry. `forPerson` is the person the room is for: an email address the deployment's own pool
 * holds, an AppInstanceUser ARN, or `<issuer id>|<address>`. `concernedChannelArn` is the conversation the
 * incident concerns (the operations team's standing room), which must be at the classification the `ops`
 * type is created at.
 */
function opsEventEntry({ instance, forPerson, topicLabel, summary, concernedChannelArn, alarmName, service, incidentId, eventBusName = 'default' }) {
  if (!instance) throw new Error('an ops event names the instance it is for');
  if (!forPerson) throw new Error('an ops event names the person it opens a room for');
  if (!concernedChannelArn) throw new Error('an ops event names the conversation it concerns');
  const detail = {
    instance,
    forPerson,
    concernedChannelArn,
    ...(topicLabel ? { topicLabel } : {}),
    ...(summary ? { summary } : {}),
    // The CloudWatch alarm the incident is about, which the room then watches (ADR-061, the incident watch).
    ...(alarmName ? { alarmName } : {}),
    // The system the incident is about, read for the room's name alone.
    ...(service ? { service } : {}),
    // The incident's own id, which the room watches, so a later update for it reaches the room (DESIGN-EVENT-TARGETS).
    ...(incidentId ? { incidentId } : {}),
  };
  return {
    EventBusName: eventBusName,
    Source: OPS_EVENT_SOURCE,
    DetailType: OPS_INCIDENT_OPENED,
    Detail: JSON.stringify(detail),
  };
}

/** The detail type of an update to an incident a room already watches (DESIGN-EVENT-TARGETS). */
const OPS_INCIDENT_UPDATED = 'Incident updated';

/** An update to an incident, naming it by the id its room watches. It names no room: the room is the one that watches the id. */
function opsUpdateEntry({ instance, incidentId, eventBusName = 'default' }) {
  if (!instance) throw new Error('an ops event names the instance it is for');
  if (!incidentId) throw new Error('an incident update names the incident it is for');
  return { EventBusName: eventBusName, Source: OPS_EVENT_SOURCE, DetailType: OPS_INCIDENT_UPDATED, Resources: [], Detail: JSON.stringify({ instance, incidentId }) };
}

module.exports = { OPS_EVENT_SOURCE, OPS_INCIDENT_OPENED, OPS_INCIDENT_UPDATED, opsEventEntry, opsUpdateEntry };
