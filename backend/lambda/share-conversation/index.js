const {
  ChimeSDKMessagingClient,
  CreateChannelMembershipCommand,
  DescribeChannelCommand,
  ListChannelMembershipsCommand,
  ListTagsForResourceCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
// Bundled from the TypeScript source (the stack builds this function with esbuild). The share names its
// join line to the router (`sayThroughRouter`) and speaks as no assistant itself.
const { sayThroughRouter, personJoinedThroughRouter } = require('../src/lib/say-through-router');
const { primaryAssistantOf } = require('../src/lib/conversation-primary');
// THE RECAP IS A TURN BY THE ROOM'S ASSISTANT, asked of the classification's router. This Lambda composes
// no recap and calls no model (`lib/join-recap.ts`).
const { dispatchJoinRecapTurn } = require('../src/lib/join-recap');
// WHO THE CALLER IS comes from the one resolver every handler uses (`lib/auth.ts`), bundled in like the
// helpers above, so this handler reads no claim for identity itself.
const { callerPerson, callerPersonArn } = require('../src/lib/auth');
const { appInstanceArnOf } = require('../src/lib/person-arn');
// WHO THE RECIPIENT IS, their clearance groups and their name come from the one directory, by person
// (`lib/membership-source.ts`). The email to them is not sent here: it is the welcome notice's, below.
const { defaultDirectory, primaryIssuer } = require('../src/lib/membership-source');
const { responder } = require('../src/lib/http-response');
const { chimeMessagingClient } = require('../src/lib/chime/clients');
const { readChannelTags } = require('../src/lib/channel-classification');
// A TYPE'S ISSUER NARROWING (T1, FR23), applied after the clearance check below.
const { admittedIssuersOf, resolveConversationTypeKey, typeAdmitsIssuers } = require('../../lib/config/conversation-types');

const messagingClient = chimeMessagingClient({});
const ddbClient = new DynamoDBClient({});
const CHANNEL_CONTEXT_TABLE = process.env.CHANNEL_CONTEXT_TABLE || '';

/**
 * The membership source a conversation ENFORCES, from its server-side context row (DESIGN-CONVERSATION-TYPES §6).
 *
 * A conversation whose people come from a group is kept equal to that group by the membership reconcile, so
 * a person invited here would be silently removed on the next pass. Sharing is refused instead (owner
 * decision, 2026-10-05). Read from the context row, never from channel Metadata, which members can write.
 * An unreadable row lets the share through: the worst outcome is a person the reconcile later removes,
 * which is not an access decision, so a transient read failure must not break sharing everywhere.
 */
async function enforcedMembershipSource(conversationArn) {
  if (!CHANNEL_CONTEXT_TABLE) return '';
  try {
    const res = await ddbClient.send(new GetItemCommand({
      TableName: CHANNEL_CONTEXT_TABLE,
      Key: { channelArn: { S: conversationArn } },
      ProjectionExpression: 'membershipSource',
    }));
    return (res.Item && res.Item.membershipSource && res.Item.membershipSource.S) || '';
  } catch (err) {
    console.warn('[Share] could not read the conversation membership source; allowing the share', err.name);
    return '';
  }
}

/**
 * The conversation's registered type, from the server-only context row the creator stamps. An unreadable
 * or unstamped row is the ordinary type, which is what every person-opened conversation is.
 */
async function conversationTypeOf(conversationArn) {
  if (!CHANNEL_CONTEXT_TABLE) return resolveConversationTypeKey({});
  try {
    const res = await ddbClient.send(new GetItemCommand({
      TableName: CHANNEL_CONTEXT_TABLE,
      Key: { channelArn: { S: conversationArn } },
      ProjectionExpression: 'conversationType',
    }));
    return resolveConversationTypeKey({ explicitType: res.Item && res.Item.conversationType && res.Item.conversationType.S });
  } catch (err) {
    console.warn('[Share] could not read the conversation type; reading it as the ordinary type', err.name);
    return resolveConversationTypeKey({});
  }
}

/**
 * Why sharing is refused, in English, for a caller with no locale. The chat app does not show this string:
 * it renders its own localized sentence from `code` and `membershipSource` in the response (tenet 11).
 */
function membershipSourceRefusal(source) {
  const match = /group:([^+]+)/.exec(source);
  return match
    ? `People in this conversation come from the "${match[1]}" group, so it can't be shared. Ask an administrator to add the person to that group.`
    : 'People in this conversation come from a fixed list, so it can\'t be shared.';
}

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN;

// ── CLASSIFICATION ADMISSION, FROM DEPLOYMENT CONFIG ─────────────────────────────────────────
//
// THIS MIRRORS `ProfileRegistry.resolveHolderToken` / `grantsFor`, and it applies the registry's DECISION DATA,
// read at runtime from the deployment's registry rows (`loadProfileRegistry`) and built as
// `lib/classification-admission.ts` builds it, so a classification added or removed changes nothing in this
// function's environment. `backend/test/lib/admission-mirrors-the-registry.test.ts` pins it against the
// registry across the cases that distinguish them, so the two cannot drift silently.
//
// WHAT IT REPLACES, AND WHY THAT WAS BROKEN. This file carried
// `TIER_RANK = { basic: 1, standard: 2, premium: 3 }` plus an `includes('premium')` ladder, which is
// deployment config frozen in code. Three consequences, all live:
//   - a person in `admins` only resolved to NO tier, ranked 0, and could be invited to NOTHING;
//   - an `admin`-classified conversation ranked 0, so a `basic` user passed the check for it;
//   - a declared classification the ladder had never heard of behaved as both at once.
//
// A grant set is not a rank, so the question is membership - "is this conversation's classification
// in what the recipient can reach" - never a comparison.
const { loadProfileRegistry } = require('../../lib/profile-registry');
const { classificationAdmission } = require('../../lib/classification-admission');
// Read at the start of every invocation from the runtime registry (`loadProfileRegistry`, cached), never while
// the module loads.
let ADMISSION = {};

/**
 * Every classification the recipient can reach, given their Cognito groups.
 *
 * Union of what each held classification grants, then the same rule the registry applies: if no
 * declared classification's grant set IS that union, the deployment has not named this combination and
 * the recipient reaches NOTHING. Never a near fit, and no floor - `ADMISSION` carries no
 * `failClosedTo`, because there is nothing to fall to once classifications are peers rather than levels
 * (`lib/classification-admission.ts`). This read `grants[ADMISSION.failClosedTo]`, which resolved to
 * `undefined` on every deployment and so already returned nothing; saying so is the change.
 */
function reachableClassifications(groups) {
  const grants = ADMISSION.grants || {};
  const held = [...new Set((groups || [])
    .map((g) => (ADMISSION.groupClearance || {})[g])
    .filter((c) => c && grants[c]))];
  if (held.length === 0) return [];
  // THE ADMIN PLANE RIDES BESIDE THE TOKEN (ProfileRegistry.holderOf): it grants itself alone, so the member
  // classifications held name the token and the admin plane is added to its reach.
  const plane = ADMISSION.adminPlane || [];
  const members = held.filter((c) => !plane.includes(c));
  const union = [...new Set(members.flatMap((c) => grants[c] || []))].sort();
  const named = members.length === 0 || Object.keys(grants).some((token) => {
    const g = [...(grants[token] || [])].sort();
    return g.length === union.length && g.every((v, i) => v === union[i]);
  });
  return named ? [...new Set([...union, ...held.filter((c) => plane.includes(c))])].sort() : [];
}


// Shape-check a recipient address before it reaches the directory lookup. Deliberately permissive but
// rejects quotes and whitespace, which no address carries and a lookup filter must not.
const EMAIL_RE = /^[^\s"@]+@[^\s"@]+\.[^\s"@]+$/;

// Gate internal error detail out of the HTTP response by default (logged server-side); DEBUG_ERRORS=true echoes it.
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === 'true';
// THE ROOM'S PRIMARY, which speaks for the room: the join announcement here, and the recap as its own
// turn, which the router resolves to the same assistant (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8). It must be an assistant of the classification the share
// was checked against; anything else is refused rather than spoken as.
async function resolveRoomPrimaryBotArn(conversationArn, tier) {
  const primary = await primaryAssistantOf(conversationArn, messagingClient, '[Share]');
  if (primary.classification !== tier) {
    throw new Error(`[Share] the room's primary is a ${primary.classification} assistant in a ${tier} room`);
  }
  return primary.botArn;
}

// This route allows any origin and any header, and sends no Content-Type header.
const http = responder({ origin: { fixed: '*' }, allowHeaders: '*', json: false });
const respond = (statusCode, body) => http.respond(statusCode, body);

/**
 * The recipient's clearance groups, through the one clearance seam (`Directory.groupsFor`), asked by
 * PERSON. THE GROUPS THEMSELVES, not a collapsed name: collapsing is what made an admin-only user resolve
 * to null and be refused everywhere; admission needs the whole set. A read that fails, or a person with no
 * clearance directory, holds nothing here, and the admission below refuses them.
 */
async function getUserGroups(directory, personArn) {
  try {
    return (await directory.groupsFor(personArn)) || [];
  } catch (err) {
    console.warn('Failed to list groups for the recipient:', err.name);
    return [];
  }
}

// The channel's enforced classification comes from the IMMUTABLE `classification` tag, NOT
// `metadata.modelTier`. Metadata is mutable via the owner rename cap (chime:UpdateChannel),
// so trusting it would let a moderator tamper the value to weaken the invite gate or attract an
// assistant of another classification. The tag cannot be changed by UpdateChannel.
// ── THE DECLARED CLASSIFICATIONS, FROM CONFIG, AND NO SUBSTITUTE FOR AN ABSENT ONE ──────────────
//
// This read a hardcoded `new Set(['basic', 'standard', 'premium'])` and fell back to a literal
// 'basic'. Both were wrong in the same direction once a fourth classification was declared, and the
// direction is OPEN, not closed: an `admin`-classified conversation carries a tag this set had never
// heard of, so the tag was discarded as invalid and the conversation was reported as `basic` - which
// is exactly what the caller below compares an invitee's reach against. The most sensitive room in
// the deployment read as the least sensitive one, and any basic user passed the invite gate for it.
//
// IT THEN FELL TO `ADMISSION.failClosedTo`, THE DEPLOYMENT'S FLOOR, AND THERE IS NO FLOOR. The
// admission payload has never carried that field (`lib/classification-admission.ts`), so the constant
// resolved to `''` on every deployment: the invite gate then compared `''` against the recipient's
// reach, which never contains it, so the invite was refused - but only after the bot lookup
// had asked SSM for `/assistant//bot-arn` and thrown, turning a refusal into a 500 with no account of
// why. A conversation whose classification cannot be established is now `undefined` and the caller
// refuses it as its own case, before any other work.
let VALID_CLASSIFICATIONS = new Set();

async function getChannelTier(conversationArn, _botArn) {
  try {
    const tag = (await readChannelTags(messagingClient, conversationArn)).classification;
    if (tag && VALID_CLASSIFICATIONS.has(tag)) return tag;
    console.warn('[Share][SecurityEvent] channel missing/invalid classification tag; refusing', {
      conversationArn, tag,
    });
    return undefined;
  } catch (err) {
    console.warn('[Share][SecurityEvent] could not read the channel classification tag; refusing:', err.name);
    return undefined;
  }
}

/**
 * Share a conversation with another user by email.
 * 1. Find the recipient: the address finds one subject in this deployment's directory, resolved to a person
 * 2. Enforce admission: the conversation's classification must be in what the recipient reaches
 * 3. Add recipient as a channel member
 * 4. The room's assistant announces the join, named to the router (`memberJoined`)
 * 5. Ask the room's assistant for a recap turn, targeted at the new member
 * 6. Send email notification with deep link
 */
exports.handler = async (event) => {
  ADMISSION = classificationAdmission(await loadProfileRegistry());
  VALID_CLASSIFICATIONS = new Set(Object.keys(ADMISSION.grants || {}));
  // Do NOT dump the full event — it carries the caller's verified token (email,
  // subject) and the request body (recipientEmail) into CloudWatch. Log only
  // non-PII request routing info.
  console.log('ShareConversation - Received event:', event.httpMethod, event.resource || event.path || '');

  try {
    // Without auth, a body-supplied senderName + caller identity would be
    // trusted, making this a phishing primitive. The gate is:
    //   1. The edge authorizer at API Gateway
    //   2. The caller is the person the verified token resolves to (`callerPersonArn`), and the
    //      sender line is the token's email
    //   3. Caller must be a member of conversationArn (verified below)
    const callerUserArn = await callerPersonArn(event, APP_INSTANCE_ARN);
    if (!callerUserArn) {
      return respond(401, { error: 'Unauthorized', code: 'MISSING_CLAIMS' });
    }
    const callerEmailFromJwt = (await callerPerson(event))?.contact.email ?? null;

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { conversationArn, conversationTitle, recipientEmail } = body;
    // senderName is NO LONGER taken from the body — it's derived from
    // the caller's JWT email (or a generic label if none) to prevent
    // sender-spoofing in the outbound SES email.
    const senderName = callerEmailFromJwt || 'A user of Agent Echelon';

    if (!conversationArn || !recipientEmail) {
      return respond(400, {
        error: 'conversationArn and recipientEmail are required',
        code: 'MISSING_REQUIRED_FIELDS',
      });
    }

    if (typeof recipientEmail !== 'string' || recipientEmail.length > 254 || !EMAIL_RE.test(recipientEmail)) {
      return respond(400, {
        error: 'recipientEmail is not a valid email address',
        code: 'INVALID_RECIPIENT_EMAIL',
      });
    }

    // Verify caller is a member of the target channel before allowing
    // them to add anyone else.
    try {
      const { DescribeChannelMembershipCommand } = require('@aws-sdk/client-chime-sdk-messaging');
      // Bearer = the caller themselves: they're a member, so they can read their
      // own membership. No shared bot is a member/creator, so it can't.
      await messagingClient.send(
        new DescribeChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: callerUserArn,
          ChimeBearer: callerUserArn,
        }),
      );
    } catch (membershipErr) {
      console.warn('[Share] caller not a member of channel', {
        callerUserArn, conversationArn, err: membershipErr.name,
      });
      return respond(403, {
        error: 'Caller is not a member of the target conversation',
        code: 'NOT_A_MEMBER',
      });
    }

    // Step 1: Find the recipient. THE ADDRESS IS INPUT, NEVER AN IDENTITY: it finds one subject in this
    // deployment's own directory, and that subject becomes a person through `Identities`, exactly as a
    // sign-in does (`Directory.findByAddress`). Nothing is bound by address, and an address that resolves
    // to nobody - no such subject, more than one, or a subject that has never signed in - is refused.
    const directory = defaultDirectory();
    const recipientUserArn = await directory.findByAddress(primaryIssuer(), recipientEmail);
    if (!recipientUserArn || appInstanceArnOf(recipientUserArn) !== APP_INSTANCE_ARN) {
      return respond(404, {
        error: 'No user found with that email address',
        code: 'USER_NOT_FOUND',
      });
    }
    // A DISPLAY NAME, never the address, for the join line the room reads.
    const recipientName = (await directory.displayNameFor(recipientUserArn)) || recipientEmail.split('@')[0];

    console.log('Found recipient:', { recipientUserArn });

    // Read the channel's tier as the CALLER (a member): no shared bot is a
    // member/creator, so it can't DescribeChannel. Then resolve the channel's
    // REAL per-tier bot — the
    // creator+member with authority to add members and send as the assistant —
    // and use it for every bot-attributed action below (membership add,
    // announce, recap).
    const channelTier = await getChannelTier(conversationArn, callerUserArn);
    // AN UNESTABLISHED CLASSIFICATION IS ITS OWN REFUSAL, and it comes before the bot lookup. Nothing
    // can be decided about a conversation whose classification cannot be read: the invite gate below
    // has no value to test, and the room-primary lookup would find the primary's classification
    // unequal to an empty one and throw, so the caller would see a 500 rather than a refusal. There is no floor to stand in
    // for the missing value (ADR-046).
    if (!channelTier) {
      return respond(403, {
        error: 'This conversation\'s classification could not be established, so nobody can be added to it.',
        code: 'CLASSIFICATION_UNKNOWN',
      });
    }
    // A CONVERSATION WHOSE PEOPLE COME FROM A GROUP CANNOT BE SHARED: the reconcile would undo it.
    const membershipSource = await enforcedMembershipSource(conversationArn);
    if (membershipSource) {
      return respond(409, { error: membershipSourceRefusal(membershipSource), code: 'MEMBERSHIP_FROM_SOURCE', membershipSource });
    }
    const botArn = await resolveRoomPrimaryBotArn(conversationArn, channelTier);

    // Step 2: CLEARANCE - the recipient is cleared for this conversation's classification, or is refused
    const recipientGroups = await getUserGroups(directory, recipientUserArn);
    const recipientReach = reachableClassifications(recipientGroups);
    const recipientGroupTier = recipientReach.length ? recipientReach.join('+') : null;

    // MEMBERSHIP OF THE REACH SET, not a rank comparison. A grant set need not be a rank prefix,
    // so `recipientRank < channelRank` could not express it - and ranked an admin at 0.
    if (!recipientReach.includes(channelTier)) {
      console.warn('[Share] Membership admission denied (recipient not cleared for the classification)', {
        channelTier,
        recipientGroupTier,
        recipientEmail,
      });
      // SPEC-CONVERSATION-SECURITY §4b — error at INVITE time rather than add a
      // member who'd be inert (Layer 1 would deny their send/read anyway).
      //
      // THE MESSAGE SAYS WHAT THE CHECK ABOVE ACTUALLY DOES. It used to read "their access level
      // (basic+standard) does not meet the conversation's premium tier", which describes a rank
      // comparison - the exact thing the comment above says this is NOT (ADR-046: a classification is
      // a declared set, not a ladder). A person reading "does not meet" concludes they need a HIGHER
      // level, and there is no higher: the recipient needs `premium` GRANTED, and granting something
      // else changes nothing. Saying "does not include" points at the one action that works.
      //
      // "tier" is kept because it is the accepted customer-facing word for this; what was wrong was
      // the comparison it implied, not the noun.
      return respond(403, {
        error:
          `This user cannot be added to this conversation. Their access (${recipientGroupTier || 'none'}) ` +
          `does not include the ${channelTier} tier this conversation requires, so they need the ` +
          `${channelTier} tier granted before they can be added.`,
        code: 'TIER_FORBIDDEN',
        recipientTier: recipientGroupTier,
        channelTier,
      });
    }

    // Step 2b: the type's issuer narrowing (T1, FR23), after the clearance check and never in its place. A
    // recipient whose issuers cannot be read is not admitted by a type that narrows.
    const typeKey = await conversationTypeOf(conversationArn);
    if (admittedIssuersOf(typeKey) !== null) {
      const clearance = await directory.clearanceOf(recipientUserArn).catch(() => null);
      const recipientIssuers = clearance && clearance.state === 'held' ? (clearance.issuers || []) : [];
      if (!typeAdmitsIssuers(typeKey, recipientIssuers)) {
        console.warn('[Share] Membership admission denied (issuer the type does not admit)', { typeKey });
        return respond(403, {
          error: 'This user cannot be added: conversations of this kind do not admit people who sign in the way they do.',
          code: 'ISSUER_NOT_ADMITTED',
        });
      }
    }

    // Step 3: Add recipient as channel member
    try {
      await messagingClient.send(
        new CreateChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: recipientUserArn,
          Type: 'DEFAULT',
          ChimeBearer: botArn,
        })
      );
    } catch (membershipErr) {
      if (membershipErr.name === 'ConflictException') {
        console.log('[Share] Recipient already a member, continuing');
      } else {
        throw membershipErr;
      }
    }

    console.log('Recipient added to conversation');

    // Whether the add made this a conversation of several people, for the caller's confirmation. Read
    // AS THE CALLER, who is a member (checked above), on this function's own role: it is not something
    // the assistant says. A failed read reports false rather than failing a share that already happened.
    let isNowMultiUser = false;
    try {
      const resp = await messagingClient.send(new ListChannelMembershipsCommand({
        ChannelArn: conversationArn, ChimeBearer: callerUserArn, MaxResults: 50,
      }));
      isNowMultiUser = (resp.ChannelMemberships || []).filter((m) => (m.Member?.Arn || '').includes('/user/')).length > 1;
    } catch (err) {
      console.warn('[Share] could not count the members; reporting a single-person conversation:', err?.name);
    }

    // Step 4: Announce the join, after membership so the new member sees it too. NAMED TO THE ROUTER
    // (`memberJoined`): the router says it as the room's primary from that assistant's own copy, so this
    // function holds no assistant session. A line the router could not say is logged there; the share stands.
    await sayThroughRouter(channelTier, {
      kind: 'memberJoined', channelArn: conversationArn, botArn, to: [], vars: { name: recipientName },
    });

    // Step 5: `person-joined` IS NAMED TO THE ROUTER once the membership exists (ADR-061 decision 1). Its run
    // carries the join recap for the new member, the platform's or after the version's own steps, so the share
    // asks for none of its own. Where the room's assistant declares a workflow on it, that run also welcomes the
    // new member, by email too, and the share sends no welcome of its own below, so the person is welcomed once.
    // A naming that fails owns and recaps nobody, and the share recaps and welcomes as below.
    const joinedRun = await personJoinedThroughRouter(channelTier, conversationArn, [recipientUserArn]);
    if (joinedRun.has(recipientUserArn)) {
      return respond(200, { success: true, recipientName, isNowMultiUser });
    }

    // Step 6: A recap for the new member, as a TURN BY THE ROOM'S ASSISTANT (`lib/join-recap.ts`), only where
    // the router could not be asked to run `person-joined`, whose run carries the recap otherwise.
    //
    // Asked of the router of this conversation's classification, after the add and the announcement so
    // the turn reads a conversation the new member is already in. The router resolves the room's
    // primary, answers in that assistant's model, voice and language, and targets the reply at the new
    // member alone. Not tied to the session above: the turn speaks on the session the router routes for
    // it. A recap that could not be asked for is logged there and the share stands.
    if (!joinedRun.recapped?.has(recipientUserArn)) {
      await dispatchJoinRecapTurn({ channelArn: conversationArn, classification: channelTier, memberArn: recipientUserArn });
    }

    // Step 7: THE WELCOME, TO THE NEW MEMBER ALONE, CARRIES THEIR EMAIL. Said by the room's primary through
    // its router like the join line, with the notify directive the email bridge reads off the message stream
    // (`noticeMetadata('memberWelcome')`, a `conversation-shared` notice they can mute). The email is that
    // message, sent by the bridge in Notifications: this function composes and sends none. A welcome the
    // router could not say is logged there; the share stands.
    await sayThroughRouter(channelTier, {
      kind: 'memberWelcome', channelArn: conversationArn, botArn, to: [recipientUserArn],
      vars: { name: recipientName, recap: conversationTitle || '', notifyPerson: recipientUserArn },
    });

    return respond(200, {
      success: true,
      recipientName,
      isNowMultiUser,
    });
  } catch (error) {
    console.error('Error sharing conversation:', error);
    return respond(500, {
      error: DEBUG_ERRORS ? error.message : 'Could not share the conversation. Please try again; if it persists, contact an administrator.',
      code: 'SHARE_FAILED',
    });
  }
};

// For unit tests only: the membership-source refusal, without the handler's AWS calls.
exports.__forTests = { enforcedMembershipSource, membershipSourceRefusal };
