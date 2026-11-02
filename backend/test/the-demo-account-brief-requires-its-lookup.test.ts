/**
 * THE DEMO'S PREMIUM ACCOUNT BRIEF REQUIRES ITS LOOKUP BEFORE THE TASK MOVES ON (ADR-064 decision 3).
 *
 * Premium's pack declares `account_brief`, a TASK_MULTI_STEP intent, and the workflow of the same name: `researching`
 * requires `load_company_context` before the task may leave it for `drafting`. This is the pack the slice-4 e2e reads
 * from the deployment (`tests/e2e/a-step-requires-its-lookup-before-the-task-moves-on.spec.ts`), so it is held here to
 * the checks the seed and the write path apply: it stores within the whole-pack limit, the workflow validates beside the
 * platform's, the seeded premium definition validates, and the required tool is one premium's assistant is offered, so
 * validate and activate accept the version and the step has an exit.
 */
import { SSMClient } from '@aws-sdk/client-ssm';
import { stratumIntentPack, ACCOUNT_BRIEF_INTENT, ACCOUNT_BRIEF_WORKFLOW } from '../demo/intent-packs';
import { PREMIUM_PERSONA } from '../demo/personas';
import { parseIntentPack, validateIntentPackBody, taskStateMachines, MAX_INTENT_PACK_BYTES } from '../lambda/src/lib/intent-pack';
import { validateTaskStateMachines, validateTaskStateMachine } from '../lambda/src/lib/task-state-machines';
import { serializeSeedDefinition, validateDefinitionBody, type ProfileDefinitionBody } from '../lambda/src/lib/active-profile';
import { requiredToolErrorDetails } from '../lambda/src/lib/profile-lifecycle';
import { TOOL_REGISTRY } from '../lambda/src/lib/tool-registry';
import { defaultProfileRegistry } from '../lib/profile-registry';

const premiumProfile = defaultProfileRegistry.requireProfileFor('premium').name;
const stored = stratumIntentPack('premium');
const raw = JSON.stringify(stored);
const machines = taskStateMachines(parseIntentPack(raw));

/** The seeded premium definition, as `seedAllProfileDefinitions` writes it. */
const seededBody = JSON.parse(serializeSeedDefinition(premiumProfile, PREMIUM_PERSONA, stored) as string) as Partial<ProfileDefinitionBody>;

/** An SSM client answering the premium pack parameter with the pack inline, the shape `deploymentTaskMachines` reads. */
const ssmWithPack = (packJson: string) => ({
  send: jest.fn(async () => ({ Parameter: { Value: packJson } })),
}) as unknown as SSMClient;

describe('the premium demo account brief requires its lookup', () => {
  it('is a storable pack within the whole-pack limit', () => {
    expect(validateIntentPackBody(stored)).toEqual([]);
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_INTENT_PACK_BYTES);
  });

  it('declares the intent as multi-step work that opens the workflow of its own name', () => {
    const intent = stored.intents.find((i) => i.key === ACCOUNT_BRIEF_INTENT);
    expect(intent?.delivery).toBe('TASK_MULTI_STEP');
    expect(machines[ACCOUNT_BRIEF_INTENT]).toEqual(ACCOUNT_BRIEF_WORKFLOW);
  });

  it('validates as a workflow, and beside every machine premium runs', () => {
    expect(() => validateTaskStateMachine(ACCOUNT_BRIEF_INTENT, ACCOUNT_BRIEF_WORKFLOW)).not.toThrow();
    expect(() => validateTaskStateMachines(machines)).not.toThrow();
  });

  it('requires a registered lookup the research step and the intent both offer, before drafting', () => {
    const research = ACCOUNT_BRIEF_WORKFLOW.states[ACCOUNT_BRIEF_WORKFLOW.initial];
    expect(ACCOUNT_BRIEF_WORKFLOW.initial).toBe('researching');
    expect(research.requiresTool).toEqual(['load_company_context']);
    expect(research.transitions).toEqual(['drafting']);
    for (const tool of research.requiresTool ?? []) {
      expect(TOOL_REGISTRY.find((d) => d.name === tool)?.category).toBe('context');
      expect(research.tools).toContain(tool);
      expect(stored.intents.find((i) => i.key === ACCOUNT_BRIEF_INTENT)?.tools).toContain(tool);
    }
    // The only step that requires a tool, so the e2e that reads the deployed pack finds this one.
    const requiring = Object.entries(machines).flatMap(([m, def]) => Object.entries(def.states)
      .filter(([, s]) => s.requiresTool?.length).map(([s]) => `${m}.${s}`));
    expect(requiring).toEqual([`${ACCOUNT_BRIEF_INTENT}.researching`]);
  });

  it('the seeded premium definition validates and offers the required tool', async () => {
    expect(validateDefinitionBody(seededBody)).toEqual([]);
    expect(seededBody.tools).toContain('load_company_context');
    // The check validate and activate run against the classification's machines: no refusal for this version.
    await expect(requiredToolErrorDetails(seededBody, ssmWithPack(raw), '/agent-echelon', premiumProfile)).resolves.toEqual([]);
  });

  it('a premium version whose tools omit the lookup is refused, naming the workflow and the step', async () => {
    const narrowed = { ...seededBody, tools: (seededBody.tools ?? []).filter((t) => t !== 'load_company_context') };
    const errs = await requiredToolErrorDetails(narrowed, ssmWithPack(raw), '/agent-echelon', premiumProfile);
    expect(errs).toEqual([expect.objectContaining({
      code: 'required_tool_not_allowed',
      path: `workflows['${ACCOUNT_BRIEF_INTENT}'].steps['researching'].requiresTool`,
    })]);
  });
});
