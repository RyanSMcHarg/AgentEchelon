/**
 * WHAT A DEPLOY SAYS ABOUT THE ASSISTANTS IT DECLARES (ADR-048, amended 2026-10-23). Pure, and unit-tested
 * (`test/declared-assistants-report.test.ts`); `declared-assistants-report.mjs` asks AWS and prints.
 *
 * A deploy seeds each declared assistant once. One retired in the console stays retired, and the deploy says so
 * rather than leaving an operator to wonder why a name in `profiles` answers nobody.
 */

/**
 * Every live assistant a deployment's set declares, by the registry's one naming rule: a classification's
 * primary is the profile it names, and each other deployed role's is `<role>-<classification>`.
 */
function declaredAssistantsOf(config) {
  const out = [];
  for (const c of config.classifications || []) {
    for (const role of c.roles && c.roles.length ? c.roles : ['primary']) {
      out.push({ assistantId: role === 'primary' ? c.profile : `${role}-${c.value}`, classification: c.value, role });
    }
  }
  return out;
}

/** The declared assistants whose directory entry says a person retired them in the console. */
function retiredInTheConsole(declared, entries) {
  return declared.filter((d) => {
    const e = entries.get(d.assistantId);
    return e && e.origin === 'declared' && (e.status === 'retired' || e.status === 'retiring')
      && e.classification === d.classification;
  });
}

/** The lines a deploy prints for them; none when there are none. */
function reportLines(retired) {
  if (!retired.length) return [];
  return [
    '',
    '• Declared, but retired in the console; a deploy does not recreate it:',
    ...retired.map((d) => `    ${d.assistantId} (${d.classification}, ${d.role})`),
    '  Its name stays reserved. To have it again, withdraw its role and declare it anew, or declare another name.',
  ];
}

/** The statuses whose console-created assistant exists, or is being built or retired. */
const STILL_THERE = new Set(['active', 'provisioning', 'retiring']);

/**
 * THE CONSOLE-CREATED ASSISTANTS A CONFIGURATION WOULD ORPHAN: each still active (or being built or retired) in a
 * classification the deployment's set no longer declares. Removing a classification deletes its stack, whose seed
 * removes only what it declared and never fails the delete, so an assistant created in the console there would be
 * left with no classification to act in. The deploy refuses such a configuration before anything is deployed or
 * deleted; the operator retires those assistants in the console first.
 */
function consoleAssistantsOrphanedBy(config, entries) {
  const declared = new Set((config.classifications || []).map((c) => c.value));
  const out = [];
  for (const [assistantId, e] of entries) {
    if (!e || e.origin === 'declared' || (e.occupancy || 'live') !== 'live' || !STILL_THERE.has(e.status)) continue;
    if (!declared.has(e.classification)) out.push({ assistantId, classification: e.classification, role: e.role });
  }
  return out.sort((a, b) => a.assistantId.localeCompare(b.assistantId));
}

/** The refusal for them, or null when there are none. */
function orphanRefusal(orphaned) {
  if (!orphaned.length) return null;
  const classifications = [...new Set(orphaned.map((o) => o.classification))].sort();
  return `this configuration no longer declares ${classifications.join(', ')}, and assistants created in the console are still active there: `
    + `${orphaned.map((o) => `${o.assistantId} (${o.classification}, ${o.role})`).join(', ')}. `
    + 'Removing a classification removes its declared assistants and no other, so retire these in the console first '
    + '(Assistants, Retire on the row, with a reason), then deploy again. Nothing was deployed';
}

module.exports = { declaredAssistantsOf, retiredInTheConsole, reportLines, consoleAssistantsOrphanedBy, orphanRefusal };
