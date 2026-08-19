/**
 * Channel id generation, for both conversation-creation paths.
 *
 * WHY THIS IS WORTH A TEST. The channel id used to only have to be unique enough for one `CreateChannel`
 * call: a collision meant a conflict, the create failed, and a retry fixed it. It is becoming load-bearing
 * beyond that. The channel ARN is derived from the id (`{appInstance}/channel/{id}`), and
 * SPEC-USER-PROFILE-AND-ONBOARDING §2 keys per-conversation participant context on that ARN, written BEFORE
 * the channel exists - the assistant is added by creation itself, so there is no window afterwards.
 *
 * Under that ordering a repeated id stops being a retryable conflict and becomes a CROSS-USER CONTEXT LEAK:
 * two requests would write into one context row before either channel is created, and the loser's
 * participants would attach to the winner's conversation. `conv-${Date.now()}` is millisecond-resolution, so
 * two concurrent creates in the same millisecond collided by construction.
 *
 * These assert the two properties that matter, not the format: ids do not repeat under same-millisecond
 * generation, and they stay legal as Chime channel ids.
 */
import { newDriftChannelId } from '../../lambda/src/lib/channel-creation';

// The primary path is a standalone CommonJS Lambda asset (its own esbuild bundle, no TS imports), so it is
// required rather than imported. Requiring it constructs AWS clients at module load, which performs no I/O.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { newConversationChannelId } = require('../../lambda/create-conversation/index.js');

/** Chime channel ids accept alphanumerics, hyphens and underscores, and are bounded well under 64 chars. */
const CHIME_LEGAL = /^[A-Za-z0-9_-]{1,64}$/;

const GENERATORS: Array<[string, () => string]> = [
  ['primary create-conversation', newConversationChannelId],
  ['drift-spawned', newDriftChannelId],
];

describe.each(GENERATORS)('%s channel id', (_label, generate) => {
  it('does not repeat across a burst generated within the same millisecond', () => {
    // The burst is the point. A timestamp-only id passes any test that generates ids slowly, which is
    // exactly why the collision survived: it is unobservable unless generation is concurrent.
    const start = Date.now();
    const ids = Array.from({ length: 5_000 }, generate);
    const elapsed = Date.now() - start;

    expect(new Set(ids).size).toBe(ids.length);

    // Vacuity guard. If the burst somehow took long enough that every id landed in its own millisecond,
    // uniqueness above would be satisfied by the timestamp alone and would prove nothing about the random
    // suffix. Assert the burst actually collapsed into few milliseconds.
    const distinctTimestamps = new Set(ids.map((id) => id.split('-').slice(0, -1).join('-'))).size;
    if (distinctTimestamps >= ids.length) {
      throw new Error(
        `the burst spanned ${elapsed}ms across ${distinctTimestamps} distinct timestamps for ${ids.length} `
        + 'ids, so the uniqueness asserted above may have come from the clock rather than from randomness. '
        + 'This test would then pass against the old timestamp-only id and prove nothing.',
      );
    }
    expect(distinctTimestamps).toBeLessThan(ids.length);
  });

  it('is a legal Chime channel id', () => {
    const ids = Array.from({ length: 100 }, generate);
    // Report every offender rather than the first, so a charset mistake is diagnosable in one run.
    expect(ids.filter((id) => !CHIME_LEGAL.test(id))).toEqual([]);
  });

  it('carries randomness that varies independently of the clock', () => {
    // Two ids taken with the clock pinned must still differ. This is the assertion that fails against
    // `conv-${Date.now()}` and against `Date.now()` plus a non-random suffix.
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1_754_236_800_000);
    try {
      const ids = new Set(Array.from({ length: 500 }, generate));
      expect(ids.size).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});
