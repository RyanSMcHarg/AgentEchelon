/**
 * A CONVERSATION'S DASHBOARD MESSAGE (DESIGN-CONVERSATION-DASHBOARDS section 4): its card, and the dashboard it opens.
 *
 * Every dashboard opens in a tab of its own, so the conversation stays usable beside it. An in-app (snapshot) dashboard is
 * painted into that tab as a sandboxed frame: no script runs in it and it can reach nothing of the app, whatever the
 * snapshot holds. A link in it (a runbook step's card) may only open a new tab of the app, where it is an ordinary deep link. The figures are read with the member's own credentials when it opens, and read again when the assistant
 * updates the message, so an open tab follows the conversation without polling; a tab the person closed is left alone. A
 * page dashboard is sent to a five-minute link issued to members only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  dashboardDocument, dashboardPageLink, readDashboardSnapshot, DashboardError, type DashboardOnMessage,
} from '../services/dashboardService';

export interface DashboardCardProps {
  dashboard: DashboardOnMessage;
  channelArn: string;
  /** The conversation's name, which titles the tab the dashboard opens in. */
  conversationName?: string;
  /** Injected in tests: the member's read and the page link. */
  read?: typeof readDashboardSnapshot;
  link?: typeof dashboardPageLink;
}

type View = { kind: 'closed' } | { kind: 'loading' } | { kind: 'open'; html: string } | { kind: 'error'; code: string };

/**
 * The tab's whole content, written from this app (the tab is the app's own `about:blank`): a status line while it loads
 * or when it cannot open, else the sandboxed frame filling the tab.
 */
function paintTab(tab: Window, label: string, content: { status?: string; html?: string; lang: string }): void {
  const d = tab.document;
  d.title = label;
  d.body.style.margin = '0';
  d.body.replaceChildren();
  if (content.html !== undefined) {
    const frame = d.createElement('iframe');
    // NO SCRIPT, NO SAME ORIGIN, NO NAVIGATION OF THIS TAB: only a link's new tab, which leaves the sandbox as the app itself.
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.title = label;
    frame.srcdoc = dashboardDocument(content.html, content.lang, `${window.location.origin}${window.location.pathname}`);
    frame.style.cssText = 'display:block;width:100%;height:100vh;border:0';
    d.body.appendChild(frame);
  } else if (content.status) {
    const p = d.createElement('p');
    p.setAttribute('role', 'status');
    p.textContent = content.status;
    p.style.cssText = 'font:16px system-ui,sans-serif;padding:24px';
    d.body.appendChild(p);
  }
}

export function DashboardCard({ dashboard, channelArn, conversationName, read = readDashboardSnapshot, link = dashboardPageLink, compact = false }: DashboardCardProps & { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  // THE TAB IS TITLED FOR ITS CONVERSATION, so a reader with several open knows which incident each is.
  const tabTitle = conversationName ? t('dashboard.titleOf', { conversation: conversationName }) : t('dashboard.label');
  const [view, setView] = useState<View>({ kind: 'closed' });
  /** The snapshot's tab while it is open; null once the person closes it. */
  const tab = useRef<Window | null>(null);
  const tabOpen = () => !!tab.current && !tab.current.closed;

  // THE LATEST READ WINS: reads are numbered, so one answered late never overwrites a newer one.
  const latestRead = useRef(0);
  const load = useCallback(async () => {
    const request = ++latestRead.current;
    setView((v) => (v.kind === 'open' ? v : { kind: 'loading' }));
    try {
      const html = await read(channelArn);
      if (request === latestRead.current) setView({ kind: 'open', html });
    } catch (err) {
      if (request === latestRead.current) setView({ kind: 'error', code: err instanceof DashboardError ? err.code : 'UNAVAILABLE' });
    }
  }, [channelArn, read]);

  // AN OPEN TAB FOLLOWS ITS MESSAGE: an update to it is a new `updatedAt`, and the figures are read again.
  useEffect(() => { if (tabOpen()) void load(); }, [dashboard.updatedAt, load]);

  const error = view.kind === 'error' ? t(`dashboard.error.${view.code}`, { defaultValue: t('dashboard.error.UNAVAILABLE') }) : '';

  // THE TAB SHOWS WHAT THE CARD KNOWS: the frame once read, else the loading or error line. A tab the person sent to
  // another page is no longer the app's to paint (its document belongs to another origin): it is let go, as a closed tab is.
  useEffect(() => {
    if (dashboard.kind !== 'snapshot' || !tabOpen() || view.kind === 'closed') return;
    const lang = i18n.language || 'en';
    try {
      if (view.kind === 'open') paintTab(tab.current!, tabTitle, { html: view.html, lang });
      else paintTab(tab.current!, tabTitle, { status: view.kind === 'loading' ? t('dashboard.loading') : error, lang });
    } catch {
      tab.current = null;
    }
  }, [view, dashboard.kind, error, i18n.language, t]);

  const onOpen = async () => {
    // THE TAB OPENS INSIDE THE CLICK, where a browser allows it. It is the app's own blank page, cut off from the app.
    const opened = window.open('about:blank', '_blank');
    if (!opened) { setView({ kind: 'error', code: 'POPUP_BLOCKED' }); return; }
    opened.opener = null;
    if (dashboard.kind === 'page') {
      setView({ kind: 'loading' });
      try {
        opened.location.href = await link(dashboard.conversationId);
        setView({ kind: 'closed' });
      } catch (err) {
        opened.close();
        setView({ kind: 'error', code: err instanceof DashboardError ? err.code : 'UNAVAILABLE' });
      }
      return;
    }
    tab.current = opened;
    await load();
  };

  const when = new Intl.DateTimeFormat(i18n.language || undefined, { timeStyle: 'short' }).format(new Date(dashboard.updatedAt));
  const stateLabel = dashboard.state ? t(`dashboard.state.${dashboard.state}`) : '';

  return (
    <div className={`proposal-card dashboard-card${compact ? ' dashboard-card--compact' : ''}`} role="group" aria-label={t('dashboard.label')}>
      <div className="dashboard-card-summary">
        {stateLabel && !compact && <span className={`dashboard-card-state dashboard-card-state-${dashboard.state}`}>{stateLabel}</span>}
        <span className="proposal-card-help">{t('dashboard.updated', { time: when })}</span>
      </div>
      <div className="proposal-card-actions">
        <button type="button" className="btn btn-primary" onClick={() => void onOpen()} aria-busy={view.kind === 'loading' || undefined}>
          {dashboard.kind === 'page' ? t('dashboard.openPage') : t('dashboard.open')}
        </button>
      </div>
      {!compact && <span className="proposal-card-help">{dashboard.kind === 'page' ? t('dashboard.pageHelp') : t('dashboard.tabHelp')}</span>}
      <div role="status" className="proposal-card-status">{error}</div>
    </div>
  );
}
