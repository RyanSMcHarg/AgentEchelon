/**
 * THE ADMIN NOTIFICATIONS CONVERSATION HAS A FIXED ID (DESIGN-EVENT-TARGETS section 12): derived from the deployment's app
 * instance, so its ARN follows from the deployment alone. A channel already at that id is reused only where the admin bot
 * created it as the admin notifications conversation; anything else there is refused rather than adopted.
 */
import { adminNoticesChannelId, createAdminNotificationChannel, contextChannelId, patternChannelId } from '../../lambda/src/lib/channel-creation';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const BOT = `${APP}/bot/admin`;
const AT = `${APP}/channel/${adminNoticesChannelId(APP)}`;

const OWN_TAGS = [{ Key: 'aeChannelKind', Value: 'admin-notifications' }, { Key: 'classification', Value: 'admin' }];

function client(onCreate: () => unknown, described?: { CreatedBy?: { Arn: string } }, tags: Array<{ Key: string; Value: string }> = OWN_TAGS) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    sent,
    send: jest.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'CreateChannelCommand') return onCreate();
      if (cmd.constructor.name === 'DescribeChannelCommand') return { Channel: described };
      if (cmd.constructor.name === 'ListTagsForResourceCommand') return { Tags: tags };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }),
  };
}
const create = (c: ReturnType<typeof client>) => createAdminNotificationChannel({
  client: c as never, appInstanceArn: APP, botArn: BOT, name: 'Admin notifications', classification: 'admin',
  kindTag: { key: 'aeChannelKind', value: 'admin-notifications' }, primaryTag: { Key: 'primary', Value: 'admin-agent' },
});
const conflict = () => { throw Object.assign(new Error('exists'), { name: 'ConflictException' }); };

describe('the admin notifications conversation\'s id', () => {
  it('is fixed by the app instance, in its own namespace, and differs between deployments', () => {
    expect(adminNoticesChannelId(APP)).toMatch(/^adm-notices-[0-9a-f]+$/);
    expect(adminNoticesChannelId(APP)).toBe(adminNoticesChannelId(APP));
    expect(adminNoticesChannelId(`${APP}2`)).not.toBe(adminNoticesChannelId(APP));
    expect(adminNoticesChannelId(APP).length).toBeLessThanOrEqual(64);
    expect(adminNoticesChannelId(APP)).not.toBe(contextChannelId('admin', 'notices', APP));
    expect(adminNoticesChannelId(APP)).not.toBe(patternChannelId('admin', 'notices', APP));
  });

  it('is the id the admin bot creates the conversation at', async () => {
    const c = client(() => ({ ChannelArn: AT }));
    expect(await create(c)).toBe(AT);
    expect(c.sent[0].input).toMatchObject({ ChannelId: adminNoticesChannelId(APP), ChimeBearer: BOT });
  });

  it('reuses one already at the id that the admin bot created as the admin notifications conversation', async () => {
    const c = client(conflict, { CreatedBy: { Arn: BOT } });
    expect(await create(c)).toBe(AT);
    expect(c.sent.map((s) => s.name).sort()).toEqual(['CreateChannelCommand', 'DescribeChannelCommand', 'ListTagsForResourceCommand']);
  });

  it('DENY: refuses one at the id that another identity created, or whose tags name another kind or classification', async () => {
    await expect(create(client(conflict, { CreatedBy: { Arn: `${APP}/user/someone` } }))).rejects.toThrow(/not adopted/);
    await expect(create(client(conflict, { CreatedBy: { Arn: BOT } }, [{ Key: 'aeChannelKind', Value: 'other' }, { Key: 'classification', Value: 'admin' }]))).rejects.toThrow(/not adopted/);
    await expect(create(client(conflict, { CreatedBy: { Arn: BOT } }, [{ Key: 'aeChannelKind', Value: 'admin-notifications' }, { Key: 'classification', Value: 'premium' }]))).rejects.toThrow(/not adopted/);
    await expect(create(client(conflict, { CreatedBy: { Arn: BOT } }, []))).rejects.toThrow(/not adopted/);
  });

  it('DENY: any other creation failure is not taken as a conflict', async () => {
    await expect(create(client(() => { throw Object.assign(new Error('no'), { name: 'ForbiddenException' }); }))).rejects.toThrow('no');
  });
});
