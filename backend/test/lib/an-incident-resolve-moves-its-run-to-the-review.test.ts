/**
 * AN INCIDENT'S RESOLVE MOVES ITS RUN TO THE REVIEW (SPEC-WORKFLOWS-AND-TASKS WT129; SPEC-PROCESSES P11; DESIGN-PROCESSES O15, O20, O22).
 *
 * What it proves: incident response is the content of `incident-triage` and `ops-room`, built from the existing steps and one
 * field (`movesTo`): triage on the incident card opens the incident conversation; the root-cause investigation is a living task
 * beside the work; resolving moves the run on rather than ending it, cancelling the runbook's open tasks and keeping the
 * investigation; the post-incident review runs in the incident conversation, drafted by the ops assistant and completed on a
 * card, and starts only once resolve is reached and the investigation is complete (`wait: { alongside }`), so a wait that
 * fails never starts it and the run ends after the review, its ending the resolve's alone, so the team hears nothing after
 * "resolved" however the investigation ended; the team conversation runs no review of its own. The ops team's
 * process links the two workflows by one id, and no step crosses to another team (O22). The runbook drafts no customer notice:
 * customer messaging is its own track beside the incident (O31, `customer-messaging-is-a-track-beside-the-incident.test.ts`).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  ALONGSIDE_RELEASED, MAX_EVENT_RUN_STEPS, RUN_END_CLAIM, MAX_EVENT_WORKFLOW_STEPS, SHIPPED_EVENT_WORKFLOWS, childEndedOutcome, continueAfter, edgeTargets, eventWorkflowErrors,
  runEndingAfterMove, runEventWorkflow, runMovedOn, versionProcessesErrors,
  type ChildEnding, type EventRunContext, type EventRunDeps, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { opsIncidentProcess } from '../../../demo/portable-assistants/ops-assistant-manifest';
import { stratumIntentPack } from '../../../demo/stratum-company/intent-packs';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';

const room = SHIPPED_EVENT_WORKFLOWS['ops-room'];
const team = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
const s = (wf: EventWorkflow) => wf.states as Record<string, any>;
const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
const service = readFileSync(resolve(__dirname, '../../lambda/src/task-service.ts'), 'utf8');

/** Every step a step can lead to, through its edges. */
function reachable(wf: EventWorkflow, from: string): Set<string> {
  const seen = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k) || !s(wf)[k]) return;
    seen.add(k);
    const d = s(wf)[k];
    for (const e of [d.onSuccess, d.onFailure, d.onDeadline]) for (const t of edgeTargets(e)) walk(t);
  };
  walk(from);
  return seen;
}

describe('the incident\'s shape (WT129)', () => {
  it('both workflows validate, within the 32-step bound', () => {
    expect(MAX_EVENT_WORKFLOW_STEPS).toBe(32);
    expect(MAX_EVENT_RUN_STEPS).toBe(32);
    expect(eventWorkflowErrors('ops-room', room)).toEqual([]);
    expect(eventWorkflowErrors('incident-triage', team)).toEqual([]);
  });

  it('the alarm opens the incident conversation at once, asking nobody first', () => {
    expect(team.initial).toBe('open');
    expect(s(team).open.onSuccess).toBe('tell');
    expect(s(team).open.onFailure).toBe('done');
  });

  it('the investigation is a living task beside the work, never required before resolve', () => {
    expect(s(room).investigation.task).toMatchObject({ continue: 'alongside' });
    expect(s(room).investigation.task.endsRun).toBeUndefined();
    expect(reachable(room, 'investigation').has('runbook-verify')).toBe(true);
  });

  it('resolving moves the run on to tell the room, rather than ending it', () => {
    expect(s(room)['lead-task'].task).toMatchObject({ endsRun: true, movesTo: 'resolved', confirmEnd: 'confirming_resolve' });
    expect(s(room).resolved.send.template).toBe('incident-resolved');
    expect(s(room).resolved.onSuccess).toBe('tell-team');
    expect(s(room)['tell-team'].onSuccess).toBe('tell-messaging-resolved');
    expect(s(room)['tell-team'].onFailure).toBe('tell-messaging-resolved');
    expect(s(room)['tell-messaging-resolved']).toMatchObject({ send: { in: 'opened', template: 'customer-messaging-resolved' }, onSuccess: 'investigation-complete', onFailure: 'investigation-complete' });
  });

  it('the review runs in the incident conversation once resolve is reached and the investigation is complete; a failed wait never starts it', () => {
    expect(s(room)['investigation-complete']).toMatchObject({ wait: { alongside: 'settled' }, onSuccess: 'review-draft', onFailure: 'done' });
    expect(s(room)['review-draft'].agent).toMatchObject({ prompt: 'post-incident-review-draft', reads: 'messages', to: 'room' });
    expect(s(room).review.task).toMatchObject({ machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, assigned: { template: 'post-incident-review' } });
    expect(s(room).review.onSuccess).toBe('done');
    // ONLY THE RESOLVE REACHES IT: no step before resolve leads to the wait, and the wait's failure edge leads to no review.
    expect(reachable(room, 'lead-task').has('investigation-complete')).toBe(false);
    expect(reachable(room, 'done').has('review')).toBe(false);
    // THE TEAM CONVERSATION RUNS NO REVIEW: its run ends once the incident's has.
    expect(reachable(team, 'open').has('review')).toBe(false);
    expect(Object.keys(s(team))).not.toContain('review-draft');
    expect(s(team).hold.onSuccess).toBe('done');
  });
});

describe('the review waits on the investigation (wait: { alongside })', () => {
  const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/conv-ops-1';
  const ctx: EventRunContext = {
    event: 'conversation-opened', channelArn: ROOM, values: { openedBy: 'workflow', label: 'X' },
    gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
  };
  function deps(holdEnd: NonNullable<EventRunDeps['holdEnd']>) {
    const claimed = new Set<string>();
    const dispatched: string[] = [];
    const ended: string[] = [];
    const endings: string[] = [];
    const sent: string[] = [];
    const held: Array<{ step: string; alongside: string[] }> = [];
    const d: EventRunDeps = {
      claimRun: async () => true,
      claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
      mentionName: async () => 'Jordan',
      dispatchAgent: async (step) => { dispatched.push(step); return true; },
      send: async (msg) => { sent.push(msg.template); return true; },
      openTask: async () => 'opened',
      ended: async (disposition, _steps, ending) => { ended.push(disposition); endings.push(ending); },
      holdEnd: async (step, alongside, transitions) => { held.push({ step, alongside: [...alongside] }); return holdEnd(step, alongside, transitions); },
    };
    return { d, dispatched, ended, endings, sent, held };
  }

  it('holds at the wait while the investigation is open, and the review starts once it completes, once', async () => {
    const run = deps(async () => 'held');
    const out = await runEventWorkflow('ops-room', room, ctx, run.d, { from: 'resolved', transitions: [{ step: 'lead-task', outcome: 'task:success:resolved' }] });
    expect(out.steps.map((x) => x.step)).toEqual(['resolved', 'tell-team', 'tell-messaging-resolved', 'investigation-complete']);
    expect(run.held[0]).toEqual({ step: 'investigation-complete', alongside: ['lead-task', 'investigation'] });
    expect(run.dispatched).toEqual([]);
    const released = [{ step: 'investigation', outcome: ALONGSIDE_RELEASED }];
    const twice = deps(async () => ({ free: [] }));
    const back = await continueAfter('ops-room', room, ctx, { step: 'investigation-complete', outcome: 'task:success:acknowledged', transitions: released }, twice.d);
    expect(back.steps.map((x) => x.step)[0]).toBe('review-draft');
    // A REDELIVERED RELEASE STARTS NOTHING MORE.
    expect((await continueAfter('ops-room', room, ctx, { step: 'investigation-complete', outcome: 'task:success:acknowledged', transitions: released }, twice.d)).ran).toBe(false);
    expect(twice.dispatched).toEqual(['review-draft']);
  });

  it('goes on at once where the investigation completed before resolve', async () => {
    const run = deps(async () => ({ free: ['task:success:resolved', 'task:success:acknowledged'] }));
    await runEventWorkflow('ops-room', room, ctx, run.d, { from: 'resolved', transitions: [] });
    expect(run.dispatched).toEqual(['review-draft']);
  });

  it('DENY: an investigation cancelled or past its deadline never starts the review, and the run ends', async () => {
    for (const outcome of ['task:deadline', 'task:failure:cancelled']) {
      const late = deps(async () => ({ free: [] }));
      const out = await continueAfter('ops-room', room, ctx, { step: 'investigation-complete', outcome, transitions: [{ step: 'investigation', outcome: ALONGSIDE_RELEASED }] }, late.d);
      expect(out.ended).toBe('success');
      expect(late.ended).toEqual(['success']);
      expect(late.dispatched).toEqual([]);
      const now = deps(async () => ({ free: [outcome] }));
      await runEventWorkflow('ops-room', room, ctx, now.d, { from: 'investigation-complete', transitions: [] });
      expect(now.dispatched).toEqual([]);
    }
  });

  it('DENY: after a resolve, an investigation that did not complete never makes the run end unresolved, and the team hears nothing after "resolved"', async () => {
    const teamCtx: EventRunContext = { ...ctx, event: 'event-received', channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/team-ops-team-premium', values: { resource: 'alarm' } };
    for (const outcome of ['task:deadline', 'task:failure:cancelled']) {
      // THE INVESTIGATION ENDED BEFORE THE RESOLVE REACHED ITS WAIT: both alongside tasks are settled, the lead's by the resolve.
      const by = { 'lead-task': 'task:success:resolved', investigation: outcome };
      const run = deps(async () => ({ free: Object.values(by), by }));
      const out = await runEventWorkflow('ops-room', room, ctx, run.d, { from: 'resolved', transitions: [{ step: 'lead-task', outcome: 'task:success:resolved' }] });
      expect(out.ended).toBe('success');
      expect(run.dispatched).toEqual([]);
      // THE ENDING IS THE RESOLVE'S, not the investigation's, and the only words said after it are the resolve's own.
      expect(run.endings).toEqual(['success']);
      expect(run.sent).toEqual(['incident-resolved', 'incident-resolved-team', 'customer-messaging-resolved']);
      // TOLD THAT ENDING, THE TEAM CONVERSATION'S WAIT GOES ON AND SAYS NOTHING: no "ended unresolved", no "timed out".
      const teamRun = deps(async () => 'free');
      await continueAfter('incident-triage', team, teamCtx, { step: 'hold', outcome: childEndedOutcome(run.endings[0] as ChildEnding) }, teamRun.d);
      expect(teamRun.sent).toEqual([]);
    }
  });

  it('DENY: a run that did not move on still ends by how its tasks alongside ended', () => {
    expect(runEndingAfterMove(room, 'success', ['task:success:resolved', 'task:deadline'], { 'lead-task': 'task:success:resolved', investigation: 'task:deadline' })).toBe('success');
    expect(runEndingAfterMove(room, 'success', ['task:deadline'], { 'lead-task': 'task:deadline' })).not.toBe('success');
    expect(runEndingAfterMove(room, 'success', ['task:success:resolved', 'task:failure:cancelled'], { investigation: 'task:failure:cancelled' })).not.toBe('success');
    // A SETTLEMENT THE END WAS RELEASED BY, whose step it does not name, still decides a run that did not move.
    expect(runEndingAfterMove(room, 'success', ['task:failure:cancelled'], {})).not.toBe('success');
  });

  it('holds again on another task still open, continued by that one\'s settlement', async () => {
    const again = deps(async () => 'held');
    const first = await continueAfter('ops-room', room, ctx, { step: 'investigation-complete', outcome: 'task:success:acknowledged', transitions: [{ step: 'investigation', outcome: ALONGSIDE_RELEASED }] }, again.d);
    expect(first).toEqual({ ran: true, steps: [] });
    expect(again.held[0]).toEqual({ step: 'investigation-complete', alongside: ['lead-task'] });
    expect(again.dispatched).toEqual([]);
  });

  it('DENY: a wait on the tasks alongside needs a task that goes on alongside, and takes no other key', () => {
    const none = { ...room, states: Object.fromEntries(Object.entries(s(room)).map(([k, d]) => [k, d.task?.continue === 'alongside' ? { ...d, task: { machine: d.task.machine, by: d.task.by, assigned: d.task.assigned, deadline: d.task.deadline } } : d])) } as EventWorkflow;
    expect(eventWorkflowErrors('ops-room', none).join('\n')).toMatch(/wait\.alongside waits on the tasks this run goes on alongside/);
    const bad = { ...room, states: { ...s(room), 'investigation-complete': { ...s(room)['investigation-complete'], wait: { alongside: 'settled', minutes: 5 } } } } as EventWorkflow;
    expect(eventWorkflowErrors('ops-room', bad).join('\n')).toMatch(/wait is \{ alongside: settled \}/);
  });
});

describe('a resolve that moves the run on (O15)', () => {
  it('is declared beside endsRun, naming a step of the workflow', () => {
    const bad = (task: object) => eventWorkflowErrors('x', { ...room, states: { ...s(room), 'lead-task': { ...s(room)['lead-task'], task: { ...s(room)['lead-task'].task, ...task } } } } as EventWorkflow).join('\n');
    expect(bad({ movesTo: 'no-such-step' })).toMatch(/movesTo names a step of this workflow/);
    expect(bad({ endsRun: undefined, confirmEnd: undefined })).toMatch(/movesTo names the step the run goes on to/);
  });

  it('claims the steps the run waits at before their tasks are cancelled, keeps what it went on alongside, and moves once', () => {
    const fn = router.slice(router.indexOf('async function moveRunOn('), router.indexOf('async function moveRunOn(') + 1200);
    expect(fn.indexOf('claimEventStep(')).toBeLessThan(fn.indexOf('endRunTasks('));
    expect(fn).toMatch(/endRunTasks\(channelArn, run\.runKey, \{ keepAlongside: true \}\)/);
    expect(router).toMatch(/deps\.claimStep\(`moved#\$\{str\(req\.step\)\}`/);
    expect(service).toMatch(/if \(input\.keepAlongside && task\.workflowRun\?\.holdsEnd\) continue;/);
  });

  it('only a success moves it, from a held end too; any other settlement ends it as endsRun does', () => {
    const fn = router.slice(router.indexOf('async function releaseHeldEnd('), router.indexOf('async function endRunWhereItStands('));
    expect(fn.match(/run\.movesTo && taskOutcomeOf\(outcome\)\.edge === 'success'/g)?.length).toBe(2);
  });
});

describe('the incident as one process (P11, O22)', () => {
  const processes = opsIncidentProcess();
  const own = { 'incident-triage': team, 'ops-room': room, 'customer-messaging': SHIPPED_EVENT_WORKFLOWS['customer-messaging'] };

  it('links both workflows by one process id, with a declared metric, and nothing else', () => {
    expect(versionProcessesErrors(processes, own)).toEqual([]);
    expect(Object.keys(processes['incident-response']).sort()).toEqual(['description', 'label', 'metrics', 'workflows']);
    expect(processes['incident-response'].workflows).toEqual(['incident-triage', 'ops-room', 'customer-messaging']);
  });

  it('DENY: a process entry that declares hand-offs is refused, since no hand-off is built (O22)', () => {
    const withHandoffs = { 'incident-response': { ...processes['incident-response'], handoffs: { 'customer-communication': { fields: { incident: { type: 'id' } } } } } };
    expect(versionProcessesErrors(withHandoffs, own)).toEqual(['processes.incident-response: PROCESSES_SHAPE']);
  });

  it('no step of either workflow crosses to another team', () => {
    for (const wf of [room, team, SHIPPED_EVENT_WORKFLOWS['customer-messaging']]) for (const d of Object.values(s(wf))) expect(Object.keys(d)).not.toContain('handoff');
    expect(Object.keys(SHIPPED_EVENT_WORKFLOWS)).not.toContain('customer-messaging-finalized');
  });
});

describe('the runbook drafts no customer notice of its own (DESIGN-PROCESSES O31)', () => {
  const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/conv-ops-1';
  const ctx: EventRunContext = {
    event: 'conversation-opened', channelArn: ROOM, values: { openedBy: 'workflow', label: 'X' },
    gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
  };

  it('the notice-draft step and its template are gone, superseded by the customer messaging track', () => {
    expect(Object.keys(s(room))).not.toContain('notice-draft');
    expect(() => shippedMessageTemplate('customer-notice-draft')).toThrow();
    for (const d of Object.values(s(room))) expect(d.task?.machine).not.toBe('customer_notice_draft');
  });

  it('the mitigation, however it went, goes on to the recovery reading', async () => {
    for (const after of [{ step: 'runbook-act', outcome: 'task:success:acknowledged' }, { step: 'runbook-decide', outcome: 'task:success:declined' }, { step: 'runbook-cause', outcome: 'task:failure:failed' }]) {
      const opened: string[] = [];
      const claimed = new Set<string>();
      const d: EventRunDeps = {
        claimRun: async () => true,
        claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
        mentionName: async () => 'Jordan', dispatchAgent: async () => true, send: async () => true,
        openTask: async (step) => { opened.push(step); return 'opened'; }, ended: async () => undefined,
      };
      const out = await continueAfter('ops-room', room, ctx, after, d);
      expect(out.steps.map((x) => x.step)).toEqual(['runbook-verify']);
      expect(opened).toEqual(['runbook-verify']);
    }
  });

  it('the account team\'s drafting intent is still one turn that sends nothing', () => {
    const intent = (stratumIntentPack('premium').intents ?? []).find((i) => i.key === 'customer_notice_draft')!;
    expect(intent).toMatchObject({ delivery: 'PLACEHOLDER_UPDATE', tools: ['load_company_context'] });
    expect(intent.instructions).toMatch(/Send nothing/);
    const ask = renderMessageTemplate(shippedMessageTemplate('customer-notice-initial')!, { label: 'X' }, { sections: ['chat'] });
    expect(ask.ok && ask.sections.chat).toMatch(/sent to nobody/);
  });
});

describe('a run a resolve moved on ends holding nothing open (O15)', () => {
  const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/conv-ops-1';
  const ctx: EventRunContext = {
    event: 'conversation-opened', channelArn: ROOM, values: { openedBy: 'workflow', label: 'X' },
    gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
  };
  /** The run's tasks by step, as the task service holds them: live, or how they settled. */
  function incident() {
    const tasks: Record<string, { machine: string; state: 'live' | string; reason?: string }> = {};
    const claimed = new Set<string>();
    const ended: string[] = [];
    let endTasksCalls = 0;
    const d: EventRunDeps = {
      claimRun: async () => true,
      claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
      mentionName: async () => 'Jordan',
      dispatchAgent: async () => true,
      send: async () => true,
      openTask: async (step, task) => { tasks[step] = { machine: task.machine, state: 'live' }; return 'opened'; },
      // THE END HOLDS ON EACH TASK ALONGSIDE STILL LIVE, and is freed with how each settled, by its step.
      holdEnd: async (_step, alongside) => {
        if (alongside.some((k) => tasks[k]?.state === 'live')) return 'held';
        const by = Object.fromEntries(alongside.filter((k) => tasks[k]).map((k) => [k, tasks[k].state]));
        return { free: Object.values(by), by };
      },
      hasEnded: async () => claimed.has(RUN_END_CLAIM),
      ended: async (disposition) => { ended.push(disposition); },
      // THE TASK SERVICE'S endRunTasks: each live task of the run is cancelled with the run's end as its reason.
      endTasks: async () => {
        endTasksCalls += 1;
        for (const t of Object.values(tasks)) if (t.state === 'live') Object.assign(t, { state: 'task:failure:cancelled', reason: 'run-ended' });
      },
    };
    return { d, tasks, ended, endTasksCalls: () => endTasksCalls };
  }

  it('an open call offer, resolved, investigation completed, review completed: no live task is left, the offer cancelled run-ended', async () => {
    const run = incident();
    // BEFORE THE RESOLVE: the incident and the investigation beside the work, and the call offer the runbook opened.
    run.tasks['lead-task'] = { machine: 'incident_ownership', state: 'live' };
    run.tasks.investigation = { machine: 'acknowledgement', state: 'live' };
    run.tasks['offer-call'] = { machine: 'meeting_offer', state: 'live' };
    // RESOLVED: the run moves on, and waits on the investigation.
    run.tasks['lead-task'].state = 'task:success:resolved';
    const moved = await runEventWorkflow('ops-room', room, ctx, run.d, { from: 'resolved', transitions: [{ step: 'lead-task', outcome: 'task:success:resolved' }] });
    expect(moved.steps.map((x) => x.step)).toEqual(['resolved', 'tell-team', 'tell-messaging-resolved', 'investigation-complete']);
    // THE INVESTIGATION COMPLETES: the review is drafted, and its task opened.
    run.tasks.investigation.state = 'task:success:acknowledged';
    const released = [{ step: 'investigation', outcome: ALONGSIDE_RELEASED }];
    await continueAfter('ops-room', room, ctx, { step: 'investigation-complete', outcome: 'task:success:acknowledged', transitions: released }, run.d);
    await continueAfter('ops-room', room, ctx, { step: 'review-draft', outcome: 'posted' }, run.d);
    expect(run.tasks.review).toEqual({ machine: 'acknowledgement', state: 'live' });
    expect(run.ended).toEqual([]);
    // THE REVIEW COMPLETES: its settlement carries no transitions, as a task's continuation does not, and the run ends.
    run.tasks.review.state = 'task:success:acknowledged';
    const end = await continueAfter('ops-room', room, ctx, { step: 'review', outcome: 'task:success:acknowledged' }, run.d);
    expect(end.ended).toBe('success');
    expect(run.ended).toEqual(['success']);
    expect(run.endTasksCalls()).toBe(1);
    expect(Object.entries(run.tasks).filter(([, t]) => t.state === 'live')).toEqual([]);
    expect(run.tasks['offer-call']).toEqual({ machine: 'meeting_offer', state: 'task:failure:cancelled', reason: 'run-ended' });
    // THE INVESTIGATION AND THE REVIEW KEEP HOW THEY SETTLED.
    expect(run.tasks.investigation.state).toBe('task:success:acknowledged');
    expect(run.tasks.review.state).toBe('task:success:acknowledged');
  });

  it('a move is read from the release of its end or from the transitions, and from nothing else', () => {
    expect(runMovedOn(room, [{ step: 'review', outcome: 'task:success:acknowledged' }], { 'lead-task': 'task:success:resolved' })).toBe(true);
    expect(runMovedOn(room, [{ step: 'lead-task', outcome: 'task:success:resolved' }, { step: 'resolved', outcome: 'sent' }])).toBe(true);
    expect(runMovedOn(room, [{ step: 'runbook-verify', outcome: 'task:success:done' }], { 'lead-task': 'task:deadline' })).toBe(false);
    expect(runMovedOn(room, [{ step: 'lead-task', outcome: 'task:success:resolved' }, { step: 'investigation', outcome: 'opened' }])).toBe(false);
  });

  it('the router settles them through the task service, every live task of the run, the investigation included', () => {
    const fn = router.slice(router.indexOf('endTasks: async () => {'), router.indexOf('endTasks: async () => {') + 300);
    expect(fn).toMatch(/endRunTasks\(ctx\.channelArn, runKey\);/);
    expect(fn).not.toMatch(/keepAlongside/);
  });
});
