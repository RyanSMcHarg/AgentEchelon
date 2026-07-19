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

export interface AgentGuardrailsProps {
  /** Descriptive name for the guardrail */
  name?: string;
}

export class AgentGuardrails extends Construct {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;
  /** Full ARN — needed to grant an agent role `bedrock:ApplyGuardrail`. */
  public readonly guardrailArn: string;

  constructor(scope: Construct, id: string, props: AgentGuardrailsProps = {}) {
    super(scope, id);

    const guardrailConfig: bedrock.CfnGuardrailProps = {
      name: props.name || `${RES_PREFIX}-guardrail`,
      description: 'Content filtering for AgentEchelon Bedrock Agents',
      blockedInputMessaging:
        'I cannot process that request. Please rephrase your message.',
      blockedOutputsMessaging:
        'I cannot provide that response. Let me try a different approach.',

      // Content filters — block harmful content categories
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

      // Sensitive information filters — block PII in outputs
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
        regexesConfig: [
          {
            name: 'MetadataMarkerFilter',
            description: 'Mask internal metadata markers if they leak into a response',
            pattern: '<!--(?:ACTIVE_TASK|corr):[^>]*-->',
            // ANONYMIZE (mask the marker) — NOT BLOCK, which would reject the
            // whole reply just because it carried an internal marker.
            action: 'ANONYMIZE',
          },
        ],
      },

      // No topic-DENY policy. AgentEchelon is open source AND the assistant's
      // knowledge is the tier-seeded company context we provide (plus general
      // knowledge) — it never holds the deployment's AWS account id, tokens, or
      // credentials, so there is nothing secret for a topic filter to protect.
      // The real data boundary is the tier-scoped S3 IAM on context/{tier}/, and
      // the rule is simply: don't seed secrets. A topic-DENY here only produced
      // false positives (blocking legitimate technical answers). Production
      // deployers can add their own topics (OSS: deployer-owned security).

      // Word policy — block specific patterns
      wordPolicyConfig: {
        wordsConfig: [
          { text: 'system-admin' },
        ],
        managedWordListsConfig: [
          { type: 'PROFANITY' },
        ],
      },
    };

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
