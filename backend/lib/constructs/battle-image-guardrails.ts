/**
 * Battle Image-Output Guardrails Construct (SPEC-BATTLE.md §"Image
 * Battles — Generation-Out", Phase 4A).
 *
 * `/battle` generation-out produces IMAGES from a user prompt. The
 * existing AgentGuardrails construct covers text I/O only; generated
 * images need their own content-moderation pass.
 *
 * **Open-source posture (see feedback-oss-security-responsibility +
 * project-open-source-no-monetization).** This ships a *basic default*:
 * a reasonable content-moderation baseline on the prompt (text in) and
 * the generated image (image out). It is deliberately NOT gated on any
 * internal sign-off. Production-grade image moderation tuned to a
 * deployer's risk profile is **the deployer's responsibility** — the
 * README / deploy docs say so explicitly. Scope here is the baseline +
 * that documented hand-off, nothing organizational.
 *
 * Wired into the image-gen invoke path in Phase 4B (the guardrail id is
 * passed to the Bedrock InvokeModel call for the image models).
 */

import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import { RES_PREFIX } from '../stacks/agent-tier-common';

export interface BattleImageGuardrailsProps {
  /** Descriptive name for the guardrail. */
  name?: string;
}

export class BattleImageGuardrails extends Construct {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props: BattleImageGuardrailsProps = {}) {
    super(scope, id);

    // Content filters apply to the text prompt (input) and the
    // generated image (output). `IMAGE` output modality is what makes
    // this distinct from the text-only AgentGuardrails — Bedrock
    // moderates the rendered image, not just the prompt.
    const imageModalities = ['TEXT', 'IMAGE'];

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: props.name || `${RES_PREFIX}-battle-image-guardrail`,
      description:
        'Basic default content moderation for /battle image generation-out. ' +
        'Production tuning is the deployer responsibility (OSS posture).',
      blockedInputMessaging:
        'I cannot generate an image for that request. Please rephrase.',
      blockedOutputsMessaging:
        'The generated image was withheld by the content filter.',

      contentPolicyConfig: {
        filtersConfig: [
          {
            type: 'SEXUAL',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
            inputModalities: imageModalities,
            outputModalities: imageModalities,
          },
          {
            type: 'VIOLENCE',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
            inputModalities: imageModalities,
            outputModalities: imageModalities,
          },
          {
            type: 'HATE',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
            inputModalities: imageModalities,
            outputModalities: imageModalities,
          },
          {
            type: 'MISCONDUCT',
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
            inputModalities: imageModalities,
            outputModalities: imageModalities,
          },
          // Prompt-injection on the text prompt only (no image input here).
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
    });

    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Initial version',
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailVersion = guardrailVersion.attrVersion;

    new cdk.CfnOutput(this, 'BattleImageGuardrailId', {
      value: guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID for /battle image generation-out (basic default)',
    });
  }
}
