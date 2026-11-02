/**
 * THE DRAFT'S SHARED CONTROLS: ONE AREA INLINE, THE DIFF, THE SERVER'S ANSWER.
 *
 * What it proves: an area's step keeps its help behind a ? control and previews the sentence the area will say; its
 * controls start from the saved draft with the area's unsaved edit laid over it, so a step rendered again shows the
 * edit; each change is reported to the caller, which holds the edit; the diff says what the draft changes or sets; a
 * refused draft lists each reason.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DraftDiff, DraftStep, DraftValidationResult, type AreaContext } from './DraftControls';
import * as svc from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: vi.fn().mockResolvedValue({ assistant: 'advisor', classification: 'premium', templates: [], family: {} }),
}));

const ACTIVE: svc.ProfileDefinitionBody = { modelKey: 'sonnet', displayName: 'Advisor', persona: 'You advise.', tools: ['search'] };
const DRAFT: svc.ProfileDefinitionBody = { ...ACTIVE, persona: 'You advise briefly.', variables: { team: { source: 'fact:team', fallback: 'your team' } } };
const CTX: AreaContext = {
  profileName: 'advisor', role: 'primary', tools: [], decisions: {}, canActivate: true, canEdit: true,
  catalog: { classification: 'premium', models: { text: ['sonnet'], image: [] }, retrievalReach: [], roles: {} },
};

/** A caller holding the edit, as the tab does, with a way to unmount and mount the step again. */
function Holder({ onChange }: { onChange?: (p: svc.ProfileDraftPatch) => void }) {
  const [unsaved, setUnsaved] = useState<svc.ProfileDraftPatch | undefined>();
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown((s) => !s)}>toggle</button>
      {shown && (
        <DraftStep area="identity" draft={DRAFT} ctx={CTX} unsaved={unsaved}
          onUnsavedPatch={(p) => { setUnsaved((u) => ({ ...(u ?? {}), ...p })); onChange?.(p); }}
          actions={(edited) => <span data-testid="edited">{String(edited)}</span>} />
      )}
    </>
  );
}

describe('one area inline', () => {
  it('keeps its help behind a ? control and previews the sentence the area will say', () => {
    render(<Holder />);
    expect(screen.queryByTestId('draft-step-identity-help-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('draft-step-identity-help'));
    expect(screen.getByTestId('draft-step-identity-help-panel')).toHaveTextContent('the persona the assistant answers with');
    fireEvent.change(screen.getByTestId('draft-name'), { target: { value: 'Tax' } });
    expect(screen.getByTestId('draft-step-preview')).toHaveTextContent('Tax, with a persona of 19 characters.');
  });

  it('reports each change to the caller, and starts from the held edit when rendered again', () => {
    const onChange = vi.fn();
    render(<Holder onChange={onChange} />);
    expect(screen.getByTestId('edited')).toHaveTextContent('false');
    fireEvent.change(screen.getByTestId('draft-name'), { target: { value: '  ' } });
    // A cleared name is null, which inherits the provisioned name; the persona was not touched.
    expect(onChange).toHaveBeenCalledWith({ displayName: null });
    fireEvent.change(screen.getByTestId('draft-persona'), { target: { value: 'Short.' } });
    expect(screen.getByTestId('edited')).toHaveTextContent('true');
    expect(screen.getByTestId('draft-step-identity-unsaved')).toHaveTextContent('Unsaved');
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect((screen.getByTestId('draft-persona') as HTMLTextAreaElement).value).toBe('Short.');
  });
});

describe('the diff and the server\'s answer', () => {
  it('lists what the draft changes, area by area, or what it sets while nothing is active', () => {
    const { unmount } = render(<DraftDiff draft={DRAFT} active={ACTIVE} />);
    const diff = screen.getByTestId('draft-diff');
    expect(diff).toHaveTextContent('What this draft changes from the active version');
    expect(within(diff).getByTestId('draft-diff-identity')).toHaveTextContent('persona (changed)');
    expect(within(diff).getByTestId('draft-diff-variables')).toHaveTextContent('variables (added)');
    unmount();
    render(<DraftDiff draft={DRAFT} active={null} />);
    expect(screen.getByTestId('draft-diff')).toHaveTextContent('nothing is active yet');
  });

  it('lists each reason a draft was refused', () => {
    render(<DraftValidationResult validation={{ valid: false, errors: ['models.default is not selected'] }} />);
    expect(within(screen.getByTestId('draft-refused')).getByRole('listitem')).toHaveTextContent('models.default is not selected');
  });
});
