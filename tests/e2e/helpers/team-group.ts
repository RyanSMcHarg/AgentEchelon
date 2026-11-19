/**
 * A TEAM CONVERSATION ADMITS ITS MEMBERSHIP GROUP'S PEOPLE ONLY (`membershipSource` on its type), so a spec that has a team
 * conversation opened for its lead puts the lead in that group for the run and leaves the group as it found it.
 */
import { CONVERSATION_TYPES } from '../../../backend/lib/config/conversation-types';
import { awsv } from './aws';

/** The group a conversation type takes its members from, or undefined where it names none. */
export function membershipGroupOf(typeKey: string): string | undefined {
  return (CONVERSATION_TYPES as Record<string, { membershipSource?: { group?: string } }>)[typeKey]?.membershipSource?.group;
}

/**
 * Put `username` in the type's membership group when they are not in it, and answer what undoes that: removing them again
 * where this call added them, nothing where they were already a member.
 */
export function joinMembershipGroup(typeKey: string, username: string, userPoolId: string): () => void {
  const group = membershipGroupOf(typeKey);
  if (!group) return () => undefined;
  const cognito = (args: string[]) => awsv(['cognito-idp', ...args, '--user-pool-id', userPoolId]);
  const groups = ((cognito(['admin-list-groups-for-user', '--username', username])?.Groups ?? []) as Array<{ GroupName: string }>).map((g) => g.GroupName);
  if (groups.includes(group)) return () => undefined;
  cognito(['admin-add-user-to-group', '--group-name', group, '--username', username]);
  return () => { cognito(['admin-remove-user-from-group', '--group-name', group, '--username', username]); };
}
