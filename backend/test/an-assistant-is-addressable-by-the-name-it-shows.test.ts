/**
 * THE NAME A PERSON IS SHOWN IS THE NAME THAT RESOLVES.
 *
 * An `@` token is matched against the Amazon Chime SDK member NAME, so an assistant whose bot carries an
 * internal identifier is addressable only by that identifier - and the name a person reads everywhere
 * else resolves to nobody.
 *
 * ── THE DEFECT THIS PINS, measured on a live deployment ─────────────────────────────────────────
 *
 * The premium primary's bot took its name from the registry ("Advisor"), and the second role's bot was
 * named `{role}-{classification}` - so `@Advisor` worked and `@Ops` did not, while the console, the
 * assistant's own welcome and the handover copy all called it Ops. The channel flow logged `an @ token
 * named nobody in this conversation` and **no turn started**: not a refusal, not an error, silence. A
 * person is neither answered nor told why.
 *
 * ── WHY A SOURCE-TEXT ASSERTION AND WHAT IT CANNOT CATCH ────────────────────────────────────────
 *
 * Every assistant's bot is built by the provisioner from the declaration each stack hands it. This asserts
 * the declaration carries the registry's display name rather than a composed identifier, and that the registry
 * really answers for the shipped second assistant. It cannot catch the name failing to APPLY to a
 * deployed bot - `UpdateAppInstanceBot` is best-effort in that handler by design - so the live check is
 * that an `@` by display name starts a turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultProfileRegistry } from '../lib/profile-registry';
import { ASSISTANT_ROLES } from '../lib/stacks/agent-classification-common';
import {
  resolveMentionedMember, resolveMentionedAssistant, stripMentionOf, matchesAtAll, type BypassMember,
} from '../lambda/src/lib/flow-bypass';
import { parseStopCommand } from '../lambda/src/lib/stop-target';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const client = fs.readFileSync(path.join(__dirname, '../../frontend/packages/chat/src/utils/mentionParser.ts'), 'utf8');

const stack = fs.readFileSync(
  path.join(__dirname, '../lib/stacks/assistant-profile-stack.ts'),
  'utf8',
);

describe('every assistant identity is named what a person calls it', () => {
  it('names a non-primary role\'s bot from the registry, not from the role identifier', () => {
    expect(stack).toContain('displayName: defaultProfileRegistry.displayNameFor(assistantId) || assistantId,');
    expect(stack).toContain('const assistantId = defaultProfileRegistry.roleAssistantName(classification, role);');
    // The composed identifier survives only as the last-resort fallback for a profile the registry does
    // not know. It must not be the first choice again.
    expect(stack).not.toMatch(/botName: `\$\{role\}-\$\{classification\}`,/);
  });

  it('names the primary from the registry too, which is the rule this follows', () => {
    expect(stack).toContain('defaultProfileRegistry.displayNameFor(');
  });

  it('the registry answers with a person-facing name for every declared assistant', () => {
    // A profile whose display name is its own internal name would reintroduce the defect quietly, so
    // every declared assistant is checked rather than only the one that had it.
    for (const name of defaultProfileRegistry.profileNames()) {
      const shown = defaultProfileRegistry.displayNameFor(name);
      expect(shown).toBeTruthy();
      expect(shown.trim()).toBe(shown);
    }
  });

  it('every display name, spaces included, is mentionable through the delimited token the picker writes', () => {
    // A display name is a name, not a token: it may hold a space. The composer's picker writes `@<Name|id>`
    // (`mentionTokenFor` in the chat client), and the flow resolves that token by id, then by the name it carried.
    expect(client).toContain('if (id) return `@<${name}|${id}> `;');
    const members: BypassMember[] = defaultProfileRegistry.profileNames().map((name) => ({
      arn: `${APP}/bot/${name}-bot`, name: defaultProfileRegistry.displayNameFor(name), isBot: true,
    }));
    for (const member of members) {
      const token = `@<${member.name}|${member.arn.split('/').pop()}> `;
      expect(resolveMentionedMember(`${token}please`, members)).toBe(member);
      expect(stripMentionOf(`${token}please`, member)).toBe('please');
    }
  });

  it('"@<Admin Assistant|id> please" names the Admin Assistant, and "@Advisor" still names Advisor', () => {
    const admin: BypassMember = { arn: `${APP}/bot/admin-bot`, name: 'Admin Assistant', isBot: true };
    const advisor: BypassMember = { arn: `${APP}/bot/advisor-bot`, name: 'Advisor', isBot: true };
    const person: BypassMember = { arn: `${APP}/user/sam`, name: 'Sam', isBot: false };
    const room = [person, advisor, admin];
    expect(defaultProfileRegistry.displayNameFor('admin-agent')).toBe('Admin Assistant');
    expect(resolveMentionedAssistant('@<Admin Assistant|admin-bot> please', room)).toBe(admin);
    expect(resolveMentionedAssistant('@<Admin Assistant> please', room)).toBe(admin);
    expect(resolveMentionedAssistant('@Advisor please', room)).toBe(advisor);
    expect(stripMentionOf('@<Admin Assistant|admin-bot> please', admin)).toBe('please');
    expect(stripMentionOf('ask @<Admin Assistant|admin-bot> please', admin)).toBe('ask please');
    expect(stripMentionOf('@<Admin Assistant|admin-bot> ask @<Sam|sam> too', admin)).toBe('ask @<Sam|sam> too');
    expect(stripMentionOf('@Advisor please', advisor)).toBe('please');
    // A delimited stop names its assistant, as a bare one does; `@all` still names nobody.
    expect(parseStopCommand('@<Admin Assistant|admin-bot> /stop')).toEqual({ isStop: true, addressed: true });
    expect(parseStopCommand('@Advisor /stop')).toEqual({ isStop: true, addressed: true });
    expect(parseStopCommand('@all /stop')).toEqual({ isStop: true, addressed: false });
    expect(parseStopCommand('/stop')).toEqual({ isStop: true, addressed: false });
    expect(matchesAtAll('@all please')).toBe(true);
  });

  it('the shipped second assistant is addressable as Ops', () => {
    // The specific case, named, because it is the one a demo depends on and the one that failed.
    expect(defaultProfileRegistry.displayNameFor('ops-premium')).toBe('Ops');
  });

  it('an assistant identifier and the name it shows are allowed to differ, and the handle stays the handle', () => {
    // The declaration's `assistantId` is the PROFILE NAME and must not become the display name: it is
    // what resolves an advertisement and an assignment. Only the Amazon Chime SDK member name changes.
    expect(stack).toMatch(/assistantId, role, occupancy: 'live' as const,\s*displayName: defaultProfileRegistry\.displayNameFor\(assistantId\)/);
    expect(ASSISTANT_ROLES).toContain('primary');
  });
});
