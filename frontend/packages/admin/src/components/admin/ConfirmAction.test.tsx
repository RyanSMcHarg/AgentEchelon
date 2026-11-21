/**
 * AN ACTION THAT THROWS AWAY WORK OR DELETES SOMETHING IS TAKEN ONLY ONCE CONFIRMED.
 *
 * What it proves: the first click does nothing but ask; Cancel keeps everything; the confirm takes the action; and every
 * such action the console offers (the task builder's Reset, a section's Reset, removing a trigger or a process, clearing
 * message alternatives or a retired welcome or copy, and resetting an intent's workflow) goes through it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmAction } from './ConfirmAction';

const renderReset = () => {
  const onConfirm = vi.fn();
  render(<ConfirmAction testId="assistant-machine-reset" className="btn-ghost" label="Reset" title="Discard your unsaved changes to this task's steps?"
    confirmLabel="Discard changes" cancelLabel="Cancel" onConfirm={onConfirm} />);
  return onConfirm;
};

describe('a Reset is taken only once confirmed', () => {
  it('does nothing until confirmed, saying what is lost', () => {
    const onConfirm = renderReset();
    fireEvent.click(screen.getByTestId('assistant-machine-reset'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('assistant-machine-reset-confirm')).toHaveTextContent("Discard your unsaved changes to this task's steps?");
  });

  it('confirming discards', () => {
    const onConfirm = renderReset();
    fireEvent.click(screen.getByTestId('assistant-machine-reset'));
    fireEvent.click(screen.getByTestId('assistant-machine-reset-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('assistant-machine-reset')).toBeTruthy();
  });

  it('cancelling keeps the edits', () => {
    const onConfirm = renderReset();
    fireEvent.click(screen.getByTestId('assistant-machine-reset'));
    fireEvent.click(screen.getByTestId('assistant-machine-reset-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('assistant-machine-reset-confirm')).toBeNull();
  });
});

describe('every action that throws work away or deletes something goes through the confirm', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  it.each([
    ['AssistantPage.tsx', 'testId="assistant-machine-reset"'],
    ['AssistantPage.tsx', 'testId="draft-step-cancel"'],
    ['EventTriggerPanel.tsx', 'testId={`trigger-remove-${id}`}'],
    ['ProcessesFields.tsx', 'testId={`process-remove-${key}`}'],
    ['MessageChoicesEditor.tsx', 'testId="message-choice-reset"'],
    ['AssistantConfigFields.tsx', 'testId="draft-retired-welcome-clear"'],
    ['AssistantConfigFields.tsx', 'testId="draft-retired-copy-clear"'],
    ['IntentWorkflowsFields.tsx', 'testId={`intent-workflow-reset-${intent}`}'],
  ])('%s: %s', (file, at) => {
    const src = read(file);
    expect(src).toContain(`<ConfirmAction ${at}`);
  });
});
