/**
 * WHAT THE SIGNED-IN OPERATOR HOLDS (SPEC-ADMIN-CONSOLE FR0e, FR0f, FR36, FR44).
 *
 * The console opens on the capability set of the person's console session, not on a group name: the
 * exchange answers a console-session request with the role the person's groups name and the
 * capabilities that role holds, and a person who holds none is refused there. Every section and every
 * control the console renders is decided from this set, so a refusal is the absence of a control rather
 * than a 403 after the click.
 *
 * NOT AN ENFORCEMENT LAYER. IAM refuses a capability the session does not hold whatever this renders;
 * this presents a decision IAM already makes (FR0a).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ae/shared';
import { consoleSession, resetSignOnCredentials } from './services/sigv4Fetch';
import { setTeamAssistant, teamAssistant } from './services/teamScope';

export type ConsoleAccess =
  /** No provider is mounted - a component rendered on its own, as in a unit test. Renders everything. */
  | { status: 'unscoped' }
  | { status: 'loading' }
  /** `code` is the exchange's reason, e.g. `NO_TEAM` for a team member in no `team-<name>` group. */
  | { status: 'denied'; message: string; code?: string }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      role: 'admins' | 'team-members';
      capabilities: ReadonlySet<string>;
      /**
       * A team member's assistants, the first of which the console opens scoped to. Empty for an admin,
       * and for a team that owns none yet, whose console opens on Assistants alone so it can create one.
       */
      assistants: readonly string[];
      /** A team member's teams: the only teams they create assistants for or assign them to. Empty for an admin. */
      teams: readonly string[];
      /** A team member's owning team for each of `assistants`, when the exchange reported it. */
      owners: Readonly<Record<string, string>>;
      /**
       * Which of `capabilities` the session does not carry and the exchange vends on request, one
       * conversation at a time with a stated reason, and how long one such credential lasts. Read from the
       * exchange, which reads the catalog's `enforcement`; null when the exchange did not report it.
       */
      onRequest: { capabilities: ReadonlySet<string>; ttlSeconds: number } | null;
    };

// UNSCOPED WITHOUT A PROVIDER. The app always mounts `CapabilityProvider`; a component rendered on its
// own (a unit test of one tab) has no session to read, and renders as it did before capabilities existed.
const AccessContext = createContext<ConsoleAccess>({ status: 'unscoped' });

/**
 * RE-ISSUE THE CONSOLE SESSION, for a change the session names at issue time.
 *
 * A team member's session policy lists the assistants their team owned when it was issued
 * (`teamSessionPolicy`), so an assistant they create is outside it until a new session is issued. Rather
 * than ask them to sign out, the console asks the exchange again and swaps credentials in place, without
 * the loading screen. Resolves true when the new session was taken; false when the exchange refused or
 * failed, in which case the previous session stays. A no-op outside a provider.
 */
const ReissueContext = createContext<() => Promise<boolean>>(async () => false);

type ConsoleSessionAnswer = Awaited<ReturnType<typeof consoleSession>>;

/** What the console shows for a session. `keepScope` keeps the team assistant already chosen when it is still owned. */
function accessOf(s: ConsoleSessionAnswer, keepScope = false): ConsoleAccess {
  // A session holding nothing is a refusal stated once, not a console rendered with every section
  // missing (FR53). A team member whose team owns no assistant yet is not refused: their console
  // opens on Assistants, where they create one for their team.
  const assistants = s.role === 'team-members' ? s.assistants ?? [] : [];
  const teams = s.role === 'team-members' ? s.teams ?? [] : [];
  // A TEAM MEMBER IS ALWAYS SCOPED TO ONE OF THEIR ASSISTANTS when they own one, set before anything
  // renders so no request goes out on an unscoped route the session cannot reach.
  const current = teamAssistant();
  setTeamAssistant(keepScope && current && assistants.includes(current) ? current : assistants[0] ?? null);
  return s.capabilities.length === 0 || (s.role === 'team-members' && assistants.length === 0 && teams.length === 0)
    ? { status: 'denied', message: '', ...(s.role === 'team-members' ? { code: 'NO_TEAM' } : {}) }
    : {
      status: 'ready', role: s.role, capabilities: new Set(s.capabilities), assistants, teams, owners: s.owners ?? {},
      onRequest: s.onRequest ? { capabilities: new Set(s.onRequest.capabilities), ttlSeconds: s.onRequest.ttlSeconds } : null,
    };
}

export function CapabilityProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isAuthenticated, user } = useAuth();
  const [access, setAccess] = useState<ConsoleAccess>({ status: 'loading' });

  const reissue = useCallback(async (): Promise<boolean> => {
    resetSignOnCredentials();
    try {
      setAccess(accessOf(await consoleSession(), true));
      return true;
    } catch {
      // The previous session's credentials were dropped with the cache, and the next signed call asks the
      // exchange again, so a failed re-issue costs a retry rather than the console.
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      resetSignOnCredentials();
      setTeamAssistant(null);
      setAccess({ status: 'loading' });
      return;
    }
    let cancelled = false;
    setAccess({ status: 'loading' });
    consoleSession()
      .then((s) => {
        if (cancelled) return;
        setAccess(accessOf(s));
      })
      .catch((err: { status?: number; message?: string; body?: { code?: string } }) => {
        if (cancelled) return;
        setAccess(err?.status === 403 || err?.body?.code === 'TEAM_SCOPE_TOO_LARGE'
          ? { status: 'denied', message: err.message || '', code: err.body?.code }
          : { status: 'error', message: err?.message || String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.email]);

  return (
    <ReissueContext.Provider value={reissue}>
      <AccessContext.Provider value={access}>{children}</AccessContext.Provider>
    </ReissueContext.Provider>
  );
}

/** Ask for a new console session and swap it in place (see `ReissueContext`). */
export function useReissueSession(): () => Promise<boolean> {
  return useContext(ReissueContext);
}

export function useConsoleAccess(): ConsoleAccess {
  return useContext(AccessContext);
}

/** Whether the signed-in operator holds a capability. False until the session has loaded. */
export function useCan(): (capability: string) => boolean {
  const access = useConsoleAccess();
  if (access.status === 'unscoped') return () => true;
  const held = access.status === 'ready' ? access.capabilities : new Set<string>();
  return (capability: string) => held.has(capability);
}

/**
 * A capability set for a test or a story, so a component renders as a given role would see it without
 * a console session.
 */
export function CapabilityTestProvider({
  capabilities,
  role = 'admins',
  assistants,
  teams,
  owners,
  onRequest,
  reissue,
  children,
}: {
  capabilities: string[];
  role?: 'admins' | 'team-members';
  /** A team member's owned assistants and teams, as the exchange reports them. */
  assistants?: string[];
  teams?: string[];
  owners?: Record<string, string>;
  /** The subset vended on request and how long one vend lasts, as the exchange reports them. */
  onRequest?: { capabilities: string[]; ttlSeconds: number };
  /** What re-issuing the session does in the test; a no-op answering false when absent. */
  reissue?: () => Promise<boolean>;
  children: React.ReactNode;
}): React.ReactElement {
  const value = useMemo<ConsoleAccess>(() => ({
    status: 'ready', role, capabilities: new Set(capabilities), assistants: assistants ?? [], teams: teams ?? [], owners: owners ?? {},
    onRequest: onRequest ? { capabilities: new Set(onRequest.capabilities), ttlSeconds: onRequest.ttlSeconds } : null,
  }), [capabilities, role, assistants, teams, owners, onRequest]);
  const content = <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
  return reissue ? <ReissueContext.Provider value={reissue}>{content}</ReissueContext.Provider> : content;
}
