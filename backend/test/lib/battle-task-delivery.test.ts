/**
 * planBattleTaskDelivery — how a /battle invocation is delivered per
 * classified intent. Pins: task intents → TASK_MULTI_STEP + taskType
 * (= the TASK_STATE_MACHINES key); everything else → PLACEHOLDER_UPDATE
 * (a battle never uses DIRECT — it needs a generated reply to compare).
 */
import { IntentType } from '../../lambda/src/lib/intent-classifier';
import { planBattleTaskDelivery, DeliveryOption } from '../../lambda/src/lib/delivery-options';
import { TASK_STATE_MACHINES } from '../../lambda/src/lib/task-tracking';

describe('planBattleTaskDelivery', () => {
  it('task intents → TASK_MULTI_STEP with a taskType that is a real state-machine key', () => {
    for (const intent of [
      IntentType.GUIDED_TROUBLESHOOTING,
      IntentType.DATA_EXTRACTION,
      IntentType.REPORT_GENERATION,
    ]) {
      const plan = planBattleTaskDelivery(intent);
      expect(plan.deliveryOption).toBe(DeliveryOption.TASK_MULTI_STEP);
      expect(plan.taskType).toBe(intent);
      // the taskType must drive a real state machine
      expect(TASK_STATE_MACHINES[plan.taskType as string]).toBeDefined();
    }
  });

  it('report_generation specifically → report state machine', () => {
    const plan = planBattleTaskDelivery(IntentType.REPORT_GENERATION);
    expect(plan.taskType).toBe('report_generation');
    expect(TASK_STATE_MACHINES.report_generation[0]).toBe('collecting_requirements');
  });

  it('GENERAL / GREETING / ACKNOWLEDGMENT → PLACEHOLDER_UPDATE, no taskType (never DIRECT)', () => {
    for (const intent of [IntentType.GENERAL, IntentType.GREETING, IntentType.ACKNOWLEDGMENT]) {
      const plan = planBattleTaskDelivery(intent);
      expect(plan.deliveryOption).toBe(DeliveryOption.PLACEHOLDER_UPDATE);
      expect(plan.taskType).toBeUndefined();
    }
  });

  it('never returns DIRECT for any intent', () => {
    for (const intent of Object.values(IntentType)) {
      expect(planBattleTaskDelivery(intent).deliveryOption).not.toBe(DeliveryOption.DIRECT);
    }
  });
});
