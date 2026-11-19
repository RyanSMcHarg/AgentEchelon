/**
 * A PROCESS TRAVELS AS ITS OWN MANIFEST, FROM THE PROCESSES SECTION (SPEC-PROCESSES P13).
 *
 * Each listed process offers Export, which downloads its manifest. Import process takes a manifest file or its pasted JSON,
 * sends it to land in this assistant's draft (naming the draft shown), and says the server's refusals code by code in the
 * locale's words, with the missing names filled in, or confirms it landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProfileDefinitionBody } from '../../services/profileService';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) }) }));
vi.mock('../../services/profileService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/profileService')>()),
  exportProcess: vi.fn(),
  importProcess: vi.fn(),
}));

import * as svc from '../../services/profileService';
import { ProcessesFields, readProcessManifestText } from './ProcessesFields';

const workflow = (states: string[]) => ({ on: 'conversation-opened', start: states[0], states: Object.fromEntries(states.map((s) => [s, { type: 'say' }])) });
const draft = (): ProfileDefinitionBody => ({
  modelKey: 'default',
  eventWorkflows: { 'incident-triage': workflow(['triage']), 'ops-room': workflow(['lead-task']) } as unknown as ProfileDefinitionBody['eventWorkflows'],
  processes: { 'incident-response': { label: 'Incident response', workflows: ['incident-triage', 'ops-room'] } },
});
const manifest = {
  schemaVersion: 1, kind: 'process', ownerProfileName: 'ops-premium', processName: 'incident-response',
  process: { label: 'Incident response', workflows: ['incident-triage', 'ops-room'] },
  requires: { workflows: ['incident-triage', 'ops-room'] }, contentHash: 'abc',
} as unknown as svc.ProcessManifest;

beforeEach(() => {
  vi.mocked(svc.exportProcess).mockReset();
  vi.mocked(svc.importProcess).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Export on each listed process', () => {
  it('downloads the process manifest of the draft shown, for the assistant by its profile name', async () => {
    vi.mocked(svc.exportProcess).mockResolvedValue(manifest);
    const created = vi.fn(() => 'blob:process');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-export-incident-response'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(svc.exportProcess).toHaveBeenCalledWith('ops-premium', 'incident-response', true);
    expect(created).toHaveBeenCalled();
  });

  it('sits alone at the far end of the process\'s action row, after Edit and Remove, so a press meant for Edit never downloads', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" />);
    const row = screen.getByTestId('process-actions-incident-response');
    const order = [...row.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['process-edit-incident-response', 'process-remove-incident-response', 'process-export-incident-response']);
    expect(screen.getByTestId('process-export-incident-response').closest('.admin-process-export')).not.toBeNull();
    expect(screen.getByTestId('process-edit-incident-response').closest('.admin-process-export')).toBeNull();
  });

  it('says a refused export in the locale\'s words', async () => {
    vi.mocked(svc.exportProcess).mockRejectedValue(Object.assign(new Error('404'), { body: { code: 'PROCESS_NOT_FOUND', refusals: [{ code: 'PROCESS_NOT_FOUND', process: 'incident-response' }] } }));
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-export-incident-response'));
    const said = await screen.findByTestId('process-export-refused-incident-response');
    expect(said.textContent).toContain('admin.processes.errors.PROCESS_NOT_FOUND');
    expect(said.textContent).toContain('"process":"incident-response"');
  });

  it('is not offered where the section is not told which assistant it is', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" />);
    expect(screen.queryByTestId('process-export-incident-response')).toBeNull();
    expect(screen.queryByTestId('process-import')).toBeNull();
  });
});

describe('Import process', () => {
  it('reads a process manifest, and nothing else, before any request', () => {
    expect(readProcessManifestText(JSON.stringify(manifest))).toMatchObject({ kind: 'process', processName: 'incident-response' });
    expect(readProcessManifestText(JSON.stringify({ kind: 'assistant-profile', body: {} }))).toBeNull();
    expect(readProcessManifestText('not json')).toBeNull();
  });

  it('lands a pasted manifest in the draft shown, naming that draft, and says so', async () => {
    vi.mocked(svc.importProcess).mockResolvedValue({ imported: 'incident-response', profileName: 'ops-premium', configId: 'c2', landedAs: 'draft' });
    const onImported = vi.fn();
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" draftConfigId="c1" onProcessImported={onImported} />);
    fireEvent.change(screen.getByTestId('process-import-text'), { target: { value: JSON.stringify(manifest) } });
    expect(screen.getByTestId('process-import-preview').textContent).toContain('admin.processes.portable.preview');
    fireEvent.click(screen.getByTestId('process-import-confirm'));
    expect((await screen.findByTestId('process-import-landed')).textContent).toContain('admin.processes.portable.landed');
    expect(svc.importProcess).toHaveBeenCalledWith(manifest, 'c1', 'ops-premium');
    expect(onImported).toHaveBeenCalledWith(true);
  });

  it('takes a chosen file the same way', async () => {
    vi.mocked(svc.importProcess).mockResolvedValue({ imported: 'incident-response', profileName: 'ops-premium', configId: 'c2', landedAs: 'draft' });
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" draftConfigId="c1" />);
    const file = new File([JSON.stringify(manifest)], 'incident-response.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('process-import-file'), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByTestId('process-import-text') as HTMLTextAreaElement).value).toContain('incident-response'));
    fireEvent.click(screen.getByTestId('process-import-confirm'));
    await screen.findByTestId('process-import-landed');
    expect(svc.importProcess).toHaveBeenCalledWith(manifest, 'c1', 'ops-premium');
  });

  it('DENY: says each requirement the deployment lacks in words, with the missing names', async () => {
    vi.mocked(svc.importProcess).mockRejectedValue(Object.assign(new Error('422'), {
      body: {
        code: 'PROCESS_REQUIREMENTS_UNMET',
        refusals: [
          { code: 'PROCESS_REQ_INTENT', type: 'customer-messaging', role: 'primary', intent: 'customer_notice_draft', assistant: 'advisor' },
          { code: 'PROCESS_REQ_TYPE', type: 'customer-messaging', classification: 'premium' },
        ],
        errors: ['processes.incident-response.workflows.ops-room: PROCESS_WORKFLOW_LINKED_TWICE'],
      },
    }));
    const onImported = vi.fn();
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" draftConfigId="c1" onProcessImported={onImported} />);
    fireEvent.change(screen.getByTestId('process-import-text'), { target: { value: JSON.stringify(manifest) } });
    fireEvent.click(screen.getByTestId('process-import-confirm'));
    const refused = await screen.findByTestId('process-import-refused');
    expect(refused.textContent).toContain('admin.processes.portable.refused');
    const items = Array.from(refused.querySelectorAll('li')).map((li) => li.textContent);
    expect(items[0]).toContain('admin.processes.errors.PROCESS_REQ_INTENT');
    expect(items[0]).toContain('"intent":"customer_notice_draft"');
    expect(items[0]).toContain('"assistant":"advisor"');
    expect(items[1]).toContain('admin.processes.errors.PROCESS_REQ_TYPE');
    expect(items[2]).toContain('admin.processes.errors.PROCESS_WORKFLOW_LINKED_TWICE');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('DENY: refuses text that is not a process manifest without a request', async () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" />);
    fireEvent.change(screen.getByTestId('process-import-text'), { target: { value: '{"kind":"assistant-profile"}' } });
    fireEvent.click(screen.getByTestId('process-import-confirm'));
    expect((await screen.findByTestId('process-import-refused')).textContent).toContain('admin.processes.portable.notManifest');
    expect(svc.importProcess).not.toHaveBeenCalled();
  });

  it('a draft saved since is kept: the refusal says so and the page reads the draft again', async () => {
    vi.mocked(svc.importProcess).mockRejectedValue(Object.assign(new Error('409'), { body: { code: 'DRAFT_EXISTS', configId: 'c9' } }));
    const onImported = vi.fn();
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="Ops" assistant="ops-premium" draftConfigId="c1" onProcessImported={onImported} />);
    fireEvent.change(screen.getByTestId('process-import-text'), { target: { value: JSON.stringify(manifest) } });
    fireEvent.click(screen.getByTestId('process-import-confirm'));
    expect((await screen.findByTestId('process-import-refused')).textContent).toContain('admin.processes.portable.draftChanged');
    expect(onImported).toHaveBeenCalledWith(false);
  });

  it('is offered only to a reader who may edit the draft', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit={false} profileName="Ops" assistant="ops-premium" />);
    expect(screen.queryByTestId('process-import')).toBeNull();
    expect(screen.getByTestId('process-export-incident-response')).toBeTruthy();
  });
});
