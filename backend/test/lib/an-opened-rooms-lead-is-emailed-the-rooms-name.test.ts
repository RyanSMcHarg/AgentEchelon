/**
 * A ROOM AN EVENT OPENS EMAILS ITS LEAD A SUBJECT THAT NAMES THE ROOM (ADR-061 decision 3).
 *
 * The lead was added to a conversation they did not open, so the `greet-lead` send on `conversation-opened` is emailed.
 * Without an `email.subject` the lead's email would arrive as the bridge's generic "An update from your assistant" and
 * say nothing of which room it leads into, so the subject is the label the event opened the room for. Not
 * `conversation:title`: that is held only once a conversation has settled, and this send is its opening, so a title
 * binding renders empty and drops the subject.
 */
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { workflowSendEmailKind } from '../../lambda/src/lib/event-workflow';

describe('the ops room lead welcome', () => {
  const welcome = shippedMessageTemplate('ops-lead-welcome');

  it("renders the event's label as the email subject, from a field held at the opening", () => {
    expect(welcome.fields?.label).toBe('value:text');
    expect(Object.values(welcome.fields ?? {})).not.toContain('conversation:title');
    const rendered = renderMessageTemplate(welcome, { label: 'Report generation is running slow' }, { refusedValue: 'empty' });
    expect(rendered.ok).toBe(true);
    if (rendered.ok) expect(rendered.sections['email.subject']).toBe('Opened for you: Report generation is running slow');
  });

  it('is emailed when the opened room addresses it to a person', () => {
    expect(workflowSendEmailKind('conversation-opened', ['arn:aws:chime:us-east-1:1:app-instance/a/user/lead'])).toBe('conversation-shared');
  });
});
