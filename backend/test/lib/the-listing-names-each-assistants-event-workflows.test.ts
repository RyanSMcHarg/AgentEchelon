/**
 * THE ASSISTANTS LISTING NAMES EACH ASSISTANT'S EVENT WORKFLOWS (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * What it proves: `listProfile` reads the active version's event workflows, each by name with the event that starts it
 * and its rooms, and whether it declares an onboarding intake, from the definition the version history already returns,
 * so the console's list names them without reading a body per row. A version that is not active contributes nothing,
 * and an assistant with no active version carries neither field.
 */
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { listProfile } from '../../lambda/src/lib/profile-lifecycle';
import { definitionParamName } from '../../lambda/src/lib/active-profile';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';

const opens = (types?: string[]) => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: { opening: { opening: {}, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
});

async function store(versions: Array<Record<string, unknown>>, active: number) {
  const { client } = fakeSsmStore();
  const name = definitionParamName(ROOT, 'ops-premium');
  for (const body of versions) {
    await client.send(new PutParameterCommand({ Name: name, Value: JSON.stringify({ name: 'ops-premium', modelKey: 'sonnet', configId: 'c', ...body }), Overwrite: true, Type: 'String' }));
  }
  if (active) await client.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: active, Labels: ['active'] }));
  return client;
}

describe('the listing of one assistant', () => {
  it('names the active version\'s event workflows by event and rooms, and its onboarding', async () => {
    const client = await store([
      { eventWorkflows: { stale: opens() } },
      {
        eventWorkflows: {
          welcome: opens(),
          'welcome-ops': opens(['ops']),
          'ops-room': { on: 'conversation-opened', types: ['ops'], initial: 'done', states: { done: { disposition: 'success' } } },
        },
        onboarding: { fields: [{ key: 'team', prompt: 'Which team?' }] },
      },
    ], 2);
    const listing = await listProfile(client, ROOT, 'ops-premium');
    expect(listing.activeEventWorkflows).toEqual([
      { name: 'welcome', on: 'assistant-joined' },
      { name: 'welcome-ops', on: 'assistant-joined', types: ['ops'] },
      { name: 'ops-room', on: 'conversation-opened', types: ['ops'] },
    ]);
    expect(listing.activeOnboarding).toBe(true);
  });

  it('says an active version with none declares none', async () => {
    const listing = await listProfile(await store([{ eventWorkflows: { welcome: opens() } }, {}], 2), ROOT, 'ops-premium');
    expect(listing.activeEventWorkflows).toEqual([]);
    expect(listing.activeOnboarding).toBe(false);
  });

  it('carries neither field while no version is active', async () => {
    const listing = await listProfile(await store([{ eventWorkflows: { welcome: opens() } }], 0), ROOT, 'ops-premium');
    expect(listing).not.toHaveProperty('activeEventWorkflows');
    expect(listing).not.toHaveProperty('activeOnboarding');
  });
});
