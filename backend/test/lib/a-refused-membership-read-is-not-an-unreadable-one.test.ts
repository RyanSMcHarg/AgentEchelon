/**
 * A REFUSAL AND A THROTTLE ARE NOT THE SAME FAILURE, and `resolveChannelSize` is where the difference
 * first has to be made.
 *
 * `channel-size.ts` had no test at all before ADR-045, and its single catch returned "treat the channel
 * as a group" for every error. That is the correct, deliberate fail direction for a throttle: somebody
 * still answers the turn. Applied to an `AccessDeniedException` it is the defect ADR-045 exists for -
 * the classification boundary refuses this assistant its first channel read, and the turn continues as
 * though the read had merely been slow.
 *
 * MEASURED BEFORE IT WAS WRITTEN (2026-09-17, dev): the deployed premium router role is implicitDeny on
 * `ListChannelMemberships` for a basic-tagged channel and allowed for a premium one, and a premium bot
 * placed in a basic room by the administrator ran a full turn. So the case below is not hypothetical.
 *
 * WHY BOTH DIRECTIONS ARE ASSERTED. A module that reported `refused: true` for every failure would pass
 * a one-sided test and would turn every transient throttle into a silent turn - trading a rare wrong
 * answer for a common missing one. The throttle cases are what stop that, and they are the reason this
 * file asserts what `refused` is NOT as carefully as what it is.
 */
import { resolveChannelSize, ONE_TO_ONE_MEMBER_COUNT } from '../../lambda/src/lib/channel-size';
import type { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';

/** Shaped like an AWS SDK v3 error: the code is the `name`, with `$metadata` alongside. */
function sdkError(name: string, httpStatusCode?: number): Error {
  const err = new Error(`${name}: simulated`);
  err.name = name;
  if (httpStatusCode) (err as unknown as { $metadata: unknown }).$metadata = { httpStatusCode };
  return err;
}

/** A client whose single `send` rejects, standing in for the service refusing or failing. */
function clientThatThrows(err: Error): ChimeSDKMessagingClient {
  return { send: jest.fn().mockRejectedValue(err) } as unknown as ChimeSDKMessagingClient;
}

function clientReturning(members: Array<{ arn: string; name: string }>): ChimeSDKMessagingClient {
  return {
    send: jest.fn().mockResolvedValue({
      ChannelMemberships: members.map((m) => ({ Member: { Arn: m.arn, Name: m.name } })),
      NextToken: undefined,
    }),
  } as unknown as ChimeSDKMessagingClient;
}

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c';
const BEARER = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/b';

describe('a refused membership read is reported as refused', () => {
  // The two names ADR-045 itself sketches. Amazon Chime SDK raises `ForbiddenException`; most other
  // services raise `AccessDeniedException`, and this module is called against both in the tree.
  it.each([
    ['the name most AWS services use', 'AccessDeniedException'],
    ['the name Amazon Chime SDK uses', 'ForbiddenException'],
  ])('sets refused for %s (%s)', async (_why, name) => {
    const size = await resolveChannelSize(clientThatThrows(sdkError(name)), CHANNEL, BEARER);
    expect(size.refused).toBe(true);
    // Still unknown, so a caller that has not been taught about `refused` keeps its old behavior
    // rather than reading a refusal as a successful count of zero.
    expect(size.unknown).toBe(true);
    expect(size.isOneToOne).toBe(false);
  });

  // The backstop that matters most, because it is the refusal nobody has seen yet. A refusal shape
  // added by a service tomorrow must land on the SILENT side, not the continue-the-turn side.
  it('sets refused for an unfamiliar refusal carrying HTTP 403', async () => {
    const size = await resolveChannelSize(clientThatThrows(sdkError('SomeFutureRefusal', 403)), CHANNEL, BEARER);
    expect(size.refused).toBe(true);
  });
});

describe('an ordinary failure is NOT a refusal', () => {
  // If these regressed to `refused: true`, every throttle would end its turn in silence. That is the
  // failure direction this module spent its original design argument avoiding.
  it.each([
    ['a throttle', 'ThrottlingException'],
    ['a timeout', 'TimeoutError'],
    ['a service fault', 'InternalServerException'],
  ])('leaves refused false for %s (%s)', async (_why, name) => {
    const size = await resolveChannelSize(clientThatThrows(sdkError(name)), CHANNEL, BEARER);
    expect(size.refused).toBe(false);
    // Unchanged from before ADR-045: unreadable, and the caller carries on with the group shape.
    expect(size.unknown).toBe(true);
    expect(size.isOneToOne).toBe(false);
  });

  it('leaves refused false when the channel reads as empty', async () => {
    // Zero is treated as unreadable rather than as "smaller than a 1:1". It is not a refusal either,
    // and calling it one would end turns on an empty response from a healthy service.
    const size = await resolveChannelSize(clientReturning([]), CHANNEL, BEARER);
    expect(size.unknown).toBe(true);
    expect(size.refused).toBe(false);
  });
});

describe('a successful read is unchanged by the new field', () => {
  it('still counts members, carries the roster, and reports refused false', async () => {
    const size = await resolveChannelSize(
      clientReturning([
        { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/u1', name: 'Ada' },
        { arn: BEARER, name: 'Assistant' },
      ]),
      CHANNEL,
      BEARER,
    );
    expect(size.refused).toBe(false);
    expect(size.unknown).toBe(false);
    expect(size.memberCount).toBe(ONE_TO_ONE_MEMBER_COUNT);
    expect(size.isOneToOne).toBe(true);
    expect(size.members.map((m) => m.name)).toEqual(['Ada', 'Assistant']);
    // The roster carries the bot discriminator the `/stop` and `@` paths read.
    expect(size.members.find((m) => m.name === 'Assistant')?.isBot).toBe(true);
  });

  it('reports a group above the 1:1 size', async () => {
    const size = await resolveChannelSize(
      clientReturning([
        { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/u1', name: 'Ada' },
        { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/u2', name: 'Grace' },
        { arn: BEARER, name: 'Assistant' },
      ]),
      CHANNEL,
      BEARER,
    );
    expect(size.isOneToOne).toBe(false);
    expect(size.refused).toBe(false);
    expect(size.unknown).toBe(false);
  });
});
