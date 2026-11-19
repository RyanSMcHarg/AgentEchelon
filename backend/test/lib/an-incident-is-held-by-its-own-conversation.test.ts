/**
 * AN INCIDENT IS HELD BY ITS OWN CONVERSATION (WT122, DESIGN-WORKFLOWS-AND-TASKS section 6 rule 3).
 *
 * What it proves:
 *  - the team conversation's `incident-triage` run opens the incident's conversation, tells the team where it is, and waits
 *    for that conversation's own run to end, holding no task of it; then it reports the incident resolved;
 *  - the incident's conversation's `ops-room` run gives the on-call the incident's task itself, in its own conversation,
 *    and goes on alongside it with the first look, the call offer and the runbook; its end waits on that task, so the run ends
 *    when the on-call resolves it, and not before;
 *  - the two runs meet on one record whichever comes first, named by what ends, and a link naming anything other than a
 *    conversation of the same app instance names nothing (refused);
 *  - a step shape that held a task in another conversation (`in: 'child'`) no longer validates (refused).
 */
import {
  SHIPPED_EVENT_WORKFLOWS, MAX_EVENT_WORKFLOW_STEPS, WAIT_CAME, childEndedOutcome, childEndingOf, continueAfter, eventWorkflowErrors, runEnding, runEventWorkflow,
  type EventRunContext, type EventRunDeps, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import {
  alongsideEndWaitId, childEndWaitId, holdUntilEnded, meetHeldRun, openedConversationOf, parentConversationOf, type HeldRunRecords,
} from '../../lambda/src/lib/held-run';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { parentArnOf } from '../../lambda/src/lib/related-conversations';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { parseTemplate } from '../../lambda/src/lib/document-template';
import { opsIntentPack, stratumIntentPack } from '../../../demo/stratum-company/intent-packs';
import * as fs from 'fs';
import * as path from 'path';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst';
const TEAM = `${APP}/channel/team-ops-team-premium`;
const ROOM = `${APP}/channel/conv-ops-1`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The run records the task service holds, in memory: written once, read back. */
function memoryRecords(opts: { failHold?: boolean } = {}): HeldRunRecords & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    hold: async ({ waitId, channelArn, continuation }) => {
      if (opts.failHold) return { claimed: false, reason: 'failed' };
      const key = `${channelArn}#${waitId}`;
      if (rows.has(key)) return { claimed: false, reason: 'already_claimed' };
      rows.set(key, continuation);
      return { claimed: true };
    },
    read: async ({ waitId, channelArn }) => rows.get(`${channelArn}#${waitId}`) ?? null,
  };
}

/** A run's dependencies that record what it did, with its claims held once. */
function recordingDeps(over: Partial<EventRunDeps> = {}) {
  const claimed = new Set<string>();
  const sent: string[] = [];
  const opened: string[] = [];
  const ended: string[] = [];
  const deps: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
    mentionName: async () => 'Jordan',
    dispatchAgent: async () => true,
    send: async ({ step }) => { sent.push(step); return true; },
    openTask: async (step) => { opened.push(step); return 'opened'; },
    ended: async (d) => { ended.push(d); },
    ...over,
  };
  return { deps, sent, opened, ended, claimed };
}

describe('the team conversation opens the incident and waits for its conversation to end its run', () => {
  const wf = SHIPPED_EVENT_WORKFLOWS['incident-triage'];

  it('opens at once, tells the team where it is, waits on the opened conversation, and reports an end that was not a resolve', () => {
    expect(eventWorkflowErrors('incident-triage', wf)).toEqual([]);
    expect(wf.states.open.open).toMatchObject({ type: 'ops', for: { typeRole: 'on-call:ops' } });
    expect(wf.states.tell.onSuccess).toBe('hold');
    expect(wf.states.hold).toEqual({
      wait: { child: 'ended' }, onSuccess: 'done',
      onFailure: [{ to: 'report-timed-out', when: { 'task:outcome': 'timed-out' } }, { to: 'report-ended', when: { 'task:outcome': 'ended' } }, { to: 'done' }],
    });
    // "RESOLVED" IS SAID AT THE RESOLVE, BY THE INCIDENT CONVERSATION'S RUN (O24), so no step of the team's run says it again.
    expect(JSON.stringify(wf)).not.toMatch(/incident-resolved-team/);
    // IT HOLDS NO TASK (WT129): triage, the incident and its post-incident review are the incident conversation's own.
    expect(Object.entries(wf.states).filter(([, s]) => s.task).map(([k]) => k)).toEqual([]);
  });

  it('goes on at once where the opened conversation\'s run ended first, and waits where it has not', async () => {
    const ctx = { event: 'event-received' as const, channelArn: TEAM, values: { label: 'X', conversation_link: '?conversation=conv-ops-1' } };
    const came = recordingDeps({ wait: async () => 'came' });
    const first = await runEventWorkflow('incident-triage', wf, ctx, came.deps, { from: 'tell', transitions: [] });
    // THE TEAM'S RUN ENDS, saying nothing more: it heard "resolved" at the resolve (O24), and the review is the incident's (WT129).
    expect(first.steps.map((s) => s.step)).toEqual(['tell', 'hold']);
    expect(came.ended).toEqual(['success']);
    const waits = recordingDeps({ wait: async () => 'waiting' });
    const second = await runEventWorkflow('incident-triage', wf, ctx, waits.deps, { from: 'tell', transitions: [] });
    expect(second.ended).toBeUndefined();
    expect(waits.sent).toEqual(['tell']);
    // ITS END, HANDED BACK, GOES ON ONCE: the run ends, and a second hand-back finds the step claimed.
    const back = await continueAfter('incident-triage', wf, ctx, { step: 'hold', outcome: WAIT_CAME }, waits.deps);
    expect(back.ran).toBe(true);
    expect(waits.ended).toEqual(['success']);
    expect(waits.sent).toEqual(['tell']);
    expect((await continueAfter('incident-triage', wf, ctx, { step: 'hold', outcome: WAIT_CAME }, waits.deps)).ran).toBe(false);
  });

  it('tells the team how an incident ended that was not resolved: its deadline passed, or ended unresolved, each in its own template', async () => {
    const gated = (): EventRunContext => ({
      event: 'event-received', channelArn: TEAM, values: { label: 'X', conversation_link: '?conversation=conv-ops-1' },
      gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
    });
    const said = async (outcome: string) => {
      const run = recordingDeps();
      const sentTemplates: string[] = [];
      run.deps.send = async ({ template }) => { sentTemplates.push(template); return true; };
      await continueAfter('incident-triage', wf, gated(), { step: 'hold', outcome }, run.deps);
      return sentTemplates;
    };
    expect(await said(childEndedOutcome('success'))).toEqual([]);
    expect(await said(childEndedOutcome('timed-out'))).toEqual(['incident-timed-out']);
    expect(await said(childEndedOutcome('ended'))).toEqual(['incident-ended-unresolved']);
    // A WAIT THAT COULD NOT BE HELD says nothing about the incident, which may still be open.
    expect(await said('failed')).toEqual([]);
    for (const name of ['incident-resolved-team', 'incident-timed-out', 'incident-ended-unresolved']) {
      const r = renderMessageTemplate(shippedMessageTemplate(name), { label: 'X', conversation_link: '?conversation=conv-ops-1' }, { sections: ['chat'] });
      expect(r.ok && r.sections.chat).toContain('X');
    }
  });

  it('DENY: the incident\'s deadline, a cancel or an archive is never reported as resolved', () => {
    expect(runEnding('success', ['task:deadline'])).toBe('timed-out');
    expect(runEnding('success', ['task:failure:cancelled'])).toBe('ended');
    expect(runEnding('success', ['task:success:resolved'])).toBe('success');
    expect(runEnding('success', [])).toBe('success');
    expect(runEnding('failure', [])).toBe('failed');
    expect(childEndingOf(childEndedOutcome('timed-out'))).toBe('timed-out');
    expect(childEndingOf(WAIT_CAME)).toBeUndefined();
    expect(childEndingOf('waited:anything')).toBeUndefined();
    expect(childEndedOutcome('success')).toBe(WAIT_CAME);
  });

  it('DENY: a wait on the opened conversation needs an open step that opens one, and a move opens none', () => {
    const none = clone(wf) as unknown as EventWorkflow & { states: Record<string, any> };
    none.initial = 'hold'; delete none.states.open; delete none.states.tell;
    expect(eventWorkflowErrors('x', none).join('\n')).toMatch(/wait\.child waits on the conversation this run opens/);
    const bad = clone(wf) as any;
    bad.states.hold.wait = { child: 'opened' };
    expect(eventWorkflowErrors('x', bad).join('\n')).toMatch(/wait is \{ child: ended \}/);
  });
});

describe('the incident\'s conversation holds its lead\'s task and runs the runbook alongside it', () => {
  const room = SHIPPED_EVENT_WORKFLOWS['ops-room'];

  it('validates within the step bound, and only a conversation a workflow opened gives its lead the task', () => {
    expect(eventWorkflowErrors('ops-room', room)).toEqual([]);
    expect(Object.keys(room.states).length).toBeLessThanOrEqual(MAX_EVENT_WORKFLOW_STEPS);
    expect(room.states.opening.onSuccess).toEqual([{ to: 'lead-task', when: { 'event:openedBy': 'workflow' } }, { to: 'greet-lead' }]);
    expect(room.states['lead-task'].task).toEqual({
      machine: 'incident_ownership', by: { participantRole: 'on-call:ops' }, continue: 'alongside',
      assigned: { template: 'incident-owner-task', withoutMeetings: 'incident-owner-task-no-call' }, deadline: { afterMinutes: 43_200 },
      endsRun: true, confirmEnd: 'confirming_resolve', movesTo: 'resolved',
    });
    expect(room.states['lead-task'].onSuccess).toBe('investigation');
    expect(room.states['greet-lead'].onSuccess).toBe('first-look');
  });

  it('goes on past the lead\'s task at once, and its end waits on it until it settles', async () => {
    const holds: string[][] = [];
    const run = recordingDeps({ holdEnd: async (_s, alongside) => { holds.push([...alongside]); return 'held'; } });
    const opened: string[] = [];
    run.deps.openTask = async (step) => { opened.push(step); return step === 'lead-task' ? 'opened' : 'no-worker'; };
    const ctx = { event: 'conversation-opened' as const, channelArn: ROOM, eventPerson: `${APP}/user/lead`, values: { label: 'X', openedBy: 'workflow' } };
    // From the lead's task, a short path to the end: the first look finds no ops assistant, and the run reaches its end.
    const path = clone(room) as unknown as EventWorkflow & { states: Record<string, any> };
    path.states['first-look'].onFailure = 'done';
    const out = await runEventWorkflow('ops-room', path, ctx, run.deps, { from: 'lead-task', transitions: [] });
    expect(opened).toEqual(['lead-task', 'investigation', 'first-look']);
    expect(out.ended).toBeUndefined();
    expect(run.ended).toEqual([]);
    expect(holds).toEqual([['lead-task', 'investigation']]);
    // THE LEAD'S TASK CONTINUES NO STEP: its continuation was claimed when the run went on.
    expect(run.claimed.has('after#lead-task')).toBe(true);
    // ITS SETTLEMENT TAKES THE END, once, as the terminal says.
    const ended = await continueAfter('ops-room', path, ctx, { step: 'done', outcome: WAIT_CAME }, run.deps);
    expect(ended.ended).toBe('success');
    expect(run.ended).toEqual(['success']);
    expect((await continueAfter('ops-room', path, ctx, { step: 'done', outcome: WAIT_CAME }, run.deps)).ran).toBe(false);
  });

  it('its end carries how the lead\'s task ended, held or settled first, so the team is never told a timed-out incident is resolved', async () => {
    const endings: string[] = [];
    const ctx = { event: 'conversation-opened' as const, channelArn: ROOM, values: { openedBy: 'workflow' } };
    const held = recordingDeps({ holdEnd: async () => 'held', ended: async (_d, _s, ending) => { endings.push(ending); } });
    await continueAfter('ops-room', room, ctx, { step: 'done', outcome: 'task:deadline' }, held.deps);
    const first = recordingDeps({ holdEnd: async () => ({ free: ['task:failure:cancelled'] }), ended: async (_d, _s, ending) => { endings.push(ending); } });
    await runEventWorkflow('ops-room', room, ctx, first.deps, { from: 'done', transitions: [] });
    expect(endings).toEqual(['timed-out', 'ended']);
  });

  it('a read that fails is never a task that is gone, nor an opener nobody tells: the router holds, retries, and backstops', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const hold = router.slice(router.indexOf('    holdEnd: async (step, alongside, transitions) => {'), router.indexOf('    ended: async (disposition, steps, ending) => {'));
    // A TASK THE RUN RECORDS AS OPENED is held on without a read, whose failure could not be told from a task that is gone.
    expect(hold).toContain('if (!transitions.some((t) => t.step === held && t.outcome === TASK_STEP_OUTCOMES.opened)) {');
    expect(hold).toContain("if ('came' in met) { settled.push(met.came); by[held] = met.came; continue; }");
    const tell = router.slice(router.indexOf('async function tellOpener('), router.indexOf('async function tellOpener(') + 1500);
    expect(tell).toContain('await tryThrice(() => readChannelContext(childArn, { consistent: true }))');
    expect(tell).not.toMatch(/getChannelContext\(/);
    expect(tell).toContain('const outcome = childEndedOutcome(ending);');
    // THE TEAM'S INCIDENTS ARE COUNTED BY THE CONVERSATION THAT OPENED THEM, read strictly where the task opens.
    expect(router).toContain('? parentConversationOf((await tryThrice(() => readChannelContext(ctx.channelArn, { consistent: true })))?.parentRef, ctx.channelArn) : undefined;');
  });

  it('DENY: at most one task the run goes on alongside ends it, so its settlement alone decides where the run goes', () => {
    const two = clone(room) as any;
    two.states['lead-task-2'] = clone(room.states['lead-task']);
    two.states['lead-task-2'].onSuccess = 'first-look';
    two.states['lead-task-2'].onFailure = 'first-look';
    two.states['greet-lead'].onSuccess = 'lead-task-2';
    expect(eventWorkflowErrors('ops-room', two).join('\n')).toMatch(/at most one task the run goes on alongside ends or moves the run/);
  });

  it('ends at once where nothing it opened alongside is open', async () => {
    const run = recordingDeps({ holdEnd: async () => 'free' });
    const out = await runEventWorkflow('ops-room', room, { event: 'conversation-opened', channelArn: ROOM, values: {} }, run.deps, { from: 'done', transitions: [] });
    expect(out.ended).toBe('success');
  });

  it('DENY: a terminal is no step to continue in a workflow that opens nothing alongside', async () => {
    const wf = SHIPPED_EVENT_WORKFLOWS['incident-watch'];
    const run = recordingDeps();
    expect((await continueAfter('incident-watch', wf, { event: 'alarm-state-changed', channelArn: ROOM, values: {} }, { step: 'done', outcome: WAIT_CAME }, run.deps)).ran).toBe(false);
  });

  it('DENY: a task in another conversation (`in`) is no field of a step, and a request to another role is never alongside', () => {
    const held = clone(room) as any;
    held.states['lead-task'].task.in = 'child';
    expect(eventWorkflowErrors('ops-room', held).join('\n')).toMatch(/task\.in is not a field of a task step/);
    const asked = clone(room) as any;
    asked.states['customer-impact'].task.continue = 'alongside';
    expect(eventWorkflowErrors('ops-room', asked).join('\n')).toMatch(/continue is alongside on a task of the run's own/);
  });

  it('offers the incident call to the lead once the first look has started, then runs the runbook to its recovery reading', () => {
    const s = room.states;
    expect(s['first-look'].onSuccess).toEqual([{ to: 'dashboard', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }]);
    expect(s.dashboard.onSuccess).toBe('offer-call');
    expect(s['offer-call'].task).toMatchObject({ machine: 'meeting_offer', by: { participantRole: 'lead' }, assigned: { template: 'incident-call-offer' } });
    expect(s['offer-call'].onSuccess).toEqual([{ to: 'start-call', when: { 'task:state': 'start' } }, { to: 'customer-impact' }]);
    expect(s['start-call'].action).toMatchObject({ tool: 'start_meeting' });
    expect(s['runbook-cause'].task).toEqual({ machine: 'runbook_cause', by: { assistantRole: 'ops' }, ask: { template: 'runbook-cause' } });
    // EVERY WAY OUT OF THE MITIGATION GOES TO THE RECOVERY READING: customer notices are the customer messaging track's (O31).
    expect(s['runbook-cause'].onFailure).toBe('runbook-verify');
    expect(s['runbook-decide'].onSuccess).toEqual([{ to: 'tell-messaging-mitigating', when: { 'task:state': 'approved' } }, { to: 'runbook-verify' }]);
    expect(s['tell-messaging-mitigating'].onSuccess).toBe('runbook-act');
    expect(s['runbook-decide'].onFailure).toBe('runbook-verify');
    expect(s['runbook-act'].onSuccess).toBe('runbook-verify');
    expect(s['notice-draft']).toBeUndefined();
    expect(s['runbook-verify'].onSuccess).toBe('done');
    for (const told of ['tell-absent', 'tell-unavailable']) {
      expect(s[told].onSuccess).toEqual([{ to: 'offer-call', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }]);
    }
  });
});

describe('the two runs meet on one record, whichever comes first', () => {
  it('the ending first: recorded, and the run that comes to wait goes on at once', async () => {
    const records = memoryRecords();
    expect(await meetHeldRun(records, childEndWaitId(ROOM), TEAM, 'success')).toEqual({ recorded: true });
    expect(await holdUntilEnded(records, childEndWaitId(ROOM), TEAM, { runKey: 'k', step: 'hold' })).toEqual({ came: 'success' });
  });

  it('the run first: held, and the ending hands back the run that waits; a redelivered ending finds it again, claimed once by the run', async () => {
    const records = memoryRecords();
    expect(await holdUntilEnded(records, alongsideEndWaitId('evt-1'), ROOM, { runKey: 'k', step: 'done' })).toEqual({ held: true });
    expect(await holdUntilEnded(records, alongsideEndWaitId('evt-1'), ROOM, { runKey: 'k', step: 'done' })).toEqual({ held: true });
    expect(await meetHeldRun(records, alongsideEndWaitId('evt-1'), ROOM, 'task:success:resolved')).toEqual({ run: { runKey: 'k', step: 'done' } });
  });

  it('DENY: a record that cannot be written is no meeting on either side', async () => {
    const records = memoryRecords({ failHold: true });
    expect(await meetHeldRun(records, childEndWaitId(ROOM), TEAM, 'success')).toEqual({ failed: true });
    expect(await holdUntilEnded(records, childEndWaitId(ROOM), TEAM, { runKey: 'k', step: 'hold' })).toEqual({ failed: true });
  });

  it('DENY: an ending reaches only the run waiting on that very conversation or task', async () => {
    const records = memoryRecords();
    await holdUntilEnded(records, childEndWaitId(ROOM), TEAM, { runKey: 'k', step: 'hold' });
    expect(await meetHeldRun(records, childEndWaitId(`${APP}/channel/conv-ops-2`), TEAM, 'success')).toEqual({ recorded: true });
    expect(await meetHeldRun(records, childEndWaitId(ROOM), `${APP}/channel/team-other-premium`, 'success')).toEqual({ recorded: true });
    expect(childEndWaitId(ROOM)).not.toBe(alongsideEndWaitId(ROOM));
  });

  it('DENY: the opened conversation and the opener are read only as conversations of the same app instance', () => {
    expect(openedConversationOf('?conversation=conv-ops-1', TEAM)).toBe(ROOM);
    expect(parentConversationOf('?conversation=team-ops-team-premium#message=m1', ROOM)).toBe(TEAM);
    expect(openedConversationOf(undefined, TEAM)).toBeUndefined();
    expect(openedConversationOf('?conversation=team-ops-team-premium', TEAM)).toBeUndefined();
    expect(openedConversationOf('?conversation=a%20b', TEAM)).toBeUndefined();
    expect(parentConversationOf('?conversation=conv-ops-1', ROOM)).toBeUndefined();
    expect(parentConversationOf('?conversation=x', 'arn:aws:chime:us-east-1:999:bot/b')).toBeUndefined();
  });

  it('the hand-back and the turn\'s relatives read one link the same way: one parse, one conversation-id rule', () => {
    for (const ref of ['?conversation=team.ops', `?conversation=${'a'.repeat(65)}`, '?conversation=%E0%A4%A', '?conversation=conv-ops-2']) {
      expect(parentConversationOf(ref, ROOM)).toBe(parentArnOf(ROOM, ref));
    }
    expect(parentConversationOf('?conversation=team.ops', ROOM)).toBeUndefined();
    expect(openedConversationOf('?conversation=%E0%A4%A', TEAM)).toBeUndefined();
  });
});

describe('the incident\'s words', () => {
  it('the demo\'s ops assistant states its runbook: its readings as intents it advertises, its cards in templates of the same names', () => {
    const intents = opsIntentPack().intents ?? [];
    for (const key of ['runbook_cause', 'runbook_verify']) {
      const intent = intents.find((i) => i.key === key);
      expect(intent).toMatchObject({ delivery: 'PLACEHOLDER_UPDATE', tools: ['read_deployment_health'] });
      expect(intent!.instructions).toMatch(/Customer API outage runbook/);
    }
    const dir = path.join(__dirname, '../../../demo/portable-assistants/templates/runbook');
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseTemplate(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(names.map((t) => t.name).sort()).toEqual(['customer-impact', 'runbook-act', 'runbook-decision']);
    for (const t of names) expect(t.kind).toBe(shippedMessageTemplate(t.name)!.kind);
    const advisor = stratumIntentPack('premium').intents ?? [];
    for (const key of ['impacted_accounts', 'customer_notice_draft']) expect(advisor.find((i) => i.key === key)).toMatchObject({ delivery: 'PLACEHOLDER_UPDATE' });
  });

  it('the demo\'s published Ops cards fill every field they name, in the double braces a published template requires', () => {
    const root = path.join(__dirname, '../../../demo/portable-assistants/templates');
    const files = ['ops-room-opening.md', 'incident-owner-task.md', ...fs.readdirSync(path.join(root, 'runbook')).filter((f) => f.endsWith('.md')).map((f) => `runbook/${f}`)];
    for (const f of files) {
      const source = fs.readFileSync(path.join(root, f), 'utf8');
      const body = source.slice(source.indexOf('\n---', 3) + 4);
      expect({ f, single: body.match(/(?<!\{)\{[a-z_]+\}(?!\})/g) }).toEqual({ f, single: null });
      const rendered = renderMessageTemplate(parseTemplate(source), { label: 'AgentEchelon-demo-incident', lead: 'Jordan Reyes' });
      expect(rendered.ok).toBe(true);
      expect(rendered.ok && rendered.sections.chat).not.toMatch(/[{}]/);
      if (/{{label}}/.test(body)) expect(rendered.ok && rendered.sections.chat).toMatch(/AgentEchelon-demo-incident/);
    }
  });

  it('the lead is told what the incident is, the steps and when to resolve it; the call\'s offer says what starting it does', () => {
    const lead = renderMessageTemplate(shippedMessageTemplate('incident-owner-task')!, { label: 'AgentEchelon-demo-incident' });
    expect(lead.ok && lead.sections.chat).toMatch(/own the incident for AgentEchelon-demo-incident/);
    expect(lead.ok && lead.sections.chat).toMatch(/1\. First look: the ops assistant reads/);
    expect(lead.ok && lead.sections.chat).toMatch(/Resolve it once the alarm is back to OK/);
    expect(lead.ok && lead.sections.chat).not.toMatch(/\*\*(resolved|acknowledged)\*\*/);
    const offer = renderMessageTemplate(shippedMessageTemplate('incident-call-offer')!, { label: 'AgentEchelon-demo-incident' });
    expect(offer.ok && offer.sections.chat).toMatch(/Start the incident call for AgentEchelon-demo-incident now\? Starting it rings everyone in this conversation/);
  });
});
