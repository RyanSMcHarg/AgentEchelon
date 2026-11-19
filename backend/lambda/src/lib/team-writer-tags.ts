/**
 * WHAT A TEAM WRITER SESSION CARRIES, NAMED ONCE for the stack that grants on it and the handler that assumes it
 * (`team-scoped-writer.ts`, `lib/constructs/team-writer-role.ts`). No SDK import, so the stack reads it freely.
 */

/** The environment variable that names a function's team writer role. */
export const TEAM_WRITER_ROLE_ARN_ENV = 'TEAM_WRITER_ROLE_ARN';

/**
 * The session tags. `assistant` is the assistant the team route's path names, and every grant of the role names
 * `${aws:PrincipalTag/assistant}`. `alt` is that assistant's role's alt, derived on the server from the path's
 * assistant, present only while a candidate version of the alt is published.
 */
export const TEAM_WRITER_TAG = { assistant: 'assistant', alt: 'alt' } as const;

/** An alt's name as the profile registry builds it (`alt-{role}-{classification}`): one IAM path segment. */
export const ALT_NAME_PATTERN = /^alt-[A-Za-z0-9_-]{1,120}$/;

/**
 * A TEAM'S EXPERIMENT ID BEGINS WITH ITS ASSISTANT AND THIS SEPARATOR (`<assistant>.<id>`), so the experiments table's
 * partition key names the assistant and the team writer's `dynamodb:LeadingKeys` condition binds a write to it. An
 * assistant id never holds a `.` (`ASSISTANT_ID_PATTERN`), so one assistant's prefix is never another's.
 */
export const TEAM_EXPERIMENT_ID_SEPARATOR = '.';

/** The id a team route stores an experiment under: the id as sent when it already carries the assistant, else prefixed. */
export function teamExperimentId(assistant: string, id: string): string {
  return isTeamExperimentId(assistant, id) ? id : `${assistant}${TEAM_EXPERIMENT_ID_SEPARATOR}${id}`;
}

/** Whether an experiment id is one a team route of this assistant writes. */
export function isTeamExperimentId(assistant: string, id: string): boolean {
  const prefix = `${assistant}${TEAM_EXPERIMENT_ID_SEPARATOR}`;
  return id.startsWith(prefix) && id.length > prefix.length;
}
