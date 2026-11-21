/**
 * AN INTENT THE PLATFORM RAISES HAS NO PERFORMANCE LINK: its tasks are opened by a workflow step or the platform, never by a
 * classified turn, so Effectiveness has nothing to show for it. Read from the platform machine catalog, never a list of names.
 */
import { describe, it, expect } from 'vitest';
import { platformRaised } from './AssistantPage';

describe('which intents link to their performance', () => {
  it('the quiet runbook refresh and the required dashboard refresh link nowhere; an intent a person raises links', () => {
    expect(platformRaised({ key: 'dashboard_runbook', machine: 'dashboard_runbook' })).toBe(true);
    expect(platformRaised({ key: 'dashboard_refresh' })).toBe(true);
    expect(platformRaised({ key: 'incident_first_look', machine: 'incident_first_look' })).toBe(false);
    expect(platformRaised({ key: 'report_request' })).toBe(false);
  });
});
