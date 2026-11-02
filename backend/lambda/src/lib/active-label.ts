/**
 * Whether reading `{definition}:active` failed only because nothing is active yet.
 *
 * Three errors mean that, not two: no parameter at all, no label, and - for a parameter that exists but
 * carries no `active` label - `ParameterVersionNotFound`, which is what SSM actually answers there
 * (measured 2026-10-13 on the alt's unlabelled versions, ADR-050). A reader that tolerated only the label
 * error refused every alt turn.
 *
 * Its own module so the vend, which imports nothing heavy, can share it with the profile readers.
 */
export function isNoActiveVersion(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'ParameterNotFound' || name === 'ParameterVersionLabelNotFound' || name === 'ParameterVersionNotFound';
}
