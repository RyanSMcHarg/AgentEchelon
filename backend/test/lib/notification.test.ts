/**
 * Email notification workflow — unit tests.
 *
 * Pins the contract: per-recipient resilient SES send
 * (one failure doesn't abort the rest), the SES v2 request's shape (the From mailbox, one destination, a
 * text and an HTML part, both UTF-8, and the recipient's own Reply-To and unsubscribe headers), the
 * PLACEHOLDER_SENDER skip-but-report guard, and HTML escaping of
 * interpolated recipient/body text.
 *
 * Mirrors battle-state.test.ts: mock @aws-sdk/client-sesv2, reset
 * modules + set env per test, dynamic-import so the module-load
 * SENDER_EMAIL capture sees the right value.
 */

const mockSesSend = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendEmail', input: args })),
}), { virtual: true });

const RECIPIENTS = [
  { email: 'a@example.com', name: 'Ada' },
  { email: 'b@example.com', name: 'Babbage' },
];

type Sent = {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ReplyToAddresses?: string[];
  Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string; Charset: string }; Html: { Data: string; Charset: string } }; Headers?: Array<{ Name: string; Value: string }> } };
};

/** One request, read as the header lines a mail client would show, and its two parts. */
function decoded(call: unknown[]): { headers: string; text: string; html: string } {
  const input = (call[0] as { input: Sent }).input;
  const simple = input.Content.Simple;
  const lines = [
    `From: ${input.FromEmailAddress}`,
    `To: ${input.Destination.ToAddresses.join(', ')}`,
    `Subject: ${simple.Subject.Data}`,
    ...(input.ReplyToAddresses ?? []).map((r) => `Reply-To: ${r}`),
    ...(simple.Headers ?? []).map((h) => `${h.Name}: ${h.Value}`),
  ];
  expect(simple.Body.Text.Charset).toBe('UTF-8');
  expect(simple.Body.Html.Charset).toBe('UTF-8');
  return { headers: lines.join('\r\n'), text: simple.Body.Text.Data, html: simple.Body.Html.Data };
}

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
    expect(cmd.input.FromEmailAddress).toBe('"Your assistant" <sender@verified.example.com>');
    expect(cmd.input.Destination.ToAddresses).toEqual(['"Ada" <a@example.com>']);
    const m = decoded(mockSesSend.mock.calls[0]);
    expect(m.headers).toContain('Subject: Daily briefing');
    expect(m.headers).toContain('To: "Ada" <a@example.com>');
    expect(m.headers).toContain('Content-Language: en');
    expect(m.text).toContain('Hi Ada,');
    expect(m.text).toContain('Your briefing is ready.');
    // Signed by the assistant (here the stand-in voice), never by a product name.
    expect(m.text).toContain('Best regards,\nYour assistant');
    expect(m.text).not.toContain('AgentEchelon');
    expect(m.html).toContain('<p>Hi Ada,</p>');
  });

  it('carries each recipient\'s own reply address and unsubscribe headers', async () => {
    mockSesSend.mockResolvedValue({});
    const { sendEmailNotifications } = await import('../../lambda/src/lib/notification');
    await sendEmailNotifications([
      { ...RECIPIENTS[0], replyTo: 'reply+abc@replies.example.com', unsubscribeUrl: 'https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=a' },
      RECIPIENTS[1],
    ], { subject: 'S', bodyText: 'B' });
    const first = decoded(mockSesSend.mock.calls[0]);
    expect(first.headers).toContain('Reply-To: reply+abc@replies.example.com');
    expect(first.headers).toContain('List-Unsubscribe: <https://test.execute-api.us-east-1.amazonaws.com/email/preferences?t=a>');
    expect(first.headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(first.text).toContain('You can reply to this email to answer in the conversation.');
    const second = decoded(mockSesSend.mock.calls[1]);
    expect(second.headers).not.toContain('Reply-To');
    expect(second.headers).not.toContain('List-Unsubscribe');
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

    const { html, text } = decoded(mockSesSend.mock.calls[0]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    // Plain-text part keeps raw text (text/plain — not a vector).
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

    expect(decoded(mockSesSend.mock.calls[0]).html).toContain('<a href="https://x/report">briefing</a>');
  });
});
