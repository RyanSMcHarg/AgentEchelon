/**
 * A REPLY TO A REQUEST NOBODY CAN READ BACK FAILS TOWARD PRIVATE (DESIGN-TASK-ACCESS 2.4).
 *
 * `inboundWasTargeted` treats an unreadable message as public, which is right for `/stop`: a failed read
 * must not take the escape hatch away from a room. A drift offer has the opposite safe direction, so it
 * reads `inboundTarget`, which answers `unreadable` instead of settling it.
 */
import type { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { inboundTarget, inboundWasTargeted } from '../../lambda/src/lib/private-command';

const clientAnswering = (send: () => Promise<unknown>) => ({ send }) as unknown as ChimeSDKMessagingClient;
const ARGS = ['arn:channel', 'msg-1', 'arn:bot'] as const;

describe('inboundTarget', () => {
  it('answers unreadable when the read fails twice, and makes the second attempt', async () => {
    const send = jest.fn(async () => { throw Object.assign(new Error('boom'), { name: 'ServiceFailureException' }); });
    await expect(inboundTarget(clientAnswering(send), ...ARGS, 0)).resolves.toBe('unreadable');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('answers targeted and public from a readable message', async () => {
    const targeted = clientAnswering(async () => ({ ChannelMessage: { Target: [{ MemberArn: 'arn:user/a' }] } }));
    const open = clientAnswering(async () => ({ ChannelMessage: {} }));
    await expect(inboundTarget(targeted, ...ARGS, 0)).resolves.toBe('targeted');
    await expect(inboundTarget(open, ...ARGS, 0)).resolves.toBe('public');
  });

  it('leaves inboundWasTargeted failing toward public for the callers that need it', async () => {
    const failing = clientAnswering(async () => { throw new Error('boom'); });
    await expect(inboundWasTargeted(failing, ...ARGS, 0)).resolves.toBe(false);
  });
});
