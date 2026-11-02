/**
 * Reading and building an app-instance principal ARN in the browser: `<appInstanceArn>/user/<id>` for
 * a person, `<appInstanceArn>/bot/<id>` for an assistant.
 *
 * The frontend twin of `backend/lambda/src/lib/person-arn.ts`, with the same rules: an id is
 * everything after the `/user/` or `/bot/` segment when it is non-empty and has no further `/`, and
 * its characters are not validated. `backend/test/an-arn-is-parsed-in-one-place.test.ts` refuses an
 * inline `.split('/user/')` or hand-built `/user/` ARN in a frontend package.
 */

const PERSON_SEGMENT = '/user/';
const ASSISTANT_SEGMENT = '/bot/';

function idAfter(arn: string | null | undefined, segment: string): string | null {
  if (typeof arn !== 'string' || !arn) return null;
  const at = arn.indexOf(segment);
  if (at <= 0) return null;
  const id = arn.slice(at + segment.length);
  return id && !id.includes('/') ? id : null;
}

/** The AppInstanceUser id a person ARN names. Null for an assistant ARN, a non-ARN, or a malformed one. */
export function personIdFromArn(arn: string | null | undefined): string | null {
  return idAfter(arn, PERSON_SEGMENT);
}

/** The AppInstanceBot id an assistant ARN names. Null for a person ARN, a non-ARN, or a malformed one. */
export function botIdFromArn(arn: string | null | undefined): string | null {
  return idAfter(arn, ASSISTANT_SEGMENT);
}

/** The ARN of the AppInstanceUser `personId` in `appInstanceArn`. */
export function userArnFor(appInstanceArn: string, personId: string): string {
  return `${appInstanceArn}${PERSON_SEGMENT}${personId}`;
}

/** The ARN of the AppInstanceBot `botId` in `appInstanceArn`. */
export function botArnFor(appInstanceArn: string, botId: string): string {
  return `${appInstanceArn}${ASSISTANT_SEGMENT}${botId}`;
}

/** Whether an ARN names an assistant (an AppInstanceBot). */
export function isAssistantArn(arn: string | null | undefined): boolean {
  return botIdFromArn(arn) !== null;
}

/** Whether an ARN names a person (an AppInstanceUser). */
export function isPersonArn(arn: string | null | undefined): boolean {
  return personIdFromArn(arn) !== null;
}
