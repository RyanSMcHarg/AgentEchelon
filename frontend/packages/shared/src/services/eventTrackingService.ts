/**
 * Lightweight client-side event tracking service.
 *
 * Batches events and POSTs them to the AE `/events` ingestion Lambda
 * (Cognito-authed). Falls back to console.log in development when
 * either VITE_CLIENT_EVENTS_API_URL or the auth token is unset.
 *
 * Auth model: the Cognito ID token is injected via `setAuthToken` from
 * AuthProvider whenever it refreshes. Without a token, payloads are
 * dropped (with a one-time console warn in dev) rather than emitted
 * unauthenticated — the /events endpoint rejects unauthed requests anyway.
 *
 * Transport: `fetch` with `keepalive: true` so in-flight requests survive
 * a tab close in modern browsers. `sendBeacon` was the previous transport
 * but it cannot carry an `Authorization` header — incompatible with the
 * Cognito-authed endpoint, so it was dropped.
 */

interface TrackingEvent {
  name: string;
  properties: Record<string, string | number | boolean>;
  timestamp: string;
  sessionId: string;
}

interface PerformanceEntry {
  metric: string;
  value: number;
  timestamp: string;
  sessionId: string;
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
  // Operational
  | 'error';

// --- Configuration ---

const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds
function readEndpoint(): string {
  try {
    return import.meta.env?.VITE_CLIENT_EVENTS_API_URL || '';
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

// --- Auth token (injected by AuthProvider) ---

let authToken: string | null = null;
let warnedAboutMissingToken = false;

/**
 * Inject the Cognito ID token. Called from AuthProvider on login + on
 * every token refresh; called with `null` on logout.
 */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

// --- Event queue ---

const eventQueue: TrackingEvent[] = [];
const perfQueue: PerformanceEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushEvents();
  }, FLUSH_INTERVAL_MS);
}

function sendPayload(payload: unknown): void {
  const body = JSON.stringify(payload);

  if (!ENDPOINT) {
    if (IS_DEV) {
      console.log('[analytics] no VITE_CLIENT_EVENTS_API_URL configured —', payload);
    }
    return;
  }

  if (!authToken) {
    if (IS_DEV && !warnedAboutMissingToken) {
      console.warn('[analytics] dropping payload: no auth token set (AuthProvider has not called setAuthToken yet)');
      warnedAboutMissingToken = true;
    }
    return;
  }

  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authToken,
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

const timers = new Map<string, number>();

/**
 * Start a named timer for measuring durations.
 */
export function startTimer(label: string): void {
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
export function endTimer(label: string): number {
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
export function trackPerformance(metric: string, value: number): void {
  try {
    const entry: PerformanceEntry = {
      metric,
      value,
      timestamp: new Date().toISOString(),
      sessionId,
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
 */
export function flushEvents(): void {
  try {
    const events = eventQueue.splice(0);
    const perf = perfQueue.splice(0);

    if (events.length === 0 && perf.length === 0) return;

    sendPayload({ events, performance: perf });
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
  // request survive the tab close.
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
