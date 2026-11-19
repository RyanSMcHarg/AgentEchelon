/**
 * AN ASSISTANT'S EVENT WORKFLOWS ARE A BODY THE PROFILE STORE HOLDS, as its persona, pack and intent workflows are.
 *
 * Advisor with the demo's four ops workflows comes within one more workflow of the 4096-character SSM definition, and a
 * version that adds the incident watch measures 4796. Inline, the parameter's cap would limit how many workflows a version
 * declares. Offloaded, the definition keeps a pointer and the names the console lists, the version's
 * `configId` is the same either way, and a pointer that does not resolve is refused, never served as no workflows.
 */
import { hydrateBodies, offloadBodies } from '../../lambda/src/lib/profile-bodies';
import { bodyFrom, resolveFromDefinition, type ProfileDefinition } from '../../lambda/src/lib/active-profile';
import { eventWorkflowsListedOf, validateBody } from '../../lambda/src/lib/profile-lifecycle';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { SHIPPED_EVENT_WORKFLOWS } from '../../lambda/src/lib/event-workflow';

const CATALOG = getModelCatalog('us-east-1', '123456789012');

const WORKFLOWS = {
  'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'],
  'incident-triage': SHIPPED_EVENT_WORKFLOWS['incident-triage'],
};

function store() {
  const objects = new Map<string, string>();
  const s3 = { send: async (cmd: { input: { Key: string; Body?: string } }) => {
    if (cmd.input.Body !== undefined) { objects.set(cmd.input.Key, cmd.input.Body); return {}; }
    const body = objects.get(cmd.input.Key);
    return { Body: body === undefined ? undefined : { transformToString: async () => body } };
  } };
  return { objects, deps: { s3: s3 as never, bucket: 'bodies' } };
}

const def = (): ProfileDefinition => JSON.parse(JSON.stringify({ profileName: 'advisor', configId: 'cfg1', modelKey: 'm', eventWorkflows: WORKFLOWS })) as ProfileDefinition;

describe('an assistant\'s event workflows', () => {
  it('are written to the store and read back whole, the definition keeping the pointer and what the listing names', async () => {
    const { objects, deps } = store();
    const stored = await offloadBodies(def(), deps);
    expect(stored.eventWorkflows).toBeUndefined();
    expect(stored.eventWorkflowsRef).toEqual({ key: 'profiles/advisor/cfg1/eventWorkflows', configId: 'cfg1' });
    expect(JSON.parse(objects.get('profiles/advisor/cfg1/eventWorkflows')!)).toEqual(WORKFLOWS);
    expect(stored.eventWorkflowsListed).toEqual([{ name: 'ops-room', on: 'conversation-opened', types: ['ops'] }, { name: 'incident-triage', on: 'event-received', types: ['ops-team'] }]);
    expect((await hydrateBodies(stored, deps)).eventWorkflows).toEqual(WORKFLOWS);
  });

  it('list the same in the console whether inline or offloaded', async () => {
    const { deps } = store();
    const inline = eventWorkflowsListedOf(JSON.stringify(def()));
    const offloaded = eventWorkflowsListedOf(JSON.stringify(await offloadBodies(def(), deps)));
    expect(offloaded.activeEventWorkflows).toEqual(inline.activeEventWorkflows);
    expect(offloaded.activeRoleTasks).toEqual(inline.activeRoleTasks);
  });

  it('keep the version\'s id: what the listing names is envelope, never hashed', async () => {
    const { deps } = store();
    const hydrated = await hydrateBodies(await offloadBodies(def(), deps), deps);
    expect(bodyFrom(hydrated)).toEqual(bodyFrom(def()));
  });

  it('DENY: a pointer that does not resolve is refused, and an unhydrated one is never served', async () => {
    const { deps } = store();
    const stored = await offloadBodies(def(), deps);
    await expect(hydrateBodies({ ...stored, eventWorkflowsRef: { key: 'profiles/advisor/cfg1/missing', configId: 'cfg1' } } as ProfileDefinition, deps))
      .rejects.toThrow(/Refusing to resolve the version without the event workflows it declares/);
    expect(() => resolveFromDefinition(stored, 'advisor')).toThrow(/event-workflows pointer/);
  });

  it('stay inline where the deployment has no body store, as every body does', async () => {
    const kept = await offloadBodies(def(), { s3: undefined as never, bucket: '' });
    expect(kept.eventWorkflows).toEqual(WORKFLOWS);
    expect(kept.eventWorkflowsRef).toBeUndefined();
  });
});

describe('the size a version is measured at', () => {
  // A body over the parameter's budget only through its event workflows: what is stored is a pointer and the listing's names.
  const big = { eventWorkflows: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ops-room-${i}`, SHIPPED_EVENT_WORKFLOWS['ops-room']])) };
  const sizeErrors = (errs: string[]) => errs.filter((e) => /SSM Standard-tier/.test(e));

  it('counts what is stored: with a body store, event workflows that alone pass the budget are accepted', () => {
    const before = process.env.PROFILE_BODY_BUCKET;
    process.env.PROFILE_BODY_BUCKET = 'bodies';
    try {
      expect(sizeErrors(validateBody(big as never, CATALOG))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.PROFILE_BODY_BUCKET; else process.env.PROFILE_BODY_BUCKET = before;
    }
  });

  it('DENY: with no body store they stay inline, so the budget still refuses them', () => {
    const before = process.env.PROFILE_BODY_BUCKET;
    delete process.env.PROFILE_BODY_BUCKET;
    try {
      expect(sizeErrors(validateBody(big as never, CATALOG)).length).toBe(1);
    } finally {
      if (before !== undefined) process.env.PROFILE_BODY_BUCKET = before;
    }
  });
});
