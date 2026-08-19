/**
 * A content guardrail for image generation, in a region the DEPLOYMENT does not live in.
 *
 * **Why a whole stack for one resource.** Bedrock guardrails are REGIONAL, and Bedrock does not offer
 * every image model in every region: `stability_image_core` and `stability_image_ultra` are
 * `us-west-2`-only (see `region` on their registry entries), so a `us-east-1` deployment invokes them
 * cross-region. A guardrail created in the deploy region cannot be attached to that call - Bedrock
 * rejects it with:
 *
 *   ValidationException: The guardrail identifier or version provided in the request does not exist.
 *
 * which reads exactly like a bad identifier. Two investigations checked the id and its version (both
 * fine, both READY) before anyone checked the region. The model pinning had already been fixed for
 * exactly this reason; the guardrail was left behind in the deploy region.
 *
 * A CloudFormation resource belongs to its stack's region, so covering another region means another
 * stack there. That is the whole purpose of this one.
 *
 * **The alternative was rejected deliberately.** Dropping the guardrail when the regions differ would
 * make image generation succeed while content moderation was silently off - a safety regression that
 * produces a green test and a generated image. The runtime therefore REFUSES to generate when no
 * guardrail covers the invocation region (`imageGuardrailFor` returns undefined), so a missing stack
 * degrades to "no image" rather than "unmoderated image".
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BattleImageGuardrails } from '../constructs/battle-image-guardrails';

export interface ImageGuardrailStackProps extends cdk.StackProps {
  /** Name for the guardrail; carries the region so it is identifiable in the console. */
  guardrailName: string;
}

export class ImageGuardrailStack extends cdk.Stack {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props: ImageGuardrailStackProps) {
    super(scope, id, props);

    const guardrail = new BattleImageGuardrails(this, 'ImageGuardrail', {
      name: props.guardrailName,
    });

    this.guardrailId = guardrail.guardrailId;
    this.guardrailVersion = guardrail.guardrailVersion;

    // Outputs so the id is readable without the console, and so a deployer can confirm the guardrail
    // actually exists in this region before trusting an image turn.
    new cdk.CfnOutput(this, 'ImageGuardrailId', {
      value: guardrail.guardrailId,
      description: `Image-generation guardrail id in ${this.region}`,
    });
    new cdk.CfnOutput(this, 'ImageGuardrailVersion', {
      value: guardrail.guardrailVersion,
      description: `Image-generation guardrail version in ${this.region}`,
    });
  }
}
