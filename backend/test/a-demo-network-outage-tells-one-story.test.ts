/**
 * THE DEMO NETWORK OUTAGE TELLS ONE STORY IN REAL DATA (`scripts/demo-network-outage.mjs`): a flat healthy baseline,
 * an outage the alarm fires on within two minutes, a recovery that brings it back to OK, and a recovery after the
 * incident call that reads the call's start from the platform's own record.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const o = require('../scripts/lib/network-outage.cjs');

const steady = () => 0.5;
const extremes = [() => 0, () => 0.999999];
const below = (v: { SuccessRate: number }) => v.SuccessRate < o.ALARM_THRESHOLD;

describe('the curves', () => {
  it('the baseline is healthy and stays healthy under any jitter', () => {
    for (const rng of [steady, ...extremes]) {
      const v = o.valuesFor('healthy', 0, rng);
      expect(v.SuccessRate).toBeGreaterThan(99.5);
      expect(v.SuccessRate).toBeLessThanOrEqual(100);
      expect(v.LatencyP95).toBeLessThan(150);
      expect(v.PacketLoss).toBeLessThan(0.2);
      expect(v.HealthyHosts).toBe(o.HOSTS);
    }
  });

  it('the outage breaches from its first minute, so 2 of 2 minutes fire the alarm, and holds near zero', () => {
    for (const rng of [steady, ...extremes]) {
      const minutes = [0, 1, 2, 3, 10].map((m) => o.valuesFor('outage', m, rng));
      expect(minutes.every(below)).toBe(true);
      expect(minutes[4].SuccessRate).toBeLessThan(1);
      expect(minutes[4].HealthyHosts).toBe(0);
      expect(minutes[4].PacketLoss).toBeGreaterThan(90);
      // ONE STORY: loss climbs and latency spikes as the success rate falls.
      expect(minutes[0].PacketLoss).toBeLessThan(minutes[2].PacketLoss);
      expect(minutes[0].LatencyP95).toBeLessThan(minutes[2].LatencyP95);
      expect(minutes[0].SuccessRate).toBeGreaterThan(minutes[2].SuccessRate);
    }
  });

  it('the recovery ramps back, and its last ramp minute and the next are over the threshold, so the alarm returns to OK', () => {
    for (const rng of [steady, ...extremes]) {
      const ramp = [0, 1, 2, 3].map((m) => o.valuesFor('recovery', m, rng));
      expect(ramp.map((v) => v.SuccessRate)).toEqual([...ramp.map((v) => v.SuccessRate)].sort((a, b) => a - b));
      expect(ramp.map((v) => v.HealthyHosts)).toEqual([...ramp.map((v) => v.HealthyHosts)].sort((a, b) => a - b));
      expect(below(ramp[0])).toBe(true);
      expect(below(ramp[2]) || below(ramp[3])).toBe(false);
      expect(ramp[3]).toEqual(o.valuesFor('healthy', 0, rng));
    }
  });

  it('one minute is one call of four datapoints on one dimension set', () => {
    const dims = o.dimensionsOf({ region: 'us-east-1', service: 'svc' });
    const data = o.metricData(o.valuesFor('healthy', 0, steady), Date.UTC(2026, 10, 13, 12, 0), dims);
    expect(data.map((d: { MetricName: string }) => d.MetricName)).toEqual(['SuccessRate', 'LatencyP95', 'PacketLoss', 'HealthyHosts']);
    expect(data.every((d: { Dimensions: unknown }) => d.Dimensions === dims)).toBe(true);
  });

  it('a backfill writes only the minutes not yet published', () => {
    const t = (m: number) => Date.UTC(2026, 10, 13, 12, m);
    expect(o.missingMinutes([new Date(t(1)), new Date(t(3) + 20_000)], t(0), t(4) + 30_000)).toEqual([t(0), t(2), t(4)]);
  });

  it('the alarm keeps its name, so its ARN, and the actions it has, and fires on the success rate', () => {
    const dims = o.dimensionsOf({ region: 'us-east-1', service: 'svc' });
    const input = o.alarmInput({ ActionsEnabled: true, AlarmActions: [], OKActions: ['arn:x'], InsufficientDataActions: [] }, dims);
    expect(input).toMatchObject({
      AlarmName: o.ALARM_NAME, MetricName: 'SuccessRate', Namespace: o.NAMESPACE, Dimensions: dims, Period: 60,
      EvaluationPeriods: 2, DatapointsToAlarm: 2, ComparisonOperator: 'LessThanThreshold', OKActions: ['arn:x'], AlarmActions: [],
    });
  });
});

describe('recovery after the call', () => {
  const STARTED = Date.UTC(2026, 10, 13, 12, 0);
  const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/room';
  const MEETING = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/meeting';

  function fakeTable(rows: Record<string, unknown>) {
    const keys: string[] = [];
    const send = jest.fn(async (cmd: { input: { Key: { channelArn: string }; ConsistentRead?: boolean } }) => {
      keys.push(cmd.input.Key.channelArn);
      expect(cmd.input.ConsistentRead).toBe(true);
      return { Item: rows[cmd.input.Key.channelArn] };
    });
    return { client: { send }, keys };
  }

  it('reads the call from the watched room\'s meeting conversation, through the alarm\'s watch record', async () => {
    const callAt = new Date(STARTED + 4 * 60_000).toISOString();
    const { client, keys } = fakeTable({
      [`watch#alarm#${o.ALARM_NAME}`]: { room: ROOM },
      [ROOM]: { meetingConversation: { channelArn: MEETING } },
      [MEETING]: { activeMeeting: { createdAt: callAt } },
    });
    const rows = await o.readCallRows(client, 'table', o.ALARM_NAME);
    expect(keys).toEqual([`watch#alarm#${o.ALARM_NAME}`, ROOM, MEETING]);
    expect(o.callStartedAt(rows.room, rows.meeting, STARTED)).toBe(Date.parse(callAt));
  });

  it('a call on the room itself counts; one that started before the outage, or none, does not', async () => {
    expect(o.callStartedAt({ activeMeeting: { createdAt: new Date(STARTED + 1000).toISOString() } }, undefined, STARTED)).toBe(STARTED + 1000);
    expect(o.callStartedAt(undefined, { activeMeeting: { createdAt: new Date(STARTED - 1000).toISOString() } }, STARTED)).toBeNull();
    const { client } = fakeTable({ [`watch#alarm#${o.ALARM_NAME}`]: { room: ROOM }, [ROOM]: {} });
    const rows = await o.readCallRows(client, 'table', o.ALARM_NAME);
    expect(o.callStartedAt(rows.room, rows.meeting, STARTED)).toBeNull();
  });

  it('no table reads nothing', async () => {
    const { client } = fakeTable({});
    await expect(o.readCallRows(client, '', o.ALARM_NAME)).resolves.toEqual({ roomArn: undefined, room: undefined, meeting: undefined });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('the outage holds until the call has run the delay, or the operator asks; recovery once begun is not undone', () => {
    const callAt = STARTED + 5 * 60_000;
    const at = (now: number, extra = {}) => o.nextPhase({ phase: 'outage' }, { now, callAt, recoverRequested: false, recoverOnCall: true, delayMs: 60_000, ...extra });
    expect(at(callAt + 30_000)).toBe('outage');
    expect(at(callAt + 60_000)).toBe('recovery');
    expect(at(callAt + 90_000, { recoverOnCall: false })).toBe('outage');
    expect(at(callAt + 90_000, { callAt: null })).toBe('outage');
    expect(at(STARTED, { callAt: null, recoverRequested: true })).toBe('recovery');
    expect(o.nextPhase({ phase: 'recovery' }, { now: STARTED, callAt: null, recoverRequested: false, recoverOnCall: true, delayMs: 0 })).toBe('recovery');
  });

  it('the command line is bounded', () => {
    expect(o.parseArgs(['outage', '--recover-on-call', '--delay=90', '--minutes=999'])).toMatchObject({ command: 'outage', recoverOnCall: true, delaySeconds: 90, minutes: 240 });
    expect(o.parseArgs(['outage']).minutes).toBe(30);
    expect(() => o.parseArgs(['outage', '--forever'])).toThrow(/unknown option/);
  });
});
