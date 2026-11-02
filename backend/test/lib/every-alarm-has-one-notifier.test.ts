/**
 * EVERY ALARM IS DELIVERED BY ONE NOTIFIER (`lambda/src/alarm-to-admin-channel.ts`).
 *
 * What an operator actually receives is the whole product of this Lambda. A test that only proved it
 * "sent something" would pass on a message reading `ALARM: true` with no link and no reason - which is
 * an alert people learn to ignore. So these assert the CONTENT, and that the subject the alarm chose is
 * the subject the email carries, through the real directive parser and the real fan-out.
 *
 * The context-source failure-rate alarm and the archival pipeline alarm each had their own notifier;
 * they are this one now, with what to do written in each alarm's description where it is defined.
 */
const mockChimeSend = jest.fn();
const mockSes = jest.fn();
const mockEventsSend = jest.fn();

jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({ send: mockEventsSend })),
  PutEventsCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'PutEvents', input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Send', input })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ListMemberships', input })),
  DescribeChannelCommand: jest.fn(),
  ListTagsForResourceCommand: jest.fn(),
}), { virtual: true });
jest.mock('../../lambda/src/lib/notification', () => ({
  ...jest.requireActual('../../lambda/src/lib/notification'),
  sendEmailNotifications: (...a: unknown[]) => mockSes(...a),
}));

import { dashboardUrl, renderAlarm, fitEncoded, alertRecipientArns } from '../../lambda/src/alarm-to-admin-channel';
import { splitIntoChunks } from '../../lambda/src/lib/chime/send';
import { __setDefaultDirectoryForTests, type Directory } from '../../lambda/src/lib/membership-source';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';

describe('dashboardUrl', () => {
  it('builds a console permalink in the alarm\'s own region', () => {
    expect(dashboardUrl('ae-standard-context-sources', 'eu-west-1'))
      .toBe('https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1'
        + '#dashboards:name=ae-standard-context-sources');
  });

  it('encodes a name that would otherwise break the fragment', () => {
    expect(dashboardUrl('ae standard/ctx', 'us-east-1')).toContain('ae%20standard%2Fctx');
  });

  it('returns empty when no dashboard is configured, rather than a broken link', () => {
    expect(dashboardUrl('', 'us-east-1')).toBe('');
  });
});

describe('renderAlarm', () => {
  const alarming = {
    AlarmName: 'ae-standard-context-source-failure-rate',
    AlarmDescription: 'More than 10% of context source reads failed over 5 minutes (standard). `denied` means a grant is missing.',
    NewStateValue: 'ALARM' as const,
    NewStateReason: 'Threshold Crossed: 1 datapoint [42.0 (01/08/26 10:05:00)] was greater than the threshold (10.0).',
    StateChangeTime: '2026-08-01T10:05:00.000Z',
    Region: 'us-east-1',
  };

  it('leads with what broke, and says what to do from the alarm\'s own description', () => {
    const { content, subject } = renderAlarm(alarming);
    expect(subject).toBe('Alarm: ae-standard-context-source-failure-rate');
    expect(content).toContain('(standard)');
    expect(content).toContain('`denied` means a grant is missing');
  });

  it('passes CloudWatch\'s own arithmetic through rather than re-deriving it', () => {
    expect(renderAlarm(alarming).content).toContain('42.0');
  });

  it('links the dashboard the alarm names, in the alarm\'s region', () => {
    expect(renderAlarm(alarming, { dashboard: 'ae-standard-context-sources' }).content)
      .toContain('**Dashboard:** https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=ae-standard-context-sources');
    expect(renderAlarm(alarming).content).not.toContain('Dashboard');
  });

  it('distinguishes RECOVERY, so the alert is not a one-way ratchet', () => {
    const { content, subject } = renderAlarm({ ...alarming, NewStateValue: 'OK', NewStateReason: 'back under.' });
    expect(subject).toContain('Recovered');
    expect(content).toContain('**Recovered:**');
    expect(content).not.toContain('**Alarm:**');
  });

  it('does not fabricate detail it was not given', () => {
    expect(renderAlarm({ NewStateValue: 'ALARM' }).content).toContain('(no reason given)');
  });
});

describe('the message fits the limits Amazon Chime SDK actually enforces', () => {
  const encodedLen = (s: string) => encodeURIComponent(s).length;

  it('posts a pathological alarm payload in parts, each inside the ENCODED content budget', () => {
    const { content } = renderAlarm({
      AlarmName: 'a'.repeat(500),
      AlarmDescription: 'description '.repeat(500),
      NewStateValue: 'ALARM',
      NewStateReason: 'Threshold Crossed: '.repeat(500),
    });
    const parts = splitIntoChunks(content);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(encodedLen(part)).toBeLessThanOrEqual(3600);
  });

  it('marks an overlong email subject as truncated rather than cutting it silently', () => {
    expect(fitEncoded('x '.repeat(5000), 3600)).toContain('[truncated]');
  });

  it('leaves a subject that already fits completely untouched', () => {
    const short = 'Alarm: x';
    expect(fitEncoded(short, 3600)).toBe(short);
  });
});

describe('who an alarm reaches', () => {
  const CHANNEL = `${APP}/channel/admin`;
  const BEARER = `${APP}/bot/admin-agent`;
  const alarmEvent = (state: 'ALARM' | 'OK') => ({
    Records: [{ Sns: { Message: JSON.stringify({
      AlarmName: 'ae-archival-pipeline-stopped', AlarmDescription: 'Nothing is reaching the archive.',
      NewStateValue: state, NewStateReason: 'Threshold Crossed', StateChangeTime: '2026-08-01T10:05:00.000Z',
    }) } }],
  });
  const directory = (reachable: Record<string, string>): Directory => ({
    personsInGroup: async () => ({ persons: [], unminted: [] }),
    personOf: async () => null,
    admins: async () => ({ persons: [], unminted: [] }),
    clearanceOf: async () => ({ state: 'none' as const }),
    listGroups: async () => [],
    groupsFor: async () => [],
    clearedByGroups: async () => null,
    displayNameFor: async () => null,
    findByAddress: async () => null,
    accountState: async () => 'active' as const,
    contactFor: async (arn) => (reachable[arn] ? { route: 'email', address: reachable[arn], name: null } : null),
  });

  beforeEach(() => {
    jest.resetModules();
    mockChimeSend.mockReset().mockResolvedValue({});
    mockEventsSend.mockReset().mockResolvedValue({ FailedEntryCount: 0 });
    mockSes.mockReset().mockImplementation(async (r: Array<{ email: string }>) => ({ sent: r.map((x) => x.email), failed: [] }));
  });
  afterEach(() => {
    delete process.env.ALERT_INSTANCE;
    delete process.env.ADMIN_ALERT_CHANNEL_ARN;
    delete process.env.ADMIN_ALERT_BEARER_ARN;
    delete process.env.ALERT_RECIPIENT_ARNS;
    __setDefaultDirectoryForTests(null);
  });

  it('names its recipients as people, and drops anything that is not a person ARN', () => {
    expect(alertRecipientArns(`${APP}/user/ops-lead, ops@example.com, ${APP}/bot/x,,${APP}/user/oncall`))
      .toEqual([`${APP}/user/ops-lead`, `${APP}/user/oncall`]);
  });

  it('raises an ae.alert that the admin poster posts under the subject the alarm chose, which the bridge emails under', async () => {
    process.env.ALERT_INSTANCE = 'i';
    const { handler } = await import('../../lambda/src/alarm-to-admin-channel');
    await handler(alarmEvent('ALARM') as never);
    // The notifier raises the alert on the bus and posts nothing itself.
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockEventsSend).toHaveBeenCalledTimes(1);
    const [entry] = mockEventsSend.mock.calls[0][0].input.Entries;
    expect(entry.Source).toBe('ae.alert');
    // The admin backend's poster takes the event as the rule delivers it, and posts it.
    process.env.ADMIN_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    const poster = await import('../../lambda/src/admin-alert-poster');
    await poster.handler({ source: entry.Source, 'detail-type': entry.DetailType, detail: JSON.parse(entry.Detail) } as never);
    expect(mockChimeSend).toHaveBeenCalledTimes(1);
    const { parseNotifyDirective } = await import('../../lambda/src/lib/channel-notify');
    const directive = parseNotifyDirective(mockChimeSend.mock.calls[0][0].input.Metadata);
    expect(directive!.subject).toBe('Alarm: ae-archival-pipeline-stopped');
    // Nobody is named for this alarm, so nobody is emailed directly: the channel's bridge does it.
    expect(mockSes).not.toHaveBeenCalled();
  });

  it('emails the people the deployment names, resolved by person, when the deployment raises no alert', async () => {
    process.env.ALERT_RECIPIENT_ARNS = `${APP}/user/ops-lead,${APP}/user/unreachable`;
    const { handler } = await import('../../lambda/src/alarm-to-admin-channel');
    const ms = await import('../../lambda/src/lib/membership-source');
    ms.__setDefaultDirectoryForTests(directory({ [`${APP}/user/ops-lead`]: 'lead@example.com' }));
    await handler(alarmEvent('OK') as never);
    expect(mockSes).toHaveBeenCalledTimes(1);
    const [recipients, content] = mockSes.mock.calls[0];
    // An alarm is a mail its recipient can stop, so it carries their unsubscribe link (B9).
    expect(recipients).toEqual([{ email: 'lead@example.com', name: '', unsubscribeUrl: expect.stringContaining('/email/preferences?t=') }]);
    expect(content.subject).toBe('Recovered: ae-archival-pipeline-stopped');
  });

  it('skips INSUFFICIENT_DATA entirely', async () => {
    process.env.ALERT_RECIPIENT_ARNS = `${APP}/user/ops-lead`;
    const { handler } = await import('../../lambda/src/alarm-to-admin-channel');
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ NewStateValue: 'INSUFFICIENT_DATA' }) } }] } as never);
    expect(mockSes).not.toHaveBeenCalled();
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('says nothing when a new alarm settles to OK, because nothing recovered', async () => {
    process.env.ALERT_RECIPIENT_ARNS = `${APP}/user/ops-lead`;
    const { handler } = await import('../../lambda/src/alarm-to-admin-channel');
    const message = { AlarmName: 'ae-new-alarm', NewStateValue: 'OK', OldStateValue: 'INSUFFICIENT_DATA' };
    await handler({ Records: [{ Sns: { Message: JSON.stringify(message) } }] } as never);
    expect(mockSes).not.toHaveBeenCalled();
    expect(mockChimeSend).not.toHaveBeenCalled();
  });
});
