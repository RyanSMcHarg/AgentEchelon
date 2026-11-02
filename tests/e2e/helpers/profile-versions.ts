/**
 * AN ASSISTANT'S PROFILE VERSIONS AS PARAMETER STORE HOLDS THEM: the `active` label, one stored version, and
 * the alt assignment record that names which experiment holds a classification's alt.
 *
 * The `active` label on the definition parameter IS the pointer every turn resolves, so a spec that asserts an
 * activation, a rollback or a promotion reads the label rather than the mutation's own answer: a call that
 * reported success while the pointer stayed put is the failure worth catching.
 */
import { awsv } from './aws';
import { SSM_ROOT } from './stack-prefix';

/** The definition parameter an assistant's versions are stored under. */
export function definitionParam(profileName: string): string {
  return `${SSM_ROOT}/assistant/${profileName}/definition`;
}

/** The version number the `active` label is on, or null when no version carries it. */
export function activeProfileVersion(profileName: string): number | null {
  const rows = (awsv([
    'ssm', 'get-parameter-history', '--name', definitionParam(profileName),
    '--query', 'Parameters[?Labels!=null].{v:Version,labels:Labels}',
  ], { timeoutMs: 30_000 }) ?? []) as Array<{ v: number; labels: string[] | null }>;
  const active = rows.filter((r) => (r.labels ?? []).includes('active')).map((r) => r.v);
  return active.length ? Math.max(...active) : null;
}

/** One stored version's definition, parsed, or null when that version cannot be read. */
export function storedProfileVersion(profileName: string, version: number): Record<string, any> | null {
  try {
    const raw = awsv(['ssm', 'get-parameter', '--name', `${definitionParam(profileName)}:${version}`,
      '--query', 'Parameter.Value'], { timeoutMs: 30_000, quiet: true });
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The alt assignment record for a classification's role: which assistant and experiment hold the alt now. */
export function altAssignmentRecord(classification: string, role = 'primary'): { assistant?: string | null; experimentId?: string | null } {
  const raw = awsv(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/assistant-assignments/${classification}/${role}/alt`,
    '--query', 'Parameter.Value'], { timeoutMs: 30_000 });
  return typeof raw === 'string' ? JSON.parse(raw) : {};
}
