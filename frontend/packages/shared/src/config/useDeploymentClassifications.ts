/**
 * WHETHER THE SIGNED-IN APP HAS ASKED FOR THE DEPLOYMENT'S CLASSIFICATIONS YET.
 *
 * Once a person is signed in, the app loads the deployment's set from `GET /classifications`
 * (`loadDeploymentClassifications`) and renders its conversations, badges and pickers after that answers, so
 * every component reads the set the deployment runs rather than the one the build carried. The load runs once
 * per session; a failed load leaves the build's fallback installed and the app renders with it.
 */
import { useEffect, useRef, useState } from 'react';
import { loadDeploymentClassifications } from './classifications';

/** True once the signed-in load has answered (installed the set, or failed and kept the one installed). */
export function useDeploymentClassificationsReady(idToken: string | null | undefined): boolean {
  const [ready, setReady] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!idToken || started.current) return;
    started.current = true;
    void loadDeploymentClassifications(idToken).finally(() => setReady(true));
  }, [idToken]);
  return ready;
}
