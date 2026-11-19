/**
 * A CREATOR NAME PATTERN IS NOT HELD TO A NAME'S BOUND (`lib/constructs/conversation-creator.ts`). Lambda bounds a function
 * name at 64 characters, and a real classification's creator name is checked against it at synth. The pattern the APIs
 * substitute at run time (`{classification}`) and the IAM wildcard (`*`) are not names: under the longest instance prefix
 * a deployment may have, they synthesize, while a real name past the bound is still refused.
 */
describe('the typed creator name under a long instance prefix', () => {
  const PREFIX = 'A'.repeat(25);
  let typedCreatorName: (classification: string) => string;

  beforeAll(() => {
    jest.resetModules();
    process.env.AE_STACK_PREFIX = PREFIX;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ typedCreatorName } = require('../../lib/constructs/conversation-creator'));
  });
  afterAll(() => { delete process.env.AE_STACK_PREFIX; });

  it('builds the run-time pattern and the IAM wildcard', () => {
    expect(typedCreatorName('{classification}')).toBe(`${PREFIX}Assistants-{classification}-TypedCreator`);
    expect(typedCreatorName('*')).toBe(`${PREFIX}Assistants-*-TypedCreator`);
  });

  it('still refuses a real classification whose name passes 64 characters', () => {
    expect(typedCreatorName('premium')).toBe(`${PREFIX}Assistants-premium-TypedCreator`);
    expect(() => typedCreatorName('a-classification-name-too-long')).toThrow(/longer than Lambda's 64 characters/);
  });
});
