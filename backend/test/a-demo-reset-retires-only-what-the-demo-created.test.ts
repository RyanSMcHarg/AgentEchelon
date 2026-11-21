/**
 * A demo reset returns a deployment to where the demo started: it retires the assistants the console
 * created during the demo and leaves everything the deployment declares exactly as the deploy made it.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assistantsToRetire, parseResetArgs, isTeamRoom, teamRoomClearing } = require('../scripts/lib/reset-demo.cjs');
import { TERMINAL_TASK_STATUS } from '../lambda/src/lib/task-tracking';

const SINCE = new Date('2026-10-27T09:00:00Z');
const entry = (over: Record<string, unknown>) => ({
  classification: 'premium', status: 'active', origin: 'console', createdAt: '2026-10-27T10:00:00Z', ...over,
});

describe('which assistants a demo reset retires', () => {
  it('retires an assistant the console created during the demo', () => {
    expect(assistantsToRetire([['finance-advisor', entry({})]], SINCE).map((a: { name: string }) => a.name))
      .toEqual(['finance-advisor']);
  });

  it('keeps every declared assistant, whenever its deploy wrote it', () => {
    expect(assistantsToRetire([['analyst', entry({ origin: 'declared' })]], SINCE)).toEqual([]);
  });

  it('keeps an assistant created before the demo began', () => {
    expect(assistantsToRetire([['older', entry({ createdAt: '2026-10-26T10:00:00Z' })]], SINCE)).toEqual([]);
  });

  it('leaves an experiment alt to its experiment, and a tombstone as it is', () => {
    expect(assistantsToRetire([
      ['alt-primary-premium', entry({ occupancy: 'alt' })],
      ['gone', entry({ status: 'retired' })],
    ], SINCE)).toEqual([]);
  });

  it('retires a create that failed or is still building, so its name and leftovers are released', () => {
    expect(assistantsToRetire([['a', entry({ status: 'failed' })], ['b', entry({ status: 'provisioning' })]], SINCE)).toHaveLength(2);
  });

  it('treats an entry with no recorded origin as console-created, as the console does', () => {
    expect(assistantsToRetire([['legacy', entry({ origin: undefined })]], SINCE)).toHaveLength(1);
  });
});

describe('the options a reset runs with', () => {
  it('requires the demo window and defaults to a dry run over the demo cast', () => {
    expect(() => parseResetArgs([])).toThrow(/--since/);
    expect(() => parseResetArgs(['--since=yesterday'])).toThrow(/not a time/);
    const opts = parseResetArgs(['--since=2026-10-27T09:00:00Z']);
    expect(opts).toMatchObject({ apply: false, assistants: true, conversations: true, teamRooms: true, secret: 'agent-interface/demo-credentials' });
  });

  it('applies only when asked, and can leave either half alone', () => {
    expect(parseResetArgs(['--since=2026-10-27T09:00:00Z', '--apply', '--skip-conversations']))
      .toMatchObject({ apply: true, assistants: true, conversations: false });
  });
});

describe("what a demo reset clears from a standing team room", () => {
  const ROOM = "arn:aws:chime:us-east-1:1:app-instance/i/channel/team-ops-team-premium";
  const CAST_PERSON = "arn:aws:chime:us-east-1:1:app-instance/i/user/cast-1";
  const REAL_PERSON = "arn:aws:chime:us-east-1:1:app-instance/i/user/on-call-engineer";
  const ASSISTANT = "arn:aws:chime:us-east-1:1:app-instance/i/bot/ops-assistant";
  const CAST = new Set([CAST_PERSON]);
  const msg = (MessageId: string, at: string, author = CAST_PERSON) => ({ MessageId, CreatedTimestamp: new Date(at), author });
  const task = (taskId: string, createdAt: string, terminal: boolean) => ({ taskId, createdAt, terminal });

  it("knows a team room by its fixed id, and nothing else", () => {
    expect(isTeamRoom(ROOM)).toBe(true);
    expect(isTeamRoom("arn:aws:chime:us-east-1:1:app-instance/i/channel/conv-123")).toBe(false);
    expect(isTeamRoom(undefined)).toBe(false);
  });

  it("in a room only the cast is in, clears the window's messages and settled tasks and keeps what came before", () => {
    const plan = teamRoomClearing(
      [msg("old", "2026-10-26T10:00:00Z"), msg("notice", "2026-10-27T10:00:00Z"), msg("notice", "2026-10-27T10:00:00Z"), msg("card", "2026-10-27T10:01:00Z", ASSISTANT)],
      [task("before", "2026-10-26T10:00:00Z", false), task("incident", "2026-10-27T10:01:00Z", true), task("incident", "2026-10-27T10:01:00Z", true)],
      SINCE, { cast: CAST, onlyCastInRoom: true },
    );
    expect(plan).toMatchObject({ clear: true, open: [], messageIds: ["notice", "card"], taskIds: ["incident"] });
  });

  it("never deletes a message a person outside the cast posted", () => {
    const messages = [msg("cast-said", "2026-10-27T10:00:00Z"), msg("engineer-said", "2026-10-27T10:02:00Z", REAL_PERSON), msg("card", "2026-10-27T10:03:00Z", ASSISTANT)];
    for (const onlyCastInRoom of [true, false]) {
      const plan = teamRoomClearing(messages, [], SINCE, { cast: CAST, onlyCastInRoom });
      expect(plan.messageIds).not.toContain("engineer-said");
      expect(plan.messageIds).toContain("cast-said");
    }
    // With nothing named as the cast, nothing a person posted goes.
    expect(teamRoomClearing(messages, [], SINCE).messageIds).toEqual([]);
  });

  it("in a room a real person is in, keeps the assistant's messages and the window's tasks, open or not", () => {
    const plan = teamRoomClearing(
      [msg("cast-said", "2026-10-27T10:00:00Z"), msg("incident-card", "2026-10-27T10:01:00Z", ASSISTANT)],
      [task("real-incident", "2026-10-27T10:01:00Z", false)],
      SINCE, { cast: CAST, onlyCastInRoom: false },
    );
    expect(plan).toMatchObject({ clear: true, messageIds: ["cast-said"], taskIds: [] });
  });

  it("says whose messages go and whose stay, so a dry run shows it", () => {
    const plan = teamRoomClearing(
      [msg("a", "2026-10-27T10:00:00Z"), msg("b", "2026-10-27T10:01:00Z", REAL_PERSON), msg("c", "2026-10-27T10:02:00Z", ASSISTANT)],
      [], SINCE, { cast: CAST, onlyCastInRoom: false },
    );
    expect(plan.authors).toEqual(expect.arrayContaining([
      { author: CAST_PERSON, kind: "cast", included: 1, kept: 0 },
      { author: REAL_PERSON, kind: "other", included: 0, kept: 1 },
      { author: ASSISTANT, kind: "assistant", included: 0, kept: 1 },
    ]));
  });

  it("leaves a room with an open task from the window as it is, and names the task", () => {
    expect(teamRoomClearing([msg("notice", "2026-10-27T10:00:00Z")], [task("incident", "2026-10-27T10:01:00Z", false)], SINCE, { cast: CAST, onlyCastInRoom: true }))
      .toEqual({ clear: false, open: ["incident"], messageIds: [], taskIds: [], authors: [] });
  });

  it("counts an abandoned task as open, since it can be resumed", () => {
    const script = require("fs").readFileSync(require("path").join(__dirname, "..", "scripts", "delete-conversations.mjs"), "utf8");
    const ended = script.match(/const ENDED_STATUS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
    expect(ended).not.toMatch(/abandoned/);
    expect(ended.replace(/['\s]/g, "").split(",").sort()).toEqual(Object.keys(TERMINAL_TASK_STATUS).sort());
  });

  it("clears team rooms only after --only-test-people has kept the rooms a real person is in", () => {
    const script = require("fs").readFileSync(require("path").join(__dirname, "..", "scripts", "delete-conversations.mjs"), "utf8");
    expect(script.indexOf("teamRooms = await onlyTestPeople(teamRooms)")).toBeGreaterThan(-1);
    expect(script.indexOf("teamRooms = await onlyTestPeople(teamRooms)")).toBeLessThan(script.indexOf("await clearTeamRoom("));
  });

  it("can be left alone", () => {
    expect(parseResetArgs(["--since=2026-10-27T09:00:00Z", "--skip-team-rooms"])).toMatchObject({ teamRooms: false, conversations: true });
  });
});

describe("the seed's account teams are part of the cast", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { seededAccountTeamEmails, ACCOUNT_TEAM_GROUP } = require('../scripts/lib/reset-demo.cjs');

  it('names the group the seed puts them in', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(ACCOUNT_TEAM_GROUP).toBe(require('../../demo/stratum-company/account-teams').ACCOUNT_TEAM_GROUP);
  });

  it("names a member of the group on the seed's domain, and never one on another domain", () => {
    const secret = { premiumUser: { email: 'premium@stratum.example.com' }, testAdmin: { email: 'admin@corp.example' } };
    expect(seededAccountTeamEmails(secret, ['CSM-Maria@stratum.example.com', 'real.person@corp.example', ''])).toEqual(['csm-maria@stratum.example.com']);
    expect(seededAccountTeamEmails({}, ['real.person@corp.example'])).toEqual([]);
  });

  it('names them from the demo-credentials secret, which holds the cast by role and no tier users', () => {
    // The shape `provision-test-users --cast ops-demo` writes: the cast by role, a lead on a real address, and the test inbox.
    const demo = {
      onCallLead: { email: 'lead@corp.example' }, platformEngA: { email: 'demo-eng-a@inbox.example.net' },
      testInbox: { bucket: 'b', prefix: '', domain: 'inbox.example.net' },
    };
    const group = ['csm-maria@inbox.example.net', 'csm-li@stratum.example.com', 'real.person@corp.example'];
    expect(seededAccountTeamEmails(demo, group)).toEqual(['csm-maria@inbox.example.net', 'csm-li@stratum.example.com']);
    // With no inbox recorded, the seed's default domain and TEST_EMAIL_DOMAIN name them; a cast member's own domain never does.
    expect(seededAccountTeamEmails({ onCallLead: { email: 'lead@corp.example' } }, group)).toEqual(['csm-li@stratum.example.com']);
    expect(seededAccountTeamEmails({}, ['csm-maria@demo.example.org'], { emailDomain: 'Demo.Example.org' })).toEqual(['csm-maria@demo.example.org']);
  });

  it("defaults to the domain seed-demo puts the demo's addresses on", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEMO_DEFAULT_EMAIL_DOMAIN } = require('../scripts/lib/reset-demo.cjs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const seed: string = require('fs').readFileSync(require('path').resolve(__dirname, '../scripts/seed-demo.ts'), 'utf8');
    const fn = seed.slice(seed.indexOf('async function demoEmailDomain('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain(`return '${DEMO_DEFAULT_EMAIL_DOMAIN}';`);
  });
});

describe('a deleted conversation leaves nothing that names it', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordsNamingDeleted } = require('../scripts/lib/reset-demo.cjs');
  const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  const rows = [
    { channelArn: `${APP}/channel/team`, children: [{ channelId: 'inc-a' }, { channelId: 'kept' }, { channelId: 'inc-b' }] },
    { channelArn: 'watch#alarm#AgentEchelon-x', room: `${APP}/channel/inc-b` },
    { channelArn: 'watch#alarm#AgentEchelon-y', room: `${APP}/channel/kept` },
    { channelArn: `${APP}/channel/inc-a`, children: [{ channelId: 'inc-b' }] },
  ];

  it('names each parent entry, highest index first, and each watch record whose room was deleted', () => {
    expect(recordsNamingDeleted(rows, [`${APP}/channel/inc-a`, `${APP}/channel/inc-b`])).toEqual({
      children: [{ channelArn: `${APP}/channel/team`, index: 2, channelId: 'inc-b' }, { channelArn: `${APP}/channel/team`, index: 0, channelId: 'inc-a' }],
      watches: [{ key: 'watch#alarm#AgentEchelon-x', room: `${APP}/channel/inc-b` }],
    });
  });

  it('DENY: keeps every record naming a conversation that stands', () => {
    expect(recordsNamingDeleted(rows, [])).toEqual({ children: [], watches: [] });
    expect(recordsNamingDeleted(rows, [`${APP}/channel/other`])).toEqual({ children: [], watches: [] });
  });
});
