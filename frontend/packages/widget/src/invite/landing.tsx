/**
 * THE INVITATION LANDING PAGE, AS ONE MOUNTABLE PAGE (M-5, M-10): the page an invitation's link opens, in the
 * person's language, with its own styles. Every client that serves `invite.html` mounts this: the chat app,
 * where every invitation lands today (`invitationLandingFor`, `backend/lib/config/app-origins.ts`), and the
 * widget's origin, its alternative. A top-level page, never a frame.
 *
 * A `sign-in` invitation sends its holder to sign in at the chat app (`signInUrl`), which redeems it with the
 * first sign-in; a `link` invitation is redeemed here and its session hosted here, for the one conversation.
 */
import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import '@ae/shared/styles/design-tokens.css';
import '../widget.css';
import { createWidgetI18n, pickLanguage } from '../i18n';
import { InvitationLanding, type InvitationLandingDeps } from '../components/InvitationLanding';

export type { InvitationLandingDeps };

/** The browser's languages, most preferred first. */
const browserLanguages = (): string[] => [...(navigator.languages ?? []), navigator.language];

/** The landing page in the first of `languages` it has. */
export function InvitationLandingPage({ deps, languages }: { deps?: InvitationLandingDeps; languages?: readonly string[] }) {
  const i18n = useMemo(() => createWidgetI18n(pickLanguage(languages ?? browserLanguages())), [languages]);
  return (
    <I18nextProvider i18n={i18n}>
      <InvitationLanding deps={deps} />
    </I18nextProvider>
  );
}

/** Mount the landing page into `root`, titling the document in the person's language. */
export function mountInvitationLanding(root: HTMLElement): void {
  const i18n = createWidgetI18n(pickLanguage(browserLanguages()));
  document.documentElement.lang = i18n.language;
  document.title = i18n.t('invitation.pageTitle');
  createRoot(root).render(
    <StrictMode>
      <InvitationLandingPage />
    </StrictMode>,
  );
}
