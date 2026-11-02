/**
 * Lightweight client-side event tracking service.
 *
 * Batches events and POSTs them to the AE `/events` ingestion Lambda
 * (Cognito-authed). Falls back to console.log in development when
 * either VITE_PERSON_API_URL or the auth token is unset.
 *
 * Auth model: the Cognito ID token is injected via `setAuthToken` from
 * AuthProvider whenever it refreshes. The /events endpoint accepts only a
 * signed-in caller, so what is recorded before sign-in (the sign-in and
 * sign-up form views, submits and failures, and the load timings) is HELD
 * in the tab, in sessionStorage so a reload or a redirect sign-in keeps it,
 * and sent the moment the person signs in. Sign-out sends what was recorded
 * under the outgoing sign-in first, so nothing is attributed to the next
 * person to sign in on the tab. A visit that never signs in sends nothing.
 *
 * Transport: `fetch` with `keepalive: true` so in-flight requests survive
 * a tab close in modern browsers. `sendBeacon` was the previous transport
 * but it cannot carry an `Authorization` header — incompatible with the
 * Cognito-authed endpoint, so it was dropped.
 */

import { personApiServes, personUrl } from '../platform/config';

interface TrackingEvent {
  name: string;
  properties: Record<string, string | number | boolean>;
  timestamp: string;
  sessionId: string;
}

/**
 * The performance metric names the backend accepts. Mirrors `VALID_PERF_METRICS` in
 * `backend/lambda/src/lib/client-event-types.ts`, which rejects any other name (a browser bundle
 * cannot import backend source, so this is a copy). `backend/test/client-perf-metrics-match-the-emitter.test.ts`
 * fails when the two disagree. A metric added here without the backend is dropped on arrival.
 */
export type PerfMetricName =
  | 'web_vital_lcp'
  | 'web_vital_inp'
  | 'web_vital_cls'
  | 'web_vital_fcp'
  | 'web_vital_ttfb'
  | 'message_round_trip_ms'
  | 'client_ttff_ms';

interface PerformanceEntry {
  metric: PerfMetricName;
  value: number;
  timestamp: string;
  sessionId: string;
  /** Correlating context, e.g. which turn this timing belongs to (G5). Omitted when there is none. */
  properties?: Record<string, string | number | boolean>;
}

type EventName =
  // Authentication funnel
  | 'signup_form_viewed'
  | 'signup_field_validation_error'
  | 'signup_submitted'
  | 'signup_confirmation_required'
  | 'signup_confirmation_completed'
  | 'signup_failed'
  | 'signin_form_viewed'
  | 'signin_submitted'
  | 'signin_succeeded'
  | 'signin_failed'
  | 'signin_password_reset_initiated'
  | 'login'
  | 'logout'
  // Session / connection health
  | 'session_started'
  | 'websocket_connected'
  | 'websocket_disconnected'
  | 'websocket_reconnected'
  // Usage
  | 'conversation_created'
  | 'message_sent'
  | 'message_received'
  | 'channel_messages_listed'
  | 'file_uploaded'
  | 'tab_switched'
  | 'admin_tab_viewed'
  // Admin actions (emitted by the admin console, adminChime.ts)
  | 'admin_message_redacted'
  | 'admin_message_deleted'
  | 'admin_member_added'
  | 'admin_member_removed'
  | 'admin_conversation_deleted'
  // Operational
  | 'error';

// --- Configuration ---

const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds
function readEndpoint(): string {
  try {
    return personApiServes('core') ? personUrl('/events') : '';
  } catch {
    return '';
  }
}
const ENDPOINT: string = readEndpoint();
const IS_DEV = typeof window !== 'undefined' && window.location?.hostname === 'localhost';

// --- Session ---

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

let sessionId: string;
try {
  sessionId = sessionStorage.getItem('_tracking_session') || generateSessionId();
  sessionStorage.setItem('_tracking_session', sessionId);
} catch {
  sessionId = generateSessionId();
}

// --- Event queue ---

const eventQueue: TrackingEvent[] = [];
const perfQueue: PerformanceEntry[] = [];

/**
 * THE HELD QUEUE: what was recorded while no one is signed in, kept in sessionStorage so it survives a
 * reload and the round trip of a redirect sign-in. Bounded, keeping the newest, so a tab left on the
 * sign-in form cannot grow it without limit.
 */
const HELD_KEY = '_tracking_held';
const MAX_HELD = 100;

function holdQueues(): void {
  if (eventQueue.length > MAX_HELD) eventQueue.splice(0, eventQueue.length - MAX_HELD);
  if (perfQueue.length > MAX_HELD) perfQueue.splice(0, perfQueue.length - MAX_HELD);
  try {
    if (eventQueue.length === 0 && perfQueue.length === 0) sessionStorage.removeItem(HELD_KEY);
    else sessionStorage.setItem(HELD_KEY, JSON.stringify({ events: eventQueue, performance: perfQueue }));
  } catch {
    // Storage unavailable: the queue is still held in memory for this page.
  }
}

function releaseHeld(): void {
  try {
    sessionStorage.removeItem(HELD_KEY);
  } catch {
    // Nothing was stored.
  }
}

function restoreHeld(): void {
  try {
    const raw = sessionStorage.getItem(HELD_KEY);
    if (!raw) return;
    const held = JSON.parse(raw) as { events?: unknown; performance?: unknown };
    if (Array.isArray(held.events)) eventQueue.push(...(held.events as TrackingEvent[]).slice(-MAX_HELD));
    if (Array.isArray(held.performance)) perfQueue.push(...(held.performance as PerformanceEntry[]).slice(-MAX_HELD));
  } catch {
    releaseHeld();
  }
}

restoreHeld();

// --- Auth token (injected by AuthProvider) ---

let authToken: string | null = null;

/**
 * Inject the Cognito ID token. Called from AuthProvider on login + on
 * every token refresh; called with `null` on logout.
 *
 * Signing in sends what was held before it. Signing out sends what was recorded under the outgoing
 * sign-in before the token is cleared, so it is never held over for the next person on the tab.
 */
export function setAuthToken(token: string | null): void {
  const signingIn = !authToken && !!token;
  if (!token && authToken) flushEvents();
  authToken = token;
  if (signingIn) flushEvents();
}

// --- Batching ---

let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushEvents();
  }, FLUSH_INTERVAL_MS);
}

function sendPayload(payload: unknown, token: string): void {
  const body = JSON.stringify(payload);
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body,
      keepalive: true,
    }).catch(() => {
      // Silently ignore delivery failures — tracking must never block the app
      // or surface noise to the user.
    });
  } catch {
    // Silently ignore
  }
}

// --- Timer map ---

const timers = new Map<PerfMetricName, number>();

/**
 * Start a named timer for measuring durations. The label is the metric it records, so it is one the
 * backend accepts.
 */
export function startTimer(label: PerfMetricName): void {
  try {
    timers.set(label, performance.now());
  } catch {
    // Ignore if performance API unavailable
  }
}

/**
 * End a named timer and record the duration as a performance metric.
 * Returns the elapsed milliseconds, or -1 if the timer was not found.
 */
export function endTimer(label: PerfMetricName): number {
  try {
    const start = timers.get(label);
    if (start === undefined) return -1;
    timers.delete(label);
    const elapsed = Math.round(performance.now() - start);
    trackPerformance(label, elapsed);
    return elapsed;
  } catch {
    return -1;
  }
}

// --- Public API ---

/**
 * Track a user action event.
 */
export function trackEvent(name: EventName | string, properties: Record<string, string | number | boolean> = {}): void {
  try {
    const event: TrackingEvent = {
      name,
      properties,
      timestamp: new Date().toISOString(),
      sessionId,
    };

    eventQueue.push(event);
    startFlushTimer();

    if (eventQueue.length >= BATCH_SIZE) {
      flushEvents();
    }
  } catch {
    // Tracking must never break the app
  }
}

/**
 * Track a performance metric (e.g., latency in ms).
 */
export function trackPerformance(
  metric: PerfMetricName,
  value: number,
  properties?: Record<string, string | number | boolean>,
): void {
  try {
    const entry: PerformanceEntry = {
      metric,
      value,
      timestamp: new Date().toISOString(),
      sessionId,
      // Only when there IS context. An empty object on every web-vital would put a key on every
      // record to say nothing, and the join below reads presence as meaning.
      ...(properties && Object.keys(properties).length > 0 ? { properties } : {}),
    };

    perfQueue.push(entry);
    startFlushTimer();

    if (perfQueue.length >= BATCH_SIZE) {
      flushEvents();
    }
  } catch {
    // Tracking must never break the app
  }
}

/**
 * Flush all queued events and performance entries to the backend.
 *
 * With no one signed in the queue is held rather than sent (see the held queue above), because the
 * endpoint refuses an anonymous caller and a payload sent anyway is a payload lost.
 */
export function flushEvents(): void {
  try {
    if (eventQueue.length === 0 && perfQueue.length === 0) return;

    if (!ENDPOINT) {
      const dropped = { events: eventQueue.splice(0), performance: perfQueue.splice(0) };
      if (IS_DEV) console.log('[analytics] no VITE_PERSON_API_URL configured —', dropped);
      return;
    }

    if (!authToken) {
      holdQueues();
      return;
    }

    const events = eventQueue.splice(0);
    const perf = perfQueue.splice(0);
    releaseHeld();
    sendPayload({ events, performance: perf }, authToken);
  } catch {
    // Silently ignore flush failures
  }
}

// --- Web Vitals (optional) ---

function captureWebVitals(): void {
  try {
    // Dynamic import to avoid hard dependency on web-vitals.
    // TTFB + FCP cover initial-load timing; LCP/INP/CLS cover post-load UX.
    import('web-vitals').then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
      onLCP((metric: { value: number }) => trackPerformance('web_vital_lcp', Math.round(metric.value)));
      onINP((metric: { value: number }) => trackPerformance('web_vital_inp', Math.round(metric.value)));
      onCLS((metric: { value: number }) => trackPerformance('web_vital_cls', Math.round(metric.value * 1000))); // CLS * 1000 for precision
      onFCP((metric: { value: number }) => trackPerformance('web_vital_fcp', Math.round(metric.value)));
      onTTFB((metric: { value: number }) => trackPerformance('web_vital_ttfb', Math.round(metric.value)));
    }).catch(() => {
      // web-vitals not installed, skip
    });
  } catch {
    // Ignore
  }
}

// --- Lifecycle ---

if (typeof window !== 'undefined') {
  // Flush on page hide / unload. keepalive: true on the fetch lets the
  // request survive the tab close; with no one signed in, the flush holds
  // the queue in sessionStorage instead.
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushEvents();
    }
  });

  window.addEventListener('pagehide', () => {
    flushEvents();
  });

  // Capture Web Vitals if available
  captureWebVitals();
}
