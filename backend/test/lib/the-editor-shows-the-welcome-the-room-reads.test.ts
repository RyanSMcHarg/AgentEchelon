/**
 * THE WELCOME EDITOR SHOWS THE TEXT THE ROOM IS GREETED WITH, AND THE ASSISTANT CAN SAY ITS OWN NAME.
 *
 * The content an assistant presents always shows in the console, so it is obvious to an editor they are in the right
 * place, and the assistant's own name is available as a variable.
 *
 *  - the classification catalog serves the deployment's welcome orientation and the classification's primary, so the
 *    console composes the same opening the router posts for an assistant whose version sets none;
 *  - `{{assistantName}}` is an opening field, filled from the name the serving version gives the assistant, and the
 *    router passes that name where it composes the opening.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { classificationCatalog } from '../../lambda/src/lib/classification-catalog';
import { composeOpening, renderWelcomeTemplate, withDeploymentOpening, WELCOME_FIELDS, WELCOME_TOKENS } from '../../lambda/src/lib/welcome-orientation';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { noticeTemplateName } from '../../lambda/src/lib/shipped-message-templates';

const ROOT = '/agent-echelon';
const keys = Object.keys(getModelCatalog('us-east-1', '123456789012'));
const lambda = { send: async () => ({}) } as never;
const ORIENTATION = {
  companyName: 'Stratum Technologies',
  accessBlurb: 'You have full internal access.',
  examples: ['What is our current net revenue retention?'],
};

describe('the catalog serves what the primary is greeted with', () => {
  it('serves the deployment\'s welcome orientation and the classification\'s primary', async () => {
    const store = fakeSsmStore();
    await store.client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/premium/welcome-orientation`, Value: JSON.stringify(ORIENTATION), Type: 'String' }));
    const c = await classificationCatalog(store.client, lambda, ROOT, 'premium', keys);
    expect(c.welcomeOrientation).toMatchObject({ companyName: 'Stratum Technologies', accessBlurb: 'You have full internal access.' });
    expect(typeof c.primaryAssistant).toBe('string');
  });

  it('serves none when the deployment sets none', async () => {
    const c = await classificationCatalog(fakeSsmStore().client, lambda, ROOT, 'premium', keys);
    expect(c.welcomeOrientation).toBeUndefined();
  });

  it('the opening composed from it is the one the room reads', () => {
    const opening = composeOpening(undefined, ORIENTATION);
    expect(opening.content).toContain('Stratum Technologies');
    expect(opening.content).toContain('What is our current net revenue retention?');
  });
});

describe('the assistant\'s own name is an opening field', () => {
  it('is offered to insert and declared as a field', () => {
    expect(WELCOME_TOKENS).toContain('assistantName');
    expect(WELCOME_FIELDS).toHaveProperty('assistantName');
  });

  it('says the name the version gives the assistant', () => {
    expect(renderWelcomeTemplate('Good morrow, I am {{assistantName}}.', {}, { name: 'Ye Olde Advisor' }).content)
      .toBe('Good morrow, I am Ye Olde Advisor.');
  });

  it('drops the line when there is no name, rather than printing a hole', () => {
    expect(renderWelcomeTemplate('I am {{assistantName}}.\nHow can I help?', {}, {}).content).toBe('How can I help?');
  });

  it('the router passes the serving version\'s name where it composes the opening', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    // The name the room shows: the serving version's, else the provisioned one, so an inherited name still fills the field.
    expect(router).toContain('const welcomeAssistantName = loaded.served?.version.displayName?.trim()');
    expect(router).toContain('|| profiles.displayNameFor(turnProfile.name);');
    expect(router).toContain('composeOpening(roleTemplate, welcomeOrientation, { role: welcomeRole, ...(welcomeAssistantName ? { name: welcomeAssistantName } : {}) },');
  });
});

describe('an opening\'s own fields layer over the deployment\'s, field by field', () => {
  it('keeps the deployment\'s company and access line when the opening sets only its suggested prompts', () => {
    const merged = withDeploymentOpening({ examples: ['Summarize the Q3 renewals'] }, ORIENTATION);
    expect(merged).toMatchObject({ companyName: 'Stratum Technologies', accessBlurb: 'You have full internal access.', examples: ['Summarize the Q3 renewals'] });
    const opening = composeOpening(undefined, merged!);
    expect(opening.content).toContain('Stratum Technologies');
    expect(opening.content).toContain('Summarize the Q3 renewals');
    expect(opening.content).not.toContain('What is our current net revenue retention?');
  });

  it('is the opening\'s own alone where the deployment\'s copy does not apply, and nothing where neither sets any', () => {
    expect(withDeploymentOpening({ examples: ['x'] }, undefined)).toEqual({ examples: ['x'] });
    expect(withDeploymentOpening(undefined, undefined)).toBeNull();
  });

  it('the router layers the opening over the deployment\'s copy for the primary, through the same function', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toContain('orientation: withDeploymentOpening(own.orientation, deployment?.orientation),');
    expect(router).toContain('const deployment = primary ? await loadWelcomeOrientation() : undefined;');
  });
});

describe('the catalog serves the deployment\'s onboarding intake, what the primary asks', () => {
  it('serves its greeting and its questions in order', async () => {
    const store = fakeSsmStore();
    await store.client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/premium/onboarding-intake`, Type: 'String', Value: JSON.stringify({
      greeting: 'Before we start, two quick questions.',
      fields: [{ key: 'team', prompt: 'Which team are you on?', required: true }, { key: 'goal', prompt: 'What are you working on?', required: false }],
    }) }));
    const c = await classificationCatalog(store.client, lambda, ROOT, 'premium', keys);
    expect(c.onboardingIntake).toEqual({ greeting: 'Before we start, two quick questions.', questions: ['Which team are you on?', 'What are you working on?'] });
  });

  it('serves none when the deployment sets none', async () => {
    expect((await classificationCatalog(fakeSsmStore().client, lambda, ROOT, 'premium', keys)).onboardingIntake).toBeUndefined();
  });
});

describe('the catalog serves the deployment line a message is said from', () => {
  it('serves the budget notice\'s deployment line by its template name, read from the router\'s environment', async () => {
    const store = fakeSsmStore();
    await store.client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/premium/router-arn`, Value: 'arn:aws:lambda:us-east-1:123456789012:function:router', Type: 'String' }));
    const withEnv = { send: async () => ({ Environment: { Variables: { BUDGET_CANNED_RESPONSE: 'We are at capacity; try again in an hour.', BEDROCK_USER_HOURLY_BUDGET: '5' } } }) } as never;
    const c = await classificationCatalog(store.client, withEnv, ROOT, 'premium', keys);
    expect(c.deploymentLines).toEqual({ [noticeTemplateName('budgetExhausted')]: 'We are at capacity; try again in an hour.' });
    expect(c.budgets).toEqual({ userHourly: 5 });
  });
});

describe("the router resolves a welcome's variables through the function the console's preview calls", () => {
  it('builds what it holds with routerHeldVariables', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toContain('return routerHeldVariables(variables, { ...(STATIC_CLASSIFICATION ? { classification: STATIC_CLASSIFICATION } : {}), ...held });');
  });
});
