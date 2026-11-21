/**
 * AN ACTION THAT THROWS AWAY WORK OR DELETES SOMETHING, TAKEN ONLY ONCE CONFIRMED: the console's inline confirm (the one
 * Discard draft uses), naming what is lost, with Cancel first. Nothing happens on the first click.
 *
 * Test ids: the button is `testId`; the confirm is `${testId}-confirm`, its Cancel `${testId}-cancel` and its action
 * `${testId}-confirm-button`.
 */
import React, { useState } from 'react';

/** The inline confirm on its own, for a page that opens it from somewhere other than one button. */
export const ConfirmPanel: React.FC<{
  testId: string;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ testId, title, body, confirmLabel, cancelLabel, onConfirm, onCancel }) => (
  <section className="admin-import-preview" role="alertdialog" aria-labelledby={`${testId}-title`} data-testid={`${testId}-confirm`}>
    <h4 id={`${testId}-title`}>{title}</h4>
    {body && <p>{body}</p>}
    <div className="admin-config-actions">
      <button type="button" className="btn-ghost" data-testid={`${testId}-cancel`} onClick={onCancel}>{cancelLabel}</button>
      <button type="button" className="btn-danger" data-testid={`${testId}-confirm-button`} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </section>
);

export const ConfirmAction: React.FC<{
  testId: string;
  /** The button as it reads before it is pressed. */
  label: React.ReactNode;
  className: string;
  disabled?: boolean;
  ariaLabel?: string;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
}> = ({ testId, label, className, disabled, ariaLabel, title, body, confirmLabel, cancelLabel, onConfirm }) => {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return <button type="button" className={className} disabled={disabled} aria-label={ariaLabel} data-testid={testId} onClick={() => setConfirming(true)}>{label}</button>;
  }
  return (
    <ConfirmPanel testId={testId} title={title} body={body} confirmLabel={confirmLabel} cancelLabel={cancelLabel}
      onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); onConfirm(); }} />
  );
};

export default ConfirmAction;
