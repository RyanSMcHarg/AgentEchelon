/**
 * WHICH ASSISTANT SERVES A CLASSIFICATION, asked of the deployment rather than hardcoded.
 *
 * THE DEFECT THIS EXISTS FOR. Three profile specs opened with `const PROFILE = 'standard'`, which was
 * correct only while every profile happened to be named after the classification it served. Once an
 * assistant could be named for what it does (`analyst` serving `standard`), those specs asked the API
 * about a profile that does not exist and got `unknown or missing profileName 'standard'` - and the
 * console spec asserted the profile list contained "basic|standard|premium", which it no longer does.
 * Four failures, all from one assumption that the two names were interchangeable.
 *
 * Hardcoding the NEW names would rot exactly the same way, because renaming an assistant is a
 * supported operation now rather than an accident. So the mapping is read from the assignment record
 * the platform already publishes for this purpose (DESIGN-SEPARATE-ASSISTANTS 3.0): it names the
 * assistant holding `(classification, role, occupancy)`, which is the question being asked here.
 *
 * `execSync` rather than the SDK because these specs already resolve SSM that way, and because the
 * answer is needed at MODULE scope - a spec builds its parameter paths from it before any test runs.
 */
import { execSync } from 'child_process';
import { SSM_ROOT } from './stack-prefix';

const REGION = process.env.AWS_REGION || 'us-east-1';

/** Resolved once per process: the record does not change while a spec file runs. */
const cache = new Map<string, string>();

/**
 * The profile name of the assistant holding `(classification, role, occupancy)`.
 *
 * Throws rather than falling back to the classification. A fallback would restore the exact
 * coincidence this replaced - the spec would pass on a deployment where the two still match and fail
 * confusingly on one where they do not, which is worse than saying the record is missing.
 */
export function assistantServing(
  classification: string,
  role = 'primary',
  occupancy: 'live' | 'alt' = 'live',
): string {
  const key = `${classification}/${role}/${occupancy}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // THE DECLARED ASSISTANT'S RECORD, at the one path every live assistant's record has (ADR-048, amended
  // 2026-10-23): `{classification}/{role}/assistants/{id}`, the declared one being the record that is not a
  // console-created (`runtime`) one. An alt's is its role's `alt` record.
  const name = occupancy === 'alt'
    ? `${SSM_ROOT}/assistant-assignments/${key}`
    : `${SSM_ROOT}/assistant-assignments/${classification}/${role}/assistants`;
  let records: Array<{ assistant?: string; source?: string }>;
  try {
    const raw = execSync(
      occupancy === 'alt'
        ? `aws ssm get-parameter --region ${REGION} --name "${name}" --query "[Parameter.Value]" --output json`
        : `aws ssm get-parameters-by-path --region ${REGION} --path "${name}" --query "Parameters[].Value" --output json`,
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    records = (JSON.parse(raw.trim() || '[]') as string[]).map((v) => JSON.parse(v));
  } catch (e) {
    throw new Error(
      `could not read the assignment records at ${name}. They name which assistant serves this role, and `
      + 'these specs resolve the profile through them rather than assuming the profile is named after '
      + `the classification. Original error: ${(e as Error).message}`,
    );
  }
  const assistant = occupancy === 'alt'
    ? records[0]?.assistant ?? undefined
    : records.find((r) => r.source !== 'runtime' && r.assistant)?.assistant;
  if (!assistant) throw new Error(`no declared assistant holds ${key} (${name})`);
  cache.set(key, assistant);
  return assistant;
}
