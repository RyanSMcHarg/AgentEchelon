/**
 * The Amazon Chime SDK clients a function builds under its own role, and the app-instance admin bearer
 * it reads from SSM.
 *
 * Two factories build Amazon Chime SDK clients, and each answers a different question:
 *
 * - `chimeMessaging` and `chimeIdentity` (here) build a client that sends as the function's own role.
 * - `sessionClient` (`lib/assistant-session.ts`) builds one that sends as the assistant session a
 *   turn adopted, which is what every conversation read and edit inside a turn uses.
 *
 * The config is passed through as given, so a caller keeps the region and request handler it chose.
 *
 * ── THE APP-INSTANCE ADMIN BEARER ───────────────────────────────────────────────────────────────
 *
 * The app-instance admin moderates every channel, so it is the `ChimeBearer` for a cleanup or an
 * audit that acts on channels the function's caller is not in. Its ARN is published to SSM at
 * `ADMIN_ARN_PARAM`. Callers differ in what a failed read means, and each states it:
 *
 * - `retry`: return '' and read again next time. The caller skips the work.
 * - `cache`: return '' and keep returning it for the container's life.
 * - `throw`: rethrow (or raise `errors.read`); an empty value returns '' or raises `errors.empty`.
 *
 * A read value is cached for the container's life: it changes only on a deploy of the Chime stack.
 * Creating a conversation bears a different identity, `resolveServiceAdminBearer`
 * (`lib/service-admin-bearer.ts`).
 */
import { ChimeSDKMessagingClient, type ChimeSDKMessagingClientConfig } from '@aws-sdk/client-chime-sdk-messaging';
import { ChimeSDKIdentityClient, type ChimeSDKIdentityClientConfig } from '@aws-sdk/client-chime-sdk-identity';
import { GetParameterCommand } from '@aws-sdk/client-ssm';

/** A messaging client that sends as the function's own role. */
export function chimeMessagingClient(config: ChimeSDKMessagingClientConfig = {}): ChimeSDKMessagingClient {
  return new ChimeSDKMessagingClient(config);
}

/** An identity client that sends as the function's own role. */
export function chimeIdentityClient(config: ChimeSDKIdentityClientConfig = {}): ChimeSDKIdentityClient {
  return new ChimeSDKIdentityClient(config);
}

type ParameterReader = { send: (cmd: GetParameterCommand) => Promise<{ Parameter?: { Value?: string } }> };

export interface AdminBearerOptions {
  ssm: ParameterReader;
  /** The parameter name: the function's `ADMIN_ARN_PARAM`. */
  param: string;
  /** What a failed read means for this caller. See the module comment. */
  onFailure: 'retry' | 'cache' | 'throw';
  /** For `throw`: the errors a failed read and an empty value raise. */
  errors?: { read: (err: Error) => Error; empty: () => Error };
  /** Called with a read error before `retry` or `cache` returns ''. */
  log?: (err: unknown) => void;
}

/** A reader of the app-instance admin's ARN, cached per container. */
export function appInstanceAdminBearer(opts: AdminBearerOptions): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    if (cached === '' && opts.onFailure === 'cache') return cached;
    let value: string;
    try {
      const res = await opts.ssm.send(new GetParameterCommand({ Name: opts.param }));
      value = res.Parameter?.Value || '';
    } catch (err) {
      if (opts.onFailure === 'throw') throw opts.errors ? opts.errors.read(err as Error) : err;
      opts.log?.(err);
      if (opts.onFailure === 'cache') cached = '';
      return '';
    }
    if (!value) {
      if (opts.onFailure === 'throw' && opts.errors) throw opts.errors.empty();
      if (opts.onFailure === 'cache') cached = '';
      return '';
    }
    cached = value;
    return cached;
  };
}
