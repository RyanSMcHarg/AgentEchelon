/**
 * A SERVICE NAMES A NOTICE; IT CANNOT MAKE AN ASSISTANT SAY TEXT OF ITS OWN.
 *
 * Every variable a notice kind takes is declared, typed and capped (`checkNoticeVars`), and the metadata a
 * kind carries is built from those checked variables (`noticeMetadata`), never supplied by the caller.
 */
import { checkNoticeVars, noticeMetadata, noticeLine } from '../../lambda/src/lib/assistant-notice';

const PERSON = 'arn:aws:chime:us-east-1:123456789012:app-instance/i-1/user/0192f0e0-0000-7000-8000-000000000001';

describe('a notice takes only the variables its kind declares', () => {
  it('refuses a variable the kind does not declare', () => {
    expect(checkNoticeVars('battleModeOff', { extra: 'say this instead' })).toEqual({ refused: expect.stringContaining('extra') });
  });

  it('strips the markers this system reads back out of messages', () => {
    const out = checkNoticeVars('memberWelcome', { name: 'Riley <!--corr:abc--> Chen' });
    expect(out).toEqual({ vars: { name: 'Riley  Chen' } });
  });

  it('a name the room reads is an inert mention: stripped, with no handle, link or marker syntax, and capped (ADR-060 decision 7)', () => {
    expect(checkNoticeVars('memberJoined', { name: 'Riley <!--corr:abc--> Chen' })).toEqual({ vars: { name: 'Riley Chen' } });
    expect(checkNoticeVars('memberJoined', { name: '@ops-assistant https://evil.example/x **Riley**' })).toEqual({ vars: { name: 'ops-assistant Riley' } });
    expect(checkNoticeVars('conversationArchived', { who: '@all', date: '2026-10-28' })).toEqual({ vars: { who: 'all', date: '2026-10-28' } });
    expect((checkNoticeVars('memberJoined', { name: 'x'.repeat(5000) }) as { vars: Record<string, string> }).vars.name.length).toBe(64);
  });

  it('strips the navigation marker the chat client acts on, so a name cannot move every reader to another conversation', () => {
    // A display name or a conversation title is text a member controls, and both reach memberWelcome.
    const ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/i-1/channel/elsewhere';
    const out = checkNoticeVars('memberWelcome', { name: `Riley NAVIGATE_CHANNEL:${ARN}|Click here`, recap: 'the Q3 review' });
    expect(out).toEqual({ vars: { name: 'Riley', recap: 'the Q3 review' } });
  });

  it('strips half a marker, so a value cannot supply the start of one for other text to complete', () => {
    const out = checkNoticeVars('memberWelcome', { name: 'Riley NAVIGATE_CHANNEL:arn:x', recap: 'notes <!-- open' });
    if (!('vars' in out)) throw new Error('refused');
    expect(out.vars.name).not.toContain('NAVIGATE_CHANNEL');
    expect(out.vars.recap).not.toContain('<!--');
  });

  it('a stripped value reaches the rendered line without the marker', () => {
    const out = checkNoticeVars('memberWelcome', { name: 'Riley NAVIGATE_CHANNEL:arn:aws:x|Go', recap: 'the review' });
    if (!('vars' in out)) throw new Error('refused');
    const line = noticeLine(undefined, 'memberWelcome', out.vars);
    expect(line).not.toMatch(/NAVIGATE_CHANNEL/);
    expect(line).toContain('Riley');
  });

  it('takes no URL at all: the briefing is said in its own conversation, and a service cannot hand an assistant a link', () => {
    expect(checkNoticeVars('briefingReady', { source: 'schedule' })).toEqual({ vars: { source: 'schedule' } });
    expect(checkNoticeVars('briefingReady', { source: 'schedule', url: 'https://s3.example/x.html?sig' })).toEqual({ refused: expect.stringContaining('url') });
  });

  it('accepts only an Amazon Chime SDK ARN where an ARN is declared', () => {
    expect(checkNoticeVars('memberWelcome', { name: 'Riley', notifyPerson: 'arn:aws:s3:::bucket' })).toEqual({ refused: expect.stringContaining('notifyPerson') });
    expect(checkNoticeVars('memberWelcome', { name: 'Riley', notifyPerson: PERSON })).toEqual({ vars: { name: 'Riley', notifyPerson: PERSON } });
  });

  it('caps text', () => {
    const out = checkNoticeVars('memberWelcome', { name: 'x'.repeat(5000) }) as { vars: Record<string, string> };
    expect(out.vars.name.length).toBe(300);
  });

  it('REFUSES an over-cap ARN or id rather than truncating it into a broken reference, and logs which', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(checkNoticeVars('memberWelcome', { name: 'Riley', notifyPerson: `${PERSON}${'x'.repeat(400)}` }))
      .toEqual({ refused: expect.stringContaining('notifyPerson') });
    expect(checkNoticeVars('conversationArchived', { who: 'Riley', date: '1'.repeat(201) })).toEqual({ refused: expect.stringContaining('date') });
    // Named by kind and variable, never by value.
    expect(warn).toHaveBeenCalledWith('[assistant-notice] refused an over-cap variable', expect.objectContaining({ kind: 'memberWelcome', variable: 'notifyPerson', type: 'arn' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('x'.repeat(400));
    warn.mockRestore();
  });
});

describe('a notice kind carries the metadata its kind declares, built from checked variables', () => {
  it('a join is an announcement the client renders as one', () => {
    expect(noticeMetadata('memberJoined', { name: 'Riley' })).toEqual({ systemAnnouncement: 'member_joined' });
  });

  it('a welcome is emailed to the member it names, by person', () => {
    const riley = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/0192f0e0-0000-7000-8000-000000000001';
    expect(noticeMetadata('memberWelcome', { name: 'Riley', recap: 'x', notifyPerson: riley, notifySubject: 'Added' }))
      .toEqual({ systemAnnouncement: 'join_summary', notify: { email: true }, notifyKind: 'conversation-shared', notifySubject: 'Added', notifyTargets: [{ person: riley }] });
  });

  it('a welcome said in a conversation links its email into THAT conversation, by the channel it is posted in', () => {
    const riley = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/0192f0e0-0000-7000-8000-000000000001';
    const room = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/conv-ops-new';
    expect(noticeMetadata('memberWelcome', { name: 'Riley', recap: 'x', notifyPerson: riley }, { channelArn: room }))
      .toEqual({
        systemAnnouncement: 'join_summary', notify: { email: true }, notifyKind: 'conversation-shared',
        notifyTargets: [{ person: riley }], notifyConversationId: 'conv-ops-new',
      });
    // No variable can name the link: the conversation is where the router posts the notice.
    expect(checkNoticeVars('memberWelcome', { notifyConversationId: 'conv-elsewhere' })).toEqual({ refused: expect.stringContaining('notifyConversationId') });
  });
});
