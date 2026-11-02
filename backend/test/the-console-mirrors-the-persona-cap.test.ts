/**
 * The console's persona field bounds what the API will accept, and the two numbers must agree.
 *
 * WHY A MIRROR AND NOT AN IMPORT. The admin console is a separate package with its own build; it does
 * not import backend modules, and the cap has to be known in the browser to stop a person typing four
 * thousand characters past it and losing the lot on submit. So the number is written twice, which is
 * exactly the arrangement that drifts.
 *
 * DRIFT IN EITHER DIRECTION IS A REAL FAILURE, not an untidiness. A console cap that is too HIGH lets
 * someone write a persona the API refuses, after they have composed it. Too LOW silently forbids a
 * persona the platform would have accepted, with no error to explain the cut-off - the field simply
 * stops taking input.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MAX_PERSONA_LENGTH } from '../lambda/src/lib/active-profile';

const CONSOLE_TAB = path.join(__dirname, '../../frontend/packages/admin/src/components/admin/DraftAreaFields.tsx');

describe('the console mirrors the persona cap', () => {
  it('declares the same number the backend enforces', () => {
    const src = fs.readFileSync(CONSOLE_TAB, 'utf8');
    const m = src.match(/const MAX_PERSONA_LENGTH = (\d+);/);
    // Jest's expect takes no message argument; the reason lives in the comment above instead.
    // The console must DECLARE the cap it enforces on the field.
    expect(m).not.toBeNull();
    expect(Number(m![1])).toEqual(MAX_PERSONA_LENGTH);
  });

  it('actually applies it to the input, rather than only declaring it', () => {
    // A constant nothing reads is a comment. The field has to carry `maxLength`, which is what makes
    // the browser stop at the same place the API does.
    const src = fs.readFileSync(CONSOLE_TAB, 'utf8');
    expect(src).toMatch(/maxLength=\{MAX_PERSONA_LENGTH\}/);
  });
});
