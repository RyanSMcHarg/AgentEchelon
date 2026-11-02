/**
 * THE IDENTITY THAT CREATES A CONVERSATION, resolved once per container.
 *
 * WHY A CONVERSATION IS NOT CREATED BY AN ASSISTANT. Amazon Chime SDK adds the `CreateChannel` bearer
 * as a member the instant the channel exists, and `CreateChannel` takes no channel-flow field - its
 * input is AppInstanceArn, Name, Mode, Privacy, Metadata, ClientRequestToken, Tags, ChimeBearer,
 * ChannelId, MemberArns, ModeratorArns, ElasticChannelConfiguration, ExpirationSettings. So the flow can
 * only be attached by a second call, and for that whole round trip the bearer is a member who can be
 * sent `WelcomeIntent`. With an assistant as bearer its welcome always bypassed the flow: measured
 * 2026-08-06 on the primary creation path (welcome delivered, zero flow invocations) and again
 * 2026-10-03 in a room holding two assistants, where the flow unwrapped the Lex envelope for the
 * assistant added AFTER the association and never saw the bearer's.
 *
 * Reordering cannot fix it - both creation paths already associate the flow as the first thing after
 * creation - because the leak is the bearer's IMPLICIT membership rather than a membership the code
 * adds. So the service admin creates, every assistant is added afterwards, and the admin then leaves.
 *
 * ── ONE RESOLVER FOR EVERY CREATION PATH ────────────────────────────────────────────────────────
 *
 * Three callers create conversations - the event creator, the conversation split, and the live-drift
 * confirm inside the router - and a copy of this in each is three chances for one of them to keep
 * creating as the assistant after the others stopped. The parameter NAME arrives in the environment and
 * the value is read at runtime, which is the same shape `BOT_ARN_PARAM` already uses on these paths, so
 * no stack needs the admin ARN as a prop.
 *
 * ── UNSET OR UNREADABLE REFUSES THE CREATION ────────────────────────────────────────────────────
 *
 * It returns empty, and the creation path refuses the conversation rather than creating it as an
 * assistant (`NoServiceAdminError` in `channel-creation.ts`). No creator's
 * role holds a create, a tag or a membership change bearing an assistant, so there is nothing to fall
 * back to. An unset parameter is logged once per container, and a failed read on each attempt, so an
 * operator can tell a deployment that has not configured it from one where the read is failing.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';

const PARAM = process.env.CREATOR_BEARER_ARN_PARAM || '';
let ssm: Pick<SSMClient, 'send'> = sessionClient(SSMClient, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });

/**
 * READ THE PARAMETER THROUGH THE HANDLER'S OWN SSM CLIENT. A cold function pays each client's first-call setup
 * once, so a handler that holds one hands it here (`create-conversation-at-classification.ts`). Optional.
 */
export function useServiceAdminBearerSsmClient(client: Pick<SSMClient, 'send'>): void {
  ssm = client;
}

/** Cached per warm container: the admin identity changes only on a deploy of the Chime stack. */
let cached: string | null = null;

export async function resolveServiceAdminBearer(): Promise<string> {
  if (cached !== null) return cached;
  if (!PARAM) {
    console.error('[service-admin-bearer] CREATOR_BEARER_ARN_PARAM is unset; no conversation can be created');
    cached = '';
    return cached;
  }
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: PARAM }));
    cached = res.Parameter?.Value?.trim() || '';
    if (!cached) {
      console.error('[service-admin-bearer] the parameter exists and is empty; no conversation can be created',
        { param: PARAM });
    }
  } catch (err) {
    console.error('[service-admin-bearer] could not read the service-admin bearer; this conversation is '
      + 'refused', {
      param: PARAM,
      name: (err as { name?: string })?.name,
      message: (err as Error)?.message,
    });
    // TERMINAL VERSUS TRANSIENT, because "never cache a failure" is as wrong as "always cache one".
    //
    // AN UNSET PARAMETER AND AN EMPTY ONE ARE CACHED ABOVE: they are deployment facts and cannot change
    // under a warm container. The question here is which THROWN errors are of that kind too, and two of
    // the likeliest are: `ParameterNotFound` is a deployment that has not published the parameter, and
    // `AccessDenied` is a role without `ssm:GetParameter` on the key. Neither resolves by trying again,
    // so re-reading them would put a failing round trip on the opening click of EVERY conversation.
    //
    // A THROTTLE OR A TIMEOUT IS THE OPPOSITE: caching one would refuse every conversation that container
    // went on to create, over a failure that has already passed.
    const name = (err as { name?: string })?.name ?? '';
    const terminal = name === 'ParameterNotFound'
      || name === 'AccessDeniedException'
      || name === 'ValidationException';
    if (terminal) cached = '';
    return '';
  }
  return cached;
}

/** Test hook: clear the warm cache so a case can exercise both the configured and unset paths. */
export function __clearServiceAdminBearerCache(): void {
  cached = null;
}
