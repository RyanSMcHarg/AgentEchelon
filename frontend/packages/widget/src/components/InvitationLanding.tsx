/**
 * THE INVITATION LANDING PAGE (M-5, M-10, D-4): what an invitation's link opens.
 *
 * The link carries its token in the URL fragment (`#t=<token>`), which no server, access log or `Referer`
 * receives. The page reads it once, removes it from the address bar, and asks what it may know
 * (`peekInvitation`): the conversation's name, who invited the holder and as whom. Opening the page never
 * redeems anything, so an email scanner that fetches it, or posts the read, consumes nothing. Joining is a
 * person's own click:
 *
 *  - a `sign-in` invitation sends its holder to the chat app to sign in, carrying the token in that
 *    page's fragment; the chat app redeems it with the first sign-in;
 *  - a `link` invitation solves the captcha, then redeems once (`redeemLinkInvitation`), and the
 *    conversation opens here, under a standing banner: the person is a guest in this one conversation, for
 *    the session's 15 minutes, and then the page says it has ended.
 *
 * Every refusal is a settled state naming the inviter, with what to do next (D-4).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  InvitationRefusal,
  peekInvitation as defaultPeek,
  redeemLinkInvitation as defaultRedeem,
  signInDestination,
  tokenFromFragment,
  type InvitationPeek,
  type InvitationRefusalCode,
  type LinkRedemption,
} from '../session/invitationApi';
import { linkSession, type WidgetSession } from '../session/widgetSession';
import { turnstileSolver, type CaptchaSolver } from '../session/captcha';
import { useChannel } from '../messaging/useChannel';
import { Transcript } from './Transcript';
import { Composer } from './Composer';

export interface InvitationLandingDeps {
  peek?: typeof defaultPeek;
  redeem?: typeof defaultRedeem;
  captcha?: CaptchaSolver;
  /** Where the browser goes for a sign-in invitation. Default: `window.location.assign`. */
  navigate?: (url: string) => void;
  /** The fragment to read and then clear. Default: the page's own. */
  readFragment?: () => string;
  clearFragment?: () => void;
  /** Render the conversation for a session. Default: the live channel. */
  Conversation?: (props: { session: WidgetSession }) => ReactNode;
  now?: () => number;
}

type State =
  | { kind: 'loading' }
  | { kind: 'invited'; invitation: InvitationPeek; joining: boolean }
  | { kind: 'joined'; session: WidgetSession; redemption: LinkRedemption }
  | { kind: 'refused'; code: InvitationRefusalCode; inviterName?: string; retryAfterSeconds?: number };

function LiveConversation({ session }: { session: WidgetSession }) {
  const { messages, status, send } = useChannel(session);
  return (
    <>
      <Transcript messages={messages} status={status} />
      <Composer onSend={(text) => void send(text)} />
    </>
  );
}

const STATUS_REFUSAL: Record<Exclude<InvitationPeek['status'], 'pending'>, InvitationRefusalCode> = {
  redeemed: 'redeemed',
  expired: 'expired',
  revoked: 'revoked',
};

export function InvitationLanding({ deps = {} }: { deps?: InvitationLandingDeps }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const tokenRef = useRef<string>('');
  const captchaRef = useRef<HTMLDivElement | null>(null);
  const Conversation = deps.Conversation ?? LiveConversation;

  // ── READ THE TOKEN ONCE, CLEAR IT FROM THE ADDRESS BAR, AND ASK WHAT IT MAY KNOW ───────────────
  useEffect(() => {
    let cancelled = false;
    const token = tokenFromFragment((deps.readFragment ?? (() => window.location.hash))());
    (deps.clearFragment ?? (() => window.history.replaceState(null, '', window.location.pathname)))();
    tokenRef.current = token;
    if (!token) {
      setState({ kind: 'refused', code: 'unknown' });
      return;
    }
    (deps.peek ?? defaultPeek)(token).then(
      (invitation) => {
        if (cancelled) return;
        if (invitation.status !== 'pending') {
          setState({ kind: 'refused', code: STATUS_REFUSAL[invitation.status], inviterName: invitation.inviterName });
        } else if (invitation.mode === 'link' && !invitation.linkAvailable) {
          setState({ kind: 'refused', code: 'wrong_mode', inviterName: invitation.inviterName });
        } else {
          setState({ kind: 'invited', invitation, joining: false });
        }
      },
      (err: unknown) => !cancelled && setState({ kind: 'refused', code: err instanceof InvitationRefusal ? err.code : 'unavailable' }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── THE SESSION ENDS WHEN ITS 15 MINUTES DO: a settled state, not a broken conversation ────────
  useEffect(() => {
    if (state.kind !== 'joined') return;
    const ms = state.redemption.sessionEndsAt * 1000 - (deps.now ?? Date.now)();
    const timer = setTimeout(() => setState({ kind: 'refused', code: 'ended', inviterName: state.redemption.inviterName }), Math.max(0, ms));
    return () => clearTimeout(timer);
  }, [state, deps.now]);

  const join = useCallback(async () => {
    if (state.kind !== 'invited' || state.joining) return;
    const { invitation } = state;
    const token = tokenRef.current;
    if (invitation.mode === 'sign-in') {
      if (!invitation.signInUrl) {
        setState({ kind: 'refused', code: 'unavailable', inviterName: invitation.inviterName });
        return;
      }
      (deps.navigate ?? ((url: string) => window.location.assign(url)))(signInDestination(invitation.signInUrl, token));
      return;
    }
    setState({ kind: 'invited', invitation, joining: true });
    let captchaToken = '';
    if (invitation.captchaSiteKey) {
      try {
        captchaToken = await (deps.captcha ?? turnstileSolver)(captchaRef.current!, invitation.captchaSiteKey, i18n.language);
      } catch {
        setState({ kind: 'refused', code: 'captcha_failed', inviterName: invitation.inviterName });
        return;
      }
    }
    try {
      const redemption = await (deps.redeem ?? defaultRedeem)(token, captchaToken);
      const session = linkSession(redemption, () => setState({ kind: 'refused', code: 'ended', inviterName: redemption.inviterName }));
      setState({ kind: 'joined', session, redemption });
    } catch (err) {
      setState({
        kind: 'refused',
        code: err instanceof InvitationRefusal ? err.code : 'unavailable',
        inviterName: invitation.inviterName,
        ...(err instanceof InvitationRefusal && err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
      });
    }
  }, [state, deps, i18n.language]);

  const someone = t('invitation.someone');
  return (
    <main className="aeinv" lang={i18n.language}>
      {state.kind === 'loading' && <p className="aeaw__hint" role="status">{t('invitation.loading')}</p>}
      {state.kind === 'invited' && (
        <section className="aeinv__card" aria-labelledby="aeinv-title">
          <h1 id="aeinv-title" className="aeinv__title">
            {t('invitation.heading', { inviter: state.invitation.inviterName || someone, conversation: state.invitation.conversationName || t('invitation.untitled') })}
          </h1>
          <p className="aeinv__body">{t('invitation.as', { name: state.invitation.inviteeName })}</p>
          <p className="aeinv__body aeinv__body--quiet">
            {state.invitation.mode === 'sign-in' ? t('invitation.signInExplained') : t('invitation.linkExplained', { minutes: state.invitation.sessionMinutes ?? 15 })}
          </p>
          <button type="button" className="aeaw__action" onClick={() => void join()} disabled={state.joining}>
            {state.invitation.mode === 'sign-in' ? t('invitation.signInToJoin') : state.joining ? t('invitation.joining') : t('invitation.join')}
          </button>
          {/* The captcha renders here when Turnstile needs an interaction. */}
          <div ref={captchaRef} className="aeaw__captcha" />
        </section>
      )}
      {state.kind === 'joined' && (
        <section className="aeinv__conversation" aria-labelledby="aeinv-conversation">
          <header className="aeaw__header">
            <h1 id="aeinv-conversation" className="aeaw__title">{state.redemption.conversationName || t('invitation.untitled')}</h1>
          </header>
          {/* THE STANDING BANNER (D-4): a guest in this one conversation, for a while. */}
          <p className="aeinv__banner" role="note">{t('invitation.banner')}</p>
          <div className="aeaw__body">
            <Conversation session={state.session} />
          </div>
        </section>
      )}
      {state.kind === 'refused' && (
        <section className="aeinv__card" role="alert" data-code={state.code}>
          <h1 className="aeinv__title">{t(`invitation.refused.${state.code}.title`)}</h1>
          <p className="aeinv__body">
            {t(`invitation.refused.${state.code}.body`, { inviter: state.inviterName || someone, seconds: state.retryAfterSeconds ?? 60 })}
          </p>
        </section>
      )}
    </main>
  );
}
