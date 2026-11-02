/**
 * A DEFINITION THAT INSERTS A VARIABLE IS STORABLE IN PARAMETER STORE.
 *
 * Parameter Store refuses a value containing `{{` as a reference to another parameter, and a version's welcome and
 * workflow sends insert variables as `{{name}}`. Every writer of a definition goes through `ssmJsonValue`, which
 * writes no `{{` and reads back as the value it was given.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ssmJsonValue } from '../../lambda/src/lib/ssm-json-value';

const definition = {
  profileName: 'advisor',
  eventWorkflows: {
    welcome: { on: 'assistant-joined', states: { opening: { opening: { text: 'Welcome. This is a {{kind}} conversation.' } } } },
    w: { states: { greet: { send: { text: '{{a}}{{b}} and {{{c}}}' } } } },
  },
  nested: [{ x: { y: '{{z}}' } }],
};

describe('a definition that inserts a variable is storable', () => {
  it('writes no "{{", which Parameter Store reads as a parameter reference', () => {
    expect(ssmJsonValue(definition)).not.toContain('{{');
  });

  it('reads back as exactly the value it was given', () => {
    expect(JSON.parse(ssmJsonValue(definition))).toEqual(definition);
  });

  it('leaves a value with no "{{" as JSON.stringify writes it', () => {
    const plain = { a: { b: [{ c: 1 }] }, d: '{single}' };
    expect(ssmJsonValue(plain)).toBe(JSON.stringify(plain));
  });

  it('is what every writer of a definition sends', () => {
    const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', p), 'utf8');
    for (const file of ['profile-lifecycle.ts', 'profile-manifest.ts', 'seed-profile-definitions.ts']) {
      expect({ file, writesRaw: /Value: JSON\.stringify\(stored\)|const body = JSON\.stringify\(stored\)/.test(src(file)) })
        .toEqual({ file, writesRaw: false });
      expect(src(file)).toContain('ssmJsonValue(');
    }
  });
});
