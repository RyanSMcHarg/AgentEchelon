/**
 * AN INCIDENT OFFERS A CALL ONLY WHERE MEETINGS ARE DECLARED, AND ITS ACCOUNT-TEAMS CARD GOES TO ITS LEAD ALONE
 * (SPEC-ASSISTANT-MEETINGS FR42, CONTRIBUTING "absent means off").
 *
 * What it proves:
 *  - where the deployment declares no `meetings` capability (the run has no meeting step to take), the call offer is skipped
 *    at run time: nobody is asked, no task opens, and the runbook goes on at once; where it is declared, the offer is made;
 *  - the lead's task is told in its no-call words there, which say nothing of a call, and in its own words elsewhere;
 *  - the runbook's customer-impact request is made for the run's lead, so the asked turn may offer its add-to-meeting card
 *    to that lead and to nobody else: not the sender of any message, not a person of another app instance, not an assistant,
 *    and not a role with more than one holder (DENY);
 *  - the lead's task and the ask say the conversation's assistant offers that card.
 */
import { SHIPPED_EVENT_WORKFLOWS, audienceOf, eventWorkflowErrors, runEventWorkflow, type EventRunDeps, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { assignedTemplateFor } from '../../lambda/src/lib/task-step';
import { proposalAddresseeOf } from '../../lambda/src/lib/asked-turn';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst';
const ROOM = `${APP}/channel/conv-ops-1`;
const LEAD = `${APP}/user/lead`;
const room = SHIPPED_EVENT_WORKFLOWS['ops-room'];
const read = (f: string) => readFileSync(resolve(__dirname, '../../lambda/src', f), 'utf8');

function deps(over: Partial<EventRunDeps>) {
  const opened: string[] = [];
  const d: EventRunDeps = {
    claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true,
    send: async () => true,
    openTask: async (step) => { opened.push(step); return 'opened'; },
    ...over,
  };
  return { d, opened };
}

describe('the call offer runs only where meetings are declared', () => {
  const ctx = { event: 'conversation-opened' as const, channelArn: ROOM, eventPerson: LEAD, values: { label: 'X', openedBy: 'workflow' }, roles: { lead: [LEAD] } };

  it('skips the offer where the run has no meeting step to take, and asks the customer-impact request at once', async () => {
    const { d, opened } = deps({});
    const out = await runEventWorkflow('ops-room', room, ctx, d, { from: 'offer-call', transitions: [] });
    expect(out.steps[0]).toEqual({ step: 'offer-call', outcome: 'skipped' });
    expect(out.steps.map((s) => s.step)).not.toContain('start-call');
    expect(opened).toEqual(['customer-impact']);
  });

  it('makes the offer where meetings are declared', async () => {
    const { d, opened } = deps({ startMeeting: async () => ({ link: 'https://x' }) });
    const out = await runEventWorkflow('ops-room', room, ctx, d, { from: 'offer-call', transitions: [] });
    expect(out.steps[0]).toEqual({ step: 'offer-call', outcome: 'opened' });
    expect(opened).toEqual(['offer-call']);
  });

  it('tells the lead the no-call words where meetings are not declared, and its own words where they are', () => {
    const assigned = room.states['lead-task'].task!.assigned;
    expect(assignedTemplateFor(assigned, true)).toBe('incident-owner-task');
    expect(assignedTemplateFor(assigned, false)).toBe('incident-owner-task-no-call');
    expect(assignedTemplateFor({ template: 'only' }, false)).toBe('only');
    expect(assignedTemplateFor(undefined, false)).toBeUndefined();
    expect(read('router-agent-handler.ts')).toMatch(/template: assignedTemplateFor\(def\.assigned, !!process\.env\.MEETING_RUN_FUNCTION\) \?\? 'workflow-task-assigned'/);
    const none = renderMessageTemplate(shippedMessageTemplate('incident-owner-task-no-call')!, { label: 'X' });
    expect(none.ok && none.sections.chat).toMatch(/own the incident for X/);
    expect(none.ok && none.sections.chat).not.toMatch(/call|meeting/i);
  });

  it('DENY: a template named for the no-meetings words is one this assistant has', () => {
    const wf = JSON.parse(JSON.stringify(room)) as EventWorkflow & { states: Record<string, any> };
    wf.states['lead-task'].task.assigned.withoutMeetings = 'no-such-template';
    expect(eventWorkflowErrors('ops-room', wf).join('\n')).toMatch(/assigned\.withoutMeetings names no-such-template/);
    wf.states['lead-task'].task.assigned = { template: 'incident-owner-task', other: 'x' };
    expect(eventWorkflowErrors('ops-room', wf).join('\n')).toMatch(/assigned is \{ template, withoutMeetings\? \}/);
  });
});

describe('the account-teams card goes to the run\'s lead alone', () => {
  it('the customer-impact request is made for the run\'s recorded lead', () => {
    expect(room.states['customer-impact'].task).toEqual({ machine: 'impacted_accounts', for: { participantRole: 'lead' }, by: { assistantRole: 'primary' }, ask: { template: 'customer-impact' } });
    expect(eventWorkflowErrors('ops-room', room)).toEqual([]);
  });

  it('the router hands the asked turn the person the request is for, and nothing else names its addressee', () => {
    const router = read('router-agent-handler.ts');
    const ask = router.slice(router.indexOf('async function askAnother('), router.indexOf('async function openWorkflowTaskStep('));
    expect(ask).toMatch(/\.\.\.\(args\.requesterArn \? \{ for: args\.requesterArn \} : \{\}\),/);
    const step = router.slice(router.indexOf('async function openWorkflowTaskStep('));
    expect(step).toMatch(/const requesterArn = def\.for !== undefined \? one\(def\.for\) : undefined;\s*if \(def\.for !== undefined && !requesterArn\) return 'no-worker';/);
  });

  it('the lead role resolves to its one recorded holder, and DENY: a role with two holders, or none, names nobody', () => {
    const ctx = { event: 'conversation-opened' as const, channelArn: ROOM, values: {} };
    expect(audienceOf({ participantRole: 'lead' }, { ...ctx, roles: { lead: [LEAD] } })).toEqual([LEAD]);
    expect(audienceOf({ participantRole: 'lead' }, { ...ctx, roles: { lead: [LEAD, `${APP}/user/other`] } })).toHaveLength(2);
    expect(audienceOf({ participantRole: 'lead' }, { ...ctx, roles: {} })).toEqual([]);
  });

  it('an asked turn offers its card to the person its request is for', () => {
    expect(proposalAddresseeOf({ channelArn: ROOM, asked: { for: LEAD } })).toBe(LEAD);
    expect(proposalAddresseeOf({ channelArn: ROOM, senderArn: LEAD })).toBe(LEAD);
  });

  it('DENY: an asked turn never offers it to a sender, a person of another app instance, an assistant, or nobody named', () => {
    expect(proposalAddresseeOf({ channelArn: ROOM, asked: {}, senderArn: LEAD })).toBeUndefined();
    expect(proposalAddresseeOf({ channelArn: ROOM, asked: { for: 'arn:aws:chime:us-east-1:111122223333:app-instance/other/user/lead' } })).toBeUndefined();
    expect(proposalAddresseeOf({ channelArn: ROOM, asked: { for: `${APP}/bot/advisor` } })).toBeUndefined();
    expect(proposalAddresseeOf({ channelArn: ROOM, asked: { for: 'lead' } })).toBeUndefined();
    expect(proposalAddresseeOf({ channelArn: ROOM })).toBeUndefined();
  });

  it('the processor offers the asked turn\'s card through that one addressee, and a person\'s turn through its sender', () => {
    const proc = read('assistant-async-processor.ts');
    expect(proc).toMatch(/const askedInvites = asked && !narrowed \? await meetingInvitesFor\(proposalAddresseeOf\(\{ channelArn: event\.channelArn, asked \}\), def\.tools \?\? \[\]\) : \{\};/);
    expect(proc).toMatch(/\{ \.\.\.invokeConfig, tools: def\.tools \?\? \[\], userTurnText: '', \.\.\.askedInvites \}/);
    expect(proc).toMatch(/await meetingInvitesFor\(proposalAddresseeOf\(\{ channelArn: event\.channelArn, senderArn: event\.senderArn \}\), invokeConfig\.tools\)/);
    // THE CARD AND THE PROPOSAL NAME THAT ONE PERSON: the offer records it as the requester and targets the card to it.
    const helper = proc.slice(proc.indexOf('const meetingInvitesFor = async'), proc.indexOf('if (event.eventStep) {'));
    expect(helper).toMatch(/requesterArn: personArn/);
    expect(helper).toMatch(/Target: \[\{ MemberArn: to \}\]/);
  });

  it('DENY: a deployment without meetings asks its router for no meeting place on any turn', () => {
    const proc = read('assistant-async-processor.ts');
    expect(proc).toContain('const MEETINGS_ATTACHED = !!process.env.TRANSCRIPT_BUCKET;');
    const helper = proc.slice(proc.indexOf('const meetingInvitesFor = async'), proc.indexOf('meetingPlaceOf(event.channelArn)'));
    expect(helper).toContain('if (!MEETINGS_ATTACHED || !personArn');
    const stack = readFileSync(resolve(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    expect(stack).toMatch(/if \(props\.capabilities\?\.includes\('meetings'\) && props\.attachmentsBucketArn\) \{\s*processorEnv\.TRANSCRIPT_BUCKET/);
  });

  it('the lead\'s task and the ask say the conversation\'s assistant offers the card', () => {
    const lead = renderMessageTemplate(shippedMessageTemplate('incident-owner-task')!, { label: 'X' });
    expect(lead.ok && lead.sections.chat).toMatch(/4\. Account teams: bring them into the call from the card it offers you\./);
    const ask = renderMessageTemplate(shippedMessageTemplate('customer-impact')!, { label: 'X' });
    expect(ask.ok && ask.sections.chat).toMatch(/offer to bring their account teams into the call\./);
  });
});
