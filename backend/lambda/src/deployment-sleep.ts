/**
 * Cost sleep mode — the checker + admin API in one Lambda.
 *
 * Two entrypoints, routed on event shape:
 *  - EventBridge scheduled event  → idle check → auto-sleep when idle.
 *  - API Gateway (REST) event      → GET /deployment/state (public),
 *                                     POST /admin/deployment/{sleep,wake} (admin).
 *
 * Design: docs/SPEC-COST-SLEEP-MODE.md. The pure decision logic lives in
 * lib/sleep-mode.ts; this file is the orchestration + HTTP surface.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { callerIsAdmin } from './lib/auth.js';
import {
  getDeploymentState,
  setDeploymentState,
  setAuroraMinCapacity,
  parseIdleThresholdMs,
  shouldSleep,
  notify,
  DeploymentState,
} from './lib/sleep-mode.js';

const DEFAULT_IDLE_MS = 2 * 3_600_000; // 2h fallback
const WAKE_MIN_ACU = Number(process.env.AURORA_WAKE_MIN_ACU || '0.5');
const now = () => Date.now();

function idleThresholdMs(): number {
  return parseIdleThresholdMs(process.env.SLEEP_AFTER_IDLE) ?? DEFAULT_IDLE_MS;
}

/** Transition to a target state, driving Aurora first so we never flip the flag
 *  while the DB is still in the wrong capacity. Idempotent. */
async function transition(target: DeploymentState, changedBy: string): Promise<{ changed: boolean; state: DeploymentState }> {
  const record = await getDeploymentState();
  const current = record?.state ?? 'awake';
  if (current === target) return { changed: false, state: current };

  // Drive Aurora capacity first; on failure, do NOT flip state.
  await setAuroraMinCapacity(target === 'asleep' ? 0 : WAKE_MIN_ACU);
  await setDeploymentState(target, changedBy, now());

  const verb = target === 'asleep' ? 'asleep (Aurora paused → 0 ACU)' : 'awake (Aurora restored)';
  await notify(
    `Deployment ${target}`,
    `The deployment is now ${verb}. Changed by: ${changedBy} at ${new Date(now()).toISOString()}.`,
  );
  return { changed: true, state: target };
}

// --- EventBridge idle checker ---------------------------------------------

async function runIdleCheck(): Promise<void> {
  const record = await getDeploymentState();
  if (!record) {
    console.log('[sleep] no state record yet — nothing to check');
    return;
  }
  const threshold = idleThresholdMs();
  if (!shouldSleep(record, threshold, now())) {
    console.log(`[sleep] not idle enough (state=${record.state}, idleMs=${now() - record.lastActivityAt}, thresholdMs=${threshold})`);
    return;
  }
  console.log(`[sleep] idle > ${threshold}ms → sleeping`);
  try {
    await transition('asleep', 'auto-idle');
  } catch (err) {
    console.error('[sleep] auto-sleep failed; state left awake', err);
    await notify('Deployment auto-sleep FAILED', `Auto-sleep failed; deployment left awake. Error: ${String(err)}`).catch(() => {});
    throw err;
  }
}

// --- HTTP API --------------------------------------------------------------

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGINS || '*',
    },
    body: JSON.stringify(body),
  };
}

function adminSub(event: APIGatewayProxyEvent): string {
  const claims = (event.requestContext as any)?.authorizer?.claims;
  return claims?.sub || claims?.['cognito:username'] || 'admin';
}

async function handleHttp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.resource || event.path || '';

  if (method === 'OPTIONS') return json(200, {});

  // Public read: the SPA renders a "paused" banner from this.
  if (method === 'GET' && path.endsWith('/deployment/state')) {
    const record = await getDeploymentState();
    return json(200, {
      state: record?.state ?? 'awake',
      lastActivityAt: record?.lastActivityAt ?? null,
      changedAt: record?.changedAt ?? null,
    });
  }

  // Admin actions. The API Gateway authorizer only proves a valid pool JWT in
  // the default ae-cognito mode (it does NOT check group membership), so the
  // handler MUST gate on the admins group itself — matching every other admin
  // handler (user-management, admin-conversations, analytics-query). Without
  // this, any authenticated user could pause/resume the Aurora data plane.
  if (method === 'POST' && (path.endsWith('/deployment/sleep') || path.endsWith('/deployment/wake'))) {
    if (!callerIsAdmin(event)) {
      return json(403, { error: 'Admin access required' });
    }
    const target = path.endsWith('/deployment/sleep') ? 'asleep' : 'awake';
    const r = await transition(target, `admin:${adminSub(event)}`);
    return json(200, { ok: true, ...r });
  }

  return json(404, { error: 'not found' });
}

// --- Entry -----------------------------------------------------------------

export const handler = async (event: any): Promise<APIGatewayProxyResult | void> => {
  // API Gateway REST events carry httpMethod; EventBridge scheduled events do not.
  if (event && typeof event.httpMethod === 'string') {
    try {
      return await handleHttp(event as APIGatewayProxyEvent);
    } catch (err) {
      console.error('[sleep] http handler error', err);
      return json(500, { error: 'internal error' });
    }
  }
  await runIdleCheck();
};
