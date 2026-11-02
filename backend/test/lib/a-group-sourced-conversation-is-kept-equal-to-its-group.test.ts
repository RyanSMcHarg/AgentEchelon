/**
 * A conversation whose type sources its membership from a group is kept equal to that group
 * (DESIGN-CONVERSATION-TYPES §6), and only ever with people its classification admits.
 *
 * Three layers, each tested on its own: resolving the allowed set (group ∪ list, then admission), the
 * shared reconcile (humans only, add and remove, moderators, the undetermined left alone), and the
 * per-classification driver (which groups an event names, which conversations are this classification's,
 * and what is skipped rather than failed).
 *
 * The directory is asked by PERSON: a group member is the AppInstanceUser their subject resolves to
 * through `Identities`, and their groups are read for that person.
 */
import { resolveAllowedSet, type Directory } from '../../lambda/src/lib/membership-source';
import { reconcileHumans } from '../../lambda/src/lib/membership-reconcile';
import { groupsToReconcile, reconcileClassification } from '../../lambda/src/group-membership-reconcile';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { oidcIssuer, poolIssuer, stubDirectory, testDirectory } from '../helpers/directory';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const u = (sub: string) => `${APP}/user/${sub}`;
const BOT = `${APP}/bot/advisor`;

/** A directory where `ops` holds the given people and each person's groups are declared. */
function directory(opsMembers: string[], groupsOf: Record<string, string[] | Error | 'undetermined'>, unminted: string[] = []): Directory {
  return stubDirectory({
    personsInGroup: async (g) => (g === 'ops' ? { persons: opsMembers.map(u), unminted } : { persons: [], unminted: [] }),
    personOf: async (subject) => u(subject),
    clearanceOf: async (arn) => {
      const v = groupsOf[arn.split('/').pop() || ''] ?? [];
      if (v instanceof Error) throw v;
      if (v === 'undetermined') return { state: 'undetermined', issuers: ['partner-oidc'] };
      return { state: 'held', token: profiles.resolveHolderToken(v), held: profiles.clearancesForGroups(v), groups: v, admin: false };
    },
  });
}

describe('resolving a membership source to the people it admits', () => {
  it('admits a group member whose clearance reaches the classification, and refuses one whose does not', async () => {
    const set = await resolveAllowedSet({ group: 'ops' }, 'premium', APP,
      directory(['lead', 'basic-only'], { lead: ['premium'], 'basic-only': ['basic'] }));
    expect([...set.admitted]).toEqual([u('lead')]);
    expect(set.refused).toEqual([u('basic-only')]);
  });

  it('takes the union of a group and a list', async () => {
    const set = await resolveAllowedSet({ group: 'ops', list: ['listed'] }, 'premium', APP,
      directory(['lead'], { lead: ['premium'], listed: ['premium'] }));
    expect([...set.admitted].sort()).toEqual([u('lead'), u('listed')].sort());
  });

  it('marks a person whose groups cannot be read as undetermined, never refused', async () => {
    const set = await resolveAllowedSet({ group: 'ops' }, 'premium', APP,
      directory(['lead', 'flaky'], { lead: ['premium'], flaky: new Error('throttled') }));
    expect([...set.undetermined]).toEqual([u('flaky')]);
    expect(set.refused).toEqual([]);
  });

  it('a group member who has never signed in is undetermined, not refused', async () => {
    const set = await resolveAllowedSet({ group: 'ops' }, 'premium', APP,
      directory(['lead'], { lead: ['premium'] }, ['never-signed-in']));
    expect(set.unminted).toEqual(['never-signed-in']);
    expect(set.refused).toEqual([]);
  });

  it('throws when the group itself cannot be listed, so nobody is reconciled against an empty set', async () => {
    const broken: Directory = { ...directory([], {}), personsInGroup: async () => { throw new Error('down'); } };
    await expect(resolveAllowedSet({ group: 'ops' }, 'premium', APP, broken)).rejects.toThrow('down');
  });

  it('leaves a disabled user out of the group, and resolves each enabled one through Identities', async () => {
    const client = {
      send: async () => ({
        Users: [
          { Username: 'a@x', Enabled: true, Attributes: [{ Name: 'sub', Value: 'sub-a' }] },
          { Username: 'b@x', Enabled: false, Attributes: [{ Name: 'sub', Value: 'sub-b' }] },
          { Username: 'c@x', Enabled: true, Attributes: [{ Name: 'sub', Value: 'sub-c' }] },
        ],
      }),
    };
    const resolved: string[] = [];
    const dir = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: poolIssuer('deployment', 'us-east-1_pool'), client }],
      identities: {
        // `sub-c` has never signed in: no Identities row, so no person.
        resolve: async (_iss, sub) => { resolved.push(sub); return sub === 'sub-c' ? null : u(`person-of-${sub}`); },
        subjectsOf: async () => [],
      },
    });
    expect(await dir.personsInGroup('ops')).toEqual({ persons: [u('person-of-sub-a')], unminted: ['sub-c'] });
    // The disabled user was never even resolved.
    expect(resolved).toEqual(['sub-a', 'sub-c']);
  });

  it('a person whose issuer decides only from a token is undetermined, never refused', async () => {
    const set = await resolveAllowedSet({ group: 'ops' }, 'premium', APP,
      directory(['lead', 'mapped'], { lead: ['premium'], mapped: 'undetermined' }));
    expect([...set.admitted]).toEqual([u('lead')]);
    expect([...set.undetermined]).toEqual([u('mapped')]);
    expect(set.refused).toEqual([]);
  });

  it('admits a listed person of an OIDC issuer at the classification its fixed source reaches, and no higher', async () => {
    const PERSON = u('0192f0e0-0000-7000-8000-00000000f1d1');
    const dir = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: oidcIssuer('partner-oidc', { fixed: ['basic'], classifications: ['basic'] }) }],
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: 'partner-oidc', subject: 'oid-1' }] },
    });
    expect([...(await resolveAllowedSet({ list: [PERSON] }, 'basic', APP, dir)).admitted]).toEqual([PERSON]);
    expect((await resolveAllowedSet({ list: [PERSON] }, 'premium', APP, dir)).refused).toEqual([PERSON]);
  });
});

/** A fake channel: humans and moderators, recording every write. */
function channel(humans: string[], moderators: string[] = []) {
  const members = new Set([...humans, BOT]);
  const mods = new Set([...moderators, BOT]);
  const writes: string[] = [];
  const messaging = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      const i = cmd.input;
      if (n === 'ListChannelMembershipsCommand') return { ChannelMemberships: [...members].map((a) => ({ Member: { Arn: a } })) };
      if (n === 'ListChannelModeratorsCommand') return { ChannelModerators: [...mods].map((a) => ({ Moderator: { Arn: a } })) };
      if (n === 'CreateChannelMembershipCommand') { members.add(i.MemberArn); writes.push(`add ${i.MemberArn}`); }
      if (n === 'DeleteChannelMembershipCommand') { members.delete(i.MemberArn); writes.push(`remove ${i.MemberArn}`); }
      if (n === 'CreateChannelModeratorCommand') { mods.add(i.ChannelModeratorArn); writes.push(`mod ${i.ChannelModeratorArn}`); }
      if (n === 'DeleteChannelModeratorCommand') { mods.delete(i.ChannelModeratorArn); writes.push(`unmod ${i.ChannelModeratorArn}`); }
      return {};
    },
  };
  return { messaging: messaging as any, members, mods, writes };
}

describe('the shared reconcile', () => {
  it('adds who joined, removes who left, and never touches an assistant', async () => {
    const c = channel([u('stays'), u('left')]);
    const res = await reconcileHumans({
      messaging: c.messaging, channelArn: 'ch', bearer: BOT,
      allowed: new Set([u('stays'), u('joined')]), moderators: 'revoke-only',
    });
    expect(res.added).toEqual([u('joined')]);
    expect(res.removed).toEqual([u('left')]);
    expect(c.members.has(BOT)).toBe(true);
    expect(c.mods.has(BOT)).toBe(true);
  });

  it('takes moderation from a person it removes, because deleting a membership does not', async () => {
    const c = channel([u('lead')], [u('lead')]);
    const res = await reconcileHumans({ messaging: c.messaging, channelArn: 'ch', bearer: BOT, allowed: new Set(), moderators: 'revoke-only' });
    expect(res.moderatorsRemoved).toEqual([u('lead')]);
  });

  it('revoke-only grants no moderation; all-allowed makes every allowed human a moderator', async () => {
    const a = channel([]);
    await reconcileHumans({ messaging: a.messaging, channelArn: 'ch', bearer: BOT, allowed: new Set([u('x')]), moderators: 'revoke-only' });
    expect(a.writes).toEqual([`add ${u('x')}`]);
    const b = channel([]);
    await reconcileHumans({ messaging: b.messaging, channelArn: 'ch', bearer: BOT, allowed: new Set([u('x')]), moderators: 'all-allowed' });
    expect(b.writes).toEqual([`add ${u('x')}`, `mod ${u('x')}`]);
  });

  it('leaves an undetermined person exactly where they are', async () => {
    const c = channel([u('flaky')]);
    await reconcileHumans({
      messaging: c.messaging, channelArn: 'ch', bearer: BOT, allowed: new Set(), undetermined: new Set([u('flaky')]), moderators: 'revoke-only',
    });
    expect(c.writes).toEqual([]);
  });
});

describe('the per-classification driver', () => {
  it('reconciles only the group an add or remove event names, and only if a type sources from it', () => {
    const add = (groupName: string) => ({ detail: { eventName: 'AdminAddUserToGroup', requestParameters: { groupName } } });
    expect(groupsToReconcile(add('ops'), 'premium')).toEqual(['ops']);
    expect(groupsToReconcile(add('marketing'), 'premium')).toEqual([]);
  });

  it('reconciles every sourced group on the backstop schedule and on a deleted or disabled user', () => {
    expect(groupsToReconcile(undefined, 'premium')).toEqual(['ops']);
    expect(groupsToReconcile({ detail: { eventName: 'AdminDisableUser' } }, 'premium')).toEqual(['ops']);
    expect(groupsToReconcile(undefined, 'basic')).toEqual([]);
  });

  it('reconciles this classification\'s conversations only, and skips one whose channel is gone', async () => {
    const premiumRoom = channel([u('left')]);
    const reached: string[] = [];
    const totals = await reconcileClassification({
      event: { detail: { eventName: 'AdminRemoveUserFromGroup', requestParameters: { groupName: 'ops' } } },
      classification: 'premium',
      appInstanceArn: APP,
      bearer: BOT,
      directory: directory(['lead'], { lead: ['premium'] }),
      messaging: premiumRoom.messaging,
      listChannels: async (typeKey) => (typeKey === 'ops' ? ['premium-room', 'basic-room', 'gone-room'] : []),
      classificationOf: async (arn) => {
        reached.push(arn);
        if (arn === 'gone-room') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
        return arn === 'premium-room' ? 'premium' : 'basic';
      },
    });
    expect(totals.conversations).toBe(1);
    expect(totals.failed).toBe(0);
    expect(premiumRoom.writes).toEqual([`add ${u('lead')}`, `remove ${u('left')}`]);
    expect(reached).toEqual(expect.arrayContaining(['premium-room', 'basic-room', 'gone-room']));
  });

  it('leaves every conversation alone when the group cannot be listed', async () => {
    const room = channel([u('someone')]);
    const totals = await reconcileClassification({
      classification: 'premium',
      appInstanceArn: APP,
      bearer: BOT,
      directory: { ...directory([], {}), personsInGroup: async () => { throw new Error('down'); } },
      messaging: room.messaging,
      listChannels: async () => ['premium-room'],
      classificationOf: async () => 'premium',
    });
    expect(room.writes).toEqual([]);
    expect(totals.failed).toBeGreaterThan(0);
  });
});
