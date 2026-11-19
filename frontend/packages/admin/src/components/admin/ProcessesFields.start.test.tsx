/**
 * A STARTING WORKFLOW SAYS WHAT IT DOES (SPEC-PROCESSES P1), on the shipped incident response, in the locale's own words.
 *
 * What it proves: each start option says what starts the workflow, its stages by name with who answers each, and the workflows
 * its open steps start next, which choosing it adds as phases; a workflow that opens nothing says so; no option shows a bare
 * count of stages.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SHIPPED_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { ProcessesFields } from './ProcessesFields';
import type { ProfileDefinitionBody } from '../../services/profileService';

const draft = (): ProfileDefinitionBody => ({
  modelKey: 'default',
  eventWorkflows: JSON.parse(JSON.stringify({
    'incident-triage': SHIPPED_EVENT_WORKFLOWS['incident-triage'],
    'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'],
    'customer-messaging': SHIPPED_EVENT_WORKFLOWS['customer-messaging'],
  })) as ProfileDefinitionBody['eventWorkflows'],
});

describe('a starting workflow says what it does', () => {
  it('the incident: no stage of its own, then the incident conversation it opens', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-add'));
    const does = screen.getByTestId('process-wf-does-incident-triage').textContent ?? '';
    expect(does).toBe('It has no labeled stage of its own.');
    expect(screen.getByTestId('process-wf-next-incident-triage').textContent).toBe('Then it opens ops-room in ops, added as the next phases.');
    // THE INCIDENT HANDS ON TO CUSTOMER MESSAGING.
    expect(screen.getByTestId('process-wf-next-ops-room').textContent).toContain('customer-messaging in customer-messaging');
    // A WORKFLOW THAT OPENS NOTHING SAYS SO, and no option counts its stages.
    expect(screen.getByTestId('process-wf-next-customer-messaging').textContent).toBe('It opens no other workflow.');
    expect(screen.getByTestId('process-start').textContent).not.toMatch(/\(\d+ stages?\)/);
  });
});
