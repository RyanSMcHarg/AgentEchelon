/**
 * The operator-script twin of `backend/lambda/src/lib/person-arn.ts`: reading and building an
 * app-instance principal ARN (`<appInstanceArn>/user/<id>` for a person, `<appInstanceArn>/bot/<id>`
 * for an assistant).
 *
 * Scripts are `.mjs` and `.cjs` run by plain Node, so they cannot import the TypeScript module. The
 * rules are the same and `backend/test/lib/person-arn.test.ts` holds both to one table, so the two
 * cannot drift apart silently. `backend/test/an-arn-is-parsed-in-one-place.test.ts` refuses an inline
 * `.split('/user/')` or hand-built `/user/` ARN in a script.
 *
 * An id is everything after the `/user/` or `/bot/` segment, when it is non-empty and has no further
 * `/`. Its characters are not validated; nothing here branches on the id's shape.
 */

const PERSON_SEGMENT = '/user/';
const ASSISTANT_SEGMENT = '/bot/';
const CHANNEL_SEGMENT = '/channel/';

function idAfter(arn, segment) {
  if (typeof arn !== 'string' || !arn) return null;
  const at = arn.indexOf(segment);
  if (at <= 0) return null;
  const id = arn.slice(at + segment.length);
  return id && !id.includes('/') ? id : null;
}

/** The AppInstanceUser id a person ARN names. Null for an assistant ARN, a non-ARN, or a malformed one. */
function personIdFromArn(arn) {
  return idAfter(arn, PERSON_SEGMENT);
}

/** The AppInstanceBot id an assistant ARN names. Null for a person ARN, a non-ARN, or a malformed one. */
function botIdFromArn(arn) {
  return idAfter(arn, ASSISTANT_SEGMENT);
}

/** `{ kind: 'person' | 'assistant', id }` for a principal ARN, or null when it names neither. */
function principalFromArn(arn) {
  const personId = personIdFromArn(arn);
  if (personId) return { kind: 'person', id: personId };
  const botId = botIdFromArn(arn);
  if (botId) return { kind: 'assistant', id: botId };
  return null;
}

/** The app instance a principal (or channel) ARN lives in. Null when it carries no such segment. */
function appInstanceArnOf(arn) {
  if (typeof arn !== 'string' || !arn) return null;
  for (const segment of [PERSON_SEGMENT, ASSISTANT_SEGMENT, CHANNEL_SEGMENT]) {
    const at = arn.indexOf(segment);
    if (at > 0) return arn.slice(0, at);
  }
  return null;
}

/** The ARN of the AppInstanceUser `personId` in `appInstanceArn`. */
function userArnFor(appInstanceArn, personId) {
  return `${appInstanceArn}${PERSON_SEGMENT}${personId}`;
}

/** The ARN of the AppInstanceBot `botId` in `appInstanceArn`. */
function botArnFor(appInstanceArn, botId) {
  return `${appInstanceArn}${ASSISTANT_SEGMENT}${botId}`;
}

function isPersonArn(arn) {
  return personIdFromArn(arn) !== null;
}

function isAssistantArn(arn) {
  return botIdFromArn(arn) !== null;
}

module.exports = {
  personIdFromArn,
  botIdFromArn,
  principalFromArn,
  appInstanceArnOf,
  userArnFor,
  botArnFor,
  isPersonArn,
  isAssistantArn,
};
