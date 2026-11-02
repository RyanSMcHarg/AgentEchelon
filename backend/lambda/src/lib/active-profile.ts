/**
 * Active profile resolution — SPEC-PORTABLE-PROFILES P0 ("store + decouple").
 *
 * The capability-profiles migration froze a profile as deploy-time-only, 1:1 with a classification.
 * P0 relaxes exactly that: a profile's *behavioral* fields resolve at runtime from the **active
 * version** in SSM (native parameter versions + an `active` label — no new datastore, §3) instead of
 * baked-in deploy-time env. Activating/editing/importing a version is then a data write, not a deploy.
 *
 * THE BEHAVIOR / PRINCIPAL CUT (§7 — load-bearing). A version changes what the assistant DOES, never
 * who it IS or what it MAY do. So this resolver merges ONLY the runtime-editable fields of the active
 * version OVER the compiled seed; the boundary fields (contextScope — an IAM `s3:GetObject` grant) are
 * ALWAYS taken from the seed, never from SSM. A tampered/hostile active version therefore cannot widen
 * scope: the widest thing it can express is ignored at resolution. The model-ARN boundary is enforced
 * separately — a version's modelKey must resolve within the deployment's `bedrock:InvokeModel`
 * allowlist (validated at write time in P1; here an out-of-catalog key simply fails closed to the seed).
 *
 * FAIL-CLOSED. Any failure — the param/label is absent (no version seeded yet), unreadable, malformed,
 * or fails validation — falls back to the compiled seed (`defaultProfileRegistry.profileByName`), never
 * to "no profile". A deployment that never seeds a definition behaves EXACTLY as today (the P0 acceptance
 * bar: behavior diff empty on the seed). Result is cached per warm container for a short TTL so an
 * activation converges within the TTL without a redeploy.
 *
 * SCOPE. A version carries the whole of what SPEC-PORTABLE-PROFILES calls a profile:
 * the model bundle, the tool allowlist, the guardrail selection, the persona, the INTENT PACK, the
 * copy, the task machines and the context selection. Persona and pack each keep their per-deployment
 * SSM/env seam as the FALLBACK for a version that does not carry one, so a deployment that has not
 * migrated behaves exactly as it did.
 *
 * The pack was the last field to arrive, and the shape of its absence is worth keeping: P0 scoped this
 * body from the compiled `AssistantProfile` TYPE rather than the spec sentence, and the pack was never a
 * field on that type - it lived in its own SSM parameter behind its own module, so it was structurally
 * invisible to the scoping. `machines`, a block INSIDE the pack, crossed anyway. Half a field moved and
 * the taxonomy it belongs to did not, for months, while each increment wrote a sentence calling the pack
 * "the remaining seam" instead of bringing it across.
 *
 * WHAT A VERSION DELIBERATELY DOES NOT CARRY. `classifierMode`, `timeoutSeconds`, `taskSupport`,
 * `rateLimitPerHour`, `battleEligible` and `models.complex` were all in this body once, and none of
 * them ever changed a turn: every reader takes them from the COMPILED deployment config
 * (`lib/config/profiles.ts`, via `defaultProfileRegistry`) or, for `timeoutSeconds`, from the Lambda's
 * `AssistantTopology` - which a running function cannot change at all. A version carrying them said an
 * operator could publish a live change that publishing could not make, so they are gone from the
 * versioned artifact and unchanged in the deployment config. See
 * `docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` section 2.3 for where each one is read,
 * and `backend/test/versioned-profile-omits-deploy-time-fields.test.ts` for the guard that keeps them
 * out.
 */
import type { LegacyWelcome } from './legacy-welcome-migration.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHash } from 'node:crypto';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import type { AssistantProfile } from '../../../lib/config/profiles.js';
import { INTENT_ROUTE_STRATEGY, getModelCatalog } from '../../../lib/config/model-strategy.js';
import type { IntentRouteDefinition, RouteKey, BackendModelKey } from '../../../lib/config/model-strategy.js';
import { ALL_TOOL_NAMES, unknownTools } from './tool-registry.js';
import { IMAGE_GEN_MODELS, type ImageGenModelKey } from './image-gen-models.js';
import { IMAGE_ROUTE_KEY, imagePrimaryOf, isImageModelKey, isImageRoute, routeKindError, textRoutesOf } from './image-route.js';
import { stepShapeErrors, type IntentRoute } from './step-models.js';
import { type TaskStateMachine, type ConfirmPolicy, CONFIRM_POLICIES } from './task-state-machines.js';
import { validateIntentPackBody, intentKeysOf, needsOf, resolveStoredPack, UNIVERSAL_INTENT_KEYS, WORK_MANAGEMENT_INTENT_KEYS, type IntentPack, type StoredIntentPack } from './intent-pack.js';
import { parseIntakeConfig, type IntakeConfig } from './onboarding-intake.js';
import { retiredRouteKeyError, routesAsServedByTheFloor, TRIVIAL_ROUTE_KEYS } from './model-resolver.js';
import { hydrateBodies, type ProfileBodyRef } from './profile-bodies.js';
import type { WorkflowLayout } from './workflow-layout.js';
import { isNoActiveVersion } from './active-label.js';
import { modelFits, outputOf } from '../../../lib/config/model-availability.js';
import { buildSourceTable, sourceLookup, whenErrors, withUnreadCatalog } from './variables.js';
import { GOLDEN_SET_CAPACITY } from './golden-upload.js';

/** Current definition schema version. Bumped when the serialized shape changes (import migrations, §5). */
export const PROFILE_DEFINITION_SCHEMA_VERSION = 1 as const;

/**
 * Default per-profile image-generation model (an `ImageGenModelKey`). `stability_image_core` is an
 * `aws-bedrock`, `active` model that needs NO external API key, so image generation works out of the
 * box (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "image generation must become a normal capability"). Kept
 * off `models.default` deliberately: image keys are NOT `BackendModelKey`s (no resolver/classification/
 * token ripple — see image-gen-models.ts), so `models.image` is a SEPARATE, registry-validated field.
 */
export const DEFAULT_IMAGE_MODEL: ImageGenModelKey = 'stability_image_core';

/**
 * The default image route's FALLBACK: `stability_image_ultra`, another `aws-bedrock`, `active` model that
 * needs no external key and lives in the same region as the primary, so the guardrail that covers the
 * primary covers it too.
 */
export const DEFAULT_IMAGE_FALLBACK_MODEL: ImageGenModelKey = 'stability_image_ultra';

/** Each route of `routes` with the image part `images` names for its intent, a route with no text model where there is none. */
export function withImageParts(routes: Record<string, IntentRoute>, images: Record<string, IntentRoute>): Record<string, IntentRoute> {
  const out: Record<string, IntentRoute> = { ...routes };
  for (const [key, part] of Object.entries(images)) out[key] = { ...(out[key] ?? {}), ...part };
  return out;
}

/**
 * THE DEFAULT IMAGE ROUTE, the one place a seed takes it from: each intent in `routeKeys` (by default
 * `image_generation`) routed to {@link DEFAULT_IMAGE_MODEL} with {@link DEFAULT_IMAGE_FALLBACK_MODEL} as its
 * fallback, each kept only where the classification allows it (a fallback only beside its primary). Empty
 * where the classification allows no default image model. Undefined classification confines nothing.
 */
export function defaultImageRoute(
  classification: string | undefined,
  routeKeys: readonly string[] = [IMAGE_ROUTE_KEY],
): Record<string, IntentRoute> {
  const fits = (k: ImageGenModelKey) => !classification || modelFits(k, classification, 'image') === null;
  if (!fits(DEFAULT_IMAGE_MODEL)) return {};
  const route = { primary: DEFAULT_IMAGE_MODEL, ...(fits(DEFAULT_IMAGE_FALLBACK_MODEL) ? { fallback: DEFAULT_IMAGE_FALLBACK_MODEL } : {}) };
  // The route's IMAGE PART (ADR-064 decision C): the shipped `image_generation` route names no text model of its own.
  return Object.fromEntries(routeKeys.map((key) => [key, { image: { ...route } }]));
}

/**
 * The route keys of every intent a pack declares that needs an image (`needsOf`): `image_generation` and any
 * intent of the pack's own, such as `logo`, that declares `needs: 'image'`. Without a pack, the platform's.
 */
export function imageIntentRouteKeysOf(intentPack: StoredIntentPack | undefined): string[] {
  if (!intentPack) return [IMAGE_ROUTE_KEY];
  return [...new Set(resolveStoredPack(intentPack).intents.filter((d) => needsOf(d) === 'image').map((d) => d.key))];
}

/**
 * The RUNTIME-EDITABLE behavioral fields a version may carry (§7). Deliberately a SUBSET of
 * `AssistantProfile`: `name` is identity (the /assistant/{name} segment, not editable) and
 * `contextScope` is a boundary (IAM grant, deploy-time), so neither appears here.
 */
/**
 * The per-profile model bundle (SPEC-ASSISTANT-CONFIG §4 unification). Model selection is PROFILE-level,
 * not a global strategy table: each profile version decides its own base and classifier model and its
 * per-intent overrides, all bounded by the classification's `bedrock:InvokeModel` allowlist (the
 * security boundary — validated at the write path, §7). `byIntent` moves per-intent routing OFF the
 * global `model-strategy` table and onto the profile, which is the level of control a portable,
 * versioned assistant needs (SPEC-PORTABLE-PROFILES §6).
 */
/**
 * Sentinel model value meaning "follow the classification-set default, whatever it is now". Stored
 * EXPLICITLY (a field carrying `'default'` is visible, self-documenting, and — unlike a concrete model
 * key — is NOT pinned: it deliberately tracks the platform default as it changes over time, rather than
 * freezing today's model into the profile). The seed uses it for the classifier so a profile's choice to
 * ride the platform classifier is recorded as a choice, not an absence. Resolution treats it exactly like
 * "unset" (falls back to the applicable default); the write-path catalog check skips it (it names no
 * catalog model). NEVER materialize it into a concrete key on read — that would defeat the tracking.
 */
export const DEFAULT_MODEL = 'default';

/** A concrete (non-sentinel, non-empty) model key, or undefined — so `?? fallback` chains skip both a
 *  blank field and the `'default'` sentinel and land on the applicable default. */
export function concreteModel(v: string | undefined): string | undefined {
  return v && v !== DEFAULT_MODEL ? v : undefined;
}

export interface ProfileModels {
  /** Base model. OPTIONAL: blank OR `'default'` ⇒ inherit the CLASSIFICATION default
   *  (`models.default` on the classification's registry entry, shown in the Model Strategy tab). A profile only sets this to a
   *  concrete key to override the classification default. */
  default?: string;
  /** LLM intent-classifier model. Blank OR `'default'` (the seeded value) ⇒ inherit the deployment default
   *  classifier (Haiku / CLASSIFIER_MODEL). Profile-level; resolved per-classification via the serving
   *  profile. Seeded EXPLICITLY as `'default'` so the profile records "follow the platform classifier" as
   *  a choice that tracks the default over time — never a pinned snapshot. */
  classifier?: string;
  /** Per-intent-route model overrides, keyed by ROUTE key (the `IntentRouteDefinition.intent`): each
   *  carries the `primary` model and an optional `fallback` (resilience degrade target). Absent route ⇒
   *  `default`. Seeded from the legacy global `INTENT_ROUTE_STRATEGY` so resolution is byte-identical
   *  until an operator edits it. (Richer than the spec's flat `Record<intent, modelKey>` so the
   *  per-intent FALLBACK — not just the primary — moves per-profile too; a bare-string form would lose
   *  the graceful-degrade model the global strategy carried.)
   *  A route whose primary is an IMAGE model generates an image for that intent (`image-route.ts`); its
   *  fallback is then an image model too. Only text routes reach the text resolver (`buildIntentStrategy`). */
  byIntent?: Record<string, IntentRoute>;
  /**
   * Per-profile IMAGE-generation model (an `ImageGenModelKey` from the self-contained IMAGE_GEN_MODELS
   * registry, e.g. `stability_image_core`). Grants this profile the image-generation CAPABILITY: on an
   * `image_generation` intent the worker produces an image with this model. Absent ⇒ the profile has no
   * image capability: an `image_generation` turn fails fast with an error naming what is unconfigured
   * (`assistant-async-processor.ts`) rather than being answered as text. Validated against IMAGE_GEN_MODELS
   * keys in a SEPARATE branch — deliberately NOT a `BackendModelKey`, so it never rides the text-catalog
   * `byIntent`/resolveModelForIntent path (those assume Converse text models). See image-gen-models.ts.
   *
   * LEGACY. An image model is now a `byIntent` route whose model is an image model (`image-route.ts`), with
   * a primary and a fallback like every other intent. This field is still read, as the primary of the
   * `image_generation` route when that intent has no route of its own (`imageRouteFor`).
   */
  image?: string;
  /**
   * ROUTING RULES OVER THE TURN'S SIGNALS (ADR-060 decision 6): `[{ when: { 'signal:userLanguage': 'zh' }, model: 'deepseek_v3' }]`.
   * The first rule whose condition holds and whose model the classification selects serves the turn, after an
   * experiment override and before the built-in context rules (`resolveModelPlan`). A condition reads only
   * values that may decide, never member text, and never a fact about the person, because the room reads the reply.
   */
  routing?: import('./resolve-model-plan.js').RoutingRule[];
}

/**
 * The retired lines a version stored before message templates, by the key each line was known by. Read by
 * `npm run migrate-legacy-copy` alone, and the static type of the words object a turn carries its templates on.
 */
export interface AssistantCopy {
  /** One message is waiting. */
  queuedOne?: string;
  /** Several are waiting. `{count}` is substituted with how many. */
  queuedMany?: string;
  /**
   * The bound was hit and the OLDEST waiting message was dropped.
   *
   * Whatever a deployment writes here must still say something was LOST and can be sent again. The
   * count quietly ceasing to rise is the one thing this line cannot be allowed to become, because it
   * is the only place a person is told a message of theirs will never be answered.
   */
  queuedOverflow?: string;
  /**
   * THE QUEUE COULD NOT BE WRITTEN, so the message is neither answered nor waiting.
   *
   * The rarest line here and the one with the least room for softening: nothing will pick this
   * message up, so whatever a deployment writes must ask for it again. Saying "I will get to it"
   * would be a promise nothing in the system can keep.
   */
  queueWriteFailed?: string;
  /** The queue has been read and is empty. `{count}` is substituted with how many were read. */
  queueSettled?: string;
  /**
   * Posted in a conversation when one of its subjects moved to a conversation of its own, carrying the
   * link to it. `{title}` is substituted with the subject's title. The conversation it is posted in stays
   * open, so the line must not say it ended.
   */
  topicMoved?: string;
  /**
   * The person stopped the assistant: the in-flight answer is discarded, their work in progress is
   * cancelled, and they will be asked how to proceed. Whatever a deployment writes must not say the
   * work is kept or paused - it is cancelled, and finished work was never touched.
   */
  stopped?: string;
  /**
   * THE WORK IS CANCELLED, BUT THE QUESTION ABOUT PROCEEDING COULD NOT BE ASKED.
   *
   * The same shape as `queueWriteFailed` and with the same rule: the ordinary `stopped` line promises
   * a question, and when the evaluation turn could not be dispatched that is a promise nothing in
   * the system can keep. Whatever a deployment writes must say the work is cancelled and that they
   * can simply ask for it again, rather than leave them waiting for a question that is not coming.
   */
  stopCancelledButNotAsked?: string;
  /**
   * THE STOP LANDED, BUT THE WORK COULD NOT BE CANCELLED.
   *
   * The running answer is still suppressed, so the person sees the stop working, while the task
   * record stays open. Whatever a deployment writes must say the work was NOT cancelled and that
   * sending `/stop` again retries, because a line that sounds like success leaves open work the
   * person believes is gone.
   */
  stopCancelFailed?: string;
  /**
   * They answered the stop question by letting the work go. The work is already cancelled, so this
   * confirms rather than acts; it must not offer to carry on with something they just declined.
   */
  stopLeftCancelled?: string;
  /**
   * The person's message answers work a DIFFERENT assistant owns, and it could not be handed to that
   * assistant. `{name}` is substituted with the owning assistant's display name.
   *
   * Whatever a deployment writes must say this assistant did NOT answer in the owner's place and that
   * sending the message again retries. A line that sounds like an answer leaves the person waiting on
   * a reply nobody is producing.
   */
  handoverOwnerUnavailable?: string;
  /**
   * A reply started with a reference (`#<n>`, ADR-035) that names nothing its sender may answer.
   * Sent only to the sender. `{ref}` is the number as typed and `{items}` is one line per open item
   * they may answer, each with its reference.
   */
  taskRefNotFound?: string;
  /** The same reply when the sender has no open item here to offer instead. `{ref}` as above. */
  taskRefNothingOpen?: string;
  /**
   * The public line left in place of an answer about a private item, when the person's message was
   * public and the answer was sent to them privately. Read by the room, so it must name nothing about
   * the work: it says only that they were answered privately.
   */
  answeredPrivately?: string;
  /**
   * The line the platform adds under a question about an item when the person has more than one open
   * item here (ADR-035). `{ref}` is that item's reference. Must tell them to start their reply with it.
   */
  taskRefHint?: string;
  /**
   * The line the platform adds when a turn ADVANCED an item without finishing it.
   *
   * Written by the platform and never by the model, for the same reason the reference hint is: it
   * states a fact the person acts on, and a turn that believed it had finished the work is exactly
   * the turn that will not say otherwise. `{state}` is where the item now stands and `{next}` is what
   * comes after it.
   */
  taskStillOpen?: string;
  /**
   * The private receipt when a person's message resumed held work and the turn posted its ANSWER in
   * the conversation. Must say where the answer is: a receipt only its sender sees is otherwise
   * indistinguishable from the answer having gone nowhere.
   */
  resumedChainAnswered?: string;
  /**
   * The same receipt when the resumed turn posted a QUESTION instead. Must point at the question, not
   * at an answer that does not exist yet.
   */
  resumedChainAsked?: string;
  /**
   * `/stop` was sent privately in a group, so nothing was stopped. A stop pauses the
   * assistant for everyone, so it must be sent to the whole conversation. Sent only to the sender. Must
   * say that nothing has been stopped.
   */
  stopMustBePublic?: string;
  /**
   * A message began with a private address (`.<member>`) naming a real member but arrived without a
   * `Target`, so the ROOM can read it rather than only the person named. The message is KEPT;
   * this line is the notice, sent by the channel flow only to the sender.
   *
   * THIS KEY REPLACED `privateMessageLackedTarget`, and the rename is the point rather than tidying.
   * That key's contract required a line saying the message "was NOT delivered" and to send it again,
   * which became false when the message stopped being deleted: a deployment honoring the old contract
   * would tell somebody their words had vanished while the room was reading them, and invite a re-send
   * the room would also read. A deployment that had customized the old key gets the fallback until it
   * writes this one, which is the safe direction - the fallback is true.
   *
   * Whatever a deployment writes must say the message IS visible to everyone, and must not promise an
   * answer: this is the variant for an address naming a PERSON, where no turn follows.
   */
  privateMessageNotPrivate?: string;
  /**
   * The same situation, except the private address named an ASSISTANT, so the turn IS routed to it and
   * answered privately to the sender.
   *
   * A SEPARATE LINE because the person needs to know an answer is coming and where it will appear. The
   * `privateMessageNotPrivate` wording would leave somebody who just asked an assistant a question
   * believing nothing was going to happen.
   */
  privateMessageNotPrivateAnswering?: string;
  /**
   * A message began with a private address (`.<member>`) naming a real member, but was stored with a
   * `Target` naming somebody ELSE, so it reached the wrong person and was removed. Sent by the channel
   * flow only to the sender.
   *
   * A SEPARATE LINE FROM the two above, and it must stay one. Those say the room can see the message,
   * which on this branch is false: it went privately to one wrong member. Whatever a deployment writes
   * must say that the person NAMED did not receive it and that sending it again is the remedy. It must
   * not say the message was never delivered - it was, to somebody - and it must not name who received
   * it, because the sender addressed one person and telling them a second name is a disclosure in its
   * own right.
   */
  privateMessageWrongTarget?: string;
  /**
   * The notice the conversation's assistant posts when a moderator archives the conversation. Carries
   * {who}, the archiver's display name in the room, and {date}, the archive date. Must say the
   * conversation is now read-only.
   */
  conversationArchived?: string;
  /**
   * THE REQUEST THE RECAP TURN ANSWERS when somebody is added to a conversation (`lib/join-recap.ts`).
   *
   * Read by the MODEL, not by the room: the assistant answers it privately to the new member, in its own
   * voice and the conversation's language, as a `conversation_summary` turn. Whatever a deployment writes
   * here should ask for a short catch-up on what the conversation is about and where it stands, and should
   * read as a plain request rather than a list of instructions, because the input guardrail screens it.
   */
  joinRecapRequest?: string;
  /**
   * The person attached a file larger than the model can take in - too many bytes, or an image whose
   * pixel edges are over the limit - so the turn was answered WITHOUT it. Both
   * limits live in one place, `lib/attachment-budget.ts`, which also carries the shipped English and
   * why each number is what it is. One line covers both: the person's remedy is the same either way,
   * and a line that named the reason would have to name it in every language a deployment speaks.
   *
   * Whatever a deployment writes must say all three of: the file arrived, it was NOT read, and the
   * answer that follows was written without it. A line that only apologizes leaves the person unable to
   * tell whether the reply accounted for their file, which is the one thing they cannot work out for
   * themselves. `{name}` is substituted with the file's name where one is known.
   *
   * Said only by the turn that CARRIED the file. The same file re-offered from conversation history on
   * a later turn is skipped in silence, because a person apologized to on every subsequent turn learns
   * nothing new and cannot make it stop.
   */
  attachmentTooLargeToRead?: string;
  /** `/stop` arrived, but nothing of this person's was running here. */
  stopNothingToStop?: string;
  /**
   * `/stop` was not addressed and the room holds more than one assistant, so nothing was stopped.
   *
   * Whatever a deployment writes here must still say that NOTHING has stopped yet and ask which
   * assistant was meant. A line that merely acknowledges the stop would be the worst of both: the
   * person believes their work is stopped and it is still running.
   */
  stopAmbiguous?: string;
  /**
   * Triage spent its bounded loop without reaching a reading, so it asks instead of guessing.
   *
   * Whatever a deployment writes here must still ASK something answerable. A line that merely says
   * the assistant is confused leaves the person with nothing to do and their messages still queued.
   */
  triageUnclear?: string;
  /**
   * The reading was refused, so the queue was drained against one derived from the messages.
   *
   * Said in addition to what was captured, never instead of it. A deployment writing this must keep
   * it an INVITATION TO CORRECT: the derived reading takes each message separately and prioritizes
   * nothing, so the person is the only one who can say whether that is what they meant. This is the
   * path where the assistant's expectation is most likely to be wrong, which is why it asks hardest.
   */
  triageDerived?: string;
  /**
   * The queued messages could not be READ from the channel at all, so nothing was captured.
   *
   * Distinct from `triageDerived`, and the difference matters to the person: there, work exists and
   * may be grouped wrongly; here nothing exists yet and their messages are still waiting. Whatever a
   * deployment writes must not imply anything has been picked up.
   */
  triageUnreadable?: string;
  /**
   * The turn CHANGED something and then produced no words of its own.
   *
   * The model ended on a tool block with no text, after running a tool that persists. Something
   * really happened, so this line says that and stops: it must not apologise, must not describe what
   * it could not do, and must never invite a retry, because retrying re-runs work that already ran.
   * Observed on the split-answer turn, where the split was applied and the person was told nothing
   * had changed and to try again.
   *
   * Whatever a deployment writes must state that the work was carried out. A line that hedges leaves
   * the person unsure whether to redo it, which is the whole failure this replaces.
   */
  completedWithoutSummary?: string;
  /**
   * The turn produced no words AND changed nothing, so there is nothing to report and nothing to undo.
   *
   * The counterpart to `completedWithoutSummary`, and the distinction is the whole point: here the
   * person's request did not happen, so asking again is the right thing to do and this line must say
   * so. Whatever a deployment writes must make clear nothing was done, or somebody will assume it was.
   */
  nothingChanged?: string;
  /** What a battle side's round-2 placeholder becomes when it declines to rebut. */
  battleNoRebuttal?: string;
  /** The note after a long answer whose later parts could not be posted. Says the answer is incomplete. */
  answerTruncated?: string;
  /** A task's failure reason when its answer could not be delivered, as the person sees it on the task. */
  answerUndelivered?: string;
  /** A battle challenger's name when it matches the live assistant's, with {name}; marks it as the challenger. */
  battleAltName?: string;
  /** The challenger's name in the Battle Mode ON line when its profile's name cannot be read; never its id. */
  battleChallengerUnnamed?: string;
  /**
   * A subject the person chose to continue elsewhere could not be given its own conversation.
   *
   * SAID, NEVER SWALLOWED. The reply this is appended to has already told them it was moving those
   * subjects, so silence here leaves them looking for a conversation that was never created - and
   * looking somewhere the messages are not. Whatever a deployment writes must name what did not
   * happen, say the work is still here, and leave the door open to trying again.
   */
  splitRefused?: string;
  /**
   * What the ROOM sees while the assistant deals with private requests.
   *
   * MUST STAY GENERIC. Naming a person, a subject, or even how many there are would publish exactly
   * what the private message exists to keep private - and this line is public by definition. It says
   * that something is happening, because silence reads as a stalled turn, and it says nothing else.
   */
  addressingPrivately?: string;
  /**
   * Sent privately to each person whose request in a drained queue was private, naming their requests.
   * `{labels}` is substituted with the requests, joined by commas. Addressed to that person alone, so it must
   * not repeat anything the room should not see.
   */
  privateFollowUp?: string;
  /**
   * How the room is told that some of the queue was private, with {count} for the number.
   *
   * A COUNT AND NOTHING ELSE. The proposal is posted to the conversation and cannot be addressed to
   * anybody, so a label for a targeted request would describe, to every member, what somebody asked
   * for privately. That the queue HELD private requests is not itself private - the deferral notice
   * already says how many messages are waiting - so this says how many and stops.
   *
   * Whatever a deployment writes must not name a person or a subject.
   */
  queuedPrivateCount?: string;
  /**
   * How this assistant heads the queued messages it could not make out (maintainer, 2026-09-03).
   *
   * A queue reading may hold a message and still be unable to tell what it asks for. Saying so is
   * better than guessing a request, because a guess becomes a work item the person has to notice and
   * correct - so the proposal names those messages separately from the work it DID understand.
   *
   * Whatever a deployment writes must ask rather than assert, and must not quote the message: the
   * proposal is posted to the room, and reading somebody's words back to them there is what the
   * targeting rules exist to prevent.
   */
  queuedUnclear?: string;
  /**
   * How this assistant offers to work through outstanding clarifications, with {count} for how many.
   *
   * A COUNT AND NOTHING ELSE, for the reason `queuedPrivateCount` gives: several people may be
   * waiting on questions of their own, the message is posted to the room, and re-stating each one
   * would republish in public what was asked of each of them. That clarifications are outstanding is
   * not private; what any of them says is.
   *
   * Whatever a deployment writes must OFFER rather than announce. This wording is used only when no
   * order is established between the questions and the work already open, and the whole point of
   * asking is that the assistant does not get to decide that by itself.
   */
  clarificationsOffer?: string;
  /**
   * How this assistant says it is taking outstanding clarifications up now, with {count}.
   *
   * Used when nothing else is open or the questions outrank what is, so this ANNOUNCES rather than
   * asks - and must still leave the person able to say no, because they may know something the
   * ordering does not.
   */
  clarificationsWorkingThrough?: string;
  /** Opens the composed reading of the queue, when the model's own words cannot be used. */
  triageUnderstood?: string;
  /** Heads the queued messages that change the work already in flight. */
  triageAmendsHeading?: string;
  /** Heads the order of new work when work is already open here, so the order shown is the whole order. */
  triageOrderAgainstOpen?: string;
  /** Heads the order of new work when nothing else is open. */
  triageOrderNew?: string;
  /** One arriving item in a list that mixes it with open work. `{label}` is the item. */
  triageNewItem?: string;
  /** Holds an open private task's place in the order. Read by the room, so it must name nothing about the task. */
  triagePrivateTaskLabel?: string;
  /** The label for a queued message that had no text to take a label from. */
  triageDerivedLabel?: string;
  /** Heads the requests whose task write failed. `{count}` is how many. Must say they were not recorded. */
  triageCouldNotRecord?: string;
  /** Counts the unrecorded requests that were private. `{count}`; must not name a person or subject. */
  triageCouldNotRecordPrivate?: string;
  /** Asks for the unrecorded requests to be sent again. Must ask; nothing else will pick them up. */
  triageResendLost?: string;
  /** Asks whether to finish the work in flight, when the reading could not tell. */
  triageAskInFlight?: string;
  /** Closes the reading by inviting the person to change the order or drop something. */
  triageInviteCorrection?: string;
  /**
   * What this assistant says when a turn died and its retries are spent.
   *
   * The person is owed something: they sent a message and nothing came back. Whatever a deployment
   * writes must say the work did not finish and that sending it again is worth doing - and must not
   * name internals, which are the platform's problem rather than theirs.
   */
  turnFailed?: string;
  /**
   * THE REFUSAL, when a person asks for something this assistant does not offer (DESIGN-CAPABILITY-
   * REFUSAL §6). Every line falls back to a shipped default, so a deployment words only what it wants.
   *
   * `capabilityUnavailable` carries {output} and is used for a request that hands something over (a
   * document, an image); `capabilityNotOffered` for one that does not. The access lines are the
   * onboarding intake's rule: `capabilityHasAccess` and `capabilityHasAccessClose` frame a list of the
   * classifications the person reaches that would serve it, one per line; `capabilityNeedsAccess`
   * ({output}) and `capabilityNotOfferedNeedsAccess` send them to their administrator and must name no
   * classification. The access lines only ever reach the person who asked.
   *
   * Authored in one language, like every other line here.
   */
  capabilityUnavailable?: string;
  capabilityNotOffered?: string;
  capabilityHasAccess?: string;
  capabilityHasAccessClose?: string;
  capabilityNeedsAccess?: string;
  capabilityNotOfferedNeedsAccess?: string;
  /** The nouns {output} takes: what a `document` and an `image` request hand over. */
  capabilityOutputDocument?: string;
  capabilityOutputImage?: string;
  /**
   * THE NOTICES THE CHANNEL FLOW NAMES AND THIS ASSISTANT SAYS (`lib/assistant-notice.ts`).
   *
   * The flow decides a notice is due and hands its kind to the router, which says it as this assistant
   * from these lines. Each key's meaning and shipped English is in `DEFAULT_NOTICE_COPY`. `rateLimited`
   * carries `{minutes}`; `budgetExhausted` falls back to the deployment's `budgetCannedResponse` before
   * the shipped English. Lines that end a duel must not promise more than the platform can keep:
   * `battleEndedReplyInFlight` exists because a rebuttal already on its way cannot be recalled.
   */
  battleNeedsPrompt?: string;
  battleNoneRunning?: string;
  battleNotYours?: string;
  battleAlreadyDone?: string;
  assistantUnavailable?: string;
  /** Lines other services name and the router says (`lib/assistant-notice.ts` holds their shipped English). */
  battleModeOn?: string;
  battleModeBriefing?: string;
  battleModeOff?: string;
  battleModeOffEnded?: string;
  memberJoined?: string;
  memberWelcome?: string;
  briefingReady?: string;
  battleEnded?: string;
  battleEndedReplyInFlight?: string;
  battleStarterUnknown?: string;
  battleUnavailable?: string;
  battleNotEnabled?: string;
  battleExperimentEnded?: string;
  battleAlreadyRunningYours?: string;
  battleAlreadyRunningTheirs?: string;
  battleStartFailed?: string;
  battleNotConfigured?: string;
  battleSideStartFailed?: string;
  battleSideDidNotFinish?: string;
  battleSideDidNotFinishUnnamed?: string;
  battleNoneFinished?: string;
  rateLimited?: string;
  budgetExhausted?: string;
  /**
   * What a person reads at each stage of the queue being worked.
   *
   * A queue being worked looks exactly like a queue that is stuck, and the difference is the whole
   * of the waiting person's experience of it. Partial is fine: any stage a deployment does not word
   * falls back to the default. Whatever is written for the private stage must stay GENERIC, since
   * that line is public and naming a person or a subject would publish what the private message
   * exists to keep private.
   */
  queueStatus?: Partial<Record<string, string>>;
  /**
   * The words an email is wrapped in: greeting, sign-off, the conversation button, the unsubscribe and
   * reply lines, and the preference page (`lib/email-copy.ts` holds their shipped English and the keys).
   * `language` names the language they are written in. Partial: an unset key falls back per key.
   */
  email?: Partial<Record<string, string>>;
}

export interface ProfileDefinitionBody {
  /** DEPRECATED (transitional): equals `models.default`. U2 removes it once resolution reads `models`.
   *  Kept in U1 so every current reader keeps working while the schema lands additively + behavior-
   *  identically; the seed sets both from the same value. */
  modelKey: string;
  /** SPEC-ASSISTANT-CONFIG §4: the per-profile model bundle (base + classifier + image + per-intent). */
  models?: ProfileModels;
  /** The Converse tool surface for this profile (tool names; a subset of what the deployment/type allows,
   *  validated at the write path). Enables per-profile tool experiments (SPEC-PORTABLE §6). */
  tools?: string[];
  /** Selection among deployment-provisioned guardrails (a version selects, never points at an arbitrary
   *  resource — §7 boundary). */
  guardrailId?: string;
  /** Per-assistant task state machines (SPEC-CONFIGURABLE-ASSISTANTS 4.5), keyed by taskType. Preferred
   *  over the deployment intent-pack machines at loop time, so a triage assistant and a report assistant
   *  can carry DIFFERENT task lifecycles. Absent ⇒ inherit the deployment pack (byte-identical). Validated
   *  (validateTaskStateMachines) at the write path AND here (shape/graph). A state says who it awaits with
   *  `awaits: { party: 'requester' }`; the deprecated `awaitsUser: true` a version stored earlier is
   *  accepted and means the same (SPEC-TASK-STATE-TRANSITIONS §12.6), so an older version still activates. */
  machines?: Record<string, TaskStateMachine>;
  /**
   * THE INTENT TAXONOMY THIS ASSISTANT RECOGNIZES, and the behavior each intent carries.
   *
   * A profile IS this (SPEC-PORTABLE-PROFILES: "a profile is what an assistant is: model, persona,
   * INTENT PACK, tools, guardrail selection..."). The pack is not a list of labels: each intent
   * declares the `description` the classifier is shown, the `delivery` a turn of that intent takes
   * (one updated reply, or a tracked multi-step task), and its `maxTokens`/`verbosity` shaping. That
   * is most of what makes one assistant behave unlike another.
   *
   * IT RIDES THE VERSION BECAUSE `models.byIntent` ALREADY DOES. A route is keyed by an intent key, so
   * the taxonomy and the per-intent model map are two halves of ONE decision. Split across two
   * lifecycles they could not be reconciled: a version routing `financial_metric` to Opus published
   * and activated cleanly on a deployment whose pack had no such intent, the route never fired, and
   * every such turn answered as `general` on the base model with nothing logged. `validateDefinitionBody`
   * refuses that version now.
   *
   * ABSENT ⇒ INHERIT THE DEPLOYMENT PACK, byte-identical, which is what every existing version does
   * and why this lands additively. The per-deployment `ASSISTANT_INTENT_PACK` / SSM seam remains the
   * fallback for a deployment that has not moved its taxonomy onto its profiles.
   *
   * STORED AS AUTHORED (`StoredIntentPack`), so `extends: 'default'` survives the round trip and the
   * platform taxonomy does not have to be copied into a 4096-character parameter to be inherited -
   * measured, the three resolved definitions on this deployment are 4422/4746/5256 characters against
   * 1260/1584/2094 authored. Readers take the RESOLVED pack off `resolveFromDefinition`; only the
   * stored shape lives on the body.
   */
  intentPack?: StoredIntentPack;
  /**
   * WHAT THIS ASSISTANT ASKS A PERSON IT HAS NOT MET, and how it opens the conversation.
   *
   * Onboarding is the assistant's first impression, so it is part of what the assistant IS - the same
   * argument that brought the persona and the intent pack onto the version, and the same seam it was
   * stuck behind (`ONBOARDING_INTAKE` / `ONBOARDING_INTAKE_PARAM`, one config per deployment).
   *
   * IT SHOULD DIFFER BY ASSISTANT, and could not. An assistant that reaches financial and customer
   * material has a different opening than one that answers product questions from public
   * documentation: different fields worth asking for, a different greeting, a different closing. One
   * deployment-wide intake made every assistant introduce itself identically and then behave
   * differently, which is the least helpful order to do those two things in.
   *
   * ABSENT ⇒ the deployment seam, byte-identical, so a deployment that has not migrated is unchanged.
   */
  onboarding?: IntakeConfig;
  /**
   * WHAT THIS ASSISTANT DOES NOT REACH, in one line a person reads.
   *
   * AUTHORED, NOT DERIVED, because absence is not a phrase. An assistant's capabilities can be
   * assembled from the intents it advertises; what it CANNOT do cannot be, since the pack says nothing
   * about the intents it does not declare. Deriving the whole introduction and dropping this would
   * delete the most useful sentence in every shipped greeting - "I do not have access to customer
   * accounts or internal figures" is exactly what tells somebody to ask a different assistant.
   *
   * It is also the sentence that stops an assistant being asked the same impossible thing repeatedly,
   * which is the cost a person actually pays for several assistants in one conversation.
   *
   * KEEP IT ABOUT REACH, not about quality. "I cannot see customer accounts" is a boundary; "I am not
   * very good at analysis" is a disclaimer, and a disclaimer in an introduction is noise.
   */
  boundary?: string;
  /**
   * RETIRED (ADR-062): a version stored before message templates may carry the lines it once said here. Nothing reads
   * them as wording: what an assistant says is its message templates, and `npm run migrate-legacy-copy` makes each
   * line a stored version holds its assistant's own template. A draft refuses a line here (`retiredCopyErrors`).
   * Kept on the body so a stored version still parses and hashes to its own `configId`.
   */
  copy?: AssistantCopy;
  /**
   * WHICH OF THIS ASSISTANT'S OWN TEMPLATES A MESSAGE IS SAID FROM (ADR-062 decision 3): a shipped template's
   * name to the name of a template in the assistant's family, `{ "member-welcome": "advisor-member-welcome" }`.
   * A message the version does not map is looked up by its own name. An entry may instead be an ordered list of
   * `{ template, when }` alternatives with one unconditioned (ADR-060 decision 6): the first whose condition holds is
   * said, else the unconditioned one. Validation refuses a mapping to a template that is not active in the family or
   * does not fit the message's call site.
   */
  messages?: import('./message-template.js').VersionMessages;
  /**
   * THE EVENT WORKFLOWS THIS ASSISTANT DECLARES (ADR-061 decision 1, as built): by name, in the event workflow format.
   * Unlike task machines, which stay global and are only selected, an event workflow is the assistant's own. Its
   * `assistant-joined` workflows are its WELCOME (W1), which `WelcomeIntent` starts, selected by the room's conversation
   * type (`welcomeWorkflowOf`); every other event selects its own.
   */
  eventWorkflows?: Record<string, import('./event-workflow.js').EventWorkflow>;
  /**
   * THE VALUES THIS ASSISTANT NAMES (ADR-060 decision 1): a variable's name to the source it reads and the
   * fallback inserted when that value is unresolved or held back, `{ "firstName": { "source": "person:displayName" } }`.
   * A version names only sources its classification publishes, checked at validate, activate and import
   * (`versionVariablesErrors`); it cannot declare a source or change a source's trust.
   */
  variables?: Record<string, import('./variables.js').VersionVariable>;
  /**
   * RETIRED (W1): a version stored before the welcome became a workflow may carry its welcome here. Nothing reads it:
   * the welcome is the version's `assistant-joined` workflow, and `npm run migrate-legacy-welcome` carries a stored
   * welcome into those workflows. A draft, validate, activate, a variant, an import and a rollback refuse one
   * (`retiredWelcomeErrors`). Kept on the body so a stored version still parses and hashes to its own `configId`.
   */
  welcome?: LegacyWelcome;
  /**
   * WHAT THE ASSISTANT IS CALLED - the name in the room, in the console, and on its `AppInstanceBot`.
   *
   * SEPARATE FROM THE PROFILE NAME, AND THAT SEPARATION IS THE POINT. The profile name is the stable
   * identifier: the SSM segment a version is stored under, the assignment record's `assistant`, and
   * the analytics dimension. It cannot change, because every key and every historical row is
   * addressed by it. Those were one field, so an assistant could not be renamed at all - the label a
   * team wants to edit was also the primary key, and renaming it orphaned the version history.
   *
   * THE DURABLE THING WAS NEVER THE NAME. An assistant's identity is its `AppInstanceBot` ARN, which
   * the platform owns for the life of the deployment; a name is a label over the top of it. So this
   * rides the version like any other behavior: edit it, validate, activate, and roll it back if it
   * reads wrong. Absent ⇒ the profile's configured `displayName`, then the profile name itself.
   *
   * ACTIVATING A VERSION ALSO PUTS IT ON THE IDENTITY (`apply-assistant-name.ts`), so the name in the
   * room and the name in the console are moved by one action. A rollback re-applies the name of the
   * version it rolls back to, which is what keeps the identity following the `active` label rather
   * than keeping whatever the last forward activation happened to set.
   */
  displayName?: string;
  /**
   * WHICH GLOBAL WORKFLOWS THIS ASSISTANT MAY OPEN - a SELECTION of keys, never a definition.
   *
   * The graphs themselves are the platform's, with a classification able to add its own on its intent
   * pack (2.9). What a version says is which of the available ones this assistant uses: a
   * classification can declare a workflow and an assistant in it can be configured to use it or not.
   *
   * NARROWS, NEVER WIDENS - the same direction every other per-assistant selection runs. A key that
   * names no available workflow is refused on the write path rather than silently never firing, which
   * is the same rule `models.byIntent` is reconciled by. Absent means every available workflow, which
   * is what every assistant had before this field existed.
   *
   * SELECTION, NOT DEFINITION, is the whole distinction. Two assistants may offer different subsets of
   * the same graphs; they can never run different graphs under one name.
   */
  workflows?: string[];
  /**
   * WHEN A WORKFLOW'S CONFIRMED STEP IS PUT TO THE PERSON, per workflow key (ADR-064 decision G, tenet P5): `always`, or
   * `when-incomplete`, where a request that already carries the complete brief goes past the step in its own turn. It
   * replaces the value the workflow declares on its `confirm` step (`withConfirmBrief`), for this version's turns only.
   * Each key names a workflow with a step that declares `confirm`, and `when-incomplete` needs that step to declare its
   * `brief` (`confirmBriefErrors`, checked on write against the machines the runtime runs). Absent: the declared value,
   * which for `image_generation` is `when-incomplete`.
   */
  confirmBrief?: Record<string, ConfirmPolicy>;
  /** Per-assistant PERSONA - the system-prompt body (SPEC-CONFIGURABLE-ASSISTANTS §2, SPEC-PORTABLE §5).
   *  Rides the versioned definition so two versions can differ in character and an export/import carries
   *  it across instances. Absent ⇒ the deployment persona seam (ASSISTANT_SYSTEM_PROMPT[_PARAM] →
   *  defaultPersonaFor). Length-capped at the write path. */
  persona?: string;
  /**
   * A SHORT PERSONA ADDENDUM layered after the persona, wrapped in `<persona_addendum>` tags at prompt
   * assembly (`personaAddendumBlock`). An experiment variant's `systemPromptAddendum` lands here when a
   * duel side's version is derived from it (DESIGN-SEPARATE-ASSISTANTS §3.7), so the side serves the
   * addendum from its own pinned version like every other field. Any version may carry one, so
   * promoting a winner (export, import, activate) keeps it. Length-capped, and refused when it contains
   * the closing tag. Absent ⇒ nothing is layered.
   */
  systemPromptAddendum?: string;
  /** Context sources this profile SELECTS, by catalog key (SPEC-CONTEXT-SOURCES-AND-STORES §7). Logical and
   *  instance-independent - never an ARN - so an export carries the selection and the target resolves it
   *  against its OWN catalog. LIST ORDER IS PROMPT ORDER: the catalog says what exists, the profile says
   *  what is used and in what sequence, so two orderings can never disagree. Absent ⇒ no catalog sources. */
  contextSources?: string[];
  /**
   * WHAT THIS ASSISTANT MUST BE MEASURED ON BEFORE A DRAFT OF IT GOES LIVE (ADR-065 decision 6): the fewest live
   * regression entries the golden set holds for each intent of the draft's pack. The gate reads it from the ACTIVE
   * version, never the draft, so a draft cannot lower the bar it is measured against; a lower minimum takes effect once
   * the version declaring it is active, by an activation that is itself gated. Absent: no minimum.
   */
  goldenSet?: { minRegressionPerIntent?: number };
}

/** A stored, versioned profile definition (the JSON in `/{instance}/assistant/{name}/definition`). */
export interface ProfileDefinition extends ProfileDefinitionBody {
  schemaVersion: typeof PROFILE_DEFINITION_SCHEMA_VERSION;
  /** Stable identity ACROSS versions — MUST equal the SSM segment. */
  profileName: string;
  /** Fingerprint of the behavioral body; a version's attribution key (analytics slices by it, §6). */
  configId: string;
  /**
   * Pointer to the persona when it lives in S3 instead of inline (SPEC-PORTABLE-PROFILES, "Bodies are
   * S3"). Present on a stored definition INSTEAD of `persona`; the two are never both set.
   *
   * ENVELOPE, NOT BODY - it is deliberately absent from `RUNTIME_EDITABLE_KEYS`, so it is not hashed
   * into `configId` and `bodyFrom` strips it. That is what keeps a version's identity a property of
   * WHAT IT SAYS rather than WHERE IT IS KEPT: the same persona hashes the same inline or offloaded, so
   * migrating a deployment's storage does not re-key its analytics or invalidate an exported manifest.
   */
  personaRef?: ProfileBodyRef;
  /**
   * Pointer to the intent pack when it lives in S3 instead of inline. Present on a stored definition
   * INSTEAD of `intentPack`; the two are never both set.
   *
   * ENVELOPE, NOT BODY, on the same terms as `personaRef`: absent from `RUNTIME_EDITABLE_KEYS`, so the
   * same taxonomy hashes to the same `configId` inline or offloaded. A deployment that turns on a body
   * store does not re-key its analytics or invalidate an exported manifest.
   */
  intentPackRef?: ProfileBodyRef;
  /**
   * WHERE THE CONSOLE DRAWS EACH WORKFLOW STEP (ADR-061 decision 7): inline only on a definition the console reads or is about
   * to write, and stored as `layoutRef` (`offloadBodies`), never inline in the parameter. ENVELOPE, NOT BODY: absent from
   * `RUNTIME_EDITABLE_KEYS`, so moving a step never changes `configId`; stripped by `bodyFrom`, so validation and every
   * runtime read see no layout.
   */
  layout?: WorkflowLayout;
  /** The pointer to the layout's body (`layoutKey`), read by the console's draft and export reads alone (`withLayout`). */
  layoutRef?: ProfileBodyRef;
  /**
   * PROVENANCE: this version was DERIVED by an experiment rather than authored by an operator - the
   * live assistant's active body at arm time plus one variant's delta (DESIGN-SEPARATE-ASSISTANTS
   * §3.7). Carried so the Profiles tab can render it as what it is: an unactivated candidate a duel
   * produced, not a state this assistant was ever in. Without it a candidate reads in the version
   * history exactly like a prior live version, which is an invitation to roll back INTO something
   * that never served anyone.
   *
   * ENVELOPE, NOT BODY, on the same terms as `personaRef` and `intentPackRef`: absent from
   * `RUNTIME_EDITABLE_KEYS`, so it is not hashed into `configId`. That is load-bearing twice over.
   * A version's identity stays a property of WHAT IT SAYS, so the same body hashes the same however
   * it came to be authored - and the arm path compares `configId` to decide whether it already has
   * the candidate it needs, which a provenance-sensitive hash would defeat by making every arm look
   * like a new body.
   *
   * `baseVersion` is the live assistant's version the delta was applied to, recorded because the derivation
   * PINS its base rather than tracking it (§3.7): afterwards, this is the only thing that says what
   * the candidate was a variation OF. ABSENT when the profile had no published version and the base
   * was the compiled seed - which is not a version and has no number.
   */
  derivedFrom?: {
    experimentId: string;
    variantId: string;
    /** The live assistant whose active body this was derived from: the alt is a different assistant. */
    baseProfile?: string;
    baseVersion?: number;
  };
  /**
   * PROVENANCE: this version is a PROMOTED copy of an experiment's measured candidate
   * (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6). Its body hashes to the candidate's `configId`, which
   * the promotion checked before it activated it, so a turn this version serves is attributed to the
   * same `configId` the experiment measured. ENVELOPE, NOT BODY, like `derivedFrom`: never hashed.
   */
  promotedFrom?: {
    /** The candidate's profile (the role's alt) and version. */
    profileName: string;
    version: number;
    experimentId: string;
  };
  /**
   * PROVENANCE: this version went live past the golden gate (ADR-065 decision 5), by an administrator who confirmed the
   * refusal that stood and said why. ENVELOPE, NOT BODY, like `promotedFrom`: never hashed, so the version's `configId`
   * is the draft's the gate refused.
   */
  activatedPastGate?: {
    /** The refusal passed, and the values it was worded with. */
    code: string;
    params: Record<string, string | number>;
    reason: string;
    actor: string;
    at: string;
    runId?: string;
  };
}

/**
 * Seeds of runtime assistants (ADR-048), learned from their assignment records by the path that assigned
 * the turn: the router from its assistant index, the processor from the vend. A record is the authority for
 * a runtime assistant, so a name is only ever remembered with the seed its own record produced.
 */
const runtimeSeeds = new Map<string, AssistantProfile>();

/** Remember a runtime assistant's seed, so its versions resolve under its own name. */
export function rememberRuntimeSeed(seed: AssistantProfile): void {
  runtimeSeeds.set(seed.name, seed);
}

/**
 * THE SEED FOR A NAME: a declared profile, an alt's declared descriptor (`alt-{role}-{classification}`,
 * ADR-050), which is its role's live assistant under the alt's own name, or a runtime assistant's seed
 * from its record. Anything else has no seed.
 */
function seedFor(profileName: string) {
  return defaultProfileRegistry.profileByName(profileName)
    ?? defaultProfileRegistry.altSeedFor(profileName)
    ?? runtimeSeeds.get(profileName);
}

const RUNTIME_EDITABLE_KEYS: ReadonlyArray<keyof ProfileDefinitionBody> = [
  // RETIRED (W1), and still hashed, so a stored version that carries one keeps its own configId.
  'welcome',
  'modelKey',
  'models',
  'tools',
  'guardrailId',
  // 'machines' was here. It is no longer something a version can say, so it cannot be part of what a
  // version is identified BY - leaving it would hash a field that is always absent.
  'persona',
  // WHAT THE ASSISTANT SAYS IS PART OF WHAT IT IS. `copy` is on the body and `bodyFrom` keeps it,
  // but it was missing here - so a copy-only edit hashed to the SAME configId, and the new version
  // was attributed in analytics to the one it replaced. A deployment that reworded its queue notice
  // or its stop line could not tell the two apart afterwards.
  //
  // Adding it re-keys any profile that already sets `copy`, once. That is the correct id: the hash
  // is meant to identify what the profile SAYS, and it did not.
  'copy',
  // WHICH TEMPLATE A MESSAGE IS SAID FROM is part of what it says, on the same terms as `copy`.
  'messages',
  // HOW IT GREETS AN EVENT is part of what it does, so a changed event workflow is a new version.
  'eventWorkflows',
  // WHICH VALUES IT READS, and what it says when one is missing, are part of what it says.
  'variables',
  // WHAT IT MUST BE MEASURED ON is a statement about this assistant, changed through a version like the rest of it.
  'goldenSet',
  // WHAT IT IS CALLED IS PART OF WHAT IT IS, on the same terms as `copy` above: a rename that did not
  // hash into `configId` would be attributed in analytics to the version it replaced, so a deployment
  // could not tell the two apart afterwards.
  'displayName',
  // WHICH WORKFLOWS IT OFFERS is part of what the assistant is, the same as which tools it holds.
  'workflows',
  // WHEN A WORKFLOW CONFIRMS A COMPLETE REQUEST is part of what the assistant does, so it is part of what identifies it.
  'confirmBrief',
  'contextSources',
  // THE TAXONOMY IS PART OF WHAT THE ASSISTANT IS, so it is part of what the version is identified by.
  // `machines` - a block INSIDE the pack - was already hashed here while the pack itself was not, which
  // is the same split that kept the pack off the version for so long: half a field counted toward a
  // version's identity and the taxonomy it belongs to did not. A version that added an intent, reworded
  // the `description` its classifier is shown, or changed an intent's `delivery` therefore hashed to the
  // SAME configId as the version it replaced, and every turn it served was attributed to that one - the
  // `copy` defect directly above, on the field that decides how turns are routed in the first place.
  //
  // This is also what makes per-turn attribution able to answer "which taxonomy classified this turn",
  // which is the whole point of stamping a config id on a turn.
  'intentPack',
  // The assistant's first impression is part of what it is; see the field's note on the body.
  'onboarding',
  // What the assistant does not reach is part of what it is, and a person reads it.
  'boundary',
  // The persona addendum is part of the persona, so it is part of what the version is identified by.
  'systemPromptAddendum',
  // DEPLOYMENT-TIME FIELDS ARE NOT LISTED HERE, and the omission is the point. `classifierMode`,
  // `timeoutSeconds`, `taskSupport`, `rateLimitPerHour` and `battleEligible` were hashed here while
  // no reader took them from a version, so two versions differing only in one of them got two
  // configIds for the same behavior. Dropping them re-keys any profile whose stored version carried
  // them, once, to the id its actual behavior earns.
];

/** Recursively key-sort an object/array so the configId hash is stable regardless of insertion order
 *  (the `models.byIntent` map + `tools` list must canonicalize deterministically). */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = canonicalize(val);
    }
    return out;
  }
  return v;
}

/** Deterministic, key-ordered JSON of just the behavioral body — the hash + equality basis. */
function canonicalBody(body: ProfileDefinitionBody): string {
  const ordered: Record<string, unknown> = {};
  for (const k of [...RUNTIME_EDITABLE_KEYS].sort()) {
    if (body[k] !== undefined) ordered[k] = canonicalize(body[k]);
  }
  return JSON.stringify(ordered);
}

/** A version's fingerprint: a short, stable hash of its behavioral body. Same body ⇒ same id. */
export function profileDefinitionConfigId(body: ProfileDefinitionBody): string {
  return createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Validate a runtime-editable body. Returns a list of human-readable errors (empty ⇒ valid). The
 * §7 model-ARN boundary (modelKey within the deployment's InvokeModel allowlist) is NOT checked here —
 * it needs the model catalog and is enforced by the write path (profile-lifecycle validate); this is
 * the schema/shape check shared by the runtime parse and the lifecycle validate.
 */
/** Persona length cap (~5k tokens of system prompt). Bounds a version's prompt so an import/edit can't
 *  smuggle an unbounded persona; generous enough for a rich, grounded persona. */
export const MAX_PERSONA_LENGTH = 20000;

/** The persona addendum's cap: the same 500 characters an experiment variant's addendum is capped at. */
export const MAX_PERSONA_ADDENDUM_LENGTH = 500;
/** The tag that closes the addendum's wrapper, refused inside the addendum itself. */
export const PERSONA_ADDENDUM_CLOSING_TAG = '</persona_addendum>';

/** The addendum as the system prompt carries it, or '' when the version has none. */
export function personaAddendumBlock(addendum: string | undefined): string {
  return addendum ? `\n\n<persona_addendum>${addendum}</persona_addendum>` : '';
}

/** Upper bound on selected context sources. The list is prompt order, so an unbounded one is a
 *  prompt-size and per-turn latency problem, not merely untidy. */
export const MAX_CONTEXT_SOURCES = 16;

/**
 * A version's `goldenSet`: an object whose only key is `minRegressionPerIntent`, a whole number from 1 to the set's
 * capacity (a minimum the set could never hold would refuse every draft).
 */
export function goldenSetErrors(goldenSet: unknown): string[] {
  if (goldenSet === undefined) return [];
  if (!goldenSet || typeof goldenSet !== 'object' || Array.isArray(goldenSet)) return ['goldenSet must be an object'];
  const extra = Object.keys(goldenSet).filter((k) => k !== 'minRegressionPerIntent');
  if (extra.length) return [`goldenSet has no field ${extra.join(', ')}; it declares minRegressionPerIntent`];
  const min = (goldenSet as { minRegressionPerIntent?: unknown }).minRegressionPerIntent;
  if (min === undefined) return [];
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > GOLDEN_SET_CAPACITY) {
    return [`goldenSet.minRegressionPerIntent must be a whole number from 1 to ${GOLDEN_SET_CAPACITY}`];
  }
  return [];
}

export function validateDefinitionBody(
  body: Partial<ProfileDefinitionBody>,
  /**
   * Routes the body ALREADY HAD. Reported by the runtime, but not refused here.
   *
   * SAME RULE AS `deploymentRouteErrors`, and it has to live in both places because the taxonomy can
   * come from either the version's own `intentPack` or the deployment's. Refusing an INHERITED
   * unreachable route makes a profile permanently uneditable when its pack narrows after seeding -
   * every later edit is rejected for routes nobody wrote, including the edit that would remove them.
   * Measured on a deployment whose seeded routes contradicted the pack seeded beside them.
   */
  inheritedRoutes?: ReadonlySet<string>,
): string[] {
  const errs: string[] = [];
  if (typeof body.modelKey !== 'string' || !body.modelKey) errs.push('modelKey required');
  // LEGACY FIELDS ARE TOLERATED AND IGNORED, NEVER REJECTED. A version stored before the
  // deployment-time fields left this body still carries `classifierMode`, `timeoutSeconds`,
  // `taskSupport`, `rateLimitPerHour`, `battleEligible` or `models.complex`. Nothing here validates
  // them and nothing reads them: `bodyFrom` drops them on the way through, so an older active version
  // resolves exactly like a new one instead of failing closed to the compiled seed. There is no
  // unknown-key rejection in this checker, which is what makes that tolerance hold for any field a
  // future version removes as well.
  errs.push(...goldenSetErrors(body.goldenSet));
  // Persona (system-prompt body). String, length-capped so a version can't smuggle an unbounded prompt.
  if (body.persona !== undefined) {
    if (typeof body.persona !== 'string') errs.push('persona must be a string');
    else if (body.persona.length > MAX_PERSONA_LENGTH) errs.push(`persona must be at most ${MAX_PERSONA_LENGTH} characters`);
  }
  // The persona addendum: short, and never able to close its own wrapper, so text inside it cannot
  // escape into the rest of the system prompt (`personaAddendumBlock`).
  if (body.systemPromptAddendum !== undefined) {
    if (typeof body.systemPromptAddendum !== 'string') errs.push('systemPromptAddendum must be a string');
    else if (body.systemPromptAddendum.length > MAX_PERSONA_ADDENDUM_LENGTH) {
      errs.push(`systemPromptAddendum must be at most ${MAX_PERSONA_ADDENDUM_LENGTH} characters`);
    } else if (body.systemPromptAddendum.toLowerCase().includes(PERSONA_ADDENDUM_CLOSING_TAG)) {
      errs.push(`systemPromptAddendum may not contain ${PERSONA_ADDENDUM_CLOSING_TAG}`);
    }
  }
  // SPEC-CONTEXT-SOURCES-AND-STORES §7: context SELECTION (shape only). Whether each key exists in this
  // classification's published catalog is checked by `contextSelectionErrors` on the validate and
  // activate paths, and by import — all three read the catalog, which this shape check cannot. Here we
  // only guarantee it is a list of non-empty keys, so a malformed selection cannot reach resolution.
  // Bounded because the list is prompt order and an unbounded one is a prompt-size and latency
  // problem, not just a tidiness one.
  if (body.contextSources !== undefined) {
    if (!Array.isArray(body.contextSources)) errs.push('contextSources must be an array of catalog keys');
    else if (body.contextSources.length > MAX_CONTEXT_SOURCES) {
      errs.push(`contextSources must name at most ${MAX_CONTEXT_SOURCES} sources`);
    } else if (!body.contextSources.every((k) => typeof k === 'string' && k.trim().length > 0)) {
      errs.push('contextSources entries must be non-empty strings');
    } else if (new Set(body.contextSources).size !== body.contextSources.length) {
      errs.push('contextSources must not repeat a key');
    }
  }
  // THE ASSISTANT'S OPENING. Shape-checked with the same parser the deployment seam uses, so a version
  // and a parameter cannot disagree about what a valid intake is. `parseIntakeConfig` returns null for
  // anything it cannot make sense of, which on the READ path means "onboarding disabled" - a perfectly
  // reasonable deployment state, and a terrible thing to store silently, since the operator would be
  // looking at an intake the assistant will never run.
  if (body.onboarding !== undefined) {
    if (typeof body.onboarding !== 'object' || body.onboarding === null || Array.isArray(body.onboarding)) {
      errs.push('onboarding must be an object of the form { greeting, fields: [...], completion? }');
    } else if (parseIntakeConfig(JSON.stringify(body.onboarding)) === null) {
      errs.push(
        'onboarding is not a valid intake config (needs a non-empty `greeting` and at least one field '
        + 'with a `key` and a `prompt`); stored as written it would disable onboarding rather than run it',
      );
    }
  }
  // THE INTENT TAXONOMY (SPEC-PORTABLE-PROFILES). Shape only here; whether the ROUTES agree with these
  // keys is checked with the model bundle below, because that needs both halves in hand.
  if (body.intentPack !== undefined) {
    errs.push(...validateIntentPackBody(body.intentPack));
    // ONE PLACE TO DECLARE MACHINES, and this refuses the second one.
    //
    // A pack may carry a `machines` block, and on the per-deployment SSM pack it is read:
    // `taskStateMachines()` merges it over the platform defaults. On a VERSION it is read by nothing -
    // every machines consumer takes the body's top-level `machines`, and none of them ever calls
    // `taskStateMachines(resolved.intentPack)`. Bringing the pack onto the version therefore created a
    // second, identical-looking place to declare task machines where only one of them does anything.
    //
    // Refused rather than folded into `machines`, because folding would make the same field mean
    // "merged over the defaults" in one location and "the version's override" in another, and an
    // operator reading a stored definition could not tell which graph a task would run. The message
    // names the field that works.
    // AN INTENT NARROWS THE PROFILE'S TOOLS; IT MAY NOT WIDEN THEM (tenet D4).
    //
    // Checked here rather than in `validateIntentPackBody`, because only this function holds both
    // halves - the pack validator sees the pack alone and cannot know what the profile allows. Left
    // unchecked, an intent naming a forbidden tool would be silently intersected away at runtime and
    // the operator would be looking at a tool list the turn does not have.
    if (body.tools !== undefined) {
      const allowed = new Set(body.tools);
      for (const def of body.intentPack.intents ?? []) {
        const outside = (def.tools ?? []).filter((t) => !allowed.has(t));
        if (outside.length) {
          errs.push(
            `intentPack intent '${def.key}' names tool(s) this profile does not allow: ${outside.join(', ')}. `
            + 'An intent narrows the profile\'s tool allowlist and can never widen it; add the tool to the '
            + "profile's `tools` first, or drop it from the intent.",
          );
        }
      }
    }
    if ((body.intentPack as { machines?: unknown }).machines !== undefined) {
      errs.push(
        'intentPack.machines is not read from a profile version. Task graphs are GLOBAL WORKFLOWS: '
        + "declare them on the CLASSIFICATION's assistant-intent-pack parameter, or use the platform "
        + "set. A version selects from what exists with `workflows`; it cannot declare one, so the "
        + "version's own top-level `machines` is refused too.",
      );
    }
  }
  // SPEC-ASSISTANT-CONFIG §4: the per-profile model bundle (shape only — the InvokeModel-allowlist
  // boundary for each model is enforced at the write path, §7, where the catalog is available).
  if (body.models !== undefined) {
    const m = body.models;
    if (typeof m !== 'object' || m === null) errs.push('models must be an object');
    else {
      // default is OPTIONAL (blank ⇒ classification default); only shape-check when present.
      if (m.default !== undefined && (typeof m.default !== 'string' || !m.default)) errs.push('models.default must be a non-empty modelKey (or omitted to inherit the classification default)');
      if (m.classifier !== undefined && (typeof m.classifier !== 'string' || !m.classifier)) errs.push('models.classifier must be a non-empty modelKey');
      if (m.byIntent !== undefined) {
        if (typeof m.byIntent !== 'object' || m.byIntent === null) errs.push('models.byIntent must be a map of route→{primary,fallback?}');
        else for (const [intent, route] of Object.entries(m.byIntent)) {
          // A RETIRED ROUTE KEY is refused, naming the intent that keys the route now (ADR-064 decision 1).
          const retired = retiredRouteKeyError(intent, `models.byIntent['${intent}']`);
          if (retired) { errs.push(retired); continue; }
          // A route names a text model, an image model, step overrides, or any of them together (ADR-064 decisions C and
          // D): a route that only overrides a step leaves the intent's other turns where they resolve without a route.
          const imagePart = route && typeof route === 'object' ? (route as { image?: unknown }).image : undefined;
          const stepsPart = route && typeof route === 'object' ? (route as { steps?: unknown }).steps : undefined;
          if (imagePart !== undefined && (!imagePart || typeof imagePart !== 'object' || typeof (imagePart as { primary?: unknown }).primary !== 'string' || !(imagePart as { primary: string }).primary)) {
            errs.push(`models.byIntent['${intent}'].image.primary must be a non-empty image model key`);
          }
          if (typeof route !== 'object' || route === null || (route.primary === undefined && route.fallback === undefined && (imagePart !== undefined || stepsPart !== undefined))) {
            if (typeof route !== 'object' || route === null) errs.push(`models.byIntent['${intent}'] must be { primary?, fallback?, image?, steps? }`);
          } else if (typeof route.primary !== 'string' || !route.primary) {
            errs.push(`models.byIntent['${intent}'].primary must be a non-empty modelKey`);
          } else if (route.fallback !== undefined && (typeof route.fallback !== 'string' || !route.fallback)) {
            errs.push(`models.byIntent['${intent}'].fallback must be a non-empty modelKey`);
          }
          if (route && typeof route === 'object') errs.push(...stepShapeErrors(intent, (route as { steps?: unknown }).steps));
        }
      }
      // ── AND THE ROUTES MUST NAME INTENTS THAT EXIST ────────────────────────────────────────
      //
      // The half that was missing, and the reason the pack had to come onto the version at all. A
      // route is keyed by an intent key; the keys live in the pack. While the two sat in different
      // lifecycles nothing could check them against each other, so a version routing an intent this
      // assistant does not recognize published and activated cleanly, never fired, and answered every
      // such turn as `general` on the base model. Nothing errored and nothing logged.
      //
      // CHECKED AGAINST THIS VERSION'S OWN PACK ONLY. A version carrying no pack inherits the
      // deployment's, which this function cannot read (it is pure, and the deployment pack is an SSM/env
      // seam resolved per container) - so that case is left to the write path, which can. Refusing here
      // on a pack we cannot see would reject every legacy version.
      if (m.byIntent !== undefined && body.intentPack !== undefined) {
        // ONE VOCABULARY: a route is keyed by the intent it serves (ADR-064 decision 1), so a route fires exactly
        // when this assistant can classify its key.
        const reachable = new Set<string>([
          ...intentKeysOf(body.intentPack), ...UNIVERSAL_INTENT_KEYS,
          // A standalone greeting or acknowledgment may have a route of its own (`resolveModelForIntent`).
          ...TRIVIAL_ROUTE_KEYS,
        ]);
        for (const intent of Object.keys(m.byIntent)) {
          if (reachable.has(intent as RouteKey)) continue;
          // Inherited ⇒ not this edit's doing, and harmless: nothing classifies to it, so it never fires.
          if (inheritedRoutes?.has(intent)) continue;
          errs.push(
            `models.byIntent['${intent}'] routes a key no intent this version can classify resolves to, `
            + `so it would never fire; reachable routes: ${[...reachable].sort().join(', ') || '(none)'}`,
          );
        }
      }
      // The image-generation model is validated in a SEPARATE branch against the IMAGE_GEN_MODELS
      // registry — NEVER through the text-catalog checkModel allowlist (profile-lifecycle / profile-
      // manifest), which would reject it because image keys are not BackendModelKeys. The registry is a
      // static enum, so this is a schema/enum check (safe to enforce at parse time), not the §7
      // deployment-allowlist boundary the write path owns for text models.
      // THE LEGACY IMAGE FIELD IS RETIRED (ADR-064 decision 2): an image model is chosen in one place, the route's image part.
      if (m.image !== undefined) {
        errs.push("models.image is retired; name the image model as models.byIntent['image_generation'].image.primary");
      }
      // AN IMAGE ROUTE IS A ROUTE WHOSE MODEL IS AN IMAGE MODEL (`image-route.ts`): its fallback is an image
      // model too, and a different one. The registry is static, so this is a schema check; whether the
      // classification allows each model is the write path's (`modelFits`).
      if (m.byIntent && typeof m.byIntent === 'object') {
        for (const [intent, route] of Object.entries(m.byIntent)) {
          if (!route || typeof route !== 'object') continue;
          const kindErr = routeKindError(intent, route as never);
          if (kindErr) errs.push(kindErr);
        }
      }
      // ROUTING RULES ARE CONDITIONS OVER WHAT MAY DECIDE (ADR-060 decisions 3 and 6): each names a text model and a
      // `when` held to `whenErrors`, read as a room message would be, because the room reads the reply. Whether the
      // classification selects the model is the write path's (`confineModelsToClassification`) and the resolver's.
      if (m.routing !== undefined) errs.push(...routingRuleErrors(m.routing));
      // A PROFILE ENABLES NOTHING. Whether a model outside AWS may be used is its classification's selection
      // (`models` on its registry entry), which also grants its key. The retired `models.externalProviderAllowed`
      // is a legacy field like the ones listed at the top of this checker: `parseDefinition` strips it on read
      // and `modelsFrom` drops it from every body a write builds, so a version that carries it stays readable,
      // editable and a rollback target, and it never reads as consent.
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string' || !t)) {
      errs.push('tools must be an array of non-empty tool names');
    } else {
      // Every tool must be a KNOWN registered tool (SPEC-ASSISTANT-CONFIG §4) — a profile can only allow
      // tools the loop actually implements; an unknown name is a typo/tampering, not a silent no-op.
      const unknown = unknownTools(body.tools);
      if (unknown.length) errs.push(`unknown tool(s): ${unknown.join(', ')} (must be in the tool registry)`);
    }
  }
  if (body.guardrailId !== undefined && (typeof body.guardrailId !== 'string' || !body.guardrailId)) errs.push('guardrailId must be a non-empty string');
  // Per-assistant task machines (4.5): validate the FULL graph (initial in states, every transition
  // target declared, terminal shape, and the party a waiting state declares) with the same checker the
  // deployment pack uses, so a hostile / malformed version can't seed an invalid lifecycle that would
  // strand tasks. Both accepted forms of the wait pass, so a version stored before the declared form
  // existed still validates and activates.
  if (body.workflows !== undefined) {
    if (!Array.isArray(body.workflows) || body.workflows.some((w) => typeof w !== 'string' || !w.trim())) {
      errs.push('workflows must be an array of non-empty workflow keys');
    } else if (new Set(body.workflows).size !== body.workflows.length) {
      // A duplicate is not harmful but it is a sign the caller built the list from two sources, and
      // the selection is small enough that saying so costs nothing.
      errs.push('workflows contains a duplicate key');
    }
  }
  // THE SHAPE OF `confirmBrief` here; whether each key names a workflow with a confirmed step is checked on write, against
  // the machines the runtime runs (`confirmBriefErrors`).
  if (body.confirmBrief !== undefined) {
    const cb = body.confirmBrief as unknown;
    if (!cb || typeof cb !== 'object' || Array.isArray(cb)) {
      errs.push('confirmBrief maps a workflow key to always or when-incomplete');
    } else {
      for (const [k, v] of Object.entries(cb as Record<string, unknown>)) {
        if (!(CONFIRM_POLICIES as readonly unknown[]).includes(v)) errs.push(`confirmBrief['${k}'] is ${JSON.stringify(v)}; it is one of ${CONFIRM_POLICIES.join(', ')}`);
      }
    }
  }
  // MACHINES ARE NOT REFUSED HERE, and that is deliberate rather than an omission.
  //
  // This validator also runs on the READ path, and a failure there fails CLOSED to the compiled seed -
  // so refusing a stored version that carries a legacy `machines` block would not drop the block, it
  // would discard the whole version: its persona, its models, its tools, everything, replaced by the
  // seed on the next turn. A narrowing must not be able to delete a deployment's configuration.
  //
  // The refusal belongs on the WRITE patch, where the operator is present to be told (`editDraft`),
  // and `bodyFrom` drops the field on read so a legacy version simply normalizes away.

  return errs;
}

/** Assemble a stored definition from a name + a (validated) body, stamping schemaVersion + configId. */
export function buildDefinition(profileName: string, body: ProfileDefinitionBody): ProfileDefinition {
  return {
    schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
    profileName,
    ...body,
    configId: profileDefinitionConfigId(body),
  };
}

/**
 * Narrow the model bundle to its known keys, the same way `bodyFrom` narrows the body.
 *
 * The bundle used to be copied whole, so a legacy `models.complex` rode straight through `bodyFrom`
 * into the next version and into its hash - the one banned field that survived the narrowing, because
 * the narrowing stopped at the top level.
 */
function modelsFrom(m: ProfileModels): ProfileModels {
  return {
    ...(m.default !== undefined ? { default: m.default } : {}),
    ...(m.classifier !== undefined ? { classifier: m.classifier } : {}),
    ...(m.byIntent !== undefined ? { byIntent: m.byIntent } : {}),
    ...(m.image !== undefined ? { image: m.image } : {}),
    ...(m.routing !== undefined ? { routing: m.routing } : {}),
  };
}

/**
 * Narrow a full/partial object down to just the runtime-editable body keys (drops name/scope/etc.).
 *
 * THIS IS ALSO WHERE A LEGACY FIELD IS IGNORED. It copies known keys rather than spreading, so a
 * stored version still carrying `classifierMode`, `timeoutSeconds`, `taskSupport`, `rateLimitPerHour`,
 * `battleEligible` or `models.complex` loses them here - on read, on edit and on export - without an
 * error and without any of them reaching a hash, a manifest or a turn.
 */
export function bodyFrom(obj: Partial<ProfileDefinitionBody>): ProfileDefinitionBody {
  return {
    modelKey: obj.modelKey as string,
    ...(obj.models !== undefined ? { models: modelsFrom(obj.models) } : {}),
    ...(obj.tools !== undefined ? { tools: obj.tools } : {}),
    ...(obj.guardrailId !== undefined ? { guardrailId: obj.guardrailId } : {}),
    // MACHINES ARE THE PLATFORM'S, NOT A VERSION'S. Dropped here, which is the
    // whitelist that decides what a stored body may carry, so a version that still holds one from
    // before this normalizes away on its next read instead of quietly out-ranking the platform graphs.
    //
    // WHAT THIS PROTECTS. Every assistant's ability to manage work has to be the same ability: a task
    // graph decides what states exist, which moves are legal and when a person is awaited, and an
    // assistant that redefined `queue_drain` for itself was running a different contract for the same
    // named workflow. Nothing else about a profile is narrowed - the persona, models, tools, context
    // and its own intents stay per assistant.
    ...(obj.intentPack !== undefined ? { intentPack: obj.intentPack } : {}),
    ...(obj.onboarding !== undefined ? { onboarding: obj.onboarding } : {}),
    ...(obj.boundary !== undefined ? { boundary: obj.boundary } : {}),
    ...(obj.persona !== undefined ? { persona: obj.persona } : {}),
    ...(obj.systemPromptAddendum !== undefined ? { systemPromptAddendum: obj.systemPromptAddendum } : {}),
    ...(obj.copy !== undefined ? { copy: obj.copy as AssistantCopy } : {}),
    ...(obj.messages !== undefined ? { messages: obj.messages as import('./message-template.js').VersionMessages } : {}),
    ...(obj.eventWorkflows !== undefined ? { eventWorkflows: obj.eventWorkflows as ProfileDefinitionBody['eventWorkflows'] } : {}),
    ...(obj.variables !== undefined ? { variables: obj.variables as ProfileDefinitionBody['variables'] } : {}),
    ...(obj.welcome !== undefined ? { welcome: obj.welcome as LegacyWelcome } : {}),
    // THIS IS A WHITELIST, so a field absent from it is SILENTLY DROPPED from every stored body -
    // which is what happened to `displayName`. It was declared on the body type, validated on the way
    // in, listed in RUNTIME_EDITABLE_KEYS and therefore believed to be hashed into `configId`, and
    // none of that mattered: the edit was stripped here before it was ever written, so a rename
    // through a profile version stored nothing and activation had no name to apply. Adding a field to
    // `ProfileDefinitionBody` without adding it here produces a field that type-checks everywhere and
    // persists nowhere.
    ...(obj.displayName !== undefined ? { displayName: obj.displayName } : {}),
    ...(obj.contextSources !== undefined ? { contextSources: obj.contextSources } : {}),
    ...(obj.workflows !== undefined ? { workflows: obj.workflows } : {}),
    ...(obj.confirmBrief !== undefined ? { confirmBrief: obj.confirmBrief as Record<string, ConfirmPolicy> } : {}),
    ...(obj.goldenSet !== undefined ? { goldenSet: obj.goldenSet } : {}),
  };
}

/**
 * Build the per-intent route strategy (`IntentRouteDefinition[]`, what `resolveModelForIntent` consumes)
 * from a profile version's `models.byIntent`. `resolveModelForIntent` reads only `intent`/`primaryModel`/
 * `fallbackModel`, so the other fields are placeholders. Returns null when the profile has no per-intent
 * routing, so the caller falls back to the (legacy) global strategy. THIS is what moves per-intent model
 * routing off the global table and onto the profile (U2 / SPEC-ASSISTANT-CONFIG §4).
 */
export function buildIntentStrategy(models: ProfileModels | undefined): IntentRouteDefinition[] | null {
  const byIntent = models?.byIntent;
  if (!byIntent || Object.keys(byIntent).length === 0) return null;
  // A per-intent route whose primary is the `'default'` sentinel means "no override — use the base model
  // for this intent", so it is DROPPED from the strategy (the resolver then falls back to base). Only
  // routes that name a concrete primary become strategy entries. An IMAGE route never does: the text
  // resolver is never handed an image model, and an image-routed intent takes the image path instead.
  const entries = Object.entries(textRoutesOf(byIntent)).filter(([, route]) => concreteModel(route.primary));
  if (entries.length === 0) return null;
  return entries.map(([intent, route]) => ({
    intent: intent as RouteKey,
    label: intent,
    primaryModel: route.primary as BackendModelKey,
    fallbackModel: (concreteModel(route.fallback) ?? route.primary) as BackendModelKey,
    rationale: 'per-profile version (SPEC-ASSISTANT-CONFIG §4)',
  }));
}

/**
 * THE PLATFORM ROUTES AS A VERSION ON `baseModelKey` SERVES THEM, explicitly: each route the retired
 * classification floor would have raised says the base model, and a standalone greeting or acknowledgment
 * keeps the route it was answered on (`routesAsServedByTheFloor`). A seed and a body with no routes carry
 * these, so what a version says is what it serves. With no concrete base model the routes are as written.
 */
export function platformRoutesServedOn(baseModelKey: string | undefined): Record<string, { primary: string; fallback?: string }> {
  const routes = seedByIntentFromGlobalStrategy();
  // Cost classes are the catalog's own and do not depend on the region or account.
  return routesAsServedByTheFloor(routes, baseModelKey, getModelCatalog('us-east-1', '') as Record<string, { costClass: 'low' | 'medium' | 'high' }>).byIntent ?? routes;
}

/** Seed a profile's `models.byIntent` from the legacy global strategy — a per-profile COPY, so building
 *  the strategy back from it is byte-identical to feeding `INTENT_ROUTE_STRATEGY` directly. */
function seedByIntentFromGlobalStrategy(): Record<string, { primary: string; fallback?: string }> {
  const out: Record<string, { primary: string; fallback?: string }> = {};
  for (const r of INTENT_ROUTE_STRATEGY) out[r.intent] = { primary: r.primaryModel, fallback: r.fallbackModel };
  return out;
}

/**
 * Backfill a COMPLETE `models` bundle onto a (possibly legacy) body so export/edit surfaces the ACTUAL
 * editable values, not a bare `modelKey` + a config hash. A definition activated BEFORE the models bundle
 * existed (pre-U2) has no `models` at all; this reconstructs it from the body's own base model + the seeded
 * per-intent strategy + the explicit classifier sentinel, so a round-trip (export → hand-edit → import) has
 * real fields to change. Idempotent: a body that already carries a populated `byIntent` is returned as-is
 * (only genuinely-missing pieces are filled). Does NOT invent tools/guardrail (those have no compiled seed).
 */
export function ensureModelsBundle(body: ProfileDefinitionBody): ProfileDefinitionBody {
  const models = body.models ?? {};
  const hasByIntent = !!models.byIntent && Object.keys(models.byIntent).length > 0;
  return {
    ...body,
    models: {
      default: models.default ?? body.modelKey,
      classifier: models.classifier ?? DEFAULT_MODEL,
      // A body with no routes is given the platform routes AS SERVED (`platformRoutesServedOn`): the routes
      // are served as written, so they say what the retired floor made them serve.
      byIntent: hasByIntent ? models.byIntent : platformRoutesServedOn(concreteModel(models.default) ?? concreteModel(body.modelKey)),
      // NO IMAGE MODEL IS BACKFILLED. An image model is one an assistant manager chose, from what the
      // assistant's classification allows (`model-availability.ts`); a body that names none generates no
      // images. Preserve an explicit key, the legacy `image` included (read as the `image_generation` route).
      ...(models.image !== undefined ? { image: models.image } : {}),
    },
    // A legacy body carries no `tools`; backfill the full registry set so export/edit shows the real,
    // editable tool surface (an all-tools body resolves byte-identically to unset). Preserve an explicit list.
    tools: body.tools ?? [...ALL_TOOL_NAMES],
  };
}

/** Extract the runtime-editable body from a full (seed) AssistantProfile. The seed carries the new
 *  `models` bundle: `default` = the profile's base modelKey, and `byIntent` seeded per-profile from the
 *  legacy global strategy so U2's per-profile resolution is byte-identical to the old global path. */
/** The pack as a version stores it: everything except the `machines` block, which a version does not
 *  read (the deployment pack parameter remains its only live home). */
export function packWithoutMachines(pack: StoredIntentPack): StoredIntentPack {
  if (pack.machines === undefined) return pack;
  const { machines: _dropped, ...rest } = pack;
  return rest;
}

/**
 * The seeded per-intent routes, keeping only what the supplied pack can actually classify.
 *
 * A route is keyed by the intent it serves, so a seeded route is kept when the pack can classify its key - the
 * same comparison `deploymentRouteErrors` makes, so the seed cannot produce a body that validator would refuse.
 */
function seedByIntentReachableIn(intentPack?: StoredIntentPack, baseModelKey?: string): ReturnType<typeof seedByIntentFromGlobalStrategy> {
  const all = platformRoutesServedOn(baseModelKey);
  if (!intentPack) return all;
  const reachable = new Set<string>([...intentKeysOf(intentPack), ...UNIVERSAL_INTENT_KEYS]);
  return Object.fromEntries(
    Object.entries(all).filter(([route]) => reachable.has(route as RouteKey) || TRIVIAL_ROUTE_KEYS.includes(route)),
  ) as ReturnType<typeof seedByIntentFromGlobalStrategy>;
}

/**
 * THE CLASSIFICATION A PROFILE SERVES: the registry's answer for a declared assistant or an alt, else the
 * classification this process serves (`CLASSIFICATION`), which is the only one a runtime assistant a
 * router or processor serves can belong to. Undefined when neither knows.
 */
export function classificationOfProfile(profileName: string): string | undefined {
  return defaultProfileRegistry.classificationOfAssistant(profileName) ?? (process.env.CLASSIFICATION || undefined);
}

/**
 * KEEP ONLY THE MODEL SELECTIONS THIS CLASSIFICATION ALLOWS, EACH FIT FOR ITS USE (`modelFits`).
 *
 * The base model and the classifier must be text models the classification allows, the image model an
 * image model it allows, and each per-intent route a text model it allows. A selection that is not is
 * DROPPED, never crashed on, and named in `dropped` so the caller logs why: the base model then falls to
 * the classification's seed, the classifier to the platform default, a route to the classification
 * default, and no image model means the assistant generates none. A `'default'` sentinel is kept, since it
 * names no model. Undefined classification confines nothing.
 *
 * `routes: false` leaves the per-intent routes to the resolver, which already refuses a route its
 * classification does not allow on every turn (`resolveModelForIntent`); the read path passes it so a
 * stored body's seeded routes are not re-reported on every resolution.
 */
export function confineModelsToClassification(
  models: ProfileModels | undefined,
  classification: string | undefined,
  opts: { routes?: boolean } = {},
): { models: ProfileModels | undefined; dropped: string[] } {
  if (!models || !classification) return { models, dropped: [] };
  const dropped: string[] = [];
  const out: ProfileModels = { ...models };
  const keep = (key: string | undefined, label: string, output: 'text' | 'image'): boolean => {
    if (!key || key === DEFAULT_MODEL) return true;
    const why = modelFits(key, classification, output);
    if (why) dropped.push(`${label}: ${why}`);
    return !why;
  };
  if (!keep(out.default, 'models.default', 'text')) delete out.default;
  if (!keep(out.classifier, 'models.classifier', 'text')) delete out.classifier;
  if (!keep(out.image, 'models.image', 'image')) delete out.image;
  if (out.byIntent && opts.routes !== false) {
    const routes: NonNullable<ProfileModels['byIntent']> = {};
    for (const [intent, route] of Object.entries(out.byIntent)) {
      // A route's kind is its primary's: an image route is held to image models, a text route to text models.
      const kind = isImageRoute(route) ? 'image' : 'text';
      if (!keep(route.primary, `models.byIntent['${intent}'].primary`, kind)) continue;
      const kept: NonNullable<ProfileModels['byIntent']>[string] = keep(route.fallback, `models.byIntent['${intent}'].fallback`, kind)
        ? { ...route }
        : { ...route, fallback: undefined };
      if (kept.fallback === undefined) delete kept.fallback;
      // THE IMAGE PART AND EACH STEP OVERRIDE are held to the classification the same way (ADR-064 security posture):
      // a step's kind is its model's, so an image step override is held to image models and a text one to text models.
      if (route.image) {
        if (!keep(route.image.primary, `models.byIntent['${intent}'].image.primary`, 'image')) delete kept.image;
        else if (!keep(route.image.fallback, `models.byIntent['${intent}'].image.fallback`, 'image')) kept.image = { primary: route.image.primary };
      }
      if (route.steps) {
        const steps: Record<string, { primary: string; fallback?: string }> = {};
        for (const [state, step] of Object.entries(route.steps)) {
          const stepKind = isImageModelKey(step.primary) ? 'image' : 'text';
          if (!keep(step.primary, `models.byIntent['${intent}'].steps['${state}'].primary`, stepKind)) continue;
          steps[state] = keep(step.fallback, `models.byIntent['${intent}'].steps['${state}'].fallback`, stepKind) ? step : { primary: step.primary };
        }
        if (Object.keys(steps).length) kept.steps = steps; else delete kept.steps;
      }
      // A route left naming no model at all is dropped whole.
      if (kept.primary || kept.image || kept.steps) routes[intent] = kept;
    }
    out.byIntent = routes;
  }
  // A ROUTING RULE SELECTS ONLY A MODEL THE CLASSIFICATION SELECTS: one naming any other is dropped and named.
  if (out.routing && opts.routes !== false) {
    out.routing = out.routing.filter((rule, i) => keep(rule.model, `models.routing[${i}].model`, 'text'));
  }
  return { models: out, dropped };
}

/** At most this many routing rules on one version. */
export const MAX_ROUTING_RULES = 16;

/**
 * Why a version's routing rules are refused as written: a list of `{ when, model }`, each model a text model key and
 * each condition held to ADR-060 decision 3 over the sources every classification publishes, selecting a message the
 * room reads. A `ctx:` key is held by the check that reads the classification's catalog (`versionConditionErrors` in
 * `profile-lifecycle.ts`), which every version passes at validate, activate, a variant and import.
 */
export function routingRuleErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['models.routing is a list of { when, model } rules'];
  const errs: string[] = [];
  if (raw.length > MAX_ROUTING_RULES) errs.push(`models.routing holds at most ${MAX_ROUTING_RULES} rules`);
  const lookup = withUnreadCatalog(sourceLookup(buildSourceTable({ catalog: [], classifications: defaultProfileRegistry.classificationValues() })));
  raw.forEach((rule, i) => {
    const at = `models.routing[${i}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { errs.push(`${at} is { when, model }`); return; }
    const r = rule as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== 'when' && k !== 'model') errs.push(`${at}.${k} is not a rule field; a rule is { when, model }`);
    if (typeof r.model !== 'string' || !r.model) errs.push(`${at}.model must be a non-empty modelKey`);
    else if (outputOf(r.model) !== 'text') errs.push(`${at}.model '${r.model}' is not a text model of the catalog`);
    if (r.when === undefined) errs.push(`${at}.when is required: a rule with no condition would route every turn`);
    else errs.push(...whenErrors(r.when, lookup, { selects: 'room', catalog: 'deferred' }).map((e) => `${at}.when: ${e}`));
  });
  return errs;
}

function bodyOf(profile: AssistantProfile, intentPack?: StoredIntentPack): ProfileDefinitionBody {
  // A SEED PRESELECTS ONLY WHAT ITS CLASSIFICATION ALLOWS: the routes and the image model below are
  // confined to the profile's classification, so no version starts with a model it was never allowed.
  const seededModels = confineModelsToClassification({
    default: profile.modelKey,
    classifier: DEFAULT_MODEL,
    byIntent: withImageParts(
      seedByIntentReachableIn(intentPack, profile.modelKey),
      // The default image part for every intent of the pack this version carries that needs an image.
      defaultImageRoute(classificationOfProfile(profile.name), imageIntentRouteKeysOf(intentPack)),
    ),
  }, classificationOfProfile(profile.name)).models;
  return {
    modelKey: profile.modelKey,
    // THE MIGRATION. When the caller has the deployment's pack, version 1 CARRIES it rather than
    // inheriting it from the SSM/env seam. Behavior on the first write is unchanged - it is the same
    // taxonomy, just written down - but three things only work once it is written down:
    //   - `models.byIntent` can be reconciled against it by the pure validator, so a version routing an
    //     intent this assistant does not recognize is refused instead of silently never firing;
    //   - an export carries the taxonomy, so an imported profile classifies the way it did at home
    //     rather than falling back to the generic default on the target instance;
    //   - an operator can EDIT it, which on this deployment was not possible at all: the stack's
    //     `IntentPackParamWriter` is never created (no `-c assistantIntentPack`) and `seed-demo` writes
    //     the parameter only if absent, so editing the pack in code could not reach a live deployment.
    // Omitted by the callers that want the pure compiled default (the lifecycle reset baseline, the
    // manifest's seed comparison), exactly as `persona` is.
    //
    // THE PACK'S `machines` BLOCK IS LEFT BEHIND on purpose. A deployment pack may carry one and
    // `taskStateMachines()` reads it there; a VERSION's copy is read by nothing, and the body's
    // top-level `machines` is the field that works (see validateDefinitionBody). Carrying it across
    // would seed every profile with a block that looks authoritative and decides nothing - and the
    // validator would then refuse the seed it just produced.
    ...(intentPack ? { intentPack: packWithoutMachines(intentPack) } : {}),
    // classifier is seeded EXPLICITLY as the `'default'` sentinel (not absent, not the concrete Haiku key):
    // the profile records "follow the classification-set classifier" as a choice that tracks the platform
    // default over time. Resolution treats `'default'` == unset ⇒ CLASSIFIER_MODEL, so this is byte-behavior-
    // identical to leaving it off.
    // the `image_generation` route is seeded to the default aws-bedrock image models (primary and fallback,
    // no external key needed, `defaultImageRoute`) ONLY where the profile's classification allows them, so
    // an assistant there generates images out of the box and an assistant elsewhere is never given one
    // (`confineModelsToClassification` above).
    // ── THE SEEDED ROUTES ARE NARROWED TO THE PACK THIS VERSION CARRIES ───────────────────────
    //
    // `seedByIntentFromGlobalStrategy()` is the PLATFORM default taxonomy. Written beside a
    // deployment pack that declares a different set, it produces a version that is invalid against
    // its own pack the moment anything checks: routes that can never fire, refused by the validator
    // this same comment block says the carried pack enables.
    //
    // MEASURED, not hypothetical. A deployment running the demo pack seeded
    // `code_generation`/`code_review`/`strategic_analysis` routes its classifier cannot resolve, and
    // every later edit to those profiles was refused for routes nobody had written - the assistant
    // could not even be renamed. Narrowing here makes seed and pack consistent BY CONSTRUCTION
    // instead of leaving the validator to report a contradiction the seed created.
    //
    // No pack supplied ⇒ the platform default taxonomy IS the taxonomy, so nothing is dropped.
    models: seededModels,
    // Tools are seeded EXPLICITLY as the full registry set (visible + editable per profile). All-tools-allowed
    // intersected with runtime availability == the pre-allowlist behavior, so seeding is byte-behavior-identical
    // while making the surface concrete (an operator removes a tool to restrict this profile). SPEC-ASSISTANT-CONFIG §4.
    tools: [...ALL_TOOL_NAMES],
    // The seed's `classifierMode`, `timeoutSeconds`, `taskSupport`, `rateLimitPerHour` and
    // `battleEligible` are deliberately NOT copied in. They are deployment-time settings that stay in
    // `lib/config/profiles.ts` and the stack topology; seeding them into a version would put an
    // editable copy in front of an operator that publishing cannot make take effect.
  };
}

/**
 * The catalog context sources every seed selects. `user-profile` is who the person is, which every
 * assistant answers better for; its catalog entry is `identity-settled`, so the welcome omits it.
 * `company-docs` is not here: the company document menu is in every turn already, with the tool to read a
 * document on demand.
 */
export const SEEDED_CONTEXT_SOURCES: readonly string[] = ['user-profile'];

/**
 * Serialize a profile's SEED (version 1) definition for the initial SSM write. The seed is
 * byte-for-byte the compiled default, so a fresh deploy that activates it changes nothing.
 * Returns null when the name is not a declared profile (nothing to seed).
 *
 * `persona` is the deployment's persona, folded into the definition when the caller has one. It
 * belongs HERE rather than only in the `assistant-system-prompt` SSM parameter, because the
 * definition is the portable artifact: `profile-manifest` exports the persona with the version, and
 * the async processor prefers it over the deployment seam precisely "so an import carries it"
 * (assistant-async-processor.ts). A deployment whose persona lives only in the parameter exports a
 * profile that is mute about who the assistant is, and lands on another instance answering as the
 * generic default - the portable artifact is not portable.
 *
 * `intentPack` is the deployment's taxonomy, folded in the same way and for the same reason - the
 * spec has always defined a profile as including it (SPEC-PORTABLE-PROFILES: "model, persona, INTENT
 * PACK, tools, guardrail selection"). Seeding it is the migration: it writes down what the deployment
 * was already classifying against, so nothing changes on the first write, and from then on the
 * taxonomy versions, rolls back, exports and converges with everything else the profile is.
 *
 * Callers that want the pure compiled default (the lifecycle reset baseline, the manifest's seed
 * comparison) omit both and get the previous behavior byte-for-byte. Persona and pack are both part
 * of the hashed body, so two personas - or two taxonomies - are two configIds, which is what makes
 * per-turn config attribution able to tell them apart.
 *
 * EVERY SEED SELECTS `SEEDED_CONTEXT_SOURCES`. A declared assistant's seeded version, a console-created
 * assistant's first draft from its classification's defaults, and the reset baseline all start here, so
 * each of them selects the same context sources from this one place.
 */
export function serializeSeedDefinition(
  profileName: string,
  persona?: string,
  intentPack?: StoredIntentPack,
  onboarding?: IntakeConfig,
  boundary?: string,
  /**
   * The assistant's OWN welcome workflows (W1), seeded onto the version's `eventWorkflows`.
   *
   * Each opening step's fields are parsed on READ anyway (`selectOpening` in the router), so a per-conversation field
   * a version may not set is dropped there whatever is written here. Seeding them is what stops an assistant whose
   * classification parameter belongs to a different assistant from rendering that assistant's opening.
   */
  eventWorkflows?: ProfileDefinitionBody['eventWorkflows'],
  /** The catalog context sources the version selects (`contextSources`). Defaults to `SEEDED_CONTEXT_SOURCES`. */
  contextSources: readonly string[] = SEEDED_CONTEXT_SOURCES,
): string | null {
  const seed = seedFor(profileName);
  if (!seed) return null;
  // Empty/whitespace is treated as absent, matching the runtime's `persona?.trim() || fallback`.
  //
  // Line endings are normalized to LF first. A persona authored in the repo reaches this function via
  // a git checkout, and on Windows `core.autocrlf` rewrites its newlines to CRLF - so the SAME profile
  // seeded from a Windows machine and from CI produces different bytes, a different content hash, and
  // therefore a different configId. That silently splits per-turn config attribution across platforms
  // and makes an exported manifest's contentHash depend on who exported it. Observed live: the
  // deployment's standard persona was byte-identical to the source apart from 9 carriage returns.
  const trimmed = persona?.replace(/\r\n/g, '\n').trim();
  const body = {
    ...bodyOf(seed, intentPack),
    ...(trimmed ? { persona: trimmed } : {}),
    ...(onboarding ? { onboarding } : {}),
    ...(boundary?.trim() ? { boundary: boundary.trim() } : {}),
    ...(eventWorkflows && Object.keys(eventWorkflows).length ? { eventWorkflows } : {}),
    ...(contextSources?.length ? { contextSources: [...contextSources] } : {}),
  };
  const def: ProfileDefinition = {
    schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
    profileName,
    ...body,
    configId: profileDefinitionConfigId(body),
  };
  return JSON.stringify(def);
}

/** SSM parameter name holding a profile's definition. `active` label selects the served version (§3). */
export function definitionParamName(ssmRoot: string, profileName: string): string {
  return `${ssmRoot}/assistant/${profileName}/definition`;
}

export { isNoActiveVersion };

/**
 * Validate a parsed definition against the schema + the §7 cut. Throws on any violation so the caller
 * fails closed to the seed rather than serving an unvalidated (possibly hostile) definition.
 */
function parseDefinition(raw: string, expectedName: string): ProfileDefinition {
  const d = JSON.parse(raw) as Partial<ProfileDefinition>;
  if (d.schemaVersion !== PROFILE_DEFINITION_SCHEMA_VERSION) {
    throw new Error(`definition schemaVersion ${d.schemaVersion} != ${PROFILE_DEFINITION_SCHEMA_VERSION}`);
  }
  if (d.profileName !== expectedName) {
    throw new Error(`definition profileName '${d.profileName}' != segment '${expectedName}'`);
  }
  // A RETIRED `models` FIELD IS READ AS ABSENT. A version stored while `models.externalProviderAllowed`
  // existed still carries it. It enables nothing (the classification's selection decides an external model),
  // so it is removed here rather than failing the read closed to the seed.
  if (d.models && typeof d.models === 'object' && 'externalProviderAllowed' in d.models) {
    const { externalProviderAllowed: _retired, ...models } = d.models as ProfileModels & { externalProviderAllowed?: unknown };
    d.models = models;
  }
  const errs = validateDefinitionBody(d);
  if (errs.length) throw new Error(`definition invalid: ${errs.join('; ')}`);
  return d as ProfileDefinition;
}

/**
 * A cached resolution: the WHOLE resolved shape plus an expiry.
 *
 * DERIVED FROM `ResolvedActiveProfile` RATHER THAN RESTATED. It used to restate every field, which made
 * four places that had to agree - this type, the resolved type, the cache-hit return and the `cache.set`
 * - with nothing comparing them. A field added to the resolved shape and missed here type-checks
 * perfectly, because every optional field is assignable to an optional field. `intentPack` and
 * `onboarding` were lost that way. Extending the type means a new field is cached by construction.
 */
type CacheEntry = ResolvedActiveProfile & { expires: number };
const cache = new Map<string, CacheEntry>();

/** The resolved active profile plus its version fingerprint (for analytics/attribution). */
export interface ResolvedActiveProfile {
  profile: AssistantProfile;
  /** The active version's configId, or `'seed'` when it fell back to the compiled default. */
  configId: string;
  /**
   * The SSM parameter version this resolved to - the operator's handle, the number the Profiles tab
   * lists and rolls back to. Undefined on the seed fallback, where there is no version to name.
   *
   * DISTINCT FROM `configId`, which fingerprints what the version SAYS: two versions with identical
   * bodies share a configId and do not share a number, and the same body imported into another
   * deployment keeps the configId and gets a different number. Analytics records both.
   */
  version?: number;
  /** The active version's per-profile model bundle (base + classifier + per-intent routing). Undefined
   *  when it fell back to the seed profile (no active version) — the caller then uses the global strategy
   *  (byte-identical, since the seed COPIES the global strategy into each version's byIntent). */
  models?: ProfileModels;
  /** The active version's per-profile tool ALLOWLIST. Undefined when it fell back to the seed (no active
   *  version) — the loop then offers all runtime-available tools (byte-identical to the pre-allowlist path). */
  tools?: string[];
  /** WHICH GLOBAL WORKFLOWS this assistant may open. Undefined ⇒ every available one. A SELECTION over
   *  the platform + classification graphs, never a definition of one (see ProfileDefinitionBody). The
  workflows?: string[];
  /** Per workflow, when its confirmed step is put to the person (`ProfileDefinitionBody.confirmBrief`). Undefined: each
   *  workflow's declared value. */
  confirmBrief?: Record<string, ConfirmPolicy>;
  workflows?: string[];
  /** The primary of the active version's `image_generation` route (`imagePrimaryOf`: the route, or the
   *  legacy `models.image`), or the seed's default image model on the seed fallback. Every image route,
   *  its fallback included, is read from `models.byIntent` (`imageRouteFor`). */
  imageModelKey?: string;
  /** The active version's intent taxonomy (SPEC-PORTABLE-PROFILES). Undefined on the seed fallback,
   *  or on a version that carries none — the classifier then uses the deployment pack. */
  intentPack?: IntentPack;
  /** The active version's onboarding intake (greeting, fields, completion). Undefined on the seed
   *  fallback or a version that carries none — the router then uses the deployment ONBOARDING_INTAKE
   *  seam, so a deployment that has not migrated onboards exactly as it did. */
  onboarding?: IntakeConfig;
  /** One line saying what this assistant does NOT reach, authored on the version. Undefined ⇒ the
   *  assistant says nothing about its limits, which is the previous behavior. */
  boundary?: string;
  /** The active version's selected guardrail id (4.6). The apply path uses it in place of the
   *  deployment `GUARDRAIL_ID` env — so a profile SELECTS among the deployment-provisioned guardrails.
   *  Undefined ⇒ the deployment default guardrail (env). Never an arbitrary ARN: selection only, and the
   *  IAM `ApplyGuardrail` grant is per provisioned guardrail, so an unprovisioned id fails closed (open). */
  guardrailId?: string;
  /** The active version's PERSONA (system-prompt body). The worker uses it in place of the deployment
   *  persona seam. Undefined ⇒ the deployment persona (ASSISTANT_SYSTEM_PROMPT[_PARAM] → default). */
  persona?: string;
  /** The version's persona addendum, layered after the persona (`personaAddendumBlock`). */
  systemPromptAddendum?: string;
  /** The name this version gives the assistant (`displayName` on the body). Undefined ⇒ the version
   *  names nothing. */
  displayName?: string;
  /** Catalog context source KEYS this version selects, in prompt order (SPEC-CONTEXT-SOURCES-AND-STORES). */
  /** Which of its own templates a message is said from (`ProfileDefinitionBody.messages`). */
  messages?: import('./message-template.js').VersionMessages;
  /** The event workflows this version declares (`ProfileDefinitionBody.eventWorkflows`). */
  eventWorkflows?: ProfileDefinitionBody['eventWorkflows'];
  /** The variables this version names (`ProfileDefinitionBody.variables`). */
  variables?: ProfileDefinitionBody['variables'];
  contextSources?: string[];
}

export interface ResolveActiveProfileOptions {
  ssm: SSMClient;
  ssmRoot: string;
  /** Cache TTL for a warm container. Default 30s: an activation converges within it. */
  ttlMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * THE VERSION'S OWN FIELDS ONLY, its bodies left unread: for a reader that needs the copy and the display
   * name (an email's wrapping), not the persona or the taxonomy the bodies hold, and so needs no read of the
   * body store. The persona and pack it returns are the SEED's, never this version's: never serve a turn from it.
   * Cached apart from a full resolution, so a turn never gets a version stripped of its bodies.
   */
  withoutBodies?: boolean;
}

/**
 * Resolve the ACTIVE version of a profile, merged over its compiled seed. Boundary fields
 * (name, contextScope) always come from the seed; only the §7 runtime-editable subset is taken from
 * the active version. Fail-closed to the pure seed on any error. Cached per container for `ttlMs`.
 */
/**
 * The event workflows ANOTHER assistant's active version declares: the run's owner, read where a step names a role
 * (`as: { role }`) and this assistant takes it. Not the serving profile: this turn is still resolved once, by
 * `resolveActiveProfile` with its variant. Undefined when the owner's version cannot be read, so no step is taken.
 */
export async function ownerEventWorkflows(
  ownerProfileName: string,
  opts: ResolveActiveProfileOptions,
): Promise<ResolvedActiveProfile['eventWorkflows'] | undefined> {
  return (await resolveActiveProfile(ownerProfileName, opts).catch(() => undefined))?.eventWorkflows;
}

export async function resolveActiveProfile(
  profileName: string,
  opts: ResolveActiveProfileOptions,
): Promise<ResolvedActiveProfile> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 30_000;

  const seed = seedFor(profileName);
  // No such seed profile ⇒ nothing to serve. This used to resolve the profile of the fail-closed
  // CLASSIFICATION, which is an indirection through an order that no longer exists
  // - and a strange one even then, since the question is "which profile" and the answer came from a
  // classification. An unknown profile name is a caller error, so it is raised as one.
  if (!seed) {
    throw new Error(`active-profile: no seed profile named '${profileName}'`);
  }
  const seedProfile = seed;

  const cacheKey = opts.withoutBodies ? `${profileName}#without-bodies` : profileName;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now()) {
    // SPREAD, NEVER ENUMERATE. This line and the `cache.set` below each listed every field by hand,
    // and the two lists plus `CacheEntry` plus `ResolvedActiveProfile` had to agree - four places, with
    // nothing checking them against each other. Every optional field is assignable to an optional
    // field, so TypeScript is silent when a name is missing from one of them.
    //
    // It failed exactly that way: `intentPack` and `onboarding` were added to the type and to
    // `resolveFromDefinition` and dropped by both lists, so the FIRST turn after a TTL miss saw the
    // version's taxonomy and intake and every cached turn after it silently fell back to the
    // deployment seam - a 30-second window of correct behavior followed by wrong behavior that looked
    // identical. Spreading removes the class: a new field on the resolved shape is cached by
    // construction.
    const { expires: _expires, ...resolvedFromCache } = cached;
    return resolvedFromCache;
  }

  // On the seed fallback (no activated version) the image model defaults to the seed's image capability
  // (== what serializeSeedDefinition would produce) so image generation works OUT OF THE BOX. This is
  // purely additive — image had no normal-path behavior before — so the "behavior diff empty on the seed"
  // text invariant (models/tools stay undefined ⇒ global text strategy) is untouched.
  let resolved: ResolvedActiveProfile = {
    profile: seedProfile,
    configId: 'seed',
    // The seed's preselected image model, only where the classification allows one (as `bodyOf` seeds it).
    ...(modelFits(DEFAULT_IMAGE_MODEL, classificationOfProfile(profileName), 'image') === null
      ? { imageModelKey: DEFAULT_IMAGE_MODEL }
      : {}),
  };
  try {
    const resp = await opts.ssm.send(
      new GetParameterCommand({ Name: `${definitionParamName(opts.ssmRoot, profileName)}:active` }),
    );
    const raw = resp.Parameter?.Value;
    if (raw) {
      const def = parseDefinition(raw, profileName);
      // WHICH VERSION THIS IS, kept rather than discarded. The response has always carried it and
      // nothing read it, so `profileVersion` was declared on the analytics metadata, rendered as a
      // column in the console's L1 view, and never written by a live turn - the only writer was the
      // manual backfill tool. An operator asking "which version produced this" got a blank.
      //
      // The SSM parameter version is the operator's handle ("v3"): monotonic, per deployment, and the
      // same number the Profiles tab lists and rolls back to. It sits ALONGSIDE `configId`, which
      // identifies what the version SAYS and is comparable across deployments - two answers to two
      // questions rather than a choice between them.
      // Follow the persona pointer, if this version has one. INSIDE the try and INSIDE the cache: an
      // unreadable body takes the same fail-closed path as an unreadable parameter (serve the compiled
      // seed, loudly) rather than serving a version stripped of the persona it declares, and a warm
      // container pays for the S3 read once per TTL, not once per turn.
      resolved = { ...resolveFromDefinition(opts.withoutBodies ? withoutBodyPointers(def) : await hydrateBodies(def), profileName), version: resp.Parameter?.Version };
    }
  } catch (err) {
    // Absent label/param (nothing activated yet) is the COMMON, expected path — log at debug volume;
    // a parse/validation failure is louder but still fail-closed to the seed.
    if (!isNoActiveVersion(err)) {
      console.warn(`[active-profile] '${profileName}' active version unresolved; serving seed:`, (err as { name?: string })?.name ?? err);
    }
  }

  cache.set(cacheKey, { ...resolved, expires: now() + ttlMs });
  return resolved;
}

/**
 * ONE EXACT VERSION of a profile's definition, the one the vend narrowed the turn's session by
 * (`assistant-grant.ts`). Serving another version than that one could ask for a model or a context
 * prefix the session does not hold, so the turn reads the version, not the label.
 *
 * A version is immutable, so it is cached for the container rather than for a TTL. A version that
 * cannot be read falls back to the label, the same answer `resolveActiveProfile` gives, and the
 * session's grants still bound whatever that turns out to ask for.
 */
const versionCache = new Map<string, ResolvedActiveProfile>();

export async function resolveProfileVersion(
  profileName: string,
  version: number,
  opts: ResolveActiveProfileOptions,
): Promise<ResolvedActiveProfile> {
  const key = `${profileName}:${version}`;
  const hit = versionCache.get(key);
  if (hit) return hit;
  try {
    const resp = await opts.ssm.send(
      new GetParameterCommand({ Name: `${definitionParamName(opts.ssmRoot, profileName)}:${version}` }),
    );
    const raw = resp.Parameter?.Value;
    if (raw) {
      const def = parseDefinition(raw, profileName);
      const resolved = { ...resolveFromDefinition(await hydrateBodies(def), profileName), version: resp.Parameter?.Version };
      versionCache.set(key, resolved);
      return resolved;
    }
  } catch (err) {
    console.warn(`[active-profile] '${key}' unreadable; serving the active label:`, (err as { name?: string })?.name ?? err);
  }
  return resolveActiveProfile(profileName, opts);
}

/**
 * Build the resolved runtime shape from a stored definition, merged over a seed profile.
 *
 * Extracted so an EXPERIMENT VARIANT can be served from a definition that is not the profile's active
 * version (SPEC-PORTABLE §6: a `profileRef` variant runs an entire version). It is deliberately pure and
 * takes no cache: the warm-container cache is keyed by profile NAME, so writing a variant's version into
 * it would serve that variant's persona and tools to the next ordinary turn on the same container.
 *
 * Merge rule (unchanged, §7): only the runtime-editable body merges over the seed; identity and boundary
 * fields stay from the seed, so a version can never widen what its classification permits.
 */
/** A stored definition with its body pointers dropped, for a `withoutBodies` read: its persona and pack fall to the seed. */
function withoutBodyPointers(def: ProfileDefinition): ProfileDefinition {
  const { personaRef: _persona, intentPackRef: _pack, ...rest } = def;
  return rest as ProfileDefinition;
}

export function resolveFromDefinition(
  def: ProfileDefinition,
  profileName: string,
): ResolvedActiveProfile {
  // A definition still holding a POINTER has not been hydrated, and serving it would answer with no
  // persona while reporting this version's configId. That is the failure this refuses to make quiet:
  // it is a caller bug (a read path that forgot `hydrateBodies`), it looks like a healthy turn, and
  // every caller here already has a fail-closed path for a throw.
  if (def.personaRef && def.persona === undefined) {
    throw new Error(
      `[active-profile] '${profileName}' version ${def.configId} was resolved without hydrating its `
      + 'persona pointer; call hydrateBodies on a stored definition before serving it.',
    );
  }
  // THE SAME REFUSAL FOR THE PACK, and it hides even better than the persona one. An unhydrated pack
  // pointer resolves to `intentPack: undefined`, which is a legitimate state meaning "inherit the
  // deployment taxonomy" - so the turn would classify against the wrong pack, report THIS version's
  // configId, and look entirely healthy. A missing persona at least reads oddly to a person.
  if (def.intentPackRef && def.intentPack === undefined) {
    throw new Error(
      `[active-profile] '${profileName}' version ${def.configId} was resolved without hydrating its `
      + 'intent-pack pointer; call hydrateBodies on a stored definition before serving it. Serving it '
      + 'unhydrated would classify against the deployment pack while reporting this version.',
    );
  }
  // Same fail-closed seed rule as resolveActiveProfile, resolved HERE rather than by the caller: an
  // experiment variant must not be the place where a different (or absent) fallback creeps in.
  const seed = seedFor(profileName);
  if (!seed) throw new Error(`active-profile: no seed profile named '${profileName}'`);
  const seedProfile = seed;
  // A STORED BODY THAT SELECTS A MODEL ITS CLASSIFICATION DOES NOT ALLOW, OR ONE UNFIT FOR ITS USE, IS
  // SERVED WITHOUT THAT SELECTION, and says so. The write path refuses such a body now; one stored before
  // it did (an image model backfilled into every version, whatever its classification) is read, not
  // crashed on. Whatever the source - an active version, a pinned duel side, an experiment's version -
  // the served version never carries a model its classification cannot use.
  const confined = confineModelsToClassification(def.models, classificationOfProfile(profileName), { routes: false });
  if (confined.dropped.length) {
    console.warn('[active-profile] serving a version without the model selections its classification does not allow', {
      profileName, configId: def.configId, dropped: confined.dropped,
    });
    def = { ...def, models: confined.models };
  }
  const merged: AssistantProfile = {
    ...seedProfile,
    // Effective base model: the version's `models.default` when set to a CONCRETE key, else the
    // transitional top-level modelKey, else the seed's CLASSIFICATION default — so a version that
    // leaves base blank OR carries the `'default'` sentinel inherits the classification default
    // (shown in the Model Strategy tab). `concreteModel` skips both blank and the sentinel.
    modelKey: concreteModel(def.models?.default) ?? concreteModel(def.modelKey) ?? seedProfile.modelKey,
    // `classifierMode`, `timeoutSeconds`, `taskSupport`, `rateLimitPerHour` and `battleEligible` are
    // NOT merged from the definition: the seed's values stand, which is what every reader of those
    // fields already used. They were merged here once, and the merged copy was read by nothing - so a
    // version could say `battleEligible: true` while `/battle` stayed refused and the Profiles tab
    // showed the version's answer. The seed is now the only answer anywhere.
  };
  const out = {
    profile: merged,
    configId: def.configId,
    models: def.models,
    tools: def.tools,
    workflows: def.workflows,
    confirmBrief: def.confirmBrief,
    imageModelKey: imagePrimaryOf(def.models),
    // `machines` is no longer carried: `bodyFrom` drops it, so this would always be undefined, and a
    // field that is structurally always absent reads as a capability that merely happens to be unset.
    // Task graphs are global; what a version says about them is `workflows` above, a SELECTION.
    // RESOLVED here, once, at the boundary between what is STORED and what is SERVED. Every reader
    // downstream then takes a pack it can use directly and none of them has to know `extends` exists -
    // which is what keeps the inheritance rule in one place instead of at each point of use.
    intentPack: def.intentPack ? resolveStoredPack(def.intentPack) : undefined,
    onboarding: def.onboarding,
    boundary: def.boundary,
    guardrailId: def.guardrailId,
    persona: def.persona,
    systemPromptAddendum: def.systemPromptAddendum,
    displayName: def.displayName,
    messages: def.messages,
    eventWorkflows: def.eventWorkflows,
    variables: def.variables,
    contextSources: def.contextSources,
  };
  return out;
}

/** Test seam: drop the warm-container cache. */
export function __clearActiveProfileCache(): void {
  cache.clear();
}
