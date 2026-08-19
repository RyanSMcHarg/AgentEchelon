/**
 * The context source alarm notifier.
 *
 * What an operator actually receives is the whole product of this Lambda. A test that only proved it
 * "sent something" would pass on a message reading `ALARM: true` with no link and no reason - which is
 * an alert people learn to ignore. So these assert the CONTENT.
 */
import { dashboardUrl, renderAlarmMessage, fitEncoded } from '../../lambda/src/context-source-alarm';

describe('dashboardUrl', () => {
  it('builds a console permalink in the alarm\'s own region', () => {
    // The region comes from the alarm payload, not the Lambda's, so a cross-region alarm still links
    // somewhere real.
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

describe('renderAlarmMessage', () => {
  const alarming = {
    AlarmName: 'ae-standard-context-source-failure-rate',
    AlarmDescription: 'More than 10% of context source reads failed over 5 minutes (standard).',
    NewStateValue: 'ALARM' as const,
    NewStateReason: 'Threshold Crossed: 1 datapoint [42.0 (01/08/26 10:05:00)] was greater than the threshold (10.0).',
    StateChangeTime: '2026-08-01T10:05:00.000Z',
    Region: 'us-east-1',
  };

  it('leads with what broke and for which classification', () => {
    const { content, subject, recovered } = renderAlarmMessage(alarming, 'standard');
    expect(recovered).toBe(false);
    expect(subject).toBe('Context source failures: standard');
    expect(content).toContain('Context sources are failing');
    expect(content).toContain('standard');
  });

  it('passes CloudWatch\'s own arithmetic through rather than re-deriving it', () => {
    // Re-computing the percentage here risks printing a number that disagrees with the console the
    // operator is about to open.
    expect(renderAlarmMessage(alarming, 'standard').content).toContain('42.0');
  });

  it('tells the operator what the reasons mean, so the message is actionable alone', () => {
    const { content } = renderAlarmMessage(alarming, 'standard');
    expect(content).toContain('denied');
    expect(content).toContain('(catalog)');
  });

  it('distinguishes RECOVERY, so the alert is not a one-way ratchet', () => {
    // An alert that never says "fixed" trains people to ignore it.
    const { content, subject, recovered } = renderAlarmMessage(
      { ...alarming, NewStateValue: 'OK', NewStateReason: 'Threshold Crossed: back under.' },
      'premium',
    );
    expect(recovered).toBe(true);
    expect(subject).toContain('Recovered');
    expect(content).toContain('Context sources recovered');
    expect(content).not.toContain('are failing');
  });

  it('does not fabricate detail it was not given', () => {
    const { content } = renderAlarmMessage({ NewStateValue: 'ALARM' }, 'basic');
    expect(content).toContain('(no reason given)');
  });
});

describe('the message fits the limits Amazon Chime SDK actually enforces', () => {
  // Chime caps Content at 4096 and Metadata at 1024 on the URL-ENCODED string, and
  // encodeURIComponent roughly doubles prose (every newline becomes %0A, every space %20). Over the
  // cap SendChannelMessage throws, the handler swallows it (it must, or SNS retries forever), and the
  // alarm that fired is never delivered - a monitoring system that silently fails to monitor.
  const encodedLen = (s: string) => encodeURIComponent(s).length;

  it('fits a pathological alarm payload inside the ENCODED content budget', () => {
    // CloudWatch's NewStateReason and AlarmDescription are both operator-influenced and unbounded.
    const monstrous = {
      AlarmName: 'a'.repeat(500),
      AlarmDescription: 'description '.repeat(500),
      NewStateValue: 'ALARM' as const,
      NewStateReason: 'Threshold Crossed: '.repeat(500),
      StateChangeTime: '2026-08-02T10:05:00.000Z',
      Region: 'us-east-1',
    };
    const { content } = renderAlarmMessage(monstrous, 'standard');
    expect(encodedLen(fitEncoded(content, 3600))).toBeLessThanOrEqual(3600);
  });

  it('marks the message as truncated rather than cutting silently', () => {
    expect(fitEncoded('x '.repeat(5000), 3600)).toContain('[truncated]');
  });

  it('leaves a message that already fits completely untouched', () => {
    // Falsification: a trimmer that always cut would satisfy the budget assertions while mangling
    // every ordinary alert.
    const short = 'Context sources are failing (standard)\nDashboard: https://example';
    expect(fitEncoded(short, 3600)).toBe(short);
  });

  it('measures the ENCODED length, not the raw one', () => {
    // The trap this repo already hit once: a raw-length check passes while the encoded string is
    // over the cap, because newlines and spaces triple.
    const newlines = '\n'.repeat(2000); // 2000 raw, 6000 encoded
    expect(newlines.length).toBeLessThan(3600);
    expect(encodedLen(newlines)).toBeGreaterThan(3600);
    expect(encodedLen(fitEncoded(newlines, 3600))).toBeLessThanOrEqual(3600);
  });
});
