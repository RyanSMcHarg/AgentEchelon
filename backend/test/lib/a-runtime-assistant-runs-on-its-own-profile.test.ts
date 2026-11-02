/**
 * A RUNTIME ASSISTANT RUNS ON ITS OWN PROFILE (ADR-048).
 *
 * Its record is the authority: the seed comes from the record's own fields, plus the two fields that
 * describe its classification's processor. A record that is not active, is not a live occupancy, takes a
 * reserved name, or assigns an undeclared role names nothing, and an assignment that names a runtime assistant
 * answers on that assistant's seed and never on another's.
 */
import { runtimeSeedFor, isServingRecord, type AssignmentRecord } from '../../lambda/src/lib/runtime-assistant';
import { turnAssistantProfile } from '../../lambda/src/lib/turn-assistant';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';

const record = (over: Partial<AssignmentRecord> = {}): AssignmentRecord => ({
  classification: 'premium', role: 'primary', occupancy: 'live', assistant: 'finance-advisor',
  botArn: 'arn:aws:chime:us-east-1:111:app-instance/a/bot/b-fin', source: 'runtime', status: 'active',
  displayName: 'Finance', descriptor: { modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 120 }, ...over,
});

describe('the seed', () => {
  it('takes its own fields from the record and the processor fields from the role it runs on', () => {
    const processor = profiles.profileByName(profiles.roleAssistantName('premium', 'primary')!)!;
    expect(runtimeSeedFor(record(), profiles)).toEqual({
      name: 'finance-advisor', displayName: 'Finance', modelKey: 'sonnet', classifierMode: 'llm',
      timeoutSeconds: processor.timeoutSeconds, contextScope: 'granted', rateLimitPerHour: 120,
      ...(processor.attachmentsReadable !== undefined ? { attachmentsReadable: processor.attachmentsReadable } : {}),
    });
  });

  it('copies no rate limit the record does not carry', () => {
    expect(runtimeSeedFor(record({ descriptor: { modelKey: 'sonnet', classifierMode: 'llm' } }), profiles)).not.toHaveProperty('rateLimitPerHour');
  });

  it.each([
    ['a deploy-time record', { source: undefined }],
    ['a retiring record', { status: 'retiring' as const }],
    ['a provisioning record', { status: 'provisioning' as const }],
    ['an alt occupancy', { occupancy: 'alt' }],
    ['a reserved name', { assistant: 'alt-primary-premium' }],
    ['a classification name', { assistant: 'premium' }],
    ['an unsafe id', { assistant: 'Finance Advisor' }],
    ['an undeclared role', { role: 'nonexistent' }],
    ['an undeclared classification', { classification: 'nowhere' }],
    ['no model', { descriptor: { classifierMode: 'llm' } }],
    ['an unknown classifier mode', { descriptor: { modelKey: 'sonnet', classifierMode: 'magic' } }],
  ])('names nothing for %s', (_label, over) => {
    expect(runtimeSeedFor(record(over as Partial<AssignmentRecord>), profiles)).toBeUndefined();
  });

  it('an absent status is a deploy-time record and serves; anything but active does not', () => {
    expect(isServingRecord({})).toBe(true);
    expect(isServingRecord({ status: 'active' })).toBe(true);
    expect(isServingRecord({ status: 'retiring' })).toBe(false);
    expect(isServingRecord({ status: 'retired' })).toBe(false);
  });
});

describe('the assignment', () => {
  const resolve = (assignedAssistant: string, withSeed = true) => turnAssistantProfile({
    runtimeSeed: withSeed ? runtimeSeedFor(record(), profiles) : undefined,
    classification: 'premium', assistantIndexLoaded: true, assignedAssistant, isAltAssistant: false, primaryBot: false, registry: profiles,
  });

  it("answers on the runtime assistant's own seed", () => {
    expect(resolve('finance-advisor')).toMatchObject({ decision: 'answer', source: 'assigned', profile: { name: 'finance-advisor' } });
  });

  it("declines an assignment naming a runtime assistant whose seed is someone else's", () => {
    expect(resolve('other-runtime')).toEqual({ decision: 'decline', reason: 'undeclared-assistant' });
  });

  it('declines a runtime name with no seed rather than answering on the primary', () => {
    expect(resolve('finance-advisor', false)).toEqual({ decision: 'decline', reason: 'undeclared-assistant' });
  });
});
