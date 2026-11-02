/**
 * The frame's entry. The host's loader (`embed/embed.ts`) frames `index.html` with its options as URL
 * parameters: `mode` (`guest`, the default, or `host`), `lang`, and the host theme (`theme.ts`).
 *
 * The frame tells its parent two things, and nothing else: that it is ready (with its localized title,
 * so the loader names the frame in the person's language), and whether the panel is open (so the loader
 * sizes the frame). Neither carries anything about the person or the conversation, so both are posted
 * to any parent origin; the loader checks they come from this frame.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import '@ae/shared/styles/design-tokens.css';
import './widget.css';
import { assertionHosts } from './config';
import { createWidgetI18n, pickLanguage } from './i18n';
import { applyHostTheme, readHostTheme } from './theme';
import { HostAssertionInbox } from './session/hostAssertion';
import { WidgetApp } from './components/WidgetApp';

export const FRAME_READY = 'ae:widget-ready';
export const FRAME_OPEN = 'ae:widget-open';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'host' ? 'host' : 'guest';
const i18n = createWidgetI18n(pickLanguage([params.get('lang'), ...(navigator.languages ?? []), navigator.language]));
applyHostTheme(document.documentElement, readHostTheme(params));
document.documentElement.lang = i18n.language;
document.title = i18n.t('widget.frameTitle');

const inbox = mode === 'host' ? new HostAssertionInbox(assertionHosts()) : undefined;
const toParent = (message: Record<string, unknown>) => {
  if (window.parent !== window) window.parent.postMessage(message, '*');
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <WidgetApp mode={mode} deps={{ inbox, onOpenChange: (open) => toParent({ type: FRAME_OPEN, open }) }} />
    </I18nextProvider>
  </StrictMode>,
);
toParent({ type: FRAME_READY, title: i18n.t('widget.frameTitle') });
