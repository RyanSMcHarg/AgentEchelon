/**
 * WHAT THE ADMIN CONSOLE ASKS OFFBOARDING TO DO: delete a person, re-admit a subject, or export what is
 * kept about one (ADR-058). A disable or an enable is the pool's administration alone: the exchange asks
 * the pool at every vend, so nothing here follows it (SPEC-CREDENTIAL-EXCHANGE §4b).
 *
 * Offboarding is identity, not administration (D9), so it runs in the `Identity` stack's one
 * `OffboardingFunction`, on the one role that holds its grants. The console's user-management handler, in
 * the `AdminServices` stack, invokes that function with one of these requests and relays the answer, so a
 * console delete and an issuer's lifecycle event run the same code (`lib/offboarding.ts`) on the same
 * role, and the admin backend holds no erasure grant of its own.
 */
import { personIdFromArn, appInstanceArnOf, adminTwinOwnerId } from './person-arn.js';
import { issuerIdOf } from './trusted-issuers.js';
import {
  OffboardingIncomplete,
  defaultOffboardingDeps,
  offboardPerson,
  offboardPoolAccount,
  readmitSubject,
  revokedPoolIssuer,
  rowOfPoolSubject,
  type OffboardingActor,
  type OffboardingDeps,
} from './offboarding.js';
import { exportPerson } from './person-export.js';

export type ConsoleOffboardingRequest =
  /** `personArn` offboards that AppInstanceUser; `username` names an account of this deployment's pool. */
  | { console: 'delete'; personArn?: string; username?: string; actor: OffboardingActor }
  /** `username` names a subject of this deployment's pool; `issuer` and `subject` name any other. */
  | { console: 'readmit'; username?: string; issuer?: string; subject?: string; actor: OffboardingActor }

  /** Export everything kept about one AppInstanceUser, from the inventory erasure walks (B13). */
  | { console: 'export'; personArn: string; actor: OffboardingActor };

/** The console route's answer: its status and body. */
export interface ConsoleOffboardingAnswer {
  status: number;
  body: unknown;
}

export function isConsoleOffboardingRequest(event: unknown): event is ConsoleOffboardingRequest {
  const e = event as { console?: unknown; actor?: { arn?: unknown } } | null;
  return !!e && (e.console === 'delete' || e.console === 'readmit' || e.console === 'export')
    && typeof e.actor?.arn === 'string';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * OFFBOARD. `personArn` offboards that AppInstanceUser, whichever issuer signs them in. `username` names
 * an account of this deployment's pool: the person it signs in as is offboarded, or, for an account that
 * never signed in, the account alone is removed. Nothing to remove is 404, never 200.
 */
async function deleteRoute(req: Extract<ConsoleOffboardingRequest, { console: 'delete' }>, deps: OffboardingDeps): Promise<ConsoleOffboardingAnswer> {
  try {
    let result;
    const personArn = str(req.personArn);
    const username = str(req.username);
    if (personArn) {
      const id = personIdFromArn(personArn);
      if (!id || appInstanceArnOf(personArn) !== deps.appInstanceArn || adminTwinOwnerId(id)) {
        return { status: 400, body: { error: 'personArn must name a person of this app instance', code: 'NOT_A_PERSON' } };
      }
      result = await offboardPerson(personArn, req.actor, deps);
    } else if (username) {
      const record = await deps.primary.record(username);
      if (!record) return { status: 404, body: { error: 'Nobody to offboard', code: 'NOT_FOUND' } };
      const row = await rowOfPoolSubject(deps.primary, record.subject, deps);
      result = row ? await offboardPerson(row.personArn, req.actor, deps) : await offboardPoolAccount(record.username, req.actor, deps);
    } else {
      return { status: 400, body: { error: 'personArn or username is required' } };
    }
    if (!result.found) return { status: 404, body: { error: 'Nobody to offboard', code: 'NOT_FOUND' } };
    return { status: 200, body: { removed: result.removed, kept: result.kept, archived: result.archived } };
  } catch (err) {
    if (err instanceof OffboardingIncomplete) {
      return { status: 503, body: { error: 'The person was not offboarded; their identity is unchanged. Retry.', code: err.code, step: err.step } };
    }
    throw err;
  }
}

/**
 * RE-ADMIT. The issuer is named by its trusted-issuer registry id or its `iss`. An issuer the registry
 * does not declare has no row to re-admit.
 */
async function readmitRoute(req: Extract<ConsoleOffboardingRequest, { console: 'readmit' }>, deps: OffboardingDeps): Promise<ConsoleOffboardingAnswer> {
  let issuer = '';
  let subject = '';
  const username = str(req.username);
  if (username) {
    const record = await deps.primary.record(username);
    if (!record) return { status: 404, body: { error: 'No such account', code: 'NOT_FOUND' } };
    // A federated person's revoked marker is under their own entry's id, not the pool's.
    issuer = (await revokedPoolIssuer(deps.primary, record.subject, deps)) ?? deps.primary.issuer;
    subject = record.subject;
  } else if (str(req.issuer) && str(req.subject)) {
    issuer = issuerIdOf(str(req.issuer)) ?? '';
    subject = str(req.subject);
    if (!issuer) return { status: 404, body: { error: 'The issuer is not one this deployment trusts', code: 'ISSUER_NOT_TRUSTED' } };
  } else {
    return { status: 400, body: { error: 'username, or issuer and subject, is required' } };
  }
  if (!(await readmitSubject(issuer, subject, req.actor, deps))) return { status: 404, body: { error: 'Not offboarded', code: 'NOT_REVOKED' } };
  return { status: 200, body: { readmitted: true } };
}


/**
 * EXPORT (B13). The archive of one AppInstanceUser, read from the same inventory an erasure walks, or 404 when
 * the platform keeps nothing about them. Read only: nothing is changed, and the export is recorded once.
 */
async function exportRoute(req: Extract<ConsoleOffboardingRequest, { console: 'export' }>, deps: OffboardingDeps): Promise<ConsoleOffboardingAnswer> {
  const personArn = str(req.personArn);
  const id = personIdFromArn(personArn);
  if (!id || appInstanceArnOf(personArn) !== deps.appInstanceArn || adminTwinOwnerId(id)) {
    return { status: 400, body: { error: 'personArn must name a person of this app instance', code: 'NOT_A_PERSON' } };
  }
  const { found, archive } = await exportPerson(personArn, req.actor, deps);
  if (!found) return { status: 404, body: { error: 'Nothing is kept about this person', code: 'NOT_FOUND' } };
  return { status: 200, body: archive };
}

export async function consoleOffboarding(req: ConsoleOffboardingRequest, deps: OffboardingDeps = defaultOffboardingDeps()): Promise<ConsoleOffboardingAnswer> {
  if (req.console === 'delete') return deleteRoute(req, deps);
  if (req.console === 'export') return exportRoute(req, deps);
  return readmitRoute(req, deps);
}
