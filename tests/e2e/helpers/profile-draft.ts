/**
 * A DRAFT IS REPLACED OR PROMOTED ONLY BY NAME (SPEC-PORTABLE-PROFILES FR19). The profile API refuses a new version or an
 * import over a draft the request does not name (`409 DRAFT_EXISTS`, carrying that draft's `configId`), an edit that
 * does not name the draft it was based on, and an activation that does not name the draft it promotes.
 *
 * A spec starts its own version on purpose, so a draft an earlier run left behind is replaced by naming it: the first
 * request is sent as written, and a `DRAFT_EXISTS` refusal is answered once by the same request naming that draft.
 *
 * Each spec's request helper answers either `{ status, body }` or the parsed body alone; both are read here.
 */
const bodyOf = (res: any): any => (res && typeof res === 'object' && 'status' in res && 'body' in res ? res.body : res);

export async function replacingDraft<T>(send: (body: Record<string, unknown>) => Promise<T>, body: Record<string, unknown>): Promise<T> {
  const first = await send(body);
  const refusal = bodyOf(first);
  if (refusal?.code === 'DRAFT_EXISTS' && typeof refusal?.configId === 'string') {
    return send({ ...body, replaceConfigId: refusal.configId });
  }
  return first;
}

/** The configId a draft write answered with: `draftConfigId` from a new version or an edit, `configId` from an import. */
export function draftIdOf(res: unknown): string | undefined {
  const b = bodyOf(res) ?? {};
  return typeof b.draftConfigId === 'string' ? b.draftConfigId : typeof b.configId === 'string' ? b.configId : undefined;
}
