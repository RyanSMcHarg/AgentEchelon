/**
 * AN ALARM OPENS THE INCIDENT CONVERSATION AT ONCE, AND THE TEAM IS TOLD WHY (SPEC-WORKFLOWS-AND-TASKS WT120, WT129):
 * nobody is asked before the incident conversation opens, the whole team conversation is told with the on-call
 * mentioned, and triage, customer impact included, is the incident conversation's own.
 *
 * What it proves: the shipped `incident-triage` opens first and then tells the team, naming the on-call by mention, and is a
 * valid workflow; the incident conversation's customer-impact card is the process's Triage stage; the announcement says
 * where the incident is worked, why it was opened, since when and where, and who owns it, and leaves out a line whose value
 * is not there.
 */
import { SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';

const triage = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
const opsRoom = SHIPPED_EVENT_WORKFLOWS['ops-room'];
const render = (values: Record<string, unknown>) => {
  const t = shippedMessageTemplates().get('incident-declared');
  if (!t) throw new Error('no shipped template incident-declared');
  const r = renderMessageTemplate(t.template, values);
  if (!r.ok) throw new Error(r.refused);
  return r.sections.chat;
};
const VALUES = {
  label: 'AgentEchelon demo incident',
  alarmMetric: 'SuccessRate',
  alarmThreshold: '90',
  alarmLatest: '9.02',
  since: '2026-11-18 19:02 UTC',
  region: 'us-east-1',
  lead: 'Jordan Reyes',
  conversation_link: '?c=conv-ops-1',
};

describe('an alarm opens the incident conversation at once, and the team is told why', () => {
  it('opens first, asks nobody, then tells the whole team with the on-call mentioned', () => {
    expect(triage.initial).toBe('open');
    expect(triage.states.open.open).toEqual({ type: 'ops', for: { typeRole: 'on-call:ops' } });
    expect(triage.states.open.onSuccess).toBe('tell');
    expect(triage.states.tell.send).toEqual({ template: 'incident-declared', to: 'room', mention: { lead: 'participantRole:on-call:ops' } });
    expect(Object.values(triage.states).some((s) => 'task' in s)).toBe(false);
    expect(eventWorkflowErrors('incident-triage', triage)).toEqual([]);
  });

  it('triage, customer impact included, is the incident conversation\'s own stage', () => {
    // NOBODY IS ASKED WHETHER CUSTOMERS ARE IMPACTED: naming the accounts opens customer messaging.
    expect(opsRoom.states['impact-confirm']).toBeUndefined();
    expect(opsRoom.states['customer-impact'].onSuccess).toEqual([{ to: 'runbook-cause', when: { 'event:customerImpact': 'impacted' } }, { to: 'messaging' }]);
  });

  it('says where the incident is worked, why it was opened, since when and where, and who owns it', () => {
    const text = render(VALUES);
    // ONE FACT A LINE, as a list under a blank line, so the chat renders each on its own line.
    expect(text).toBe([
      '**Incident conversation opened for AgentEchelon demo incident:** [open it](?c=conv-ops-1)',
      '',
      '- **Why:** SuccessRate crossed its alarm threshold of 90',
      '- **Latest value:** 9.02',
      '- **Since:** 2026-11-18 19:02 UTC',
      '- **AWS Region:** us-east-1',
      '- **On call:** Jordan Reyes owns it',
      '',
      'Triage, including customer impact, happens in the incident conversation. Ask here how it is going; this conversation is told when it is resolved.',
    ].join('\n'));
  });

  it('a value it does not have leaves its line out', () => {
    const text = render({ label: VALUES.label, conversation_link: VALUES.conversation_link });
    expect(text).not.toContain('**Why:**');
    expect(text).not.toContain('owns it');
    expect(text).toContain('Incident conversation opened for AgentEchelon demo incident');
    expect(text).not.toMatch(/\n{3,}/);
  });
});
