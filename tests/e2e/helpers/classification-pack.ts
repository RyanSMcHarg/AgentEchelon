/**
 * A CLASSIFICATION'S INTENT PACK AS THE DEPLOYMENT RUNS IT.
 *
 * The pack is the classification's `assistant-intent-pack` parameter: the pack inline, or a pointer to its body in the
 * attachments bucket (`classification-packs/<classification>/<sha256>/intentPack`), which is followed here. It is the
 * only place a classification's task machines live (a version does not read `machines`), so a spec that exercises a
 * workflow reads it from here rather than assuming what was seeded.
 */
import { awsv, awsvText } from './aws';
import { SSM_ROOT } from './stack-prefix';
import { attachmentsBucket } from './delivered-template';

/** An SSM parameter's value, or undefined when it does not exist. */
function parameter(name: string): string | undefined {
  try {
    return awsv(['ssm', 'get-parameter', '--name', name], { quiet: true })?.Parameter?.Value;
  } catch {
    return undefined;
  }
}

/** The classification's deployed pack, parsed; undefined when the deployment sets none. */
export function deployedClassificationPack(classification: string): Record<string, any> | undefined {
  const raw = parameter(`${SSM_ROOT}/assistant/${classification}/assistant-intent-pack`);
  let pack = raw ? JSON.parse(raw) : undefined;
  const bucket = pack?.ref?.key ? attachmentsBucket() : undefined;
  if (bucket) pack = JSON.parse(awsvText(['s3', 'cp', `s3://${bucket}/${pack.ref.key}`, '-'], { quiet: true }));
  return pack;
}

/** A workflow step that requires a tool before the task leaves it, with the intent that opens the workflow. */
export interface RequiredToolStep {
  /** The workflow, which is also the intent that opens it. */
  workflow: string;
  state: string;
  tools: string[];
  /** Where the task goes when it leaves the step. */
  next: string[];
}

/**
 * The steps of a pack's workflows that declare `requiresTool`, each in a workflow an intent of the same pack opens as
 * multi-step work (so a person's request can reach it).
 */
export function requiredToolSteps(pack: Record<string, any> | undefined): RequiredToolStep[] {
  const opened = new Set(((pack?.intents ?? []) as Array<{ key?: string; delivery?: string }>)
    .filter((i) => i.delivery === 'TASK_MULTI_STEP').map((i) => String(i.key)));
  const out: RequiredToolStep[] = [];
  for (const [workflow, machine] of Object.entries((pack?.machines ?? {}) as Record<string, any>)) {
    if (!opened.has(workflow)) continue;
    for (const [state, def] of Object.entries((machine?.states ?? {}) as Record<string, any>)) {
      if (Array.isArray(def?.requiresTool) && def.requiresTool.length) {
        out.push({ workflow, state, tools: def.requiresTool.map(String), next: (def.transitions ?? []).map(String) });
      }
    }
  }
  return out;
}
