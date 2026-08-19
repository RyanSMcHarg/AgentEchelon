/**
 * Two write-path guards that were claimed and not implemented.
 *
 * Both have the same shape: validation passed, the operator got no error, and the failure surfaced
 * somewhere that does not name the cause - an opaque AWS exception in one case, a per-turn metric in
 * the other.
 */
import { validateBody, validateDraft, activateDraft } from '../../lambda/src/lib/profile-lifecycle';
import { SSM_STANDARD_TIER_MAX } from '../../lambda/src/lib/seed-profile-definitions';
import type { ProfileDefinitionBody } from '../../lambda/src/lib/active-profile';
import { getModelCatalog } from '../../lib/config/model-strategy';

const catalog = getModelCatalog('us-east-1', '123456789012');
const anyModel = Object.keys(catalog)[0];

function body(over: Partial<ProfileDefinitionBody> = {}): Partial<ProfileDefinitionBody> {
  return {
    modelKey: anyModel,
    classifierMode: 'llm',
    timeoutSeconds: 30,
    taskSupport: 'full',
    ...over,
  };
}

describe('the persona cap matches the storage the write path actually uses', () => {
  // `MAX_PERSONA_LENGTH` is 20000; every PutParameter below is Tier: 'Standard', whose limit is 4096
  // for the WHOLE serialized definition. A persona in that gap passed validation and then failed at
  // PutParameter with an AWS ValidationException naming neither the profile nor the field. The seeder
  // has had this guard since it was written; the admin API, which is what operators use, did not.
  it('rejects a definition over the SSM Standard-tier limit', () => {
    const errs = validateBody(body({ persona: 'x'.repeat(SSM_STANDARD_TIER_MAX) }), catalog);
    expect(errs.join(' ')).toMatch(/over the 4096-character SSM Standard-tier limit/);
  });

  it('says how much room is actually left, so the operator can act on it', () => {
    // "too long" without a number sends someone guessing. The message names the budget the rest of
    // the definition consumes and what that leaves for the persona.
    const errs = validateBody(body({ persona: 'x'.repeat(SSM_STANDARD_TIER_MAX) }), catalog);
    expect(errs.join(' ')).toMatch(/leaving room for a persona of about \d+ characters/);
  });

  it('accepts a persona that FITS', () => {
    // Falsification: a guard that rejected everything would satisfy the assertions above while
    // blocking every activation.
    expect(validateBody(body({ persona: 'A grounded, useful persona.' }), catalog)).toEqual([]);
  });

  it('measures the whole definition, not the persona alone', () => {
    // The 4096 covers the serialized body. A persona just under the cap can still overflow once the
    // models bundle and limits are serialized alongside it, and the old check would have missed that.
    const long = 'x'.repeat(SSM_STANDARD_TIER_MAX - 20);
    expect(validateBody(body({ persona: long }), catalog).join(' '))
      .toMatch(/over the 4096-character/);
  });
});

describe('context source keys are verified before a version can activate', () => {
  // `validateDefinitionBody` only proved the selection was a list of non-empty strings, while its own
  // comment claimed the keys were "checked at the write path and at import". Only import checked. So
  // an operator could activate a version naming a key this deployment never publishes, see no error,
  // and find out from a per-turn `not-in-catalog` metric.
  // A real SSM double rather than a spy: validateDraft calls getDraft internally by direct
  // reference, so spying on the module object does not intercept it. Feeding the draft through the
  // client exercises the actual path.
  const ssmWithDraft = (draftBody: Partial<ProfileDefinitionBody>) => ({
    send: async () => ({
      Parameter: { Value: JSON.stringify({ profileName: 'standard', configId: 'cfg-1', ...draftBody }) },
    }),
  }) as never;

  const selecting = ssmWithDraft(body({ contextSources: ['company-docs', 'x-not-published'] }));

  it('rejects a key the deployment does not publish, naming what it does offer', async () => {
    const { errors } = await validateDraft(selecting, '/root', 'standard', catalog,
      async () => [{ key: 'company-docs' }]);
    expect(errors.join(' ')).toMatch(/'x-not-published' is not published/);
    expect(errors.join(' ')).toMatch(/'company-docs'/);
  });

  it('accepts a selection the deployment DOES publish', async () => {
    // Falsification: a check that rejected every key would pass the test above and block all use of
    // the feature.
    const { errors } = await validateDraft(selecting, '/root', 'standard', catalog,
      async () => [{ key: 'company-docs' }, { key: 'x-not-published' }]);
    expect(errors).toEqual([]);
  });

  it('FAILS CLOSED when the catalog cannot be read, matching import', async () => {
    const { errors } = await validateDraft(selecting, '/root', 'standard', catalog,
      async () => { throw new Error('AccessDenied'); });
    expect(errors.join(' ')).toMatch(/could not be read/);
    expect(errors.join(' ')).toMatch(/refusing to activate/);
  });

  it('does not consult the catalog when a profile selects NOTHING', async () => {
    // An unrelated SSM problem must not block a profile that uses none of this.
    const readCatalog = jest.fn();
    const { errors } = await validateDraft(ssmWithDraft(body()), '/root', 'standard', catalog, readCatalog as never);
    expect(errors).toEqual([]);
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('gates ACTIVATION too, not just validate', async () => {
    // A caller can skip validate entirely, so activate is the gate that matters.
    await expect(activateDraft(selecting, '/root', 'standard', catalog, 'actor',
      async () => [{ key: 'company-docs' }])).rejects.toThrow(/x-not-published/);
  });
});
