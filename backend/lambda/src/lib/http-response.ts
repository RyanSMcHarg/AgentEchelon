/**
 * The one HTTP response builder for API Gateway Lambda handlers: status, JSON body and CORS headers.
 *
 * Every handler answers through a `responder` built here, so the CORS headers a route sends are
 * declared once, as data, at the top of the handler rather than re-derived by a local `cors()` copy.
 * Routes do not all send the same headers, and this keeps each route's headers exactly as they are:
 *
 * - `origin.allow` echoes the request's `Origin` when it is on the list, else the fallback (the
 *   list's first entry). This is the dual-plane shape: the chat and admin consoles share an API.
 * - `origin.fixed` always sends one configured value, whatever the request said.
 * - `origin.fixed` with `callerPicked` sends the origin the handler passes, unchecked, and the fixed
 *   value when it passes none. The handler is the one that chose it from its own list.
 *
 * The error body is `{ error, code? }`, the envelope every handler already returns. The gateway's own
 * refusals (an authorizer 401, a throttle) carry API Gateway's `{ message }` body and never reach
 * this code.
 */

/** The local development console, the fallback when a stack sets no origin. */
export const DEV_ORIGIN = 'http://localhost:5173';

export type AllowOrigin =
  | {
      /** Origins the request's `Origin` is echoed for. */
      allow: readonly string[];
      /** Sent when the request's origin is not listed and the list is empty. */
      fallback?: string;
      /** A listed `*` allows every origin, and `*` is sent. */
      wildcard?: boolean;
    }
  | {
      /** The one origin sent. A function is read at response time. */
      fixed: string | (() => string);
      /** Send the origin the handler passes as-is, falling back to `fixed`. */
      callerPicked?: boolean;
    };

export interface ResponderOptions {
  origin: AllowOrigin;
  /** `Access-Control-Allow-Methods`. Omitted when unset. */
  methods?: string;
  /** `Access-Control-Allow-Headers`. Defaults to `Content-Type,Authorization`; `null` omits it. */
  allowHeaders?: string | null;
  /** Send `Vary: Origin`. Defaults to true for an `allow` list and false for a fixed origin. */
  vary?: boolean;
  /** Send `Content-Type: application/json`. Defaults to true. */
  json?: boolean;
}

/** An API Gateway proxy result whose headers are strings, assignable to `APIGatewayProxyResult`. */
export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface Responder {
  /** The `Access-Control-Allow-Origin` value for a request from `requestOrigin`. */
  allowOrigin(requestOrigin?: string): string;
  /** The response headers for a request from `requestOrigin`. */
  headers(requestOrigin?: string): Record<string, string>;
  /** A JSON response. */
  respond(statusCode: number, body: unknown, requestOrigin?: string): HttpResult;
  /** The `{ error, code? }` envelope. */
  error(statusCode: number, message: string, requestOrigin?: string, code?: string): HttpResult;
  /** A response with an empty body, for a preflight. */
  empty(statusCode: number, requestOrigin?: string): HttpResult;
}

/**
 * Parse a comma-separated origin list from the environment. `trim` trims each entry and `dropEmpty`
 * drops empty ones; each handler keeps the parsing it already had.
 */
export function originsFrom(
  raw: string | undefined,
  dflt: string,
  opts: { trim?: boolean; dropEmpty?: boolean } = {},
): string[] {
  let list = (raw || dflt).split(',');
  if (opts.trim) list = list.map((o) => o.trim());
  if (opts.dropEmpty) list = list.filter(Boolean);
  return list;
}

/** The request's `Origin` header, in either case API Gateway delivers it. */
export function requestOrigin(event: { headers?: Record<string, string | undefined> | null } | null | undefined): string | undefined {
  return event?.headers?.origin || event?.headers?.Origin || undefined;
}

/** The request's origin when it is on `allow`, else the list's first entry. */
export function pickOrigin(allow: readonly string[], origin?: string): string {
  return origin && allow.includes(origin) ? origin : allow[0];
}

export function responder(opts: ResponderOptions): Responder {
  const { origin } = opts;
  const allowHeaders = opts.allowHeaders === undefined ? 'Content-Type,Authorization' : opts.allowHeaders;
  const vary = opts.vary ?? 'allow' in origin;
  const json = opts.json ?? true;

  const allowOrigin = (requestOrigin?: string): string => {
    if ('allow' in origin) {
      if (origin.wildcard && origin.allow.includes('*')) return '*';
      const picked = pickOrigin(origin.allow, requestOrigin);
      return origin.fallback !== undefined ? picked || origin.fallback : picked;
    }
    if (origin.callerPicked && requestOrigin) return requestOrigin;
    return typeof origin.fixed === 'function' ? origin.fixed() : origin.fixed;
  };

  const headers = (requestOrigin?: string): Record<string, string> => {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    h['Access-Control-Allow-Origin'] = allowOrigin(requestOrigin);
    if (allowHeaders !== null) h['Access-Control-Allow-Headers'] = allowHeaders;
    if (opts.methods) h['Access-Control-Allow-Methods'] = opts.methods;
    if (vary) h.Vary = 'Origin';
    return h;
  };

  const respond = (statusCode: number, body: unknown, requestOrigin?: string): HttpResult => ({
    statusCode,
    headers: headers(requestOrigin),
    body: JSON.stringify(body),
  });

  return {
    allowOrigin,
    headers,
    respond,
    error: (statusCode, message, requestOrigin, code) =>
      respond(statusCode, code ? { error: message, code } : { error: message }, requestOrigin),
    empty: (statusCode, requestOrigin) => ({ statusCode, headers: headers(requestOrigin), body: '' }),
  };
}
