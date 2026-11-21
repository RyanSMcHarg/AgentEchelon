const {
  ChimeSDKMessagingClient,
  CreateChannelMembershipCommand,
  DescribeChannelCommand,
  ListChannelMembershipsCommand,
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
// THE CALLER'S OWN BOUNDARY, the one every person route puts in front of its own role (`lib/conversation-access.ts`).
const { callerReachesConversation, refusalAnswer } = require('../src/lib/conversation-access');
const { typeAllows, capabilityRefusal } = require('../src/lib/type-capability');
const { appInstanceArnOf, personIdFromArn } = require('../src/lib/person-arn');
// WHO THE RECIPIENT IS, their clearance groups and their name come from the one directory, by person
// (`lib/membership-source.ts`). The email to them is not sent here: it is the welcome notice's, below.
const { defaultDirectory, primaryIssuer } = require('../src/lib/membership-source');
const { responder } = require('../src/lib/http-response');
const { chimeMessagingClient } = require('../src/lib/chime/clients');
// A TYPE'S ISSUER NARROWING (T1, FR23), applied after the clearance check below.
const { admittedIssuersOf, resolveConversationTypeKey, typeAdmitsIssuers } = require('../../lib/config/conversation-types');

const messagingClient = chimeMessagingClient({});
const ddbClient = new DynamoDBClient({});
const CHANNEL_CONTEXT_TABLE = process.env.CHANNEL_CONTEXT_TABLE || '';

/**
 * The conversation's context row, read once: the membership source it ENFORCES (DESIGN-CONVERSATION-TYPES §6) and its
 * registered type. Null when the row cannot be read, so the share is refused rather than decided on an unknown source or type.
 *
 * A conversation whose people come from a group is kept equal to that group by the membership reconcile, so
 * a person invited here would be silently removed on the next pass. Sharing is refused instead.
 * Read from the context row, never from channel Metadata, which members can write.
 * A row that was read and names no type is the ordinary type, which is what every person-opened conversation
 * is. A deployment with no context table is refused earlier, by `typeAllows`.
 */
async function conversationRowOf(conversationArn) {
  if (!CHANNEL_CONTEXT_TABLE) return { membershipSource: '', typeKey: resolveConversationTypeKey({}) };
  try {
    const res = await ddbClient.send(new GetItemCommand({
      TableName: CHANNEL_CONTEXT_TABLE,
      Key: { channelArn: { S: conversationArn } },
      ProjectionExpression: 'membershipSource, conversationType',
    }));
    return {
      membershipSource: (res.Item && res.Item.membershipSource && res.Item.membershipSource.S) || '',
      typeKey: resolveConversationTypeKey({ explicitType: res.Item && res.Item.conversationType && res.Item.conversationType.S }),
    };
  } catch (err) {
    console.error('[Share] could not read the conversation context row; refusing the share', err.name);
    return null;
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
 * THE ONE ANSWER FOR A RECIPIENT WHO CANNOT BE ADDED, whatever the reason: nobody at that address, a person not
 * cleared for the conversation's classification, or a person whose issuer the conversation's type does not
 * admit. One status, one code and no detail about the person, so the share route cannot be used to learn
 * whether an address has an account here, how its owner signs in, or which classifications they hold.
 */
const RECIPIENT_NOT_ADDABLE = 'RECIPIENT_NOT_ADDABLE';
/**
 * EVERY REFUSAL OF A RECIPIENT ANSWERS AT ONE TIME, measured from the start of the recipient's lookup: nobody at the
 * address answers after one directory read and an uncleared person after several, so each refusal is held until
 * {@link RECIPIENT_ANSWER_FLOOR_MS} after the lookup began. The response time says no more than the body does.
 */
const RECIPIENT_ANSWER_FLOOR_MS = 1500;
let clock = () => Date.now();
let pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const recipientNotAddable = async (lookupStartedAt) => {
  const left = RECIPIENT_ANSWER_FLOOR_MS - (clock() - lookupStartedAt);
  if (left > 0) await pause(left);
  return respond(403, {
    error: 'That address cannot be added to this conversation',
    code: RECIPIENT_NOT_ADDABLE,
  });
};

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
    //   3. Caller must be a current member of conversationArn, cleared for its classification (verified below)
    const callerUserArn = await callerPersonArn(event, APP_INSTANCE_ARN);
    if (!callerUserArn) {
      return respond(401, { error: 'Unauthorized', code: 'MISSING_CLAIMS' });
    }
    const callerEmailFromJwt = (await callerPerson(event))?.contact.email ?? null;

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { conversationArn: requested, recipientEmail } = body;
    // senderName is NO LONGER taken from the body — it's derived from
    // the caller's JWT email (or a generic label if none) to prevent
    // sender-spoofing in the outbound SES email.
    const senderName = callerEmailFromJwt || 'A user of Agent Echelon';

    if (!requested || !recipientEmail) {
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

    // THE CALLER REACHES THE CONVERSATION before they may add anyone to it: a current member, proven with their
    // own AppInstanceUser as bearer, and cleared for its classification. A member whose clearance no longer
    // reaches it is refused, as is anything that cannot be answered.
    const access = await callerReachesConversation(event, requested, { appInstanceArn: APP_INSTANCE_ARN, client: messagingClient });
    if (!access.ok) {
      const refused = refusalAnswer(access);
      return respond(refused.statusCode, refused.body);
    }
    // The conversation as the check named it, its full channel ARN, for every read and write below.
    const conversationArn = access.channelArn;
    // A TYPE THAT TURNS SHARING OFF IS REFUSED HERE (`lib/type-capability.ts`): a customer's room declares it off.
    const allowed = await typeAllows(conversationArn, 'sharing');
    if (!allowed.ok) return respond(allowed.statusCode, capabilityRefusal(allowed));

    // THE CHANNEL'S TIER is the classification the caller's own check read from the conversation's IMMUTABLE
    // `classification` tag, never `metadata.modelTier`, which a moderator can rewrite to weaken the invite gate.
    // The check refused a conversation with no recognized classification before anything here, so the tier is
    // always a declared classification. Then resolve the channel's REAL per-tier bot, the creator and member
    // with authority to add members and send as the assistant, and use it for every bot-attributed action
    // below (membership add, announce, recap).
    const channelTier = access.classification;
    // A CONVERSATION WHOSE PEOPLE COME FROM A GROUP CANNOT BE SHARED: the reconcile would undo it. Asked before
    // the recipient is looked up, so this answer is the same whoever the address names.
    const row = await conversationRowOf(conversationArn);
    if (!row) {
      return respond(503, capabilityRefusal({ code: 'CONVERSATION_TYPE_UNREADABLE', capability: 'sharing' }));
    }
    const { membershipSource, typeKey } = row;
    if (membershipSource) {
      return respond(409, { error: membershipSourceRefusal(membershipSource), code: 'MEMBERSHIP_FROM_SOURCE', membershipSource });
    }

    // Step 1: Find the recipient. THE ADDRESS IS INPUT, NEVER AN IDENTITY: it finds one subject in this
    // deployment's own directory, and that subject becomes a person through `Identities`, exactly as a
    // sign-in does (`Directory.findByAddress`). Nothing is bound by address, and an address that resolves
    // to nobody - no such subject, more than one, or a subject that has never signed in - is refused.
    //
    // ONE REFUSAL FOR EVERY RECIPIENT WHO CANNOT BE ADDED (`recipientNotAddable`): nobody at that address, a
    // person not cleared for this conversation's classification, and a person whose issuer this kind of
    // conversation does not admit all answer alike. The caller learns that this address cannot be added, never
    // whether an account exists behind it, how its owner signs in, or which classifications they hold. The
    // log names the person by id once one is resolved, and never carries the address that was typed.
    const directory = defaultDirectory();
    const lookupStartedAt = clock();
    const recipientUserArn = await directory.findByAddress(primaryIssuer(), recipientEmail);
    if (!recipientUserArn || appInstanceArnOf(recipientUserArn) !== APP_INSTANCE_ARN) {
      console.warn('[Share] Membership admission denied (the address names no person here)');
      return recipientNotAddable(lookupStartedAt);
    }
    const recipientId = personIdFromArn(recipientUserArn);
    console.log('[Share] Found recipient', { recipientId });

    // Step 2: CLEARANCE - the recipient is cleared for this conversation's classification, or is refused.
    // MEMBERSHIP OF THE REACH SET, not a rank comparison (ADR-046: a classification is a declared set, not a
    // ladder). SPEC-CONVERSATION-SECURITY section 4b: refused at invite time rather than added as a member
    // Layer 1 would leave inert.
    const recipientGroups = await getUserGroups(directory, recipientUserArn);
    if (!reachableClassifications(recipientGroups).includes(channelTier)) {
      console.warn('[Share] Membership admission denied (recipient not cleared for the classification)', { channelTier, recipientId });
      return recipientNotAddable(lookupStartedAt);
    }

    // Step 2b: the type's issuer narrowing (T1, FR23), after the clearance check and never in its place. A
    // recipient whose issuers cannot be read is not admitted by a type that narrows.
    if (admittedIssuersOf(typeKey) !== null) {
      const clearance = await directory.clearanceOf(recipientUserArn).catch(() => null);
      const recipientIssuers = clearance && clearance.state === 'held' ? (clearance.issuers || []) : [];
      if (!typeAdmitsIssuers(typeKey, recipientIssuers)) {
        console.warn('[Share] Membership admission denied (issuer the type does not admit)', { typeKey, recipientId });
        return recipientNotAddable(lookupStartedAt);
      }
    }

    // A DISPLAY NAME, never the address, for the join line the room reads.
    const recipientName = (await directory.displayNameFor(recipientUserArn)) || recipientEmail.split('@')[0];
    const botArn = await resolveRoomPrimaryBotArn(conversationArn, channelTier);

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
    // THE WELCOME NAMES THE CONVERSATION BY ITS OWN NAME, read as the caller, who is a member (checked above), so what
    // the recipient reads is what the room is called. A failed read leaves the name out, and the share stands.
    const conversationName = await messagingClient.send(new DescribeChannelCommand({ ChannelArn: conversationArn, ChimeBearer: callerUserArn }))
      .then((r) => r.Channel?.Name || '')
      .catch((err) => { console.warn('[Share] could not read the conversation name for the welcome:', err?.name); return ''; });
    await sayThroughRouter(channelTier, {
      kind: 'memberWelcome', channelArn: conversationArn, botArn, to: [recipientUserArn],
      vars: { name: recipientName, recap: conversationName, notifyPerson: recipientUserArn },
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
exports.__forTests = {
  conversationRowOf,
  membershipSourceRefusal,
  RECIPIENT_ANSWER_FLOOR_MS,
  setTiming: (t) => { if (t.clock) clock = t.clock; if (t.pause) pause = t.pause; },
};
