/**
 * Guardrail catalog (SPEC-CONFIGURABLE-ASSISTANTS 4.6b — "define, then select").
 *
 * The set of guardrails a deployment PROVISIONS and a profile may SELECT among (via
 * ProfileDefinitionBody.guardrailId). Defined as DATA rather than a single hardcoded CDK literal, so a
 * deployment can offer more than one guardrail and a profile can carry a stricter/industry-specific one
 * without a code fork. The stack provisions each entry, grants `bedrock:ApplyGuardrail` on each ARN to
 * the assistant role, and publishes the resolved ids so an operator (and the admin console) can select.
 *
 * The security boundary (§7): a profile SELECTS a catalog guardrail; it can never point at an arbitrary
 * resource, because the IAM grant is per PROVISIONED guardrail — an unprovisioned id AccessDenies and the
 * apply path fails OPEN (never drops a reply).
 */
import type * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { buildGuardrailPolicy } from '../constructs/bedrock-guardrails';

export interface GuardrailCatalogEntry {
  /** Stable selection key (human-facing; the provisioned id is resolved at deploy time). */
  key: string;
  /** Human-readable name (shown in the admin console's guardrail picker). */
  name: string;
  /** The guardrail policy as data. */
  policy: bedrock.CfnGuardrailProps;
}

/**
 * The deployment's guardrail catalog. Entry 0 is the DEFAULT (what `GUARDRAIL_ID` env points at; every
 * profile inherits it unless it selects another). Additional entries are selectable alternates.
 *
 * `strict` is a working EXAMPLE of a per-assistant guardrail: the base policy plus one extra blocked
 * term, so a profile that selects it is OBSERVABLY different (a reply containing the term is masked).
 * Deployers extend/replace this list with their own industry-specific guardrails.
 */
export function guardrailCatalog(resPrefix: string): GuardrailCatalogEntry[] {
  return [
    {
      key: 'default',
      name: `${resPrefix}-guardrail`,
      policy: buildGuardrailPolicy({ name: `${resPrefix}-guardrail` }),
    },
    {
      key: 'strict',
      name: `${resPrefix}-guardrail-strict`,
      policy: buildGuardrailPolicy({
        name: `${resPrefix}-guardrail-strict`,
        description: 'Stricter content filtering — the default policy plus deployment-specific blocked terms',
        extraBlockedWords: ['confidential-alpha'],
      }),
    },
  ];
}
