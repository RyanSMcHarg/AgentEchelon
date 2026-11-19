/**
 * A CHILD CONVERSATION'S RELATION TO ITS PARENT IS DECLARED ON ITS TYPE (DESIGN-WORKFLOWS-AND-TASKS section 6).
 *
 * `move` shares nothing but the links; `thread` lists the child on its parent, and a turn in either reads the other's
 * latest summary only where every person reading it is a member of both, the read made as the assistant, whose role
 * reaches only its own classification's conversations.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONVERSATION_TYPES, relationOf } from '../../lib/config/conversation-types';
import { CHILDREN_CONSIDERED, MAX_CHILDREN_READ, parentArnOf, readableRelatives, threadRelatives } from '../../lambda/src/lib/related-conversations';
import { buildRelatedConversationsHint } from '../../lambda/src/analytics-aurora/document-retrieval';
import { SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const TEAM = `${APP}/channel/team-ops-team-premium`;
const CHILD = (id: string) => `${APP}/channel/${id}`;
const ALICE = `${APP}/user/alice`;
const BOB = `${APP}/user/bob`;
const CAROL = `${APP}/user/carol`;

const teamRow = (children: Array<{ channelId: string; typeKey: string }>) => ({
  conversationType: 'ops-team',
  children: children.map((c) => ({ ...c, openedAt: '2026-11-08T00:00:00Z' })),
});

const deps = (people: Record<string, string[] | null>) => ({
  peopleOf: async (arn: string) => people[arn] ?? null,
});

describe('a child conversation\'s relation to its parent', () => {
  it('is declared on its type: an incident is a thread, an ordinary conversation moves', () => {
    expect(relationOf('ops')).toBe('thread');
    expect(relationOf('general')).toBe('move');
    expect(relationOf(undefined)).toBe('move');
    for (const [key, type] of Object.entries(CONVERSATION_TYPES)) {
      expect({ key, relation: type.relation ?? 'move' }).toEqual({ key, relation: expect.stringMatching(/^(move|thread)$/) });
    }
  });

  it('the creator lists a thread child on its parent, and a move child on nothing', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/channel-creation.ts'), 'utf8');
    expect(src).toMatch(/if \(input\.parentChannelArn && relationOf\(core\.typeKey\) === 'thread'\) \{\s*await recordChildConversation\(input\.parentChannelArn/);
  });

  it('a thread child is read by its parent, and the parent by the child, where everyone reading is in both', async () => {
    const row = teamRow([{ channelId: 'esc-1', typeKey: 'ops' }]);
    const out = await readableRelatives({ channelArn: TEAM, candidates: threadRelatives(TEAM, row) }, deps({ [TEAM]: [ALICE, BOB], [CHILD('esc-1')]: [ALICE, BOB, CAROL] }));
    expect(out).toEqual([{ channelArn: CHILD('esc-1'), relation: 'child' }]);

    const childRow = { conversationType: 'ops', parentRef: '?conversation=team-ops-team-premium' };
    expect(parentArnOf(CHILD('esc-1'), childRow.parentRef)).toBe(TEAM);
    const up = await readableRelatives({ channelArn: CHILD('esc-1'), candidates: threadRelatives(CHILD('esc-1'), childRow) }, deps({ [CHILD('esc-1')]: [ALICE], [TEAM]: [ALICE, BOB] }));
    expect(up).toEqual([{ channelArn: TEAM, relation: 'parent' }]);
  });

  it('DENY: a parent turn whose conversation has a person the child lacks reads no child summary', async () => {
    const row = teamRow([{ channelId: 'esc-1', typeKey: 'ops' }]);
    const out = await readableRelatives({ channelArn: TEAM, candidates: threadRelatives(TEAM, row) }, deps({ [TEAM]: [ALICE, BOB, CAROL], [CHILD('esc-1')]: [ALICE, BOB] }));
    expect(out).toEqual([]);
  });

  it('DENY: a conversation with nobody in it reads no relative, however the relative\'s members read', async () => {
    const row = teamRow([{ channelId: 'esc-1', typeKey: 'ops' }]);
    const out = await readableRelatives({ channelArn: TEAM, candidates: threadRelatives(TEAM, row) }, deps({ [TEAM]: [], [CHILD('esc-1')]: [ALICE] }));
    expect(out).toEqual([]);
  });

  it('DENY: a move child is never read into its parent, nor its parent into it', async () => {
    const row = teamRow([{ channelId: 'split-1', typeKey: 'general' }]);
    expect(threadRelatives(TEAM, row)).toEqual([]);
    const moved = { conversationType: 'general', parentRef: '?conversation=team-ops-team-premium#message=m1' };
    expect(threadRelatives(CHILD('split-1'), moved)).toEqual([]);
  });

  it('DENY: a child entry in channel Metadata is not read; only the server-side row names children', () => {
    // The relatives come from the server-only row the host grounding reads, never from member-writable Metadata.
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/host-grounding.ts'), 'utf8');
    expect(src).toMatch(/const relatives = threadRelatives\(channelArn, priv\);/);
    expect(src.indexOf('const priv = await getChannelContext(channelArn);')).toBeLessThan(src.indexOf('threadRelatives(channelArn, priv)'));
    expect(src).not.toMatch(/threadRelatives\(channelArn, contextMeta/);
  });

  it('DENY: a conversation whose members cannot be read, another classification\'s among them, is not read', async () => {
    const row = teamRow([{ channelId: 'esc-1', typeKey: 'ops' }, { channelId: 'esc-2', typeKey: 'ops' }]);
    const candidates = threadRelatives(TEAM, row);
    // esc-1 is another classification's, refused at the membership read; esc-2's members cannot be read.
    expect(await readableRelatives({ channelArn: TEAM, candidates }, deps({ [TEAM]: [ALICE], [CHILD('esc-1')]: null, [CHILD('esc-2')]: null }))).toEqual([]);
    // Nobody here could be read: nothing is read at all.
    expect(await readableRelatives({ channelArn: TEAM, candidates }, deps({ [CHILD('esc-1')]: [ALICE] }))).toEqual([]);
  });

  it('considers the newest children, newest first, and reads at most three that pass', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const row = teamRow(ids.map((channelId) => ({ channelId, typeKey: 'ops' })));
    const named = threadRelatives(TEAM, row);
    expect(named.map((r) => r.channelArn)).toEqual(['h', 'g', 'f', 'e', 'd', 'c'].map(CHILD));
    expect(named).toHaveLength(CHILDREN_CONSIDERED);
    // AN ENDED CHILD THAT CANNOT BE READ GIVES ITS PLACE TO AN OLDER ONE STILL OPEN.
    const people: Record<string, string[] | null> = { [TEAM]: [ALICE] };
    for (const id of ids) people[CHILD(id)] = id === 'h' || id === 'g' ? null : [ALICE];
    const out = await readableRelatives({ channelArn: TEAM, candidates: named }, deps(people));
    expect(out.map((r) => r.channelArn)).toEqual(['f', 'e', 'd'].map(CHILD));
    expect(out).toHaveLength(MAX_CHILDREN_READ);
  });

  it('a parent ref that is not a conversation id names no parent', () => {
    expect(parentArnOf(CHILD('x'), '?conversation=../../evil')).toBeUndefined();
    expect(parentArnOf(CHILD('x'), undefined)).toBeUndefined();
  });

  it('the turn is told what each says, as context', () => {
    const hint = buildRelatedConversationsHint([{ relation: 'child', summary: 'The on-call restarted the service.' }]);
    expect(hint).toMatch(/RELATED CONVERSATIONS/);
    expect(hint).toMatch(/A conversation opened from this one\n\nThe on-call restarted the service\./);
    expect(buildRelatedConversationsHint([])).toBe('');
  });

  it('an incident\'s resolve is said in the team conversation it was opened from, by the incident conversation\'s run (O24)', () => {
    const wf = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
    expect(wf.states.hold.onSuccess).toBe('done');
    expect(SHIPPED_EVENT_WORKFLOWS['ops-room'].states['tell-team'].send).toMatchObject({ template: 'incident-resolved-team', to: 'room', in: 'opener' });
    expect(eventWorkflowErrors('incident-triage', wf)).toEqual([]);
  });
});
