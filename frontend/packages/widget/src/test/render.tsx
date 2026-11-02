import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createWidgetI18n } from '../i18n';

/** Render inside a fresh widget i18n instance (English unless a test passes another locale). */
export function renderWidget(ui: ReactNode, lng = 'en', extra: Record<string, { translation: unknown }> = {}) {
  const i18n = createWidgetI18n(lng, extra);
  const result = render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
  /** Re-render with new props inside the same i18n instance. */
  const rerenderWidget = (next: ReactNode) => result.rerender(<I18nextProvider i18n={i18n}>{next}</I18nextProvider>);
  return { i18n, rerenderWidget, ...result };
}
