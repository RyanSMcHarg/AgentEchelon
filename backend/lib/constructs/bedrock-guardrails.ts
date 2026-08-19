/**
 * Bedrock Guardrails Construct
 *
 * Phase 2: Deterministic content filtering attached to Bedrock Agents.
 * Replaces prompt-based content filtering with low-latency guardrails
 * that run before and after model invocation.
 */

import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import * as crypto from 'crypto';
import { RES_PREFIX } from '../stacks/agent-classification-common';
import { METADATA_MARKER_FILTER_NAME } from '../config/guardrail-masks';

export interface AgentGuardrailsProps {
  /** Descriptive name for the guardrail */
  name?: string;
  /**
   * A fully data-driven policy (SPEC-CONFIGURABLE-ASSISTANTS 4.6b): when provided, this construct
   * provisions THIS policy verbatim instead of the built-in default — so a deployment can define more
   * than one guardrail as data and a profile can SELECT among them. Absent ⇒ `buildGuardrailPolicy(name)`.
   */
  policy?: bedrock.CfnGuardrailProps;
}

/**
 * The platform-default guardrail policy as DATA (SPEC-CONFIGURABLE-ASSISTANTS 4.6b). Exported so a
 * deployment's guardrail catalog can start from it and tweak (e.g. add industry-specific blocked words)
 * rather than re-declaring the whole policy. `extraBlockedWords` appends to the word filter — the cheap
 * lever a "stricter" variant uses to be observably different from the default.
 */
export function buildGuardrailPolicy(opts: { name: string; description?: string; extraBlockedWords?: string[] }): bedrock.CfnGuardrailProps {
  return {
    name: opts.name,
    description: opts.description ?? 'Content filtering for AgentEchelon Bedrock Agents',
    blockedInputMessaging: 'I cannot process that request. Please rephrase your message.',
    blockedOutputsMessaging: 'I cannot provide that response. Let me try a different approach.',
    contentPolicyConfig: {
      filtersConfig: [
        { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
        { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
        { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
        { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
        { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
        { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
      ],
    },
    sensitiveInformationPolicyConfig: {
      piiEntitiesConfig: [
        { type: 'EMAIL', action: 'ANONYMIZE' },
        { type: 'PHONE', action: 'ANONYMIZE' },
        { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
        { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
      ],
      regexesConfig: [
        {
          // The NAME is the mask: Bedrock Guardrails substitutes `{MetadataMarkerFilter}` for an
          // ANONYMIZE match, so the name is a user-visible string the runtime has to recognise and
          // remove. It comes from the shared declaration (`config/guardrail-masks`) that the marker
          // stripper reads, so the provisioned filter and the stripped token cannot drift apart.
          name: METADATA_MARKER_FILTER_NAME,
          description: 'Mask internal metadata markers if they leak into a response',
          pattern: '<!--(?:ACTIVE_TASK|corr):[^>]*-->',
          action: 'ANONYMIZE',
        },
      ],
    },
    wordPolicyConfig: {
      wordsConfig: [
        { text: 'system-admin' },
        ...(opts.extraBlockedWords ?? []).map((text) => ({ text })),
      ],
      managedWordListsConfig: [{ type: 'PROFANITY' }],
    },
  };
}

export class AgentGuardrails extends Construct {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;
  /** Full ARN — needed to grant an agent role `bedrock:ApplyGuardrail`. */
  public readonly guardrailArn: string;

  constructor(scope: Construct, id: string, props: AgentGuardrailsProps = {}) {
    super(scope, id);

    // Default policy comes from the shared, data-driven builder (single source of truth); a caller may
    // pass a fully-formed `policy` to provision an alternate guardrail (4.6b — the guardrail catalog).
    const guardrailConfig: bedrock.CfnGuardrailProps = props.policy ?? buildGuardrailPolicy({ name: props.name || `${RES_PREFIX}-guardrail` });

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', guardrailConfig);

    // Publish a version. CfnGuardrailVersion snapshots the DRAFT at create
    // time; a later config edit leaves consumers (GUARDRAIL_VERSION env) pinned
    // to the stale snapshot unless the version resource itself changes — the
    // same class of bug as the agent-alias auto-bump. Hash the config into the
    // version description so any guardrail change republishes a fresh version
    // and consumers (which read attrVersion) roll forward automatically.
    const cfgHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(guardrailConfig))
      .digest('hex')
      .slice(0, 12);
    // Hash in the LOGICAL ID (not just the description): a guardrail version is
    // an immutable snapshot, so to pick up a config edit CFN must create a NEW
    // version resource (publishing a fresh snapshot of the updated DRAFT) and
    // retire the old one. A description-only change would update in place and
    // leave the snapshot — and thus consumers — stale.
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, `GuardrailVersion${cfgHash}`, {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `cfg ${cfgHash}`,
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailVersion = guardrailVersion.attrVersion;
    this.guardrailArn = guardrail.attrGuardrailArn;

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID',
    });
  }
}
