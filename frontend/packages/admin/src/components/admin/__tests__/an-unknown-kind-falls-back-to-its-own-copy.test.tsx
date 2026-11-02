/**
 * AN UNKNOWN ENUMERATED VALUE RENDERS THE FALLBACK SENTENCE, NOT A KEY.
 *
 * The console has fifteen `Record<string, string>` help maps keyed by a value from the backend - a turn
 * kind, an interaction, a router step, a tool error class. Each had an `?? FALLBACK` at its call site,
 * because the sets are closed and a value this console has not been taught about means a producer
 * shipped ahead of its reader.
 *
 * Converting them to `t([specific, fallback])` moves that branch into the lookup: i18next resolves an
 * ARRAY of keys to the first that exists. That is cleaner and it is also an ASSUMPTION ABOUT A LIBRARY,
 * and the failure mode if it is wrong is silent - an unknown kind would render the literal string
 * "admin.turnKinds.help.something_new" in a tooltip, which looks like a styling bug and reaches nobody
 * who could fix it. Fifteen maps will rest on this, so it is asserted once, here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';

/** The exact shape the converted maps use. */
const Probe = ({ kind }: { kind: string }) => {
  const { t } = useTranslation();
  return <span data-testid="help">{t([`admin.turnKinds.help.${kind}`, 'admin.turnKinds.help.fallback'])}</span>;
};

describe('a closed set of help strings', () => {
  it('uses the specific copy when the value is known', () => {
    render(<Probe kind="reading" />);
    expect(screen.getByTestId('help')).toHaveTextContent(/answers a BURST of messages/i);
  });

  it('falls through to the fallback when the value is not', () => {
    render(<Probe kind="some_kind_that_does_not_exist" />);
    const el = screen.getByTestId('help');
    expect(el).toHaveTextContent(/has no description for yet/i);
    // THE PART THAT WOULD BE SILENT: a failed array lookup returns the first key verbatim.
    expect(el.textContent).not.toMatch(/admin\.turnKinds/);
  });

  it('does the same for the interaction map, so the pattern is not one lucky namespace', () => {
    const IProbe = ({ kind }: { kind: string }) => {
      const { t } = useTranslation();
      return (
        <span data-testid="i">
          {t([`admin.interactionLatency.help.${kind}`, 'admin.interactionLatency.help.fallback'])}
        </span>
      );
    };
    render(<IProbe kind="not_a_real_interaction" />);
    const el = screen.getByTestId('i');
    expect(el).toHaveTextContent(/has no description for yet/i);
    expect(el.textContent).not.toMatch(/admin\.interactionLatency/);
  });
});
