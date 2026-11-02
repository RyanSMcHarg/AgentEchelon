/**
 * WHICH TEAM OWNS WHICH ASSISTANT (SPEC-ADMIN-CONSOLE FR47, DESIGN-ADMIN-CONSOLE 5.2).
 *
 * Ownership is the `owner-team` tag on an assistant's `AppInstanceBot`, read live, so no IAM policy
 * names an assistant and reassigning one needs no deploy. A person's teams are their Cognito groups
 * named `team-<name>`. The credential exchange reads both to decide which assistant paths a team
 * member's console session may reach, and the handlers behind those paths read them again so a stale
 * session or a mis-built policy is caught by a second check rather than being the only one.
 *
 * The bot's own `assistant` tag (written when it is provisioned) names the profile it serves, which
 * is how an owner on a bot becomes an owner of an assistant name in a route.
 */
import {
  ChimeSDKIdentityClient,
  ListAppInstanceBotsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { ADMIN_ROLE_GROUP } from '../../../lib/config/admin-capabilities';

export const OWNER_TEAM_TAG = 'owner-team';
/**
 * The value an owner CLEARED in the console is recorded as, so a deploy's seed can tell "nobody has
 * decided" (no tag, seeded from the profile) from "an admin decided no team" (this, left alone). The
 * underscore keeps it outside every team name (`TEAM_NAME_PATTERN`), so no `team-<name>` group matches it.
 */
export const OWNER_TEAM_CLEARED = '_none';
export const TEAM_GROUP_PREFIX = 'team-';

/** An assistant as its identity records it. */
export interface AssistantIdentity {
  /** The profile name from the bot's `assistant` tag: the `{assistant}` in a scoped route. */
  assistant: string;
  botArn: string;
  /** The bot's display `Name`. */
  name: string;
  classification: string | null;
  role: string | null;
  /** The owning team, or null when no team owns it (reachable by `admins` alone). */
  ownerTeam: string | null;
  /** Whether an owner has been recorded at all, a cleared one included: the seed leaves these alone. */
  ownerRecorded: boolean;
}

/** The team names a person's groups make them a member of. */
export function teamsOfGroups(groups: string[]): string[] {
  // THE ROLE GROUP IS NOT A TEAM. `team-members` shares the prefix, and read as a team it would make every
  // team member a member of a team `members`, reaching any assistant whose owner tag says so.
  return groups.filter((g) => g.startsWith(TEAM_GROUP_PREFIX) && g.length > TEAM_GROUP_PREFIX.length && g !== ADMIN_ROLE_GROUP['team-members'])
    .map((g) => g.slice(TEAM_GROUP_PREFIX.length));
}

/**
 * Every assistant in the app instance with its ownership, read from the bots and their tags.
 *
 * A bot with no `assistant` tag is not an assistant a route can name (a probe, an untagged test bot), so it
 * is left out rather than given a name nobody could own.
 */
export async function listAssistantIdentities(client: ChimeSDKIdentityClient, appInstanceArn: string): Promise<AssistantIdentity[]> {
  const bots: Array<{ arn: string; name: string }> = [];
  let next: string | undefined;
  do {
    const page = await client.send(new ListAppInstanceBotsCommand({ AppInstanceArn: appInstanceArn, MaxResults: 50, NextToken: next }));
    for (const b of page.AppInstanceBots || []) {
      if (b.AppInstanceBotArn) bots.push({ arn: b.AppInstanceBotArn, name: b.Name || '' });
    }
    next = page.NextToken;
  } while (next);

  const out: AssistantIdentity[] = [];
  for (const bot of bots) {
    const tags = (await client.send(new ListTagsForResourceCommand({ ResourceARN: bot.arn }))).Tags || [];
    const tag = (key: string) => tags.find((t) => t.Key === key)?.Value || null;
    const assistant = tag('assistant');
    if (!assistant) continue;
    out.push({
      assistant,
      botArn: bot.arn,
      name: bot.name,
      classification: tag('classification'),
      role: tag('role'),
      ownerTeam: tag(OWNER_TEAM_TAG) === OWNER_TEAM_CLEARED ? null : tag(OWNER_TEAM_TAG),
      ownerRecorded: tag(OWNER_TEAM_TAG) !== null,
    });
  }
  return out;
}

/** The assistants these teams own, by the same rule as `teamsOwn`. Several bots may serve one name; it is listed once. */
export function ownedBy(identities: AssistantIdentity[], teams: string[]): string[] {
  return [...new Set(identities.map((i) => i.assistant))].filter((a) => teamsOwn(identities, teams, a)).sort();
}

/**
 * Whether an assistant is owned by one of these teams. Every bot serving the name must agree: an
 * assistant one team owns in one classification and another team owns elsewhere is not wholly either
 * team's, so neither reaches it through a scoped route.
 */
export function teamsOwn(identities: AssistantIdentity[], teams: string[], assistant: string): boolean {
  const bots = identities.filter((i) => i.assistant === assistant);
  if (bots.length === 0) return false;
  const held = new Set(teams);
  return bots.every((b) => b.ownerTeam !== null && held.has(b.ownerTeam));
}

/**
 * WHAT A PERSON'S CONSOLE MAY BE SCOPED TO: the assistants their teams own whose every classification
 * their own clearance reaches.
 *
 * Owning an assistant does not raise anyone's clearance. A team that owns an assistant serving a
 * classification above a member's clearance does not give that member its conversations or its
 * analytics, so such an assistant is left out of their scope entirely rather than shown partly.
 */
export function scopeFor(
  identities: AssistantIdentity[],
  groups: string[],
  reaches: (holder: string, target: string) => boolean,
  clearances: (groups: string[]) => string[],
): string[] {
  const held = clearances(groups);
  const cleared = (assistant: string) => identities
    .filter((i) => i.assistant === assistant)
    .every((i) => !!i.classification && held.some((h) => reaches(h, i.classification as string)));
  return ownedBy(identities, teamsOfGroups(groups)).filter(cleared);
}
