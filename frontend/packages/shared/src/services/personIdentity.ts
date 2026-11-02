/**
 * WHO THE SIGNED-IN PERSON IS: the AppInstanceUser the credential exchange resolves their token to.
 *
 * The exchange mints each person an opaque id once per (issuer, subject), and that id is never the
 * token's `sub`. So the client does not read its identity off its token: an ARN built from `sub` names
 * an AppInstanceUser that does not exist, and does it without failing. The person's ARN, their id, and
 * whether they hold the `admins` console role all come from one chat-plane exchange answer.
 *
 * Resolved once per session and shared by every caller (the AuthProvider, the admin app's "add me"),
 * so a page asks the exchange once rather than once per reader. A sign-out advances the session epoch,
 * which both drops the cached answer and discards one still in flight.
 *
 * A `sign-in` INVITATION RIDES ON THIS FIRST EXCHANGE (`pendingInvitation.ts`, M-10). Presented here, a first
 * sign-in is bound to the invitee the invitation names, and the person lands in its conversation. A refusal
 * (an account that already exists, a used or withdrawn invitation) is recorded for the app to show, and the
 * exchange is asked again without it, so the person is still signed in as themselves.
 *
 * SO DOES A VISIT BEING KEPT BY PATH A (`pendingUpgrade.ts`): a first sign-in carrying the visit's refresh
 * credential is bound to the visitor, and the answer names the conversation the visit continues in.
 */
import { ExchangeRefusedError, exchangeCredentials, type ConsoleRole, type ExchangeAnswer } from './credentialExchange';
import { INVITATION_REFUSALS, recordInvitationOutcome, takePendingInvitation } from './pendingInvitation';
import { presentPendingBind } from './pendingUpgrade';
import { currentSessionEpoch } from './sessionEpoch';
import { personIdFromArn } from '../utils/principalArn';

export interface PersonIdentity {
  /** The person's AppInstanceUser ARN, exactly as the exchange returned it. */
  userArn: string;
  /** The AppInstanceUser id the ARN names. */
  personId: string;
  /** The console role the exchange reports for this person, or null when it reports none. */
  consoleRole: ConsoleRole | null;
}

/** The session ended while the exchange was being asked, so its answer was discarded. */
export class IdentitySupersededError extends Error {
  constructor() {
    super('the session ended while its identity was being resolved');
    this.name = 'IdentitySupersededError';
  }
}

let cached: { epoch: number; promise: Promise<PersonIdentity> } | null = null;

async function firstExchange(idToken: string): Promise<ExchangeAnswer> {
  const bound = await presentPendingBind(idToken);
  if (bound) return bound;
  const invitation = takePendingInvitation();
  if (!invitation) return exchangeCredentials({}, idToken);
  try {
    const answer = await exchangeCredentials({ invitation }, idToken);
    if (answer.invitationChannelArn) recordInvitationOutcome({ joined: answer.invitationChannelArn });
    return answer;
  } catch (err) {
    if (!(err instanceof ExchangeRefusedError) || !err.code || !INVITATION_REFUSALS.has(err.code)) throw err;
    recordInvitationOutcome(err.code === 'wrong_account' ? { refused: err.code, retryToken: invitation } : { refused: err.code });
    return exchangeCredentials({}, idToken);
  }
}

async function ask(idToken: string, epoch: number): Promise<PersonIdentity> {
  const answer = await firstExchange(idToken);
  if (epoch !== currentSessionEpoch()) throw new IdentitySupersededError();
  const personId = personIdFromArn(answer.userArn);
  if (!personId) throw new Error('The credential exchange returned no person ARN');
  return { userArn: answer.userArn, personId, consoleRole: answer.consoleRole ?? null };
}

/**
 * The signed-in person's identity, asked of the exchange once per session. A failed ask is not
 * cached, so the next caller asks again.
 */
export function resolvePersonIdentity(idToken: string): Promise<PersonIdentity> {
  const epoch = currentSessionEpoch();
  if (cached && cached.epoch === epoch) return cached.promise;
  const promise = ask(idToken, epoch);
  cached = { epoch, promise };
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}
