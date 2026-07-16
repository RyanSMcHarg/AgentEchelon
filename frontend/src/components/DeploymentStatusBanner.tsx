import { useEffect, useState } from 'react';
import './DeploymentStatusBanner.css';

type DeploymentState = 'awake' | 'asleep';

interface StateResponse {
  state: DeploymentState;
  changedAt: number | null;
}

/**
 * Cost sleep mode (docs/SPEC-COST-SLEEP-MODE.md): when the deployment has
 * auto-paused its Aurora data plane after inactivity, show a clean "paused"
 * banner instead of letting users hit raw DB timeouts. Polls the public
 * `GET {analyticsApi}/deployment/state` endpoint.
 *
 * Only probes when sleep mode is actually deployed (VITE_SLEEP_MODE_ENABLED). When
 * it is off, that route does not exist, so polling it would 403 on every tick — we
 * skip entirely. Also inert in Athena mode (no analytics API) or on any request
 * failure. Never blocks the app.
 */
export default function DeploymentStatusBanner() {
  const [asleep, setAsleep] = useState(false);
  const base = import.meta.env.VITE_ANALYTICS_API_URL as string | undefined;
  const sleepModeEnabled = import.meta.env.VITE_SLEEP_MODE_ENABLED === 'true';

  useEffect(() => {
    if (!base || !sleepModeEnabled) return;
    let cancelled = false;
    const url = `${base.replace(/\/$/, '')}/deployment/state`;

    const poll = async () => {
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
      }
    };

    void poll();
    const id = window.setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [base, sleepModeEnabled]);

  if (!asleep) return null;

  return (
    <div className="deployment-paused-banner" role="status" aria-live="polite">
      <span className="deployment-paused-dot" aria-hidden="true" />
      This deployment is paused to save cost after a period of inactivity. An administrator can
      wake it, or it will resume shortly after activity returns.
    </div>
  );
}
