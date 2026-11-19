import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@ae/shared';
import EventTriggerPanel, { summarizePattern, arnName } from './EventTriggerPanel';

const svc = vi.hoisted(() => ({
  listEventTriggers: vi.fn(), listEventTypes: vi.fn(), attachEventTrigger: vi.fn(), removeEventTrigger: vi.fn(), describeEventType: vi.fn(),
}));
vi.mock('../../services/eventTriggerService', () => svc);
vi.mock('./EventPolicyPanel', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe('choosing what starts a workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.listEventTriggers.mockResolvedValue({ channelArn: 'arn:room', triggers: [{ id: 'abc', workflow: 'w', ruleArn: 'arn:rule', pattern: '{}' }, { id: 'zzz', workflow: 'other', ruleArn: 'arn:other', pattern: null }] });
    svc.attachEventTrigger.mockResolvedValue({ id: 'n', ruleArn: 'arn:n' });
    svc.describeEventType.mockRejectedValue(new Error('no schema'));
    svc.removeEventTrigger.mockResolvedValue({ removed: 'abc' });
  });

  it('asks for a team room before anything else', () => {
    render(<EventTriggerPanel workflow="w" />);
    expect(screen.getByTestId('event-trigger-no-room')).toBeTruthy();
    expect(svc.listEventTriggers).not.toHaveBeenCalled();
  });

  it('shows the room and this workflow\'s triggers alone', async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    await waitFor(() => expect(screen.getByTestId('event-trigger-room').textContent).toContain('room'));
    expect(screen.getByTestId('event-trigger-abc')).toBeTruthy();
    expect(screen.queryByTestId('event-trigger-zzz')).toBeNull();
  });

  it('lists no other assistant\'s trigger for a workflow of the same name, so it cannot be removed from here', async () => {
    svc.listEventTriggers.mockResolvedValue({ channelArn: 'arn:room', triggers: [
      { id: 'mine', workflow: 'w', ruleArn: 'arn:rule/mine', pattern: '{}', assistant: 'advisor' },
      { id: 'theirs', workflow: 'w', ruleArn: 'arn:rule/theirs', pattern: '{}', assistant: 'concierge' },
      { id: 'unnamed', workflow: 'w', ruleArn: 'arn:rule/unnamed', pattern: '{}' },
    ] });
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" assistant="advisor" />);
    await waitFor(() => expect(screen.getByTestId('event-trigger-mine')).toBeTruthy());
    expect(screen.getByTestId('event-trigger-unnamed')).toBeTruthy();
    expect(screen.queryByTestId('event-trigger-theirs')).toBeNull();
  });

  it('selects an event type from the list, and says how many the search found', async () => {
    svc.listEventTypes.mockResolvedValue([{ name: 'aws.ec2@X', registry: 'aws.events' }, { name: 'aws.ec2@Y', registry: 'aws.events' }]);
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    expect(screen.queryByTestId('event-trigger-types')).toBeNull();
    fireEvent.change(screen.getByTestId('event-trigger-search'), { target: { value: 'ec2 ' } });
    fireEvent.keyDown(screen.getByTestId('event-trigger-search'), { key: 'Enter' });
    await screen.findByRole('option', { name: 'aws.ec2@X' });
    expect(svc.listEventTypes).toHaveBeenCalledWith('ec2');
    expect(screen.getByTestId('event-trigger-search-status').textContent).toContain('admin.eventTrigger.found');
    fireEvent.change(screen.getByTestId('event-trigger-types'), { target: { value: 'aws.ec2@X' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', { eventType: 'aws.ec2@X' }));
  });

  it.each([['resourceArn', 'arn:aws:cloudwatch:us-east-1:1:alarm:a', { resourceArn: 'arn:aws:cloudwatch:us-east-1:1:alarm:a' }], ['rule', 'my-rule', { rule: 'my-rule' }]])('takes a pasted %s', async (mode, value, choice) => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.change(screen.getByTestId('event-trigger-mode'), { target: { value: mode } });
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', choice));
  });

  it('records the assistant whose version holds the workflow, so that version runs it', async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" assistant="ops-premium" />);
    fireEvent.change(screen.getByTestId('event-trigger-mode'), { target: { value: 'rule' } });
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value: 'my-rule' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', { rule: 'my-rule' }, undefined, 'ops-premium'));
  });

  it('keeps what was pasted when the kind is chosen after it, and attaches it', async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value: 'arn:aws:cloudwatch:us-east-1:1:alarm:a' } });
    fireEvent.change(screen.getByTestId('event-trigger-mode'), { target: { value: 'resourceArn' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', { resourceArn: 'arn:aws:cloudwatch:us-east-1:1:alarm:a' }));
    expect((await screen.findByTestId('event-trigger-attached')).textContent).toContain('admin.eventTrigger.attached');
  });

  it('says what is missing rather than doing nothing when there is nothing to attach', async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.change(screen.getByTestId('event-trigger-mode'), { target: { value: 'resourceArn' } });
    expect((screen.getByTestId('event-trigger-attach') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    expect((await screen.findByTestId('event-trigger-error')).textContent).toContain('admin.eventTrigger.needValue');
    expect(svc.attachEventTrigger).not.toHaveBeenCalled();
  });

  it('says why a refused choice was refused', async () => {
    svc.attachEventTrigger.mockRejectedValue(new Error('the rule names no exact source'));
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    expect((await screen.findByTestId('event-trigger-error')).textContent).toContain('the rule names no exact source');
  });

  it('says a throttled attach in the console\'s own words: nothing was attached, try again', async () => {
    svc.attachEventTrigger.mockRejectedValue(new ApiError(429, 'server text in English', { code: 'TRIGGER_THROTTLED', error: 'server text in English' }));
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    expect((await screen.findByTestId('event-trigger-error')).textContent).toBe('admin.eventTrigger.errors.TRIGGER_THROTTLED');
  });

  it('chooses the one event type a search finds, and says when none matches', async () => {
    svc.listEventTypes.mockResolvedValueOnce([{ name: 'aws.cloudwatch@CloudWatchAlarmStateChange', registry: 'aws.events' }]).mockResolvedValueOnce([]);
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.click(screen.getByTestId('event-trigger-search-go'));
    await waitFor(() => expect((screen.getByTestId('event-trigger-value') as HTMLInputElement).value).toBe('aws.cloudwatch@CloudWatchAlarmStateChange'));
    fireEvent.click(screen.getByTestId('event-trigger-search-go'));
    await waitFor(() => expect(screen.getByTestId('event-trigger-search-status').textContent).toContain('admin.eventTrigger.foundNone'));
    expect(screen.queryByTestId('event-trigger-types')).toBeNull();
  });

  it('names what a trigger listens for and links the alarm and the rule in the AWS console', async () => {
    const alarm = 'arn:aws:cloudwatch:us-east-1:1:alarm:demo-incident';
    svc.listEventTriggers.mockResolvedValue({ channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/team-ops-team-premium', triggers: [{
      id: 'abc', workflow: 'w', ruleArn: 'arn:aws:events:us-east-1:1:rule/trigger-abc',
      pattern: JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: [alarm], detail: { state: { value: ['ALARM'] } } }),
    }] });
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    const link = await screen.findByTestId('event-trigger-abc-resource-0') as HTMLAnchorElement;
    expect(link.href).toBe('https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/demo-incident');
    expect(link.textContent).toContain('demo-incident');
    expect((screen.getByTestId('event-trigger-abc-rule') as HTMLAnchorElement).href).toBe('https://us-east-1.console.aws.amazon.com/events/home?region=us-east-1#/eventbus/default/rules/trigger-abc');
    expect(screen.getByTestId('event-trigger-abc').textContent).toContain('CloudWatch Alarm State Change');
    expect(screen.getByTestId('event-trigger-abc').textContent).toContain('ALARM');
    expect(screen.getByTestId('event-trigger-room').textContent).toContain('team-ops-team-premium');
  });

  it('for a type that is not a team room\'s, runs in the conversation watching the key: the kind its openers record and the key path go with the attach', async () => {
    svc.listEventTriggers.mockResolvedValue({ channelArn: null, target: 'watched', triggers: [{ id: 'abc', workflow: 'w', ruleArn: 'arn:aws:events:us-east-1:1:rule/r', pattern: null, kind: 'ops-incident', keyPath: '$.detail.incidentId' }] });
    render(<EventTriggerPanel workflow="w" typeKey="ops" />);
    expect(screen.getByTestId('event-trigger-target').textContent).toContain('admin.eventTrigger.target_watched');
    expect((await screen.findByTestId('event-trigger-abc')).textContent).toContain('$.detail.incidentId');
    expect(screen.queryByTestId('event-trigger-room')).toBeNull();
    expect((screen.getByTestId('event-trigger-kind') as HTMLSelectElement).value).toBe('ops-incident');
    fireEvent.change(screen.getByTestId('event-trigger-mode'), { target: { value: 'rule' } });
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value: 'my-rule' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    expect((await screen.findByTestId('event-trigger-error')).textContent).toContain('admin.eventTrigger.needValue');
    fireEvent.change(screen.getByTestId('event-trigger-key-path'), { target: { value: '$.detail.incidentId' } });
    fireEvent.click(screen.getByTestId('event-trigger-attach'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops', 'premium', 'w', { rule: 'my-rule' }, { kind: 'ops-incident', keyPath: '$.detail.incidentId' }));
  });

  it('asks only for what the event does not carry, and says why: the room for an event with no target, the key for one that names its conversation', async () => {
    const { unmount } = render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    expect(screen.getByTestId('event-trigger-target').textContent).toContain('admin.eventTrigger.why_team');
    expect(screen.queryByTestId('event-trigger-key-path')).toBeNull();
    expect(screen.getByTestId('event-trigger-inputs').textContent).not.toContain('admin.eventTrigger.input_key');
    await waitFor(() => expect(svc.listEventTriggers).toHaveBeenCalled());
    unmount();
    render(<EventTriggerPanel workflow="w" typeKey="ops" />);
    expect(screen.getByTestId('event-trigger-target').textContent).toContain('admin.eventTrigger.why_watched');
    expect(screen.getByTestId('event-trigger-key-path')).toBeTruthy();
    expect(screen.getByTestId('event-trigger-inputs').textContent).toContain('admin.eventTrigger.input_key');
    // AN ALARM NAMES NO CONVERSATION, which the form says when the workflow's conversation is not a team room.
    expect(screen.queryByTestId('event-trigger-alarm-note')).toBeNull();
    fireEvent.change(screen.getByTestId('event-trigger-mode'), { target: { value: 'resourceArn' } });
    fireEvent.change(screen.getByTestId('event-trigger-value'), { target: { value: 'arn:aws:cloudwatch:us-east-1:1:alarm:a' } });
    expect(screen.getByTestId('event-trigger-alarm-note').textContent).toContain('admin.eventTrigger.alarmNamesNoConversation');
    await waitFor(() => expect(svc.listEventTriggers).toHaveBeenCalledTimes(2));
  });

  it('adjusts to the chosen event: its schema\'s fields become the key path, and the kind\'s own path is chosen for it', async () => {
    svc.listEventTypes.mockResolvedValue([{ name: 'ae.ops@IncidentUpdated', registry: 'discovered-schemas' }]);
    svc.describeEventType.mockResolvedValue({ name: 'ae.ops@IncidentUpdated', source: 'ae.ops', detailType: 'Incident updated', detailPaths: ['$.detail.instance', '$.detail.incidentId'] });
    render(<EventTriggerPanel workflow="w" typeKey="ops" />);
    fireEvent.click(screen.getByTestId('event-trigger-search-go'));
    await waitFor(() => expect(svc.describeEventType).toHaveBeenCalledWith('ae.ops@IncidentUpdated'));
    const keyPath = await screen.findByRole('option', { name: '$.detail.incidentId' });
    expect(keyPath).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId('event-trigger-key-path') as HTMLSelectElement).value).toBe('$.detail.incidentId'));
    expect(screen.queryByTestId('event-trigger-wrong-source')).toBeNull();
  });

  it('says when the chosen event\'s source cannot carry any key the type\'s conversations record, and will not attach it', async () => {
    svc.listEventTypes.mockResolvedValue([{ name: 'aws.ec2@X', registry: 'aws.events' }]);
    svc.describeEventType.mockResolvedValue({ name: 'aws.ec2@X', source: 'aws.ec2', detailType: 'X', detailPaths: ['$.detail.id'] });
    render(<EventTriggerPanel workflow="w" typeKey="ops" />);
    fireEvent.click(screen.getByTestId('event-trigger-search-go'));
    expect((await screen.findByTestId('event-trigger-wrong-source')).textContent).toContain('admin.eventTrigger.sourceCarriesNoKey');
    expect((screen.getByTestId('event-trigger-attach') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the chosen event opens its own conversation', async () => {
    svc.listEventTypes.mockResolvedValue([{ name: 'ae.ops@IncidentOpened', registry: 'discovered-schemas' }]);
    svc.describeEventType.mockResolvedValue({ name: 'ae.ops@IncidentOpened', source: 'ae.ops', detailType: 'Incident opened', detailPaths: [] });
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.click(screen.getByTestId('event-trigger-search-go'));
    expect((await screen.findByTestId('event-trigger-opens-note')).textContent).toContain('admin.eventTrigger.eventOpensItsOwn');
  });

  it('a team room type\'s trigger names its room as where it runs', async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    expect(screen.getByTestId('event-trigger-target').textContent).toContain('admin.eventTrigger.target_team');
    expect(screen.queryByTestId('event-trigger-kind')).toBeNull();
    await waitFor(() => expect(svc.listEventTriggers).toHaveBeenCalled());
  });

  it("says another assistant's trigger refusal in the console's own words, not the server's text", async () => {
    svc.removeEventTrigger.mockRejectedValue(new ApiError(409, 'server text in English', { code: 'TRIGGER_OTHER_ASSISTANT', error: 'server text in English' }));
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" assistant="advisor" />);
    fireEvent.click(await screen.findByTestId('event-trigger-remove-abc'));
    expect((await screen.findByTestId('event-trigger-error')).textContent).toBe('admin.eventTrigger.errors.TRIGGER_OTHER_ASSISTANT');
  });

  it('removes a trigger', async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" />);
    fireEvent.click(await screen.findByTestId('event-trigger-remove-abc'));
    await waitFor(() => expect(svc.removeEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'abc', undefined));
  });

  it("removes a trigger as the assistant whose version this editor holds, so the route refuses another assistant's", async () => {
    render(<EventTriggerPanel workflow="w" typeKey="ops-team" assistant="ops-premium" />);
    fireEvent.click(await screen.findByTestId('event-trigger-remove-abc'));
    await waitFor(() => expect(svc.removeEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'abc', 'ops-premium'));
  });
});

describe('what a trigger listens for', () => {
  it('reads the event, source, resources and states from the pattern', () => {
    const p = summarizePattern(JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: ['arn:a'], detail: { state: { value: ['ALARM'] } } }));
    expect(p).toMatchObject({ detailTypes: ['CloudWatch Alarm State Change'], sources: ['aws.cloudwatch'], resources: ['arn:a'], states: ['ALARM'] });
    expect(summarizePattern('not json')).toBeUndefined();
    expect(summarizePattern(null)).toBeUndefined();
  });

  it('names a resource by the end of its ARN', () => {
    expect(arnName('arn:aws:cloudwatch:us-east-1:1:alarm:demo')).toBe('demo');
    expect(arnName('arn:aws:events:us-east-1:1:rule/r1')).toBe('r1');
  });
});
