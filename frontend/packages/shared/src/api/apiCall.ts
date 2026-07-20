/**
 * Shared fetch+Bearer(idToken)+JSON helper.
 *
 * Every admin/chat API service (analyticsService, adminConversationService,
 * experimentService, membershipAuditService, feedbackService, ...)
 * re-implemented the same fetch + `Authorization: Bearer <idToken>` + JSON
 * body + `body.error || 'Request failed: ' + status` pattern. This is the one
 * place that logic lives now.
 */

export type TokenProvider = () => string | null;

let tokenProvider: TokenProvider = () => localStorage.getItem('idToken');

/** Override where apiCall reads the bearer token from (defaults to localStorage.idToken). */
export function setApiTokenProvider(fn: TokenProvider): void {
  tokenProvider = fn;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApiCallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  token?: string | null;
  requireAuth?: boolean;
  headers?: Record<string, string>;
  mapError?: (status: number, bodyError?: string) => string | undefined;
  label?: string;
}

export async function apiCall<T = any>(
  baseUrl: string | undefined,
  path = '',
  opts: ApiCallOptions = {},
): Promise<T> {
  if (!baseUrl) throw new Error(`${opts.label ?? 'API'} URL not configured`);

  const requireAuth = opts.requireAuth ?? true;
  const token = opts.token !== undefined ? opts.token : tokenProvider();
  if (requireAuth && !token) throw new Error('Not authenticated');

  let url = `${baseUrl}${path}`;
  if (opts.query) {
    const qs = Object.entries(opts.query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

  if (!res.ok) {
    let be: string | undefined;
    try {
      be = (await res.clone().json())?.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, opts.mapError?.(res.status, be) ?? be ?? `${opts.label ?? 'Request'} failed: ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
