/**
 * archival-alarm Lambda — unit tests.
 *
 * Pins the OSS-portability contract:
 *   - empty/missing ALERT_RECIPIENTS → warn + return (does NOT throw),
 *     so a misconfigured SNS subscription cannot retry-storm.
 *   - non-ALARM state transitions (OK, INSUFFICIENT_DATA) are skipped
 *     silently (no email churn on recovery).
 *   - ALARM transitions trigger a SES send via the existing
 *     sendEmailNotifications path (Source / Destination / Subject+Body).
 *   - Malformed ALERT_RECIPIENTS JSON is treated as empty, not fatal.
 */

const mockSesSend = jest.fn();
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendEmail', input: args })),
}), { virtual: true });

import type { SNSEvent } from 'aws-lambda';

function alarmEvent(stateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA' = 'ALARM'): SNSEvent {
  return {
    Records: [
      {
        EventSource: 'aws:sns',
        EventVersion: '1.0',
        EventSubscriptionArn: 'arn:aws:sns:us-east-1:000000000000:test:sub',
        Sns: {
          Type: 'Notification',
          MessageId: 'mid',
          TopicArn: 'arn:aws:sns:us-east-1:000000000000:test',
          Subject: '',
          Message: JSON.stringify({
            AlarmName: 'TestStack-archival-pipeline-stopped',
            NewStateValue: stateValue,
            NewStateReason: 'Threshold Crossed: 1 datapoint [0.0 (...)] was less than or equal to the threshold (0.0).',
            Region: 'us-east-1',
            StateChangeTime: '2026-05-21T15:30:00.000Z',
          }),
          Timestamp: '2026-05-21T15:30:00.000Z',
          SignatureVersion: '1',
          Signature: '',
          SigningCertUrl: '',
          UnsubscribeUrl: '',
          MessageAttributes: {},
        },
      },
    ],
  } as unknown as SNSEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.SENDER_EMAIL = 'sender@verified.example.com';
  delete process.env.ALERT_RECIPIENTS;
});

describe('archival-alarm', () => {
  it('skip-but-report when ALERT_RECIPIENTS is unset (no SES call, no throw)', async () => {
    const { handler } = await import('../lambda/src/archival-alarm');
    await expect(handler(alarmEvent('ALARM'))).resolves.toBeUndefined();
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('skip-but-report when ALERT_RECIPIENTS is an empty array', async () => {
    process.env.ALERT_RECIPIENTS = '[]';
    const { handler } = await import('../lambda/src/archival-alarm');
    await handler(alarmEvent('ALARM'));
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('skip-but-report when ALERT_RECIPIENTS is malformed JSON', async () => {
    process.env.ALERT_RECIPIENTS = '{not-json';
    const { handler } = await import('../lambda/src/archival-alarm');
    await expect(handler(alarmEvent('ALARM'))).resolves.toBeUndefined();
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('sends one SES email per recipient on ALARM transition', async () => {
    process.env.ALERT_RECIPIENTS = JSON.stringify([
      { email: 'ops1@example.com', name: 'Ops One' },
      { email: 'ops2@example.com', name: 'Ops Two' },
    ]);
    mockSesSend.mockResolvedValue({});

    const { handler } = await import('../lambda/src/archival-alarm');
    await handler(alarmEvent('ALARM'));

    expect(mockSesSend).toHaveBeenCalledTimes(2);
    const cmds = mockSesSend.mock.calls.map(([cmd]) => cmd.input);
    const tos = cmds.flatMap((c) => c.Destination.ToAddresses);
    expect(tos.sort()).toEqual(['ops1@example.com', 'ops2@example.com']);

    // Each command has the expected subject + body structure.
    for (const cmd of cmds) {
      expect(cmd.Message.Subject.Data).toContain('Archival pipeline alarm');
      expect(cmd.Message.Body.Text.Data).toContain('TestStack-archival-pipeline-stopped');
      expect(cmd.Message.Body.Text.Data).toContain('Likely causes');
    }
  });

  it('skips OK transitions (no email churn on recovery)', async () => {
    process.env.ALERT_RECIPIENTS = JSON.stringify([{ email: 'ops@example.com', name: 'Ops' }]);
    const { handler } = await import('../lambda/src/archival-alarm');
    await handler(alarmEvent('OK'));
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('skips INSUFFICIENT_DATA transitions', async () => {
    process.env.ALERT_RECIPIENTS = JSON.stringify([{ email: 'ops@example.com', name: 'Ops' }]);
    const { handler } = await import('../lambda/src/archival-alarm');
    await handler(alarmEvent('INSUFFICIENT_DATA'));
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('filters non-conforming recipients (missing email or name)', async () => {
    process.env.ALERT_RECIPIENTS = JSON.stringify([
      { email: 'good@example.com', name: 'Good' },
      { email: 'no-name@example.com' },
      { name: 'No Email' },
      'bare string',
      null,
    ]);
    mockSesSend.mockResolvedValue({});

    const { handler } = await import('../lambda/src/archival-alarm');
    await handler(alarmEvent('ALARM'));

    expect(mockSesSend).toHaveBeenCalledTimes(1);
    expect(mockSesSend.mock.calls[0][0].input.Destination.ToAddresses).toEqual(['good@example.com']);
  });

  it('does not throw when SES rejects (resilient per-recipient)', async () => {
    process.env.ALERT_RECIPIENTS = JSON.stringify([
      { email: 'a@example.com', name: 'A' },
      { email: 'b@example.com', name: 'B' },
    ]);
    mockSesSend
      .mockRejectedValueOnce(new Error('SES throttled'))
      .mockResolvedValueOnce({});

    const { handler } = await import('../lambda/src/archival-alarm');
    await expect(handler(alarmEvent('ALARM'))).resolves.toBeUndefined();
    expect(mockSesSend).toHaveBeenCalledTimes(2);
  });
});
