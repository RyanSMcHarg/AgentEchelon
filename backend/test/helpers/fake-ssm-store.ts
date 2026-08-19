/**
 * A versioned, labeled in-memory SSM stand-in for the profile-lifecycle / manifest tests. Models exactly
 * the SSM semantics those modules rely on: PutParameter appends a monotonic version; LabelParameterVersion
 * MOVES a label onto one version; GetParameter resolves `name` (latest), `name:label` OR `name:version`;
 * GetParameterHistory PAGES like the real API. NOT a jest test file (no `.test.` — jest ignores it).
 *
 * THE PAGING IS THE POINT, and it was missing. This fake used to return every version from
 * `GetParameterHistory` in one page with no `NextToken`, which is more generous than the real API and is
 * exactly why an unpaginated history scan passed every test while being broken in the deployment. Real
 * `GetParameterHistory` returns at most `MaxResults` (default 10) entries, OLDEST FIRST, with a
 * `NextToken` to continue. Three call sites read the first page only and therefore could not see any
 * version past the tenth: a pinned experiment variant resolved to null and was silently skipped, a
 * manifest export failed with "version not found", and ROLLBACK refused a version the console had just
 * offered. Modelling the page boundary here is what makes that class of bug fail in CI.
 */
import {
  PutParameterCommand,
  LabelParameterVersionCommand,
  GetParameterHistoryCommand,
} from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';

/** Real `GetParameterHistory` default/maximum page size. The boundary the fake must reproduce. */
export const SSM_HISTORY_PAGE_SIZE = 10;

interface Ver {
  version: number;
  value: string;
  labels: Set<string>;
}

export function fakeSsmStore() {
  const store = new Map<string, Ver[]>();

  function notFound(): never {
    const e = new Error('not found') as Error & { name: string };
    e.name = 'ParameterNotFound';
    throw e;
  }

  const client = {
    send: jest.fn(async (cmd: unknown) => {
      if (cmd instanceof PutParameterCommand) {
        const { Name, Value } = cmd.input as { Name: string; Value: string };
        const vers = store.get(Name) ?? [];
        const version = (vers[vers.length - 1]?.version ?? 0) + 1;
        vers.push({ version, value: Value, labels: new Set() });
        store.set(Name, vers);
        return { Version: version };
      }
      if (cmd instanceof LabelParameterVersionCommand) {
        const { Name, ParameterVersion, Labels } = cmd.input as { Name: string; ParameterVersion: number; Labels: string[] };
        const vers = store.get(Name);
        if (!vers) notFound();
        for (const l of Labels) for (const v of vers) v.labels.delete(l); // a label lives on ONE version
        const target = vers.find((v) => v.version === ParameterVersion);
        if (!target) notFound();
        for (const l of Labels) target.labels.add(l);
        return {};
      }
      if (cmd instanceof GetParameterHistoryCommand) {
        const { Name, MaxResults, NextToken } = cmd.input as { Name: string; MaxResults?: number; NextToken?: string };
        const vers = store.get(Name);
        if (!vers) notFound();
        // Oldest first, capped, with a continuation token — the real contract. A caller that ignores
        // `NextToken` sees only the first page, which is the defect this models.
        const start = NextToken ? Number(NextToken) : 0;
        const size = Math.min(MaxResults ?? SSM_HISTORY_PAGE_SIZE, SSM_HISTORY_PAGE_SIZE);
        const page = vers.slice(start, start + size);
        const end = start + page.length;
        return {
          Parameters: page.map((v) => ({ Version: v.version, Value: v.value, Labels: [...v.labels], LastModifiedDate: undefined })),
          ...(end < vers.length ? { NextToken: String(end) } : {}),
        };
      }
      // GetParameterCommand: `name`, `name:label`, or `name:version` (a numeric selector addresses one
      // immutable version directly, which is how a pinned version should be read).
      const { Name } = (cmd as { input: { Name: string } }).input;
      const [base, selector] = Name.split(':');
      const vers = store.get(base);
      if (!vers?.length) notFound();
      const chosen = selector === undefined
        ? vers[vers.length - 1]
        : /^[0-9]+$/.test(selector)
          ? vers.find((v) => v.version === Number(selector))
          : vers.find((v) => v.labels.has(selector));
      if (!chosen) notFound();
      return { Parameter: { Value: chosen.value } };
    }),
  };

  return { client: client as unknown as SSMClient, store };
}
