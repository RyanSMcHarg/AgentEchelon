/**
 * WHAT `add-assistant-role.mjs` DECIDES BEFORE IT TOUCHES ANYTHING, as pure functions.
 *
 * A role is deployed exactly when the deployment declares it, and a role the shipped catalog offers is declared
 * by naming its assistant in `profiles` in deploy.config.json beside its classification (`ops-premium` beside
 * `premium`, `shippedProfilesSelection` in lib/config/profiles.ts). So adding the premium ops assistant is one
 * name in one list and a deploy of `Assistants-premium`, and removing it is the same deploy without the name.
 *
 * The script drives a live account and cannot run under test. What it writes and what it runs can: the new
 * `profiles` value, the edited file text (only that one value changes, so the deployer's layout and comments
 * survive), the stack it deploys, and whether this checkout is one that deploys at all.
 */

/** The key every deploy records in deploy.config.json the first time it runs (`deploy-guards.cjs`). */
const DEPLOYED_RECORD_KEY = '_analyticsModeChosenAtFirstDeploy';

/** Retired keys that would fail the synth this script ends in, so it refuses before writing anything. */
const RETIRED_ROLE_KEYS = ['additionalRoles'];

/** The assistant the demo adds when none is named. */
const DEFAULT_ROLE_ASSISTANT = 'ops-premium';

/**
 * The command line: `[assistant] [--dry-run] [--remove]`. Anything else is refused rather than ignored, because
 * an ignored flag on a script that deploys is a deploy the operator did not mean.
 */
function parseRoleArgs(argv) {
  const out = { assistant: DEFAULT_ROLE_ASSISTANT, dryRun: false, remove: false, help: false };
  const names = [];
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--remove') out.remove = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option "${a}" (the options are --dry-run, --remove and --help)`);
    else names.push(a);
  }
  if (names.length > 1) throw new Error(`name one role assistant, not ${names.length} (${names.join(', ')})`);
  if (names.length) out.assistant = names[0];
  return out;
}

/**
 * The `profiles` value as a list of names, or a refusal. Absent or empty is the shipped default selection,
 * spelled out, so naming a role beside it keeps every classification the deployment already runs. A custom set
 * (an object) declares its roles on its own classification entries, which this script does not edit.
 */
function profilesList(value, defaultSelection) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return [...defaultSelection];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('json64:')) throw customSetRefusal();
    if (text.startsWith('[')) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw customSetRefusal();
      return parsed.map((v) => String(v).trim()).filter(Boolean);
    }
    return text.split(',').map((s) => s.trim()).filter(Boolean);
  }
  throw customSetRefusal();
}

function customSetRefusal() {
  return new Error('profiles in deploy.config.json is a custom set. A custom set declares a role on its classification entry '
    + '(roles: ["primary", "<role>"]) with a profile named <role>-<classification>; add it there and run npm run deploy:stack '
    + '-- <prefix>Assistants-<classification>');
}

/**
 * THE NEW `profiles` LIST: the role assistant added (or, with `remove`, taken out), and nothing else changed.
 *
 * `offered` maps each role assistant the shipped catalog offers to its `{ classification, role }`
 * (`shippedRoleAssistants`). Refused: a name the catalog does not offer, and adding a role beside a
 * classification the selection does not name (synth would refuse the same thing, after the file was written).
 * `changed` is false when the list already says what was asked, so a second run deploys nothing new.
 */
function roleSelection(currentValue, assistant, { offered, defaultSelection, remove = false }) {
  const role = offered.get(assistant);
  if (!role) {
    throw new Error(`"${assistant}" is not a role assistant the shipped catalog offers (it offers ${[...offered.keys()].join(', ') || 'none'})`);
  }
  const before = profilesList(currentValue, defaultSelection);
  if (remove) {
    const after = before.filter((v) => v !== assistant);
    return { ...role, before, after, changed: after.length !== before.length };
  }
  if (!before.includes(role.classification)) {
    throw new Error(`profiles does not name "${role.classification}", the classification "${assistant}" is a role of; `
      + `add "${role.classification}" to profiles first`);
  }
  if (before.includes(assistant)) return { ...role, before, after: before, changed: false };
  const after = [...before, assistant];
  return { ...role, before, after, changed: true };
}

/** A JSON string literal's end, from its opening quote. */
function endOfString(text, from) {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i + 1;
  }
  return -1;
}

/**
 * The top-level `"profiles"` value's span in the file text, or null when the key is absent. Walks the text
 * with a depth count, so a `"profiles"` inside a comment string or a nested object is never the one replaced.
 */
function topLevelValueSpan(text, key) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfString(text, i);
      if (end < 0) return null;
      if (depth === 1 && JSON.parse(text.slice(i, end)) === key) {
        const colon = text.slice(end).search(/\S/);
        if (text[end + colon] === ':') {
          let start = end + colon + 1;
          while (/\s/.test(text[start])) start++;
          return { start, end: valueEnd(text, start) };
        }
      }
      i = end - 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return null;
}

/** Where the JSON value starting at `start` ends. */
function valueEnd(text, start) {
  if (text[start] === '"') return endOfString(text, start);
  if (text[start] === '{' || text[start] === '[') {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { i = endOfString(text, i) - 1; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }
  const m = /^[^,}\]\s]+/.exec(text.slice(start));
  return m ? start + m[0].length : -1;
}

/**
 * THE FILE TEXT WITH ONLY `profiles` CHANGED. The value is replaced in place where the key exists and added as
 * the first key where it does not, in the file's own indentation and line endings. Throws rather than return a
 * text that does not parse back to the same config with the new list, so a malformed edit is never written.
 */
function withProfilesText(text, list) {
  const value = `[${list.map((v) => JSON.stringify(v)).join(', ')}]`;
  const before = JSON.parse(text);
  const span = topLevelValueSpan(text, 'profiles');
  let next;
  if (span && span.end > span.start) {
    next = text.slice(0, span.start) + value + text.slice(span.end);
  } else {
    const at = text.indexOf('{');
    const rest = text.slice(at + 1);
    const empty = Object.keys(before).length === 0;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = (/\n([ \t]*)"/.exec(rest) || [null, '  '])[1];
    const line = `${eol}${indent}"profiles": ${value}${empty ? eol : ','}`;
    next = text.slice(0, at + 1) + line + (empty ? rest.replace(/^\s*/, '') : rest);
  }
  const after = JSON.parse(next);
  const expected = { ...before, profiles: list };
  if (JSON.stringify(Object.keys(after).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.keys(expected).some((k) => JSON.stringify(after[k]) !== JSON.stringify(expected[k]))) {
    throw new Error('the edited deploy.config.json would not read back as the same config with the new profiles; nothing was written');
  }
  return next;
}

/**
 * WHO STILL FILLS A ROLE is not decided here: the script reads the compiled `lambda/src/lib/role-filling.js`, the
 * same module the deploy's provisioner reads, so the build deadline and the rule have one source.
 */
const ROLE_FILLING_MODULE = '../lambda/src/lib/role-filling.js';

/**
 * WHY A ROLE MAY NOT BE WITHDRAWN YET, or null. A role and the assistants filling it are separate: the role is
 * infrastructure, an assistant filling it is data, so the role is withdrawn only once every assistant in it is
 * retired in the console. The deploy refuses the same withdrawal; this says so before the config is written.
 */
function withdrawalRefusal(fillers, { classification, role }) {
  if (!fillers.length) return null;
  return `the ${role} role cannot be withdrawn from ${classification} while ${fillers.length === 1 ? 'an assistant fills' : 'assistants fill'} it: `
    + `${fillers.join(', ')}. Retire ${fillers.length === 1 ? 'it' : 'them'} in the console first (Assistants, Retire on the row, with a reason), `
    + 'then run --remove again. Nothing was written and nothing was deployed';
}

/** The classification's assistant stack, as `cdk list` names it under this instance's prefix. */
function assistantsStackFor(prefix, classification) {
  return `${prefix}Assistants-${classification}`;
}

/** The guarded single-stack deploy, as argv for `npm`. */
function deployArgs(stack) {
  return ['run', 'deploy:stack', '--', stack];
}

/**
 * WHY THIS CHECKOUT MAY NOT RUN IT, or null when it may. The checkout that deploys an instance is a git work tree
 * holding that instance's deploy.config.json, parseable, which a deploy has already run from (every deploy
 * records the analytics mode in it on its first run). Anything else is a copy of the code that has never
 * deployed this instance, and adding a role from there deploys a stack from a tree that is not what is live.
 * A retired role key in the config is refused too, because the synth this ends in would refuse it after the
 * file was written.
 */
function checkoutRefusal({ isGitWorkTree, configExists, configText }) {
  if (!isGitWorkTree) return 'this is not a git work tree, so it is not the checkout this instance deploys from';
  if (!configExists) return 'backend/deploy.config.json is not here, so this is not the checkout this instance deploys from';
  let config;
  try {
    config = JSON.parse(configText);
  } catch (err) {
    return `backend/deploy.config.json could not be parsed (${err.message}); fix it before adding a role`;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'backend/deploy.config.json is not a JSON object';
  if (!Object.prototype.hasOwnProperty.call(config, DEPLOYED_RECORD_KEY)) {
    return `backend/deploy.config.json carries no ${DEPLOYED_RECORD_KEY}, so no deploy has run from this checkout; `
      + 'run the role from the checkout that deploys this instance';
  }
  const retired = RETIRED_ROLE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(config, k));
  if (retired.length) {
    return `backend/deploy.config.json still carries ${retired.join(', ')}, which is retired and fails the synth; `
      + 'remove it (and its _-prefixed comment): a role is declared by naming its assistant in profiles';
  }
  return null;
}

module.exports = {
  DEFAULT_ROLE_ASSISTANT,
  DEPLOYED_RECORD_KEY,
  RETIRED_ROLE_KEYS,
  parseRoleArgs,
  profilesList,
  roleSelection,
  withProfilesText,
  assistantsStackFor,
  deployArgs,
  checkoutRefusal,
  ROLE_FILLING_MODULE,
  withdrawalRefusal,
};
