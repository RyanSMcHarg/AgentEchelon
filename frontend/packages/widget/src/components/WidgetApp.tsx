/**
 * THE WIDGET: a launcher, and a panel holding one conversation.
 *
 * Keyboard operable throughout: the launcher is a button (`aria-expanded`, `aria-controls`), the panel
 * is a labelled dialog that takes focus into its composer when it opens, Escape closes it, and closing
 * returns focus to the launcher. The transcript is an ARIA live region (`Transcript.tsx`).
 *
 * What the panel holds is a state machine over the session:
 *
 *  - guest: `notice` (the privacy notice, before the first message), then `starting` (captcha and guest
 *    start), then `ready`. A visit already open on this origin (a reload, another tab) is joined.
 *  - host: `waiting` for the host's assertion, then `ready`.
 *  - either: `refused`, the settled state of the refusal, with its way forward (and, when paused or
 *    unavailable, the host's declared contact route, `contactRoute`).
 *
 * THE VISIT CARRIES OVER WITH NOTHING TO CLICK (`CarryOver.tsx`, `session/upgrade.ts`): a ready guest
 * session shows, under the conversation, what the deployment declares and the chat app it names allow.
 * "Sign in" (path A) opens the chat app's sign-in in a new tab and hands the visit off to that tab alone
 * (`session/upgrade.ts`: a nonce in its link, the secret over `postMessage` to the window it opened), and
 * `continued` says the visit continues there, with "Back to the conversation" to the same session. The
 * registration form (path B) registers the visit with the address its sign-in link is emailed to, and says
 * where the link went; the conversation goes on beside it. Nothing asks the visitor to keep anything.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { contactRoute, guestNoticeVersion, guestCaptchaSiteKey, guestSignInUrl, guestStartOffered, guestUpgradePaths } from '../config';
import {
  answerHandOff, bindDestination, handOffSecretHash, HANDOFF_WINDOW, newHandOffSecret, registerGuest as defaultRegister, RegistrationRefusal,
  type RegistrationFields, type RegistrationOutcome, type RegistrationRefusalCode,
} from '../session/upgrade';
import { CarryOverBar, SigningIn } from './CarryOver';
import { guestRefresh, guestStart as defaultGuestStart, WidgetRefusal, type GuestStart, type RefusalCode } from '../session/personApi';
import { GuestVisit } from '../session/refreshLeader';
import { guestSession, hostSession, type WidgetSession } from '../session/widgetSession';
import { turnstileSolver, type CaptchaSolver } from '../session/captcha';
import type { HostAssertionInbox } from '../session/hostAssertion';
import { useChannel } from '../messaging/useChannel';
import { Transcript } from './Transcript';
import { Composer } from './Composer';
import { Refusal } from './Refusal';
import { Notice } from './Notice';

export interface WidgetDeps {
  /** Default: Turnstile. */
  captcha?: CaptchaSolver;
  /** Default: `POST /guest/start`. */
  guestStart?: (captchaToken: string, noticeVersion: string) => Promise<GuestStart>;
  /** Default: the visit shared by this origin's tabs. */
  visit?: GuestVisit;
  /** The host's inbox, in host mode. */
  inbox?: HostAssertionInbox;
  /** Render the conversation for a session. Default: the live channel. A test passes its own. */
  Conversation?: (props: { session: WidgetSession }) => ReactNode;
  /** Tells the parent page whether the panel is open, so the loader sizes the frame. */
  onOpenChange?: (open: boolean) => void;
  /** Default: `POST /guest/register`. */
  register?: (guestToken: string, fields: RegistrationFields, email: string) => Promise<{ status: RegistrationOutcome }>;
  /**
   * Opens (or reuses) the sign-in tab at `url`, and answers with it. Default: `window.open` into the named
   * `HANDOFF_WINDOW`, KEEPING the opener: the tab asks this widget for the hand-off's secret through it.
   */
  openTab?: (url: string) => Window | null;
  /** The host's contact route. Default: the frame's `?contact=`. */
  contact?: string | null;
}

type Panel =
  | { kind: 'loading' }
  | { kind: 'notice' }
  | { kind: 'starting' }
  | { kind: 'waiting' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; session: WidgetSession }
  | { kind: 'continued'; session: WidgetSession; destination: string }
  | { kind: 'refused'; code: RefusalCode; retryAfterSeconds?: number };

function LiveConversation({ session }: { session: WidgetSession }) {
  const { messages, status, send } = useChannel(session);
  return (
    <>
      <Transcript messages={messages} status={status} />
      <Composer onSend={(text) => void send(text)} />
    </>
  );
}

function refusalOf(err: unknown): Panel {
  if (err instanceof WidgetRefusal) return { kind: 'refused', code: err.code, retryAfterSeconds: err.retryAfterSeconds };
  return { kind: 'refused', code: 'unavailable' };
}

export function WidgetApp({ mode, deps = {} }: { mode: 'guest' | 'host'; deps?: WidgetDeps }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>({ kind: 'loading' });
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const captchaRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);
  const visitRef = useRef<GuestVisit | null>(deps.visit ?? null);
  const onRefused = useCallback((r: WidgetRefusal) => setPanel({ kind: 'refused', code: r.code, retryAfterSeconds: r.retryAfterSeconds }), []);
  const Conversation = deps.Conversation ?? LiveConversation;

  // ── the session ───────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (mode === 'host') {
      if (!deps.inbox) {
        setPanel({ kind: 'unavailable' });
        return;
      }
      setPanel({ kind: 'waiting' });
      hostSession(deps.inbox, onRefused).then(
        (session) => !cancelled && setPanel({ kind: 'ready', session }),
        (err: unknown) => !cancelled && setPanel(refusalOf(err)),
      );
      return () => {
        cancelled = true;
      };
    }
    if (!guestStartOffered()) {
      setPanel({ kind: 'unavailable' });
      return;
    }
    const visit = visitRef.current ?? new GuestVisit('ae-widget-guest', { refresh: guestRefresh });
    visitRef.current = visit;
    const offEnded = visit.onEnded((code) => setPanel({ kind: 'refused', code }));
    visit.join().then((joined) => {
      if (cancelled) return;
      setPanel(joined ? { kind: 'ready', session: guestSession(visit, joined, onRefused) } : { kind: 'notice' });
    });
    return () => {
      cancelled = true;
      offEnded();
    };
  }, [mode, deps.inbox, onRefused]);

  useEffect(() => () => {
    if (deps.visit) return;
    visitRef.current?.close();
    visitRef.current = null;
  }, [deps.visit]);

  const startGuest = useCallback(async () => {
    const visit = visitRef.current;
    if (!visit) return;
    setPanel({ kind: 'starting' });
    let captchaToken: string;
    try {
      captchaToken = await (deps.captcha ?? turnstileSolver)(captchaRef.current!, guestCaptchaSiteKey(), i18n.language);
    } catch {
      setPanel({ kind: 'refused', code: 'captcha_failed' });
      return;
    }
    try {
      const started = await (deps.guestStart ?? defaultGuestStart)(captchaToken, guestNoticeVersion());
      visit.open(started);
      setPanel({ kind: 'ready', session: guestSession(visit, started, onRefused) });
    } catch (err) {
      setPanel(refusalOf(err));
    }
  }, [deps.captcha, deps.guestStart, i18n.language, onRefused]);

  // ── the visit carrying over ───────────────────────────────────────────────────────────────────
  const paths = mode === 'guest' ? guestUpgradePaths() : new Set<'bind' | 'claim'>();
  const contact = deps.contact === undefined ? contactRoute() : deps.contact;
  const [registration, setRegistration] = useState<{ busy: boolean; error?: RegistrationRefusalCode; done?: { outcome: RegistrationOutcome; email: string } }>({ busy: false });
  // THE HAND-OFF (path A). The tab is opened at once, inside the click, so no popup blocker stands in the
  // way; it is sent to the sign-in once the refresh has minted the nonce. The secret stays in this closure
  // and goes only to that tab, when it asks (`answerHandOff`).
  const tabRef = useRef<Window | null>(null);
  const stopAnswering = useRef<(() => void) | null>(null);
  useEffect(() => () => stopAnswering.current?.(), []);
  const openTab = useCallback((url: string) => (deps.openTab ?? ((u: string) => window.open(u, HANDOFF_WINDOW)))(url), [deps.openTab]);
  const signIn = useCallback((session: WidgetSession) => {
    const visit = visitRef.current;
    if (!visit?.current()?.refreshToken) {
      setPanel({ kind: 'refused', code: 'ended' });
      return;
    }
    tabRef.current = openTab('about:blank');
    void (async () => {
      try {
        const secret = newHandOffSecret();
        const nonce = await visit.handOff(await handOffSecretHash(secret));
        const destination = bindDestination(guestSignInUrl(), nonce);
        stopAnswering.current?.();
        stopAnswering.current = answerHandOff(() => tabRef.current, new URL(guestSignInUrl()).origin, nonce, secret);
        if (tabRef.current) tabRef.current.location.href = destination;
        setPanel({ kind: 'continued', session, destination });
      } catch (err) {
        tabRef.current?.close();
        tabRef.current = null;
        setPanel(refusalOf(err));
      }
    })();
  }, [openTab]);
  const reopenSignIn = useCallback((destination: string) => {
    tabRef.current = openTab(destination);
  }, [openTab]);
  const register = useCallback(async (fields: RegistrationFields, email: string) => {
    const visit = visitRef.current;
    if (!visit) return;
    setRegistration({ busy: true });
    try {
      const { status } = await (deps.register ?? defaultRegister)(await visit.guestToken(), fields, email);
      setRegistration({ busy: false, done: { outcome: status, email } });
    } catch (err) {
      if (err instanceof WidgetRefusal) {
        setPanel({ kind: 'refused', code: err.code, retryAfterSeconds: err.retryAfterSeconds });
        return;
      }
      setRegistration({ busy: false, error: err instanceof RegistrationRefusal ? err.code : 'unavailable' });
    }
  }, [deps.register]);

  const reload = useCallback(() => {
    visitRef.current?.forget();
    setPanel({ kind: 'notice' });
  }, []);

  // ── open and close, and where focus goes ──────────────────────────────────────────────────────
  useEffect(() => {
    deps.onOpenChange?.(open);
    if (open) {
      const target = panelRef.current?.querySelector<HTMLElement>('textarea, button.aeaw__action, [tabindex="0"]');
      (target ?? panelRef.current)?.focus();
    } else if (wasOpen.current) {
      launcherRef.current?.focus();
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="aeaw" lang={i18n.language}>
      {open && (
        <section
          id="aeaw-panel"
          ref={panelRef}
          className="aeaw__window"
          role="dialog"
          aria-labelledby="aeaw-title"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <header className="aeaw__header">
            <h2 id="aeaw-title" className="aeaw__title">{t('widget.panelTitle')}</h2>
            <button type="button" className="aeaw__ctrl" onClick={close} aria-label={t('widget.close')}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
                <path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          <div className="aeaw__body">
            {panel.kind === 'ready' && <Conversation session={panel.session} />}
            {panel.kind === 'ready' && panel.session.kind === 'guest' && (
              <CarryOverBar
                paths={paths}
                onSignIn={() => signIn(panel.session)}
                register={{ ...registration, onSubmit: (fields, email) => void register(fields, email) }}
              />
            )}
            {panel.kind === 'continued' && (
              <SigningIn onOpen={() => reopenSignIn(panel.destination)} onBack={() => setPanel({ kind: 'ready', session: panel.session })} />
            )}
            {panel.kind === 'notice' && <Notice version={guestNoticeVersion()} onAccept={() => void startGuest()} busy={false} />}
            {panel.kind === 'starting' && <Notice version={guestNoticeVersion()} onAccept={() => undefined} busy />}
            {panel.kind === 'waiting' && <p className="aeaw__hint" role="status">{t('widget.waitingForHost')}</p>}
            {panel.kind === 'loading' && <p className="aeaw__hint" role="status">{t('widget.status.connecting')}</p>}
            {panel.kind === 'unavailable' && <p className="aeaw__hint">{t('widget.noGuestStart')}</p>}
            {panel.kind === 'refused' && (
              <Refusal
                code={panel.code}
                retryAfterSeconds={panel.retryAfterSeconds}
                onRetry={mode === 'guest' ? () => setPanel({ kind: 'notice' }) : undefined}
                onReload={mode === 'guest' ? reload : undefined}
                contact={contact}
              />
            )}
            {/* The captcha renders here, inside the panel, when Turnstile needs an interaction. */}
            <div ref={captchaRef} className="aeaw__captcha" />
          </div>
        </section>
      )}
      <button
        ref={launcherRef}
        type="button"
        className="aeaw__launcher"
        aria-expanded={open}
        aria-controls="aeaw-panel"
        aria-label={open ? t('widget.close') : t('widget.launcher')}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
          <path d="M4 5h16v10H8l-4 4V5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
