/**
 * A versioned, labeled in-memory SSM stand-in for the profile-lifecycle / manifest tests. Models exactly
 * the SSM semantics those modules rely on: PutParameter appends a monotonic version; LabelParameterVersion
 * MOVES a label onto one version; GetParameter resolves `name` (latest) or `name:label`; GetParameterHistory
 * returns every version with its labels. NOT a jest test file (no `.test.` — jest ignores it).
 */
import {
  PutParameterCommand,
  LabelParameterVersionCommand,
  GetParameterHistoryCommand,
} from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';

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
        const { Name } = cmd.input as { Name: string };
        const vers = store.get(Name);
        if (!vers) notFound();
        return {
          Parameters: vers.map((v) => ({ Version: v.version, Value: v.value, Labels: [...v.labels], LastModifiedDate: undefined })),
        };
      }
      // GetParameterCommand: name or name:label
      const { Name } = (cmd as { input: { Name: string } }).input;
      const [base, label] = Name.split(':');
      const vers = store.get(base);
      if (!vers?.length) notFound();
      const chosen = label ? vers.find((v) => v.labels.has(label)) : vers[vers.length - 1];
      if (!chosen) notFound();
      return { Parameter: { Value: chosen.value } };
    }),
  };

  return { client: client as unknown as SSMClient, store };
}
