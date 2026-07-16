/** Generation-out image models (mirrors backend
 *  image-gen-models.ts ImageGenModelKey — kept a local union per the
 *  frontend's self-contained-types convention, like MODEL_OPTIONS). */
export type ImageGenModelKey = 'titan_image' | 'nova_canvas';

export interface ExperimentVariant {
  variantId: string;
  modelKey: string;
  weight: number;
  /** v0.2.0 (/battle): per-variant display name shown to users + in rival prompts. Max 16 chars. */
  displayName?: string;
  /** v0.2.0 (/battle): variant-specific addendum layered onto the tier's base system prompt. Sanitized server-side. Max 500 chars. */
  systemPromptAddendum?: string;
  /** /battle generation-out: when set, this variant generates
   *  an IMAGE with this model instead of replying with text. A battle is
   *  generation-out iff BOTH variants set it (server-validated
   *  both-or-neither). */
  imageGenModelKey?: ImageGenModelKey;
}

/** Experiment type. Absent ⇒ 'intent' (the default). */
export type ExperimentType = 'intent' | 'base_model' | 'classification';

/** Advisory objective target. */
export type ExperimentObjectiveMetric = 'cost' | 'accuracy' | 'quality' | 'latency';
export interface ExperimentObjective {
  metric: ExperimentObjectiveMetric;
  /** Percentage in [0, 100]: a decrease for cost/latency, a target level for accuracy/quality. */
  target: number;
}

export interface Experiment {
  experimentId: string;
  status: 'active' | 'paused' | 'completed';
  /** Defaults to 'intent' when absent. */
  experimentType?: ExperimentType;
  intent: string;
  tiers: string[];
  variants: ExperimentVariant[];
  startDate: string;
  endDate?: string;
  createdAt: string;
  description?: string;
  /** Advisory; never auto-acts. */
  objective?: ExperimentObjective;
  /** v0.2.0 (/battle): when true, this experiment powers /battle. Requires exactly 2 variants + displayName on each + altBotSlotId. */
  battleEnabled?: boolean;
  altBotSlotId?: string;
  altBotSlotArn?: string;
  boundBy?: string;
  boundAt?: string;
}

function getApiUrl(): string {
  // Dedicated endpoint (CDK output AgentEchelonExperiments.ExperimentsApiUrl).
  // It lives on the experiments API, NOT the admin-conversations API:
  // the experiments table is owned by the AgentEchelonExperiments stack, which is
  // downstream of the cognito-auth stack that hosts admin-conversations,
  // so the API must be co-located with its table (no stack cycle).
  const url = import.meta.env.VITE_EXPERIMENTS_API_URL;
  if (!url) throw new Error('VITE_EXPERIMENTS_API_URL not configured');
  return url; // already .../admin/experiments
}

function getIdToken(): string {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  return idToken;
}

async function apiCall(path = '', init: RequestInit = {}) {
  const idToken = getIdToken();

  const response = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

export async function listExperiments(): Promise<Experiment[]> {
  const result = await apiCall();
  return result.experiments || [];
}

export async function createExperiment(experiment: Omit<Experiment, 'createdAt'>): Promise<Experiment> {
  const result = await apiCall('', {
    method: 'POST',
    body: JSON.stringify(experiment),
  });
  return result;
}

export async function updateExperimentStatus(experimentId: string, status: Experiment['status']): Promise<void> {
  await apiCall(`/${experimentId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}
