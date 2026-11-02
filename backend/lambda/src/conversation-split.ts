/**
 * CONTINUING A SUBJECT SOMEWHERE ELSE, WHEN THE PERSON ASKED FOR THAT (DESIGN 2.4.2).
 *
 * A queue often turns out to cover several subjects. The assistant names them and offers to continue
 * any of them in its own conversation, and this is what runs when somebody says yes to some of them.
 *
 * ── WHY THIS IS ITS OWN FUNCTION RATHER THAN A FEW LINES IN THE PROCESSOR ────────────────────────
 *
 * Creating a channel needs `chime:CreateChannel`, which cannot be tag-scoped the way the assistant's
 * other rights are: the tag that would gate it does not exist until the channel does. So it is a
 * genuinely wider grant, and where it is placed decides what an injected reply can reach.
 *
 * The processor is the component that EXECUTES MODEL OUTPUT. Putting channel creation there would
 * mean a reply that talks its way past the contract can open rooms. Putting it behind this function
 * means the model can only ever REQUEST a split, and the request is checked against a record it never
 * wrote: the offer stored when the subjects were put to the person.
 *
 * So a fully injected reply can still only create conversations that were genuinely offered, to the
 * person they were genuinely offered to, under labels that were genuinely on the table. That is the
 * same shape as a host's add-member (`membershipHandler`, `conversation-management.ts`), for the same reason.
 */

import { readPendingSplit, clearPendingSplit } from './lib/turn-lock.js';
import { createConversationFromDrift } from './lib/channel-creation.js';
import { resolveServiceAdminBearer } from './lib/service-admin-bearer.js';
import { readChannelClassificationTag } from './lib/channel-classification.js';
import type { Classification } from '../../lib/config/model-strategy.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  ChimeSDKMessagingClient,
  ListChannelMembershipsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { personIdFromArn, rosterOf } from './lib/person-arn.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
/** The classification this function is deployed for. Nothing it creates may be of a classification it does not grant. */
const DEPLOYED_CLASSIFICATION = process.env.CLASSIFICATION || '';

const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
const chime = chimeMessagingClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * WHO IS IN THE PARENT CONVERSATION, read from Chime rather than from anything stored.
 *
 * Membership is Chime-owned state, so a copy of it is a copy: it can be stale in the direction that
 * matters, which is somebody who has joined since. Read live, and on failure carry NOBODY rather than
 * guessing - a conversation missing people is a visible problem somebody reports, while one holding a
 * person who should not be there is a disclosure nobody sees.
 */
async function parentMembers(channelArn: string, botArn: string): Promise<string[]> {
  try {
    const out: string[] = [];
    let nextToken: string | undefined;
    do {
      const res: any = await chime.send(new ListChannelMembershipsCommand({
        ChannelArn: channelArn,
        ChimeBearer: botArn,
        MaxResults: 50,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      for (const m of rosterOf(res?.ChannelMemberships)) {
        // Bots are members of a channel by creation, so carrying one across would add a SECOND
        // assistant to a room that already has its own - and then two of them answer.
        if (m.kind === 'person') out.push(m.arn);
      }
      nextToken = res?.NextToken;
    } while (nextToken);
    return out;
  } catch (err) {
    console.error('[conversation-split] could not read the parent membership; carrying nobody', {
      channelArn, message: (err as Error)?.message,
    });
    return [];
  }
}

/**
 * The channel flow the spawned conversation is associated with, WITHOUT which it has no @all or
 * @assistant routing - a room that looks right and answers nobody.
 *
 * Resolved HERE rather than passed in. The caller is the processor, which holds no grant for this
 * parameter and should not: everything it could pass came through a model, and a channel flow is
 * not something a reply gets to choose.
 */
let cachedFlowArn: string | undefined;
async function resolveChannelFlowArn(): Promise<string | undefined> {
  if (!CHANNEL_FLOW_ARN_PARAM) return undefined;
  if (cachedFlowArn !== undefined) return cachedFlowArn || undefined;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: CHANNEL_FLOW_ARN_PARAM }));
    cachedFlowArn = res.Parameter?.Value || '';
  } catch (err) {
    // Not fatal: the conversation is still created, and an unrouted room is a better outcome than
    // refusing a split the person asked for. Loud, because it is a real degradation.
    console.warn('[conversation-split] could not resolve the channel flow', (err as Error)?.message);
    cachedFlowArn = '';
  }
  return cachedFlowArn || undefined;
}

/**
 * THE CLASSIFICATION THE NEW CONVERSATIONS ARE CREATED AT, read from the parent channel's immutable tag.
 *
 * NOT FROM THE REQUEST. The new channel's `classification` tag is what Layer 1 gates every later access
 * on, and `chime:CreateChannel`/`chime:TagResource` on this role are app-scoped (the tag that would gate
 * them does not exist yet), so IAM does not stop a request naming a higher classification. The
 * invariant "never above the parent's" therefore has to be enforced here, against a value the caller
 * cannot supply: the tag, which `chime:UpdateChannel` cannot change.
 *
 * REFUSES rather than falling back to the floor. A floor answer is safe for choosing who replies; it
 * is a guess for creating a resource, so an unreadable tag creates nothing. A request that names a
 * classification is held to it: a disagreement means the caller's picture of this conversation is
 * wrong, and acting on either value would be acting on a picture somebody has shown to be wrong.
 */
/**
 * REFUSED AND UNREADABLE ARE NOT THE SAME ANSWER, and collapsing them cost the person their choices.
 *
 * Both used to return `undefined`, and the caller cleared the pending offer either way on the
 * reasoning that "the person answered". That is right for a REFUSAL: they answered, we said no for a
 * stated reason, and the caller tells them. It is wrong when the tag read itself failed - a Chime
 * throttle while they were answering refused every label, created nothing, and then destroyed the
 * offer and the subjects they had picked, permanently, on a path reached by our failure rather than
 * theirs. Naming the two outcomes is what lets the offer stand for the one that is retryable.
 */
type SplitClassification =
  | { kind: 'ok'; classification: string }
  | { kind: 'refused' }
  | { kind: 'unreadable' };

async function classificationForSplit(req: ConversationSplitRequest): Promise<SplitClassification> {
  const parent = await readChannelClassificationTag(chime, req.channelArn, '[conversation-split]');
  if (!parent) return { kind: 'unreadable' };
  if (req.classification && profiles.resolveClassification(req.classification) !== parent) {
    console.warn('[conversation-split][SecurityEvent] requested classification disagrees with the parent tag; refusing', {
      channelArn: req.channelArn, requested: req.classification, parent,
    });
    return { kind: 'refused' };
  }
  // THE DECLARED SET RATHER THAN A RANK COMPARISON. This asked whether the parent
  // "outranks" this deployment, which needs an ordering that no longer exists. `grantsFor` preserves
  // the answer on a ladder deployment and is expressible on a peer one.
  //
  // NOT `channelsActableBy`: narrowing this to exactly-own is ADR-045 decision 3, which the owner has
  // held. Removing the ordering must not smuggle in the narrowing.
  if (DEPLOYED_CLASSIFICATION && !profiles.grantsFor(DEPLOYED_CLASSIFICATION).includes(parent)) {
    console.warn('[conversation-split][SecurityEvent] parent is above this deployment\'s classification; refusing', {
      channelArn: req.channelArn, parent, deployed: DEPLOYED_CLASSIFICATION,
    });
    return { kind: 'refused' };
  }
  return { kind: 'ok', classification: parent };
}

export interface ConversationSplitRequest {
  channelArn: string;
  /** The assistant whose queue was read, as a principal id. Keys the offer being answered. */
  responderId: string;
  botArn: string;
  /**
   * The turn that asked, for the log. The link in the parent is posted by that turn's processor, on its
   * own session; this function holds none.
   */
  correlationId?: string;
  /** The person answering. Must be the person the offer was put to. */
  userArn: string;
  /**
   * What the caller believes the parent's classification is. NOT what the new conversation is created
   * at - that is read from the parent's tag. When present it must agree with the tag, or nothing is
   * created. Empty or absent is no claim.
   */
  classification?: Classification | string;
  /** The subjects they chose, as the labels they were offered under. */
  labels: string[];
  originatingMessageId: string;
  channelFlowArn?: string;
  modelId?: string;
  modelName?: string;
}

export interface ConversationSplitResult {
  created: Array<{ label: string; channelArn: string }>;
  /** Named rather than silently dropped: the caller tells the person what did not happen. */
  refused: string[];
}

function principalIdFromUserArn(userArn: string): string {
  return personIdFromArn(userArn) || '';
}

export const handler = async (req: ConversationSplitRequest): Promise<ConversationSplitResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const refusedAll = (): ConversationSplitResult => ({ created: [], refused: req?.labels ?? [] });

  if (!req?.channelArn || !req.responderId || !req.userArn || !req.labels?.length) return refusedAll();
  // THE SPLIT SPEAKS AS NOBODY. It creates the conversations and returns them; the processor that asked
  // posts the link to each in the parent, as part of the answer it is already giving, on its own turn
  // session. So this function holds no assistant session: what it does is checked against the offer record
  // the router wrote, which the model never wrote, and only the classification's processor may invoke it.
  return splitAsTheAssistant(req, refusedAll);
};

async function splitAsTheAssistant(
  req: ConversationSplitRequest,
  refusedAll: () => ConversationSplitResult,
): Promise<ConversationSplitResult> {
  if (!APP_INSTANCE_ARN) {
    console.error('[conversation-split] no app instance configured; nothing can be created');
    return refusedAll();
  }

  // THE OFFER IS THE AUTHORITY, and it is read here rather than accepted from the caller. Everything
  // the caller says about what was offered came through a model; this record did not.
  const offer = await readPendingSplit({
    channelArn: req.channelArn,
    responderId: req.responderId,
    // Read AS the person answering, so an offer put to somebody else is not visible to this call at
    // all. A split is the requester's decision, and a third party disposing of work they may not even
    // be able to see is the failure this check exists for.
    speakerId: principalIdFromUserArn(req.userArn),
  });
  if (!offer) {
    console.warn('[conversation-split] no offer outstanding for this person; refusing', {
      channelArn: req.channelArn, responderId: req.responderId,
    });
    return refusedAll();
  }

  const channelFlowArn = req.channelFlowArn || await resolveChannelFlowArn();

  // READ ONCE, and only if something actually needs it. An offer of nothing but private subjects
  // never asks who else is in the room, which is both a call saved and a question not asked.
  let roomMembers: string[] | undefined;
  const carryTheRoom = async (): Promise<string[]> => {
    if (roomMembers === undefined) roomMembers = await parentMembers(req.channelArn, req.botArn);
    return roomMembers;
  };

  // THE OFFER THIS READ, NAMED. The processor decided against the offer it had; this function
  // re-reads the record and decides against whatever is there NOW. If a later turn replaced the
  // offer between those two moments, every label arrives unmatched and the split quietly does
  // nothing - so the two sets are printed together, and a mismatch reads as a mismatch.
  console.log('[conversation-split] deciding', {
    channelArn: req.channelArn,
    requested: req.labels,
    offered: offer.topics.map((t) => t.label),
  });
  const offeredByLabel = new Map(offer.topics.map((topic) => [topic.label.trim().toLowerCase(), topic]));
  const created: ConversationSplitResult['created'] = [];
  const refused: string[] = [];

  // Read once, after the offer, so a request with nothing outstanding never reads the tag at all. On
  // refusal every label is refused and the loop creates nothing; the offer is still cleared below,
  // because the person answered, and the caller tells them what did not happen.
  const resolved = await classificationForSplit(req);
  const classification = resolved.kind === 'ok' ? resolved.classification : undefined;
  if (!classification) refused.push(...req.labels);

  // THE OFFER IS CLEARED BELOW EVEN WHEN THE TAG COULD NOT BE READ, and that is deliberate rather
  // than an oversight (it is asserted by `conversation-split-checks-the-offer.test.ts`). A standing
  // offer is also `awaitingPerson`, which HOLDS the conversation for every other member, so leaving
  // it up after our own read failed traded a lost answer for an unanswerable room - the worse of the
  // two, and the bug that this clearing was introduced to fix.
  //
  // The cost is real and is not hidden: a throttle here loses the subjects the person chose, and they
  // have to be asked again. `resolved.kind` distinguishes that case from a genuine refusal so the
  // caller can say which happened, which is the part that was missing.
  for (const label of classification ? req.labels : []) {
    const topic = offeredByLabel.get(label.trim().toLowerCase());
    // A SUBJECT NOBODY OFFERED. Creating it would open a room the person did not ask for, holding
    // messages they did not send there.
    if (!topic) {
      // SAID OUT LOUD. This was a bare `continue`, so a subject refused for not being in the offer
      // and a subject that was never asked for looked identical from outside: nothing created and
      // nothing said. It is the one branch that can make the whole split a no-op while every other
      // signal - the invoke, the duration, the absence of an error - says it worked.
      console.warn('[conversation-split] a chosen subject is not in the offer this read; refusing it', {
        channelArn: req.channelArn,
        requested: label,
        offered: [...offeredByLabel.keys()],
      });
      refused.push(label);
      continue;
    }

    try {
      const result = await createConversationFromDrift({
        // The processor posts the link in the parent (see the handler); this function speaks as nobody.
        postParentLink: false,
        // The service admin creates it, so the channel flow is attached before any assistant is a
        // member and the welcome goes through the flow like any other message.
        creatorBearerArn: await resolveServiceAdminBearer(),
        appInstanceArn: APP_INSTANCE_ARN,
        botArn: req.botArn,
        userArn: req.userArn,
        // THE PARENT'S, from its tag (see classificationForSplit). The new channel's tag is what Layer 1
        // gates access on, so a conversation spawned higher would carry the parent's messages to a
        // classification the parent never had.
        modelTier: classification as Classification,
        modelId: req.modelId || '',
        modelName: req.modelName || '',
        topicLabel: topic.label,
        // ── WHO THE NEW CONVERSATION BELONGS TO (DESIGN 2.4.2) ────────────────────────────────
        //
        // A PRIVATE subject carries its requester and nobody else: the room never saw it, so
        // carrying them would publish it by the act of moving it. An ORDINARY subject carries the
        // room, because they could already read it and moving it into a conversation they are not
        // in would make a shared thread vanish for everyone but the person who answered.
        ...(topic.private ? {} : { additionalMemberArns: await carryTheRoom() }),
        ...(channelFlowArn ? { channelFlowArn } : {}),
        parentChannelArn: req.channelArn,
        originatingMessageId: req.originatingMessageId,
      });
      created.push({ label: topic.label, channelArn: result.channelArn });
    } catch (err) {
      // ONE SUBJECT FAILING IS NOT ALL OF THEM FAILING. The person chose several things; losing the
      // rest because the first threw would be a worse answer than the partial one, and the caller is
      // told exactly which did not happen.
      console.error('[conversation-split] could not create the conversation for a chosen subject', {
        channelArn: req.channelArn, label: topic.label, message: (err as Error)?.message,
      });
      refused.push(topic.label);
    }
  }

  // ANSWERED EITHER WAY, AND THAT NOW INCLUDES "EVERY ONE OF THEM FAILED".
  //
  // The condition here used to be `created.length || !refused.length`, so a reply whose every chosen
  // subject failed to create left the offer standing - and the offer is not just a question, it is
  // `awaitingPerson`. `clearPendingSplit` says why that matters in its own comment: nothing takes a
  // lock over from a holder that is waiting on somebody, so the guard that protects a person who is
  // thinking becomes the thing that strands the room. With the record's expiry removed there is no
  // longer anything behind it, so the conversation was unanswerable to every other member FOREVER,
  // on a path reached by our failure rather than theirs.
  //
  // The person answered. That is what this record was waiting for, and it is true whether or not the
  // work behind their answer succeeded. What failed is reported back to them by the caller, which is
  // where a failure belongs - a standing question they already answered cannot report anything, it
  // just holds the door shut.
  await clearPendingSplit({
    channelArn: req.channelArn,
    responderId: req.responderId,
    // The person who answered. Their subjects are settled; a subject private to somebody else is
    // still outstanding and their offer stands (ADR-033).
    ...(req.userArn ? { speakerId: principalIdFromUserArn(req.userArn) } : {}),
  });
  if (refused.length && !created.length) {
    console.warn('[conversation-split] every chosen subject failed; the offer is cleared anyway', {
      channelArn: req.channelArn, refused: refused.length,
    });
  }

  return { created, refused };
};
