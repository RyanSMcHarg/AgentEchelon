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
    expect(capabilityForQueryType('record_moderation')).toBe('view-moderation-audit');
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
  });
});

describe('ANALYTICS_CAPABILITY_SUBPATHS', () => {
  it('lists exactly the three sensitive resources the CDK must create', () => {
    expect(ANALYTICS_CAPABILITY_SUBPATHS.map((s) => s.path).sort()).toEqual(
      ['events-log', 'moderation-audit', 'user-activity'],
    );
  });
});
