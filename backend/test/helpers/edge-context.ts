/**
 * THE EDGE AUTHORIZER'S CONTEXT, AS A HANDLER RECEIVES IT, FOR A SUITE ABOUT THE HANDLER.
 *
 * Every person route is behind the edge authorizer (`lambda/src/edge-authorizer.ts`), which verifies the
 * token, resolves its subject through `Identities`, and hands the gateway a context: the issuer's registry
 * id, the subject that entry declares, the person, and the claims the registry reads. A payload format
 * 1.0 event carries it as `requestContext.authorizer`, which is what `callerPersonId` reads.
 *
 * A suite about a handler states its caller as the claims a token would carry. This builds the context the
 * edge would hand over for them: the issuer the claims' `iss` names in the registry this process is handed
 * (`TRUSTED_ISSUERS`, read when the handler asks, so a suite may set it after building its events), the
 * subject that entry declares, and the person the default resolver mapping names (the AppInstanceUser
 * whose id is the subject, as `test/setup/person-resolver.ts` maps it). A suite proving a handler keys on
 * the PERSON rather than the subject names one (`personId`).
 *
 * The claims stay a live object, so a suite that changes a claim after building the event changes what the
 * handler reads. The edge authorizer itself, the policy and the context it answers with, is tested in
 * `test/lib/the-edge-admits-a-token-only-where-its-person-is-served.test.ts`.
 */
import { issuerOfToken } from '../../lambda/src/lib/trusted-issuers';
import { subjectOf } from '../../lib/config/issuers';

export interface EdgeFixture {
  /** The claims a token from the caller's issuer carries. */
  claims?: Record<string, unknown>;
  /** The person the edge resolved, when it is not the AppInstanceUser whose id is the subject. */
  personId?: string;
  /** The registry id, when it is not the one the claims' `iss` names. */
  issuerId?: string;
}

/** The context the edge authorizer hands a handler for a caller with these claims. */
export function edgeContext(fixture: EdgeFixture = {}): Record<string, unknown> {
  const ctx: Record<string, unknown> = { tokenClaims: fixture.claims ?? {} };
  let person = fixture.personId;
  const issuer = () => issuerOfToken((ctx.tokenClaims as Record<string, unknown>) ?? {});
  const subject = (): string | undefined => {
    const i = issuer();
    return (i && subjectOf(i, (ctx.tokenClaims as Record<string, unknown>) ?? {})) || undefined;
  };
  const personId = (): string | undefined => person ?? subject();
  Object.defineProperties(ctx, {
    issuerId: { enumerable: true, get: () => fixture.issuerId ?? issuer()?.id },
    subject: { enumerable: true, get: subject },
    personId: { enumerable: true, get: personId, set: (v: string | undefined) => { person = v; } },
    personArn: {
      enumerable: true,
      get: () => {
        const id = personId();
        const app = process.env.APP_INSTANCE_ARN || 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
        return id ? `${app}/user/${id}` : undefined;
      },
    },
  });
  return ctx;
}

/**
 * The same event, with the edge having resolved its token to this person: the AppInstanceUser the
 * exchange minted, which is not the token's subject. For a suite proving a handler keys on the person.
 */
export function asPerson<T extends { requestContext?: unknown }>(event: T, personId: string): T {
  const authorizer = (event.requestContext as { authorizer?: Record<string, unknown> } | undefined)?.authorizer;
  if (!authorizer || !('issuerId' in authorizer)) throw new Error('asPerson: the event carries no edge context; build it with edgeContext');
  authorizer.personId = personId;
  return event;
}
