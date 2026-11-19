/**
 * A MEETING'S OWN CONVERSATION NAMES THE CONVERSATION IT WAS STARTED FROM (SPEC-ASSISTANT-MEETINGS FR27).
 *
 * The meeting is held in its own conversation, which a person added to the meeting alone may be the only one of these they
 * are in. So its started card names the conversation the meeting was started from and links to it, and never says "this
 * conversation", which there is the meeting itself. Where that conversation's opening run is under way (an incident's
 * runbook), the card carries where the run stands at the meeting's start: what it is about, who leads it, its current
 * step, the steps still to come in order, and where its dashboard is. A meeting started from an ordinary conversation reads
 * the first line alone. Its ended card carries no link to itself.
 *
 * What it proves: the template renders each case from the platform's values; the router posts it in the meeting's own
 * conversation only, reads the name from Amazon Chime SDK channel state, and reads the standing from the run's own claims.
 */
import * as fs from 'fs';
import * as path from 'path';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { SHIPPED_EVENT_WORKFLOWS, continuationClaim, runStanding, stepLabel } from '../../lambda/src/lib/event-workflow';

const router = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
const fnOf = (name: string): string => {
  const start = router.search(new RegExp(`\\n(export )?(async )?function ${name}[(<]`));
  expect(start).toBeGreaterThan(-1);
  const next = router.slice(start + 10).search(/\n(export )?(async )?function /);
  return router.slice(start, next < 0 ? undefined : start + 10 + next);
};
const say = (values: Record<string, string>) => {
  const r = renderMessageTemplate(shippedMessageTemplate('meeting-started-from'), values, { sections: ['chat'] });
  expect(r.ok).toBe(true);
  return r.ok ? r.sections.chat ?? '' : '';
};

describe('the started card in a meeting\'s own conversation', () => {
  const wf = SHIPPED_EVENT_WORKFLOWS['ops-room'];
  const label = (ks: string[]) => ks.map((k) => stepLabel(wf, k)).join(', ');

  it('for an incident: names the conversation, its current step, the steps to come in order, its lead and its dashboard', () => {
    const at = runStanding(wf, {
      'lead-task': 'opened', 'first-look': 'opened', [continuationClaim('first-look')]: 'opened',
      'offer-call': 'opened', [continuationClaim('offer-call')]: 'task:success:start', 'customer-impact': 'opened',
    });
    const card = say({
      room_name: 'Customer API errors', room_link: '?conversation=conv-ops-1', about: 'Customer API errors', lead: 'Jordan',
      status: label(at.current), next_steps: label(at.next), dashboard_link: '?conversation=conv-ops-1',
    });
    expect(card).toContain('started from another conversation, Customer API errors: [open it](?conversation=conv-ops-1)');
    expect(card).toContain('- Now: Customer impact');
    expect(card).toContain('- Next: Customers impacted?, Cause and recommended action, Mitigation decision, Mitigation change, Recovery check');
    expect(card).toContain('- Lead: Jordan');
    expect(card).toContain('- [Dashboard](?conversation=conv-ops-1)');
    expect(card).not.toMatch(/this conversation/i);
  });

  it('for an ordinary conversation: the one line naming where it was started, and none of the run\'s items', () => {
    const card = say({ room_name: 'Planning', room_link: '?conversation=conv-plan' });
    expect(card).toBe('This meeting was started from another conversation, Planning: [open it](?conversation=conv-plan).');
    expect(card).not.toMatch(/Now:|Next:|Lead:|Dashboard|this conversation/i);
    // A NAME THAT COULD NOT BE READ still links back, and says nothing in its place.
    expect(say({ room_name: '', room_link: '?conversation=conv-plan' })).toBe('This meeting was started from another conversation: [open it](?conversation=conv-plan).');
  });

  it('the router posts it in the meeting\'s own conversation alone, from the server\'s reads, and keeps the card\'s Metadata', () => {
    const fn = fnOf('handleMeetingLifecycle');
    expect(fn).toContain('const own = started ? await meetingStartedFromCard(room, roomRecord, primary.botArn) : null;');
    expect(fn).toContain("name: own ? own.template : cardName");
    // THE ENDED COPY THERE carries no link to the meeting's own conversation.
    expect(fn).toContain("values: own ? own.values : { ...cardValues, conversation_link: '' },");
    expect(fn).toContain('roomConversationId: conversationKey(room)');
    const card = fnOf('meetingStartedFromCard');
    expect(card).toContain('new DescribeChannelCommand({ ChannelArn: room, ChimeBearer: botArn })');
    expect(card).toContain('r.Channel?.Name');
    expect(card).not.toContain('Metadata');
    const standing = fnOf('meetingRoomStanding');
    expect(standing).toContain('const standing = await standingOf(opened.workflow, runKey, room);');
    expect(standing).toContain("if (!standing || standing.ended || (!standing.current.length && !standing.next.length)) return {};");
  });
});
