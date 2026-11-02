/**
 * AN ASSISTANT IS ASSIGNED EXACTLY ONE CLASSIFICATION, AND ANSWERS AT IT.
 *
 * Owner direction, 2026-09-13, stated twice because it kept not landing:
 *
 *   "an assistant should always answer based on its classification anyway, it should always be one
 *    level"
 *   "the assistant only has one classification, if the channel or user doesn't have a classification
 *    to match they shouldn't be in the exchange. Channels should always only have one."
 *   "the assistant never classifies itself, it has a classification assigned"
 *
 * Three properties follow, and all three are asserted here:
 *
 *   1. The classification is ASSIGNED, not self-determined. The deployment decides; the CDK stack
 *      stamps `PROFILE_NAME` on the Lambda; the processor carries it. There is no runtime resolution
 *      and no path by which an assistant reports anything other than what it was given.
 *   2. It is exactly ONE. An assistant serves at its assigned classification or it does not serve.
 *   3. An exchange is between parties that MATCH. A channel has one classification too, and anyone
 *      who does not hold it should never have been admitted - so a disagreement is an admission
 *      failure, in EITHER direction, not a downgrade working as intended.
 *
 * The classification recorded against a turn is therefore a property of the ASSISTANT. The two values
 * that look usable in its place are both facts about somebody else:
 *
 *   event.classification    the CONVERSATION's classification, from the channel tag. About the room.
 *   event.userClearance     the CALLER's clearance. About the person.
 *   the sender ARN          a UUID on every real deployment, carrying no classification at all.
 *
 * A REQUEST FIELD AND THE ARN WERE BOTH USED, AND BOTH WERE WRONG (measured live 2026-09-13):
 *
 *   - `async-processor-core` set `agentType` from the request's classification, filing a fact about the room as the
 *     identity of the assistant. It reads as correct while traffic stays on the diagonal - a basic
 *     person, in a basic room, served by the basic assistant makes all three `basic` - which is why
 *     it survived. A user may hold SEVERAL classifications, and the moment one speaks in a room below
 *     their clearance the recorded value describes neither the agent nor anything stable.
 *
 *   - `kinesis-archival` fell back to matching substrings in the bot ARN ('admin' meant premium,
 *     'auth' meant standard). Bot ARNs here look like
 *     `.../bot/28532eca-4472-4f50-b33a-d9149a54e5ae`, so it returned null for every bot message this
 *     deployment has ever archived. It never once produced a value, and each miss became an
 *     'unknown' row indistinguishable from a measurement. The answer was in the adjacent field:
 *     `Sender.Name` is "Assistant-basic".
 *
 * These are source-level guards because the defect is a WIRING one: every unit test of the turn
 * passed throughout, since the values coincide on the fixtures anyone would write. What has to be
 * pinned is WHERE the value comes from, which no behavioural assertion over a single-classification
 * fixture can see.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * The file with its comments removed.
 *
 * These guards assert what the CODE does, and the code in question is documented by comments that
 * necessarily name the thing being banned - the record of why `extractAgentType` was deleted has to
 * say `extractAgentType`. Matching the raw text would make the explanation fail the rule it explains,
 * and the cheapest way to pass would be to delete the explanation. So the comments come out first.
 */
const codeOf = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

describe('an assistant is assigned one classification and answers at it', () => {
  it('takes agentType from the serving processor, never from the request', () => {
    const core = read('lib/async-processor-core.ts');

    // The assignment exists and reads from what the SERVING PROCESSOR passed. It used to read
    // `params.servingClassification`; it reads `params.servingAssistant` now, because `agent_type` is
    // the responder's identity rather than the boundary it works inside. The rule the
    // assertion enforces is unchanged: the value comes from the processor that answered, never from
    // the request.
    expect(core).toMatch(/agentType:\s*params\.servingAssistant/);

    // AND IT DOES NOT FALL BACK. `|| event.classification` would be the original defect written as a
    // default: a caller that cannot say which assistant answered has nothing to substitute, and
    // recording a plausible-but-wrong value is strictly worse than recording none - a missing value is
    // discoverable, a wrong one that looks right is not.
    expect(core).not.toMatch(/agentType:[^,\n]*event\.(classification|userClearance|userType)/);
  });

  it('carries the ASSISTANT as its own fact, which is what the analytics dimension records', () => {
    // WHAT CHANGED, AND WHY THIS GUARD DID NOT SIMPLY LOSE ITS ARGUMENT. The rule below
    // still holds: `servingClassification` must be the CLASSIFICATION, because a classification is a
    // boundary and must not move because a persona was edited. What changed is that `agent_type` -
    // the analytics dimension - was being FED that classification, and `agent_type` is the
    // RESPONDER'S identity. So two assistants in one classification would have been one row and the
    // "scope to this assistant" filter separated nothing.
    //
    // The fix is a SECOND carried fact, not a reinterpreted one: the classification travels as
    // itself and lands in `conversation_classification`; the assistant travels as itself and lands in
    // `agent_type`. Feeding the dimension from the classification again would rebuild the conflation.
    const processor = read('assistant-async-processor.ts');
    // FROM THE ASSISTANT, NOT FROM THE ENVIRONMENT, and that is a tightening of this assertion rather than
    // a loosening. `PROFILE_NAME` is one value per FUNCTION, and one runtime serves every role a
    // classification declares - so once a classification held a second assistant, pinning the dimension
    // to the env filed every one of its turns under the primary. Measured: no `ops-premium` row existed
    // in the reports after the ops assistant had answered live turns.
    //
    // The env remains the fallback, which is what keeps every single-assistant classification on the
    // behavior this test was originally written to protect.
    // THE SAME NAME THE BEHAVIOR CAME FROM (ADR-050). The vend admits only a declared profile or the alt
    // of a declared role (`alt-{role}-{classification}`), so the resolved name always names an assistant with
    // a profile, and a duel's challenger is archived as the alt that answered rather than as the primary.
    expect(processor).toMatch(/servingAssistant:\s*turnProfileName,/);
    expect(processor).toContain('const turnProfileName = turnAssistantName || PROFILE_NAME;');
    expect(processor).toMatch(/servingRole:\s*turnAssistantRole\s*\|\|\s*ASSISTANT_ROLE/);
    const core = read('lib/async-processor-core.ts');
    expect(core).toMatch(/agentType:\s*params\.servingAssistant/);
    expect(core).not.toMatch(/agentType:\s*params\.servingClassification/);
  });

  it('classifies a turn against the ADDRESSED assistant\'s taxonomy, not the primary\'s', () => {
    // THE OTHER HALF OF THE SAME TURN. The processor resolves behavior from the assistant (above), and the
    // router resolves the INTENT PACK from the same assistant. Read from `requireProfileFor(classification)`
    // - the classification's primary - a second assistant's turn is classified against the primary's
    // taxonomy while being answered with its own persona and tools: `ops-premium` recognizes none of its
    // own intents and every operational question lands on `general`. Two halves of one turn reading two
    // profiles is the shape this whole file is about, which is why the guard sits here.
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/assignedAssistant: assistantByBotArn\.get\(botArn\),/);
    // GUARDED BY THE REGISTRY inside `turnAssistantProfile`, for the same reason the processor guards with
    // `isKnownProfile`: an armed experiment names the alt `alt-{role}` and no profile is
    // published under it. `test/a-turn-runs-on-its-assistants-profile.test.ts` holds the guard's behavior.
    expect(router).toMatch(/const turnAssignment = await assistantOfBot\(botArn, /);
    // A turn serving a pinned version (a duel side, an enrolled arm) reads that version's pack; otherwise the
    // addressed assistant's own active version, never the primary's.
    expect(router).toMatch(/const activeForPack = servedVersion \?\? await resolveActiveProfile\(turnProfile\.name,/);
  });

  it('passes the ASSIGNED CLASSIFICATION, not the profile name', () => {
    // The stack stamps the classification on the Lambda; the processor carries it. Nothing resolves it
    // at runtime and there is no path by which an assistant reports one it was not assigned.
    //
    // NOT `PROFILE_NAME`, and this assertion changed once already for that reason. A classification
    // REFERENCES a profile in config/profiles.ts ({ value, rank, profile }), so a deployment may point
    // one at a differently-named profile and the strings come apart. They are equal on the default
    // config, which is exactly the kind of coincidence that let a fact about the USER be recorded as
    // the identity of the ASSISTANT in the first place. A profile is capability configuration and is
    // operator-editable; a classification is a boundary and must not move because a persona was edited.
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/servingClassification:\s*CLASSIFICATION/);
    expect(processor).not.toMatch(/servingClassification:\s*PROFILE_NAME/);
    // And the value comes from the environment the stack stamps, never from a literal floor.
    expect(processor).toMatch(/const CLASSIFICATION = \(process\.env\.CLASSIFICATION/);
  });

  it('never infers a classification from the sender ARN', () => {
    const archival = codeOf('analytics-aurora/kinesis-archival.ts');

    // The deleted guess, by name and by shape. The shape term matters independently: a future
    // re-introduction is unlikely to reuse the function name, but any ARN sniff has to lowercase the
    // ARN and test it for a classification word.
    expect(archival).not.toMatch(/extractAgentType/);
    expect(archival).not.toMatch(/arnLower|botArn\.toLowerCase\(\)/);

    // AN UNDECLARED ASSISTANT RECORDS NULL, and nothing GUESSES one.
    //
    // This pinned the exact expression `analytics.agentType || null`, which made it fail the day a
    // second DECLARED source was added - a content declaration, for the Lex-entry answer that carries
    // no metadata at all and so had nowhere else to put the responder. That is not a guess: the value
    // is checked against the deployment's declared roster in `turnDeclarationOf`, so an unrecognized
    // name arrives as absent rather than as an invented assistant.
    //
    // So the rule is asserted rather than the expression: every term in the fallback chain is either
    // a declaration or `null`, and the chain still ends at `null`.
    // The ASSIGNMENT, not the interface field of the same name a few hundred lines above it - matching
    // `agent_type:` alone finds `agent_type: string | null;` first and asserts nothing about behavior.
    const agentTypeLine = archival.match(/assistant:\s*analytics\.agentType[^,\n]*/)?.[0] ?? '';
    expect(agentTypeLine).toContain('analytics.agentType');
    expect(agentTypeLine).toMatch(/\|\|\s*null\s*$/);
    // Nothing in the chain derives from the sender, the ARN or the channel - the three things this
    // test exists to keep out of it.
    expect(agentTypeLine).not.toMatch(/sender|Arn|channel/i);
  });

  it('does not copy the room\'s classification onto every message', () => {
    // The channel's classification has a home: the `channel_classification` table, written by the
    // router from the immutable tag. A per-message copy is a second recording of one fact (tenet D7)
    // and spends inline metadata budget that sits at 1022 of 1024 on a premium experiment turn.
    const archival = read('analytics-aurora/kinesis-archival.ts');
    expect(archival).not.toMatch(/channel_classification:\s*analytics\./);
    // It is READ for the comparison instead, from the one place that holds it.
    expect(archival).toMatch(/lookupChannelClassification\(/);
  });

  it('treats EITHER direction of classification disagreement as a boundary crossing', () => {
    // An exchange is between parties that match. A participant who does not hold the channel's
    // classification should never have been admitted, so an assistant serving BELOW its room is an
    // admission failure exactly as much as one serving above it.
    //
    // THIS TEST REPLACED ITS OWN OPPOSITE. It first asserted that below-the-room logged as routine
    // information, on the reasoning that the min-cap binding is the design working. That is the same
    // error one level up: a bound min-cap means somebody is in a room they should not be in, so its
    // FIRING is the signal rather than the resolution. The control stays; reporting it as normal does
    // not.
    const archival = codeOf('analytics-aurora/kinesis-archival.ts');

    // One report, both directions, at the severity the router already uses for a classification fault.
    expect(archival).toMatch(/SecurityEvent\] an exchange crossed a classification boundary/);
    // The direction is NAMED - it says which way admission failed - but never used to excuse one.
    expect(archival).toMatch(/direction:/);
    // No branch logs a disagreement as ordinary information.
    expect(archival).not.toMatch(/console\.log\([^)]*min-cap bound/);
    // THE DETECTOR READS THE DECLARED SETS, NOT RANKS (ADR-046). `profiles.rank` is deleted; what
    // this case is about is that the comparison comes from the registry rather than from a literal,
    // and `channelsActableBy` is that same registry answering which room an assistant may act in.
    expect(archival).toMatch(/profiles\.channelsActableBy\(/);
  });

  it('compares the room against the assistant\'s CLASSIFICATION, not against its name', () => {
    // WHAT EVERY ASSERTION ABOVE COULD NOT SEE. They pin the detector's shape - the report, the
    // direction, the registry call - and all of them stayed true while the detector was comparing two
    // things that can no longer be equal. `agent_type` held a classification when this was written;
    // once it began naming the ASSISTANT (migration 055), `premium === 'advisor'` was false on every
    // archived bot message, so the boundary event fired on all of them, and
    // `channelsActableBy('advisor')` returned an empty set so the direction was always "above" too.
    //
    // A control that fires on every row is not a strict control. It is a silent one: the real event is
    // still reported and nobody can find it. Nothing failed, because the shape was never what broke.
    const { defaultProfileRegistry: profiles } = require('../../lib/profile-registry');
    const rooms: string[] = profiles.classificationValues().filter((v: string) => profiles.isConversational(v));

    // THE GUARD AGAINST THIS TEST BEING VACUOUS. If every assistant were still named after its
    // classification, the old direct comparison would pass this and the regression would be invisible
    // again. The shipped config renames them (premium -> advisor), and that is the premise here.
    // (If this ever fails, the message is: no assistant is named differently from its classification,
    // so the direct comparison would pass and this test proves nothing.)
    const renamed = rooms.filter((c) => profiles.requireProfileFor(c).name !== c);
    expect(renamed.length).toBeGreaterThan(0);

    // The round trip the detector depends on: every room's assistant resolves back to that room.
    for (const c of rooms) {
      expect(profiles.classificationFor(profiles.requireProfileFor(c).name)).toBe(c);
    }
    // ...and an assistant the deployment does not declare resolves to nothing, rather than to itself.
    // The detector reports that case rather than skipping it, which is why it must be distinguishable.
    expect(profiles.classificationFor('not-an-assistant')).toBeUndefined();

    // The comparison the regression was made of is gone: the row's `agent_type` is never measured
    // against the room directly, only after being resolved through the registry.
    const archival = codeOf('analytics-aurora/kinesis-archival.ts');
    expect(archival).not.toMatch(/room === r\.assistant/);
    // Through the resolver that covers a role's assistant too: `classificationFor` answers only for a
    // primary, so every message from `ops-premium` read as an undeclared identity.
    expect(archival).toMatch(/profiles\.classificationOfAssistant\(r\.assistant\)/);
    for (const c of rooms) {
      for (const role of profiles.rolesFor(c)) {
        expect(profiles.classificationOfAssistant(profiles.roleAssistantName(c, role))).toBe(c);
      }
    }
  });

  it("reads a runtime assistant's classification from its turn's stamp, on a bot's row and an unreserved name only (ADR-048)", () => {
    const archival = codeOf('analytics-aurora/kinesis-archival.ts');
    // A person's message metadata is theirs to write, so a stamp on it must not silence the report.
    expect(archival).toMatch(/const stamped = r\.is_bot && typeof analytics\.runtimeClassification === 'string' && !profiles\.isReservedAssistantName\(r\.assistant\)/);
    // The registry answers first: a declared assistant's classification is config, never the stamp.
    expect(archival).toMatch(/profiles\.classificationOfAssistant\(r\.assistant\) \?\? stamped/);
    // And the stamp is written only for an assistant that came from a runtime record.
    expect(codeOf('router-agent-handler.ts')).toMatch(/turnProfile === runtimeSeedByBotArn\.get\(botArn\) && \{ runtimeClassification: STATIC_CLASSIFICATION \}/);
    expect(codeOf('assistant-async-processor.ts')).toMatch(/turnAssistantIsRuntime && \{ servingRuntimeClassification: CLASSIFICATION \}/);
  });
});

/**
 * THE CORE DESIGN: the classification lives on the IDENTITY, not in deployment wiring.
 *
 * EVERY PRINCIPAL CARRIES ITS CLASSIFICATION, ASSISTANTS INCLUDED.
 *
 * The platform's premise, stated in the launch post, is that access is an IAM decision keyed on an
 * immutable classification tag, and that people, assistants and conversations are all ARN'd principals
 * governed the same way. Conversations were tagged from the first commit. Assistants never were:
 * `CreateAppInstanceBot` was called with `Name` and no `Tags` from 2025-12-26, and no commit in 503
 * ever added one - so `aws:ResourceTag/classification` meant something on one side of an exchange and
 * nothing on the other.
 *
 * These assertions pin the identity tag itself. They are source-level for the same reason as the block
 * above: the failure is a missing wire, and no behavioural test over a correctly-wired fixture can see
 * a wire that was never there.
 */
describe('an assistant identity carries its own classification tag', () => {
  it('tags the AppInstanceBot at creation, from the assigned classification', () => {
    // Every identity is built by the provisioner's one path (ADR-048, amended 2026-10-23), which stamps the
    // classification, the assistant, the role and the provisioner IN the create request, so no identity exists
    // untagged even for a moment.
    const provisioner = codeOf('lib/assistant-provisioner.ts');
    expect(provisioner).toContain('return { classification, assistant: assistantId, role, [PROVISIONER_TAG]: RUNTIME_PROVISIONER };');
    expect(provisioner).toMatch(/new CreateAppInstanceBotCommand\(\{[\s\S]{0,300}Tags: Object\.entries\(tags\)/);
  });

  it('reads the identity tag FIRST when auditing an assistant, with the published map as fallback', () => {
    // The auditor used to invert an SSM parameter map - a derivation, and one that only knows about
    // assistants whose ARN was published where it expected. The tag is the same signal the channel
    // side is judged on, so the comparison is now like-for-like.
    const audit = codeOf('membership-audit.ts');
    // THROUGH THE IDENTITY CLIENT, which is the half that was wrong rather than incidental. An
    // AppInstanceBot is a Chime SDK IDENTITY resource; this read it with the Messaging client, so it
    // failed on every call against real AWS, logged a warning, and fell through to the SSM map - the
    // tag-first design never executed once. Pinning the command name alone would have passed
    // throughout, because the name is identical in both SDKs.
    expect(audit).toMatch(/resolveBotClassification[\s\S]{0,400}chimeIdentity\.send\(new ListIdentityTagsCommand/);
    expect(audit).toMatch(/ListTagsForResourceCommand as ListIdentityTagsCommand/);
    // The fallback survives, because a deployment that has not redeployed yet still has untagged
    // assistants and switching the check off there would be worse than deriving.
    expect(audit).toMatch(/resolveBotClassification[\s\S]{0,900}loadBotClassificationMap/);
  });
});

/**
 * AND A PERSON'S IDENTITY CARRIES THEIR CLEARANCE, for the same reason and by the same mechanism.
 *
 * The design tags people and assistants alike.
 *
 * A person may hold several classifications, which at first looks like it rules a single tag out. It
 * does not, because the tag carries the NAME of the set rather than the set itself:
 * `resolveHolderToken` returns the declared classification whose `grants` are exactly the union of
 * what the holder's groups clear for, and the policy generator expands that one token back into the
 * set wherever a policy is built. A tag value is one bounded string and an IAM session tag is
 * single-valued, so a name is the only shape that fits - and it loses nothing, because the expansion
 * is deterministic.
 *
 * THE TOKEN NAMING THE WHOLE SET, never one group picked from it: a classification can grant any
 * set, so one group and the token naming the set a person holds can be two different values.
 *
 * THE TAG IS NOT THE ENFORCEMENT and these tests must not be read as claiming it is. What gates a
 * request is the classification-bound role the exchange vends. The tag makes the same fact READABLE
 * on the principal, so an auditor comparing a member against a channel compares two values of one
 * kind instead of deriving one of them from Cognito on every check.
 */
describe('a person\'s identity carries their clearance', () => {
  it('tags the AppInstanceUser with the SAME token the vended role was chosen from', () => {
    const exchange = codeOf('credential-exchange.ts');
    // ONE RESOLVER, ONE VALUE. The tag and the role are two consequences of a single decision, so both
    // read `roleKey` - the one token the caller holds. Two independent lookups could name different
    // things for anybody holding more than one clearance, which is exactly what happened while one
    // side asked for the highest group and the other asked for the holder's token.
    // `string | undefined` since ADR-046: an undeclared group combination resolves to NO token and
    // the exchange refuses the vend, where it used to hand back the fail-closed floor. The property
    // under test is unchanged - the role, the session assertion and the identity tag read one value.
    // The resolver and the identity helpers are the shared vend library's (lib/vend.ts).
    expect(codeOf('lib/vend.ts')).toMatch(/export function resolveRoleKey\(groups: string\[\]\): string \| undefined \{\s*return profiles\.resolveHolderToken\(groups\);/);
    expect(exchange).toMatch(/const roleArn = await resolveExchangeRoleArn\(roleKey\);/);
    expect(exchange).toMatch(/await classifyIdentity\(personId, roleKey, idpName, personCreated\);/);
    expect(exchange).toMatch(/Key: 'classification', Value: roleKey/);
    // And no single-group lookup is what stamps a principal: one group differs from the token
    // whenever a person holds more than one clearance.
    expect(exchange).not.toMatch(/clearanceForGroups\(parseGroups/);
  });

  it('repairs an EXISTING identity on the conflict branch, which runs on every exchange', () => {
    // Every identity predating this change is untagged. The conflict branch runs on EVERY exchange
    // for an existing user, so it is where an existing person becomes classified, and where a
    // promotion or demotion is re-stamped, without anybody running a migration.
    const vend = codeOf('lib/vend.ts');
    expect(vend).toMatch(/ConflictException[\s\S]{0,300}await classifyIdentity\(/);
    expect(vend).toMatch(/async function classifyIdentity[\s\S]{0,300}await tagIdentity\(userId, clearance(, ownerArn)?\);/);
    // The person's own identity is classified on every exchange, with the minter's answer to whether
    // it was just created (lib/person-identity.ts creates it; a conflict there is the existing person).
    expect(codeOf('credential-exchange.ts')).toMatch(/await classifyIdentity\(personId, roleKey, idpName, personCreated\);/);
  });

  it('NEVER carries the tag on the create call, because that coupling was a live outage', () => {
    // `CreateAppInstanceUser` with `Tags` requires `chime:TagResource` as well, so on a role without
    // it the CREATE itself fails AccessDeniedException - which is not ConflictException, so it
    // rethrows and the exchange returns no credentials at all. A missing permission on a decorative
    // field became a total authentication outage: nobody could obtain Amazon Chime SDK credentials.
    // Measured live, 2026-09-13.
    //
    // So the create is tagless and the tag is a separate best-effort call. This is the guard for the
    // most expensive mistake in this file, and it asserts the ABSENCE that keeps the exchange alive.
    const exchange = codeOf('lib/vend.ts');
    const create = exchange.match(/new CreateAppInstanceUserCommand\(\{[\s\S]*?\}\)\)/);
    expect(create).not.toBeNull();
    expect(create![0]).not.toMatch(/Tags/);
    // The minter's create, which every person goes through, is tagless too.
    const minted = codeOf('lib/person-identity.ts').match(/new CreateAppInstanceUserCommand\(\{[\s\S]*?\}\)\)/);
    expect(minted).not.toBeNull();
    expect(minted![0]).not.toMatch(/Tags/);
    // And the tag goes out under its own command, whose failure is caught rather than propagated.
    expect(exchange).toMatch(/async function tagIdentity[\s\S]{0,400}new TagResourceCommand/);
    expect(exchange).toMatch(/new TagResourceCommand[\s\S]{0,400}catch/);
  });

  it('re-stamps the tag on a clearance change, with the TOKEN the exchange would compute', () => {
    const mgmt = codeOf('user-management.ts');
    // NOT `Value: clearance`, which is what this pinned and what the code did. `clearance` is the
    // CLEARANCE GROUP being set - one role of the exclusive set - while the exchange stamps the token
    // for the caller's whole grant set, which is `admin` for an admins-group member. The two writers
    // disagreed, so an administrator's tag FLIP-FLOPPED: `standard` after an operator changed their
    // clearance, `admin` again on their next sign-in.
    //
    // THEN THEY DISAGREED AGAIN, by a different pair, which is why both sides are pinned here rather
    // than one side and a memory of the other. This asserted `clearanceForGroups` on the management
    // side alone; the exchange moved to `resolveHolderToken` when a grant set stopped being a rank
    // prefix, and a guard naming only one writer's resolver cannot see the other one leave.
    expect(mgmt).toMatch(/profiles\.resolveHolderToken\(groupsAfter\)/);
    expect(mgmt).not.toMatch(/profiles\.clearanceForGroups\(/);
    expect(codeOf('credential-exchange.ts')).toMatch(/profiles\.resolveHolderToken\(groups\)/);
    expect(mgmt).toMatch(/TagResourceCommand\(\{[\s\S]{0,200}Key: 'classification', Value: holderToken/);
    expect(mgmt).not.toMatch(/Key: 'classification', Value: clearance\b/);
    // THE PERSON THE USERNAME SIGNS IN AS, never an ARN built from the username or the sub. The
    // AppInstanceUser id is the opaque id the exchange minted, reached from the username's subject
    // through Identities; tagging by username or sub would address a principal that does not exist and
    // fail silently into the catch.
    expect(mgmt).toMatch(/personArnOfUsername\(username\)[\s\S]{0,200}ResourceARN: personArn/);
    // The admin lifecycle reads the subject's Identities row at any status, so a person disabled at their issuer, whose row is unchanged, is still re-stamped.
    // Under every issuer on the pool, so a person who signed in through a provider on it is found too.
    expect(mgmt).toMatch(/getUserSub\(username\)[\s\S]{0,200}rowOfPoolSubject\(deps\.primary, sub, deps\)/);
    expect(mgmt).not.toMatch(/ResourceARN: `\$\{APP_INSTANCE_ARN\}\/user\/\$\{username\}`/);
  });

  it('never guesses a classification when clearance is unresolved', () => {
    // An untagged principal is one a reader treats as unclassified, which is recoverable. A WRONG tag
    // on a principal is not - it would read as authority the person does not hold.
    const exchange = codeOf('lib/vend.ts');
    // No clearance, no classification tag, and with no owner tag either, no call at all - the tagger
    // stands down rather than stamping a default. A guessed classification reads as authority the
    // person does not hold.
    expect(exchange).toMatch(/async function tagIdentity[\s\S]{0,200}\.\.\.\(clearance \? \[\{ Key: 'classification', Value: clearance \}\] : \[\]\)[\s\S]{0,200}if \(!tags\.length\) return;/);
  });
});

/**
 * EVERY VEND ASSERTS THE CALLER'S CLASSIFICATION, NOT JUST THE CHAT ONE.
 *
 * The session's `classification` tag is what lets a policy require that the session and the ROLE it
 * was vended on agree - the one failure a correct role policy cannot catch by itself, because in a
 * mis-vend the policy is right and simply handed to the wrong caller.
 *
 * THIS IS A COUNT, AND THE COUNT IS THE POINT. There are three `AssumeRole` call sites here - chat,
 * archive, attachment - and the first version of this change reached only chat. A condition requiring
 * the tag would then have denied every admin-plane vend while chat kept working: no archive reads, no
 * attachment access, and a symptom that looks nothing like its cause. The same shape as the
 * tag-on-create coupling that took this function down once already: one call site changed, the others
 * left behind.
 *
 * So the assertion is counted against the call sites rather than merely found somewhere in the file.
 */
describe('every credential vend asserts both identity and classification', () => {
  /**
   * EVERY FILE THAT ASSUMES A ROLE, not one named file.
   *
   * The first version of this guard read `credential-exchange.ts` alone and counted assertions against
   * the AssumeRole calls in it. That is the right SHAPE and the wrong SCOPE: a vend in a sibling file
   * the guard could not see shipped without the assertion once. The classification role's trust policy requires
   * the tag, and `StringEquals` does not match an absent key - so every vend from that file would have
   * failed AccessDenied while the guarded paths kept working.
   *
   * Discovered by scanning rather than listed, so a FIFTH exchange added later is held to the rule
   * instead of inheriting the omission - which is the same failure this file already records for
   * `extractAgentType` and for the tag-on-create coupling.
   */
  const SRC_DIR = path.join(__dirname, '..', '..', 'lambda', 'src');
  const vendFiles = fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }))
    .filter((x) => x.src.includes('new AssumeRoleCommand'))
    // NOT A VEND: the provisioner's session (`assistant-provisioner-function.ts`) is assumed by the function for
    // itself, tagged with the classification it works at, and bears no person or assistant: nobody acts as it.
    .filter((x) => x.file !== 'assistant-provisioner-function.ts');

  it('finds every vending file (a scan that finds none passes vacuously)', () => {
    expect(vendFiles.length).toBeGreaterThanOrEqual(2);
    // The one exchange every issuer shares, its one-conversation vend included, and the assistant vend.
    expect(vendFiles.map((x) => x.file)).toEqual(expect.arrayContaining(['credential-exchange.ts', 'admin-credential-exchange.ts', 'assistant-vend.ts']));
  });

  /**
   * The body of each `new AssumeRoleCommand({...})`, so a tag written anywhere ELSE cannot be
   * mistaken for a session assertion.
   *
   * A whole-file count said `credential-exchange.ts` had four classification tags for three vends and
   * failed - correctly. The fourth is `tagIdentity`, which stamps the tag on the AppInstanceUser: the
   * same key, a different resource, and NOT an IAM input. Counting it would have let a real missing
   * session assertion hide behind an unrelated identity tag.
   */
  const assumeRoleBodies = (src: string): string[] =>
    src.match(/new AssumeRoleCommand\(\{[\s\S]*?\n\s*\}\)\)/g) || [];

  it('asserts a classification INSIDE every AssumeRole, in every file that makes one', () => {
    for (const { file, src } of vendFiles) {
      const bodies = assumeRoleBodies(src);
      expect(`${file}: ${bodies.length} parsed`)
        .toBe(`${file}: ${(src.match(/new AssumeRoleCommand\(/g) || []).length} parsed`);
      bodies.forEach((body, i) => {
        expect(`${file} vend#${i}: ${/Key: 'classification'/.test(body)}`).toBe(`${file} vend#${i}: true`);
      });
    }
  });

  it('still pins the bearer on every vend, because classification is not identity', () => {
    // The two tags answer different questions and neither replaces the other: the identity tag says who
    // may be acted as, `classification` says at what. Dropping either is a different hole. A person's
    // identity tag is `person`; an assistant's is `bot`, the AppInstanceBot its session may bear (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
    for (const { file, src } of vendFiles) {
      const identityKey = file === 'assistant-vend.ts' ? 'bot' : 'person';
      assumeRoleBodies(src).forEach((body, i) => {
        expect(`${file} vend#${i}: ${new RegExp(`Key: '${identityKey}'`).test(body)}`).toBe(`${file} vend#${i}: true`);
      });
    }
  });
});
