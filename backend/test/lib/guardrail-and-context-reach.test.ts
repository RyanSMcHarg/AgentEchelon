/**
 * WHAT A VERSION SELECTS IS READ THE WAY THE TURN READS IT.
 *
 * A guardrail key sent to the draft edit is stored as the id `ApplyGuardrail` is called with, by the rule import
 * applies (`resolveGuardrailSelection`). A company-context source the assistant's role cannot read is warned about at
 * Validate, never refused, by the rule the turn applies (`readableByRole` over `contextPrefixesForRole`).
 */
import { editDraft, getDraft, createDraft, contextReachWarnings, ProfileValidationError } from '../../lambda/src/lib/profile-lifecycle';
import { resolveGuardrailSelection } from '../../lambda/src/lib/guardrail-selection';
import { isCompanyContextSource, readableByRole } from '../../lambda/src/lib/context-source-reach';
import { __clearActiveProfileCache, bodyFrom } from '../../lambda/src/lib/active-profile';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const ACTOR = 'admin-sub-123';
const GUARDRAILS = [{ key: 'default', guardrailId: 'gr-default' }, { key: 'strict', guardrailId: 'gr-strict' }];

beforeEach(() => __clearActiveProfileCache());

describe('resolveGuardrailSelection', () => {
  it('keeps a provisioned id, maps a key to its id, and names the keys for anything else', () => {
    expect(resolveGuardrailSelection('gr-strict', GUARDRAILS)).toEqual({ guardrailId: 'gr-strict' });
    expect(resolveGuardrailSelection('strict', GUARDRAILS)).toEqual({ guardrailId: 'gr-strict', remappedFrom: 'strict' });
    expect(resolveGuardrailSelection('lenient', GUARDRAILS)).toEqual({ offered: "'default', 'strict'" });
    expect(resolveGuardrailSelection('x', [])).toEqual({ offered: '(none provisioned)' });
  });
});

describe('the draft edit stores a guardrail as the id it names', () => {
  it('stores a catalog key as its provisioned id', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { guardrailId: 'strict' }, ACTOR, undefined, async () => GUARDRAILS);
    expect(bodyFrom((await getDraft(client, ROOT, 'analyst'))!).guardrailId).toBe('gr-strict');
  });

  it('keeps an id the catalog provisions unchanged', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { guardrailId: 'gr-default' }, ACTOR, undefined, async () => GUARDRAILS);
    expect(bodyFrom((await getDraft(client, ROOT, 'analyst'))!).guardrailId).toBe('gr-default');
  });

  it('refuses a selection the catalog names nowhere, and a catalog it cannot read', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await expect(editDraft(client, ROOT, 'analyst', { guardrailId: 'lenient' }, ACTOR, undefined, async () => GUARDRAILS))
      .rejects.toThrow(/matches no guardrail published for 'analyst'; one of: 'default', 'strict'/);
    await expect(editDraft(client, ROOT, 'analyst', { guardrailId: 'strict' }, ACTOR, undefined, async () => { throw new Error('denied'); }))
      .rejects.toBeInstanceOf(ProfileValidationError);
  });

  it('clears the selection with null without reading the catalog', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    const read = jest.fn(async () => GUARDRAILS);
    await editDraft(client, ROOT, 'analyst', { guardrailId: null } as never, ACTOR, undefined, read);
    expect(read).not.toHaveBeenCalled();
    expect(bodyFrom((await getDraft(client, ROOT, 'analyst'))!).guardrailId).toBeUndefined();
  });
});

describe('which catalog sources a role can read', () => {
  it('narrows only company context: an s3-prefix source under context/', () => {
    expect(isCompanyContextSource({ type: 's3-prefix', prefix: 'context/premium/' })).toBe(true);
    expect(isCompanyContextSource({ type: 's3-prefix', prefix: 'profiles/' })).toBe(false);
    expect(isCompanyContextSource({ type: 'dynamodb-item' })).toBe(false);
    expect(readableByRole({ type: 's3-prefix', prefix: 'context/premium/finance/' }, ['context/basic/', 'context/standard/'])).toBe(false);
    expect(readableByRole({ type: 's3-prefix', prefix: 'context/standard/runbooks/' }, ['context/basic/', 'context/standard/'])).toBe(true);
    expect(readableByRole({ type: 'dynamodb-item' }, [])).toBe(true);
  });
});

describe('Validate warns about a selected source the role cannot read, and never refuses it', () => {
  const ops = profiles.roleAssistantName('premium', 'ops');
  const primary = profiles.profileFor('premium')?.name as string;
  const catalog = async () => [
    { key: 'company-docs', type: 's3-prefix', prefix: 'context/premium/' },
    { key: 'runbooks', type: 's3-prefix', prefix: 'context/standard/' },
    { key: 'user-profile', type: 'dynamodb-item' },
  ];

  it('names the premium source on the ops assistant, with what its role reads', async () => {
    const warnings = await contextReachWarnings({ contextSources: ['company-docs', 'runbooks', 'user-profile'] }, ops!, catalog);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/contextSources key 'company-docs' reads context\/premium\/, which the ops role/);
    expect(warnings[0]).toMatch(/not-readable-by-role/);
  });

  it('says nothing for the primary, whose role reads every prefix premium grants', async () => {
    expect(await contextReachWarnings({ contextSources: ['company-docs'] }, primary, catalog)).toEqual([]);
  });

  it('says the check did not run for a profile whose role it cannot resolve', async () => {
    const warnings = await contextReachWarnings({ contextSources: ['company-docs'] }, 'not-a-declared-assistant', catalog);
    expect(warnings[0]).toMatch(/could not be resolved, so whether it can read them is not checked/);
  });
});
