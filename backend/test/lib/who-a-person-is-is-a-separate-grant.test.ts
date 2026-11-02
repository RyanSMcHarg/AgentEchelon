/**
 * WHO A PERSON IS, AS AGAINST WHAT THEY SAID (SPEC-ADMIN-CONSOLE FR41, FR42).
 *
 * The name on an Amazon Chime SDK `AppInstanceUser` is the person's EMAIL - the Cognito
 * post-confirmation trigger creates it with `Name: email` - so every participant name an admin surface
 * draws is an address, not a nickname. Reading a conversation and being told which human sent which line
 * are therefore separate grants: an operator investigating a weak answer needs the messages, and does
 * not necessarily need to be told whose they are.
 *
 * ── WHY A ROUTE AND NOT A FIELD, WHICH IS THE WHOLE LESSON OF THIS ROW ───────────────────────────
 *
 * The first implementation withheld the name as a FIELD on the conversation reads, and that failed twice
 * over, both times found by evidence rather than review:
 *
 *   IT DID NOT BIND. The check short-circuits for a trusted IAM-signed caller, which is sound only when
 *   the capability owns an `execute-api` resource the gateway can refuse. A field on a shared route owns
 *   none, so on the deployed API every caller reaching that route still received names, with the
 *   group narrowing changing nothing.
 *
 *   IT LEAKED ANYWAY, three ways: the Aurora branch returned above the mapper the omission lived in;
 *   `raw.Sender.Name` carried the same address one key deeper into the drawer that prints every field;
 *   and `invitedBy` and `moderatedByName` were never dropped at all.
 *
 * So the name is not on those payloads for ANY caller, and `GET admin/conversations/identities` resolves
 * an ARN to a name under `see-user-identity`. A payload with no name in it cannot leak one, and a route
 * with its own resource can be refused. These guards pin both halves.
 *
 * Source-text assertions, which is what they can honestly be: the behavior is exercised against the
 * handler in `test/a-withheld-name-is-withheld-everywhere-it-rides.test.ts`, and the route is exercised
 * against the deployed API by `scripts/deny-test-admin-capabilities.mjs`, which refuses it at the gateway to
 * a role that does not hold `see-user-identity` and admits one that does.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ADMIN_CAPABILITIES, roleIsGranted } from '../../lib/config/admin-capabilities';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');
const repo = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

const auth = src('lib/auth.ts');
const conversations = src('admin-conversations.ts');
// The rows themselves are read behind the archive seam; the handler strips and gates them.
const archive = src('lib/archive-reader.ts');
const stack = repo('lib/stacks/admin-services-stack.ts');

describe('the identity grant is a capability with a resource of its own', () => {
  it('is in the catalog, so the persona policies derive from one place', () => {
    const cap = ADMIN_CAPABILITIES['see-user-identity'];
    expect(cap).toBeDefined();
    expect(cap.wired).toBe(true);
    expect(cap.enforcement).toBe('signOnRole');
  });

  it('owns a resource that authorizes NOTHING ELSE, which is what makes the gate real', () => {
    // The early return in `callerCanSeeUserIdentity` trusts the gateway. That trust is only earned if
    // reaching the resource proves this capability and not a broader one - so the resource must be the
    // identity path alone, never a conversation read.
    const resources = ADMIN_CAPABILITIES['see-user-identity'].resources;
    expect(resources).toEqual([
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations/identities' },
    ]);
  });

  it('is held by admins and never by a team, because it is PII', () => {
    const cap = ADMIN_CAPABILITIES['see-user-identity'];
    expect(cap.roles).toContain('admins');
    expect(cap.roles).not.toContain('team-members');
    expect(roleIsGranted('team-members', cap)).toBe(false);
  });

  it('has the route deployed and the built-in admin role granted it', () => {
    expect(stack).toContain("conversations('GET', '/admin/conversations/identities');");
    // The grant is read from the catalog entry above: AdminApi grants every console role the routes of its capabilities.
    expect(repo('lib/stacks/admin-api-stack.ts')).toContain('grantAdminRolesOnApi(this, this.api, props.consoleRoles);');
  });
});

describe('a conversation read carries no participant name at all', () => {
  it('strips every row-bearing response, in both modes', () => {
    // Three returns carry rows: messages, history and a team's bounded message read. Each serves both
    // modes, because the archive reader (`lib/archive-reader.ts`) answers for Aurora and Athena alike. The `[]` error returns are excluded deliberately - there is nothing to strip and asserting
    // it would assert noise.
    const rowReturns = (conversations.match(/return respond\(200, \{ (?:messages|history): [^,\n]+/g) || [])
      .filter((r) => !/: \[\]/.test(r));
    expect(rowReturns.length).toBe(3);
    for (const r of rowReturns) expect(r).toContain('withoutIdentity(');
  });

  it('takes no caller into account when doing it', () => {
    // The regression this guards is the original design returning: a per-caller field decision. The
    // strip has no caller argument, so there is no branch in which a name survives one of these reads.
    expect(conversations).toMatch(/function withoutIdentity<T extends IdentityBearing>\(rows: T\[\]\): T\[\]/);
    expect(conversations).not.toMatch(/showIdentity/);
  });

  it('drops the inviter and the moderating operator, not just the participant', () => {
    // `invitedBy` is a `sender_name`, so an email, and the only one with no ARN archived beside it.
    // `moderatedByName` is `actor_name`, documented in schema/012 as a display name or email.
    expect(conversations).toMatch(/const \{ senderName, memberName, invitedBy, moderatedByName, \.\.\.rest \} = row;/);
  });

  it('reaches into the raw inspect payload, where the same email sits one key deeper', () => {
    expect(conversations).toContain('function scrubRawIdentity');
    expect(conversations).toMatch(/for \(const key of \['Sender', 'ModeratedBy'\]/);
    // Blanked in place, not deleted: a missing key in `raw` reads as "the archive has no sender".
    expect(conversations).toMatch(/Name: WITHHELD/);
    // The ARN in the same object survives, or the drawer can no longer identify the actor at all.
    expect(conversations).toMatch(/identifies the actor without naming them/);
  });

  it('keeps the ARN on every row, because the read must still identify the participant', () => {
    expect(archive).toMatch(/senderArn,/);
    expect(archive).toMatch(/memberArn,/);
  });
});

describe('resolving an ARN to a name is its own gated route', () => {
  it('checks the capability before answering', () => {
    expect(conversations).toMatch(/async function resolveIdentities/);
    expect(conversations).toMatch(/if \(!callerCanSeeUserIdentity\(event\)\) \{[\s\S]{0,120}respond\(403/);
  });

  it('is scoped to one conversation and honors the classification callerScope', () => {
    // Same subject the other reads check, so a scoped operator cannot resolve names in a conversation
    // they could not have read in the first place.
    const fn = conversations.slice(conversations.indexOf('async function resolveIdentities'));
    expect(fn).toMatch(/isValidChannelArn\(channelArn\)/);
    expect(fn.slice(0, 2000)).toMatch(/channelClassificationAllowed\(archive, channelArn, callerScope\)/);
  });

  it('answers from the same rows the conversation views read', () => {
    // One query rather than a second shape that could disagree about who was in a conversation.
    const fn = conversations.slice(conversations.indexOf('async function resolveIdentities'));
    expect(fn.slice(0, 2500)).toContain('archive.participants(channelArn)');
    // On the archive, the timeline and the identity pairing come from the same membership query.
    expect(archive).toMatch(/async function archiveMembershipRows/);
    expect(archive).toMatch(/membership: \(channelArn\) => archiveMembershipRows\(channelArn\)/);
    const participants = archive.slice(archive.lastIndexOf('async participants('));
    expect(participants.slice(0, 400)).toContain('archiveMembershipRows(channelArn)');
    // On the projection, from the timeline and the messages the other routes return.
    const projected = archive.slice(archive.indexOf('async participants('));
    expect(projected.slice(0, 600)).toMatch(/adminMembershipHistory\(channelArn\)[\s\S]*adminListMessages\(channelArn\)/);
  });
});

describe('the early return is justified where it now sits', () => {
  it('records that the justification is the resource, not the enforcement flag', () => {
    expect(auth).toMatch(/SOUND HERE ONLY BECAUSE THE CAPABILITY OWNS A RESOURCE/);
    expect(auth).toContain('authorizes\n  // NOTHING ELSE');
  });

  it('keeps the measured history, so the field version is not reintroduced', () => {
    // The comment has to carry WHY a field on a shared route failed, or the next person writing a
    // similar gate repeats it. This is the one fact a reader cannot re-derive from the code.
    expect(auth).toMatch(/every caller reaching that route still received\s+\/\/ names/);
    expect(auth).toMatch(/putting it back on a shared read reinstates that bug/);
  });
});
