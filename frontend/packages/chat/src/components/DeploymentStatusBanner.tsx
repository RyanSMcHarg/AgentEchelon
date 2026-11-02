import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { personApiServes, personUrl } from '@ae/shared';
import './DeploymentStatusBanner.css';

type DeploymentState = 'awake' | 'asleep';

interface StateResponse {
  state: DeploymentState;
  changedAt: number | null;
}

/**
 * Cost sleep mode (docs/SPEC-COST-SLEEP-MODE.md): when the deployment has
 * auto-paused its Aurora data plane after inactivity, show a clean "paused"
 * banner instead of letting users hit raw DB timeouts. Reads the public
 * `GET /deployment/state` route on the person API (VITE_PERSON_API_URL).
 *
 * READ ON ARRIVAL, NOT ON A TIMER (tenet D6). No event reaches the client when the
 * state changes: the change is a scheduled idle check or an operator's action on the
 * server, announced only to operators. So the banner reads the state when the app
 * loads and whenever a person comes back to it (the tab becomes visible, the window
 * takes focus, the network returns). That is the only moment the answer can matter:
 * the deployment sleeps only after nobody has used it for the idle window, so a
 * person reading the page is either arriving (load) or returning to a tab left open
 * (visibility, focus). A minute's timer read the route in every open tab whether or
 * not anybody was looking at it.
 *
 * Only reads when sleep mode is actually deployed (VITE_SLEEP_MODE_ENABLED). When
 * it is off, that route does not exist, so a read would take a 403 - we skip
 * entirely. Also inert without a person API or on any request failure. Never
 * blocks the app.
 */
export default function DeploymentStatusBanner() {
  const { t } = useTranslation();
  const [asleep, setAsleep] = useState(false);
  const served = personApiServes('core');
  const sleepModeEnabled = import.meta.env.VITE_SLEEP_MODE_ENABLED === 'true';

  useEffect(() => {
    if (!served || !sleepModeEnabled) return;
    let cancelled = false;
    const url = personUrl('/deployment/state');

    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) {
          // 404/403 ⇒ sleep mode not deployed here; stop showing anything.
          if (!cancelled) setAsleep(false);
          return;
        }
        const data = (await res.json()) as StateResponse;
        if (!cancelled) setAsleep(data.state === 'asleep');
      } catch {
        if (!cancelled) setAsleep(false);
      } finally {
        inFlight = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    const onReturn = () => { void read(); };

    void read();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
    };
  }, [served, sleepModeEnabled]);

  if (!asleep) return null;

  return (
    <div className="deployment-paused-banner" role="status" aria-live="polite">
      <span className="deployment-paused-dot" aria-hidden="true" />
      {t('deployment.paused')}
    </div>
  );
}
