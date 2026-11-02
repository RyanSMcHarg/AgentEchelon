/**
 * A14 analytics capability partition (lambda/src/lib/admin-capability-map.ts).
 * Pins the queryType->capability assignment + the path<->capability round-trip
 * the per-resource IAM enforcement depends on: a sensitive queryType may only
 * run on its own resource path.
 */
import {
  capabilityForQueryType,
  capabilityForPath,
  queryTypeAllowedOnPath,
  ANALYTICS_CAPABILITY_SUBPATHS,
} from '../../lambda/src/lib/admin-capability-map';

describe('capabilityForQueryType', () => {
  it('assigns the sensitive queryTypes to their own capability', () => {
    expect(capabilityForQueryType('channel_events')).toBe('view-events');
    expect(capabilityForQueryType('user_activity')).toBe('view-user-activity');
    expect(capabilityForQueryType('signup_funnel_conversion')).toBe('view-user-activity');
    expect(capabilityForQueryType('moderation_audit')).toBe('view-moderation-audit');
    // The audit WRITE is its own capability, apart from the audit read.
    expect(capabilityForQueryType('record_moderation')).toBe('record-moderation');
  });

  it('decides a write that rides a read queryType by its action', () => {
    // Reading the flagged queue is the analytics bundle; changing it is triage.
    expect(capabilityForQueryType('flagged_responses')).toBe('view-analytics');
    for (const action of ['flag', 'unflag', 'review']) {
      expect(capabilityForQueryType('flagged_responses', action)).toBe('triage-responses');
    }
    expect(capabilityForQueryType('ground_truth')).toBe('view-analytics');
    expect(capabilityForQueryType('ground_truth', 'submit')).toBe('label-ground-truth');
    expect(capabilityForQueryType('classifier_replay_adjudicate')).toBe('label-ground-truth');
    // An action a read does not recognize as a write stays a read.
    expect(capabilityForQueryType('flagged_responses', 'list')).toBe('view-analytics');
  });

  it('defaults every other (low-sensitivity) queryType to the analytics bundle', () => {
    for (const q of ['conversation_volumes', 'model_usage', 'evaluation_scores', 'drift_events', 'experiment_results']) {
      expect(capabilityForQueryType(q)).toBe('view-analytics');
    }
    expect(capabilityForQueryType('something_new_and_unmapped')).toBe('view-analytics');
  });
});

describe('capabilityForPath', () => {
  it('maps each sub-path to its capability and the root to the bundle', () => {
    expect(capabilityForPath('/events-log')).toBe('view-events');
    expect(capabilityForPath('/prod/user-activity')).toBe('view-user-activity');
    expect(capabilityForPath('/moderation-audit')).toBe('view-moderation-audit');
    expect(capabilityForPath('/')).toBe('view-analytics');
    expect(capabilityForPath('/prod')).toBe('view-analytics');
  });
});

describe('queryTypeAllowedOnPath — the enforcement predicate', () => {
  it('permits a queryType only on its own capability resource', () => {
    // A13 PII on its own path: allowed; on the low-sensitivity bundle: denied.
    expect(queryTypeAllowedOnPath('user_activity', '/user-activity')).toBe(true);
    expect(queryTypeAllowedOnPath('user_activity', '/')).toBe(false);
    // The event log must arrive on /events-log, not the bundle.
    expect(queryTypeAllowedOnPath('channel_events', '/events-log')).toBe(true);
    expect(queryTypeAllowedOnPath('channel_events', '/')).toBe(false);
    // A bundle query on the bundle root: allowed; on a sensitive path: denied.
    expect(queryTypeAllowedOnPath('model_usage', '/')).toBe(true);
    expect(queryTypeAllowedOnPath('model_usage', '/user-activity')).toBe(false);
    // A write refused on the read bundle, and allowed on its own resource.
    expect(queryTypeAllowedOnPath('flagged_responses', '/', 'flag')).toBe(false);
    expect(queryTypeAllowedOnPath('flagged_responses', '/triage', 'flag')).toBe(true);
    expect(queryTypeAllowedOnPath('ground_truth', '/ground-truth', 'submit')).toBe(true);
    expect(queryTypeAllowedOnPath('record_moderation', '/moderation-audit')).toBe(false);
    expect(queryTypeAllowedOnPath('record_moderation', '/moderation-record')).toBe(true);
  });
});

describe('ANALYTICS_CAPABILITY_SUBPATHS', () => {
  it('lists exactly the per-capability resources the CDK must create', () => {
    expect(ANALYTICS_CAPABILITY_SUBPATHS.map((s) => s.path).sort()).toEqual(
      ['events-log', 'ground-truth', 'moderation-audit', 'moderation-record', 'triage', 'user-activity'],
    );
  });
});

/**
 * A NEW QUERY TYPE IS IAM-ENFORCEABLE BEFORE IT SHIPS.
 *
 * The analytics API funnels every queryType through one POST, and the ONLY thing that makes a
 * capability enforceable per resource is `queryTypeAllowedOnPath`: the handler refuses a queryType
 * that did not arrive on the resource its capability owns. A type nobody classified still gets a
 * class - the `view-analytics` default - which is correct for an ordinary analytics read and wrong
 * for anything carrying identity or conversation content.
 *
 * So the check is not "is it mapped" but "is the class it lands in the right one", asserted per query
 * rather than left to a default nobody revisited.
 */
describe('the drills added for metric evidence are enforceable', () => {
  it.each([
    // Per-turn latency for one breakdown row. No identity, no user content: the same class as
    // latency_metrics, which it drills into.
    ['latency_exchanges'],
    // The ratings themselves. Carries the prose a person wrote and the ASSISTANT's reply, and
    // deliberately no userSub and no user message - so it is strictly less identifying than
    // flagged_responses, which shows the user's own message and sits in the same class.
    ['user_ratings'],
  ])('%s is a view-analytics read', (queryType) => {
    expect(capabilityForQueryType(queryType)).toBe('view-analytics');
  });

  it.each([['latency_exchanges'], ['user_ratings']])(
    '%s is refused on a resource belonging to another capability',
    (queryType) => {
      // The whole point of the split: a caller allowed the low-sensitivity resource must not be able
      // to read a different data class by naming its queryType on that resource, and the reverse.
      // The real sub-path is 'events-log'; '/analytics/events' matches no capability and so falls
      // to the view-analytics default, which would have made this assertion pass for the wrong reason.
      expect(queryTypeAllowedOnPath(queryType, '/analytics/events-log')).toBe(false);
      expect(queryTypeAllowedOnPath(queryType, '/analytics/user-activity')).toBe(false);
    },
  );

  it('keeps the identity-bearing classes where they were', () => {
    // A regression here would widen a PII read to the general analytics role.
    expect(capabilityForQueryType('user_activity')).toBe('view-user-activity');
    expect(capabilityForQueryType('channel_events')).toBe('view-events');
  });
});

/**
 * A QUERY THAT SERVES MESSAGE CONTENT IS NOT IN THE AGGREGATE BUNDLE.
 *
 * `cross_conversation_context` returns the first 100 characters of a person's message as `topic` and
 * the first 500 as `summary`, for every conversation a named `userSub` has had. It was never listed in
 * the map, so it inherited the `view-analytics` default by omission - and that bundle's own rule is
 * that its reads "carry labels and counts, never message content".
 *
 * The table is written continuously on the archival path, while the endpoint's comment claimed it had
 * no writer and always returned empty. So the gap was real and the code said it was not, which is why
 * it is pinned by name here rather than left to the default-to-bundle rule that created it.
 */
describe('a content-serving queryType is not served from the low-sensitivity bundle', () => {
  it('requires view-events for cross_conversation_context', () => {
    expect(capabilityForQueryType('cross_conversation_context')).toBe('view-events');
  });

  it('refuses it on the analytics root, which is where an unlisted queryType would have been served', () => {
    expect(queryTypeAllowedOnPath('cross_conversation_context', '')).toBe(false);
    expect(queryTypeAllowedOnPath('cross_conversation_context', '/analytics')).toBe(false);
  });

  it('permits it only on the content resource', () => {
    expect(queryTypeAllowedOnPath('cross_conversation_context', '/analytics/events-log')).toBe(true);
    expect(queryTypeAllowedOnPath('cross_conversation_context', '/analytics/user-activity')).toBe(false);
    expect(queryTypeAllowedOnPath('cross_conversation_context', '/analytics/moderation-audit')).toBe(false);
  });
});
