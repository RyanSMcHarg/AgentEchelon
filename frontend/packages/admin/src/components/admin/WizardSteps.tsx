/**
 * THE STEPS OF A WIZARD: every step named in order, the current one marked (`aria-current="step"`), and a heading that
 * says which step this is and takes focus when the step changes, so a keyboard or screen reader user lands on it.
 * The create flow and the setup that continues it once the assistant is built read the same steps.
 */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export const WizardSteps: React.FC<{
  steps: ReadonlyArray<{ key: string; label: string }>;
  /** The index of the current step. */
  current: number;
  /** The heading's test id. */
  headingTestId?: string;
}> = ({ steps, current, headingTestId }) => {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement | null>(null);
  // The heading takes focus when the step changes, not when the wizard first renders.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [current]);
  return (
    <>
      <ol className="admin-steps" aria-label={t('admin.create.stepsLabel')}>
        {steps.map((s, i) => (
          <li key={s.key} aria-current={i === current ? 'step' : undefined}
            className={['admin-step', i === current ? 'admin-step--current' : i < current ? 'admin-step--done' : ''].filter(Boolean).join(' ')}>
            {s.label}
          </li>
        ))}
      </ol>
      <h5 ref={heading} tabIndex={-1} data-testid={headingTestId}>
        {t('admin.create.stepOf', { n: current + 1, total: steps.length, name: steps[current]?.label ?? '' })}
      </h5>
    </>
  );
};

export default WizardSteps;
