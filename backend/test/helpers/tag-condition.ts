/**
 * WHETHER A STATEMENT'S CONDITION ADMITS A RESOURCE CARRYING THESE TAGS, as IAM evaluates the three operators a
 * tag-bounded grant here uses: `StringEquals` (the tag is present and one of the values), `StringNotEquals` (the tag
 * is absent or none of the values) and `Null` (`'false'`: the tag is present; `'true'`: it is absent).
 *
 * Every key must be a tag key under `prefix` (`aws:ResourceTag/` for a function, `ssm:resourceTag/` for a
 * parameter), and any other operator is refused, so a condition this helper cannot read fails the test rather than
 * passing it.
 */
const asList = (v: unknown): string[] => ([] as unknown[]).concat(v).map(String);

export function admitsTags(condition: unknown, tags: Record<string, string>, prefix = 'aws:ResourceTag/'): boolean {
  for (const [op, block] of Object.entries((condition ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const [key, raw] of Object.entries(block)) {
      if (!key.startsWith(prefix)) throw new Error(`admitsTags: ${op} on ${key} is not a ${prefix} condition`);
      const value = tags[key.slice(prefix.length)];
      const values = asList(raw);
      if (op === 'StringEquals') {
        if (value === undefined || !values.includes(value)) return false;
      } else if (op === 'StringNotEquals') {
        if (value !== undefined && values.includes(value)) return false;
      } else if (op === 'Null') {
        if ((value === undefined) !== (values[0] === 'true')) return false;
      } else {
        throw new Error(`admitsTags: operator ${op} is not read here`);
      }
    }
  }
  return true;
}

/** A synthesized resource's tags as a map, from a Lambda function's `[{ Key, Value }]` or a parameter's `{ k: v }`. */
export function tagsOf(properties: { Tags?: unknown } | undefined): Record<string, string> {
  const t = properties?.Tags;
  if (Array.isArray(t)) return Object.fromEntries(t.map((e: { Key: string; Value: string }) => [e.Key, e.Value]));
  return { ...((t ?? {}) as Record<string, string>) };
}
