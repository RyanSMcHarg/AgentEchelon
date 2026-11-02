/**
 * Delivery Option Selection for Agent Handlers
 *
 * Determines how the agent should respond based on intent classification.
 *
 * Options:
 * - DIRECT: Immediate response without Bedrock (greetings, acknowledgments), from the intent's message template
 * - PLACEHOLDER_UPDATE: Send "Thinking...", call Bedrock, update in place
 * - TASK_UPDATE_IN_PLACE: Track as task, single response update
 * - TASK_MULTI_STEP: Track as task, multiple updates (troubleshooting, extraction, reports)
 */

import { deliveryClassForIntent, getIntentPack, type IntentPack } from './intent-pack.js';
import type { AcknowledgmentKind } from './intent-classifier.js';
import { renderMessageTemplate } from './message-template.js';
import { messageTemplateFor, templateLine, type VersionWords } from './message-lines.js';

export enum DeliveryOption {
  DIRECT = 'DIRECT',
  PLACEHOLDER_UPDATE = 'PLACEHOLDER_UPDATE',
  TASK_UPDATE_IN_PLACE = 'TASK_UPDATE_IN_PLACE',
  TASK_MULTI_STEP = 'TASK_MULTI_STEP',
  /**
   * The request was for something this assistant does not offer, and the reply is the refusal
   * (DESIGN-CAPABILITY-REFUSAL §8). It answers the message it refuses, so it pairs as that message's
   * exchange, and this value is what makes refusals countable. Declarable because the declaration
   * parser lists this enum (`DECLARABLE_DELIVERY`).
   */
  REFUSED = 'REFUSED',
}

/**
 * Select the delivery option for a classified intent key (universal or pack-defined) + task state.
 * The intent→delivery mapping lives in the active intent pack; an in-flight task continues as
 * TASK_MULTI_STEP regardless of the new turn's intent.
 */
export function selectDeliveryOption(
  intent: string,
  hasActiveTask: boolean,
  pack?: IntentPack,
): DeliveryOption {
  // THE PACK THE TURN WAS CLASSIFIED AGAINST, when the caller has it. Omitted falls to the deployment
  // pack, which is the previous behavior and the right answer for a version carrying no pack.
  //
  // Without this a version-declared intent could never be multi-step: `delivery` was read from the
  // DEPLOYMENT pack, which has never heard of that key, so it resolved to PLACEHOLDER_UPDATE and the
  // turn never reached the task branch - whatever the version's `machines` said. The taxonomy was on
  // the version and the one field that decides how a turn is DELIVERED was still read from elsewhere.
  const cls = deliveryClassForIntent(intent, pack ?? getIntentPack());
  if (cls === 'DIRECT') return DeliveryOption.DIRECT;
  if (cls === 'TASK_MULTI_STEP') return DeliveryOption.TASK_MULTI_STEP;
  // PLACEHOLDER_UPDATE — but a continuation of an active task stays multi-step.
  return hasActiveTask ? DeliveryOption.TASK_MULTI_STEP : DeliveryOption.PLACEHOLDER_UPDATE;
}

/**
 * Phase-2 `/battle`: how a battle invocation should be delivered for a
 * classified intent. Differs from selectDeliveryOption in two ways:
 *  - a battle never uses DIRECT (DIRECT skips Bedrock; a battle needs a
 *    generated reply to compare, so greetings/acks fall back to
 *    PLACEHOLDER_UPDATE),
 *  - task intents carry the taskType (= the IntentType value, which is
 *    also the TASK_STATE_MACHINES key) so each bot's task creation
 *    starts the right state machine.
 * Pure — unit-testable; the fan-out just consumes it.
 */
export function planBattleTaskDelivery(
  intent: string,
  /**
   * MAY THIS SIDE OPEN A TASK OF THIS TYPE? The serving version's workflow selection, asked here
   * rather than where the task is created (ADR-047).
   *
   * A duel side is the SECOND door into task creation, and it was ungated: an assistant configured
   * not to offer a workflow still ran one when asked to duel, so `/battle` was a walk-around for the
   * selection. Gating it at the creation site looked like it meant making the task id conditional
   * for the whole battle chain, which is a change to `/battle`'s hot path.
   *
   * It does not, because the delivery option and the task type are decided together and HERE. A side
   * that may not open the workflow plans a PLACEHOLDER_UPDATE instead - a real generated reply, never
   * DIRECT - so it carries no task type, and the creation branch downstream is simply not taken. The
   * two facts cannot disagree because one function produces both.
   *
   * Omitted means "no selection to apply", which is a version that selected nothing and therefore
   * offers everything - not a version that offers nothing.
   */
  mayOpen?: (taskType: string) => boolean,
): {
  deliveryOption: DeliveryOption;
  taskType?: string;
} {
  // A multi-step intent carries its key as the taskType (= the TASK_STATE_MACHINES key).
  if (deliveryClassForIntent(intent) === 'TASK_MULTI_STEP' && (!mayOpen || mayOpen(intent))) {
    return { deliveryOption: DeliveryOption.TASK_MULTI_STEP, taskType: intent };
  }
  // greeting / acknowledgment / general / single-turn → a real generated reply
  // (never DIRECT in a battle).
  return { deliveryOption: DeliveryOption.PLACEHOLDER_UPDATE };
}

/**
 * THE QUICK REPLY, CHOSEN BY THE INTENT THE CLASSIFIER RETURNED (ADR-062 decision 7, tenet D11). A greeting is
 * answered from the `quick-greeting` template, and an acknowledgment from `quick-acknowledgment` in the form for
 * the kind the classifier recorded (`thanks`, `farewell`, or the plain line for any other). Nothing here reads
 * what the person typed. Null for any other intent.
 */
export function quickReply(
  classification: { intent: string; acknowledgment?: AcknowledgmentKind },
  words: VersionWords = {},
): string | null {
  if (classification.intent === 'greeting') return templateLine('quick-greeting', words);
  if (classification.intent !== 'acknowledgment') return null;
  const form = classification.acknowledgment && classification.acknowledgment !== 'confirmation' ? classification.acknowledgment : undefined;
  return templateLine('quick-acknowledgment', words, form ? { form } : {});
}

/**
 * THE PLACEHOLDER A REPLY IN PROGRESS SHOWS (ADR-062 decision 6): the workflow state's declared `placeholder`
 * first, else the `task-placeholder` template's label for the workflow and step, then for the workflow, then for
 * the delivery, then its plain line. The template is the assistant's own, the classification's or the shipped one.
 */
export function getTaskPlaceholder(
  deliveryOption: DeliveryOption,
  taskType?: string,
  taskStatus?: string,
  opts: { words?: VersionWords; declared?: string } = {},
): string {
  if (opts.declared && opts.declared.trim()) return opts.declared.trim();
  const template = messageTemplateFor('task-placeholder', opts.words);
  const sections = template.messageSections ?? {};
  const candidates = [
    ...(taskType && taskStatus ? [`label.${taskType}.${taskStatus}`] : []),
    ...(taskType ? [`label.${taskType}`] : []),
    `label.${deliveryOption.toLowerCase()}`,
    'chat',
  ];
  const section = candidates.find((c) => Object.prototype.hasOwnProperty.call(sections, c)) ?? 'chat';
  const rendered = renderMessageTemplate(template, {}, { sections: [section], refusedValue: 'empty' });
  return rendered.ok ? rendered.sections[section] ?? '' : '';
}
