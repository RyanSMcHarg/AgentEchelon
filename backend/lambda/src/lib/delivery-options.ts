/**
 * Delivery Option Selection for Agent Handlers
 *
 * Determines how the agent should respond based on intent classification.
 *
 * Options:
 * - DIRECT: Immediate response without Bedrock (greetings, acknowledgments)
 * - PLACEHOLDER_UPDATE: Send "Thinking...", call Bedrock, update in place
 * - TASK_UPDATE_IN_PLACE: Track as task, single response update
 * - TASK_MULTI_STEP: Track as task, multiple updates (troubleshooting, extraction, reports)
 */

import { deliveryClassForIntent } from './intent-pack.js';

export enum DeliveryOption {
  DIRECT = 'DIRECT',
  PLACEHOLDER_UPDATE = 'PLACEHOLDER_UPDATE',
  TASK_UPDATE_IN_PLACE = 'TASK_UPDATE_IN_PLACE',
  TASK_MULTI_STEP = 'TASK_MULTI_STEP',
}

/**
 * Select the delivery option for a classified intent key (universal or pack-defined) + task state.
 * The intent→delivery mapping lives in the active intent pack; an in-flight task continues as
 * TASK_MULTI_STEP regardless of the new turn's intent.
 */
export function selectDeliveryOption(intent: string, hasActiveTask: boolean): DeliveryOption {
  const cls = deliveryClassForIntent(intent);
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
 *    also the TASK_STATE_MACHINES key) so each bot's createBattleTask
 *    starts the right state machine.
 * Pure — unit-testable; the fan-out just consumes it.
 */
export function planBattleTaskDelivery(intent: string): {
  deliveryOption: DeliveryOption;
  taskType?: string;
} {
  // A multi-step intent carries its key as the taskType (= the TASK_STATE_MACHINES key).
  if (deliveryClassForIntent(intent) === 'TASK_MULTI_STEP') {
    return { deliveryOption: DeliveryOption.TASK_MULTI_STEP, taskType: intent };
  }
  // greeting / acknowledgment / general / single-turn → a real generated reply
  // (never DIRECT in a battle).
  return { deliveryOption: DeliveryOption.PLACEHOLDER_UPDATE };
}

/**
 * Quick responses for DIRECT delivery option
 * Returns pre-defined responses for common queries
 */
export function getQuickResponse(lexIntentName: string, userMessage: string): string | null {
  const message = userMessage.toLowerCase().trim().replace(/[!?.]+$/, '');

  // Greeting responses
  const simpleGreetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
  if (simpleGreetings.includes(message)) {
    return 'Hey, what can I help you with?';
  }

  // Acknowledgment responses
  const thankYouVariants = ['thanks', 'thank you'];
  if (thankYouVariants.includes(message)) {
    return 'Happy to help. Let me know if you have other questions.';
  }

  const acknowledgments = ['ok', 'okay', 'got it', 'great', 'perfect', 'cool'];
  if (acknowledgments.includes(message)) {
    return 'Let me know if you have other questions.';
  }

  if (message === 'bye' || message === 'goodbye') {
    return 'Goodbye! Feel free to reach out anytime.';
  }

  return null;
}

/**
 * Get placeholder message for task-based delivery options
 */
export function getTaskPlaceholder(
  deliveryOption: DeliveryOption,
  taskType?: string,
  taskStatus?: string
): string {
  if (taskType === 'guided_troubleshooting') {
    switch (taskStatus) {
      case 'collecting_symptoms':
        return 'Let me understand the issue...';
      case 'diagnosing':
        return 'Analyzing the problem...';
      case 'proposing_solutions':
        return 'Finding solutions...';
      default:
        return 'Looking into that...';
    }
  }

  if (taskType === 'data_extraction') {
    switch (taskStatus) {
      case 'collecting_requirements':
        return 'Understanding your data needs...';
      case 'extracting':
        return 'Extracting data...';
      case 'validating':
        return 'Validating results...';
      default:
        return 'Processing your request...';
    }
  }

  if (taskType === 'report_generation') {
    switch (taskStatus) {
      case 'collecting_requirements':
        return 'Understanding your report needs...';
      case 'drafting_outline':
        return 'Drafting outline...';
      case 'generating':
        return 'Generating report...';
      default:
        return 'Working on the report...';
    }
  }

  switch (deliveryOption) {
    case DeliveryOption.TASK_UPDATE_IN_PLACE:
      return 'Analyzing...';
    case DeliveryOption.TASK_MULTI_STEP:
      return 'Working on that...';
    default:
      return 'One moment...';
  }
}
