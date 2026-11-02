/**
 * A JSON VALUE AMAZON SSM PARAMETER STORE ACCEPTS, WHATEVER ITS STRINGS SAY.
 *
 * Parameter Store refuses a value containing `{{`, which it reads as a reference to another parameter. A version's
 * welcome, workflow sends and templates insert variables as `{{name}}`, so a definition is written with every `{{`
 * as `{{`. JSON reads `{` back as `{`, so `JSON.parse` returns exactly the value that was serialized, and
 * `{{` cannot occur between JSON tokens (an object opens with a key), so every one rewritten is inside a string.
 */
export function ssmJsonValue(value: unknown): string {
  return JSON.stringify(value).replace(/\{\{/g, '{\\u007b');
}
