/**
 * Email notification workflow — unit tests.
 *
 * Pins the contract: per-recipient resilient SES send
 * (one failure doesn't abort the rest), correct SendEmailCommand
 * shape (Source / Destination / Subject+Body Text+Html UTF-8), the
 * PLACEHOLDER_SENDER skip-but-report guard, and HTML escaping of
 * interpolated recipient/body text.
 *
 * Mirrors battle-state.test.ts: mock @aws-sdk/client-ses, reset
 * modules + set env per test, dynamic-import so the module-load
 * SENDER_EMAIL capture sees the right value.
 */

const mockSesSend = jest.fn();
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendEmail', input: args })),
}), { virtual: true });

const RECIPIENTS = [
  { email: 'a@example.com', name: 'Ada' },
  { email: 'b@example.com', name: 'Babbage' },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.SENDER_EMAIL = 'sender@verified.example.com';
});

describe('sendEmailNotifications', () => {
  it('sends one SES email per recipient with the expected command', async () => {
    mockSesSend.mockResolvedValue({});
    const { sendEmailNotifications } = await import('../../lambda/src/lib/notification');

    const res = await sendEmailNotifications(RECIPIENTS, {
      subject: 'Daily briefing',
      bodyText: 'Your briefing is ready.',
    });

    expect(res.sent).toEqual(['a@example.com', 'b@example.com']);
    expect(res.failed).toEqual([]);
    expect(mockSesSend).toHaveBeenCalledTimes(2);

    const cmd = mockSesSend.mock.calls[0][0];
    expect(cmd.__type).toBe('SendEmail');
    expect(cmd.input.Source).toBe('sender@verified.example.com');
    expect(cmd.input.Destination.ToAddresses).toEqual(['a@example.com']);
    expect(cmd.input.Message.Subject).toEqual({ Data: 'Daily briefing', Charset: 'UTF-8' });
    expect(cmd.input.Message.Body.Text.Charset).toBe('UTF-8');
    expect(cmd.input.Message.Body.Html.Charset).toBe('UTF-8');
    expect(cmd.input.Message.Body.Text.Data).toContain('Hi Ada,');
    expect(cmd.input.Message.Body.Text.Data).toContain('Your briefing is ready.');
    expect(cmd.input.Message.Body.Text.Data).toContain('Best regards,\nAgentEchelon');
    expect(cmd.input.Message.Body.Html.Data).toContain('<p>Hi Ada,</p>');
  });

  it('is resilient: one recipient failing does not abort the others', async () => {
    mockSesSend
      .mockRejectedValueOnce(new Error('SES throttled'))
      .mockResolvedValueOnce({});
    const { sendEmailNotifications } = await import('../../lambda/src/lib/notification');

    const res = await sendEmailNotifications(RECIPIENTS, {
      subject: 'S',
      bodyText: 'B',
    });

    expect(res.sent).toEqual(['b@example.com']);
    expect(res.failed).toEqual([{ email: 'a@example.com', error: 'SES throttled' }]);
    expect(mockSesSend).toHaveBeenCalledTimes(2);
  });

  it('skips entirely (no SES calls) when SENDER_EMAIL is the placeholder', async () => {
    process.env.SENDER_EMAIL = 'noreply@example.com';
    const { sendEmailNotifications } = await import('../../lambda/src/lib/notification');

    const res = await sendEmailNotifications(RECIPIENTS, { subject: 'S', bodyText: 'B' });

    expect(res.sent).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.skipped).toMatch(/placeholder/i);
    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('HTML-escapes interpolated recipient name and bodyText (no HTML injection)', async () => {
    mockSesSend.mockResolvedValue({});
    const { sendEmailNotifications } = await import('../../lambda/src/lib/notification');

    await sendEmailNotifications([{ email: 'x@example.com', name: '<script>x</script>' }], {
      subject: 'S',
      bodyText: '<img src=x onerror=1>',
    });

    const html = mockSesSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    // Plain-text part keeps raw text (text/plain — not a vector).
    const text = mockSesSend.mock.calls[0][0].input.Message.Body.Text.Data as string;
    expect(text).toContain('<img src=x onerror=1>');
  });

  it('uses a provided bodyHtml fragment verbatim in the HTML part', async () => {
    mockSesSend.mockResolvedValue({});
    const { sendEmailNotifications } = await import('../../lambda/src/lib/notification');

    await sendEmailNotifications([RECIPIENTS[0]], {
      subject: 'S',
      bodyText: 'plain fallback',
      bodyHtml: '<p>Open your <a href="https://x/report">briefing</a>.</p>',
    });

    const html = mockSesSend.mock.calls[0][0].input.Message.Body.Html.Data as string;
    expect(html).toContain('<a href="https://x/report">briefing</a>');
  });
});
