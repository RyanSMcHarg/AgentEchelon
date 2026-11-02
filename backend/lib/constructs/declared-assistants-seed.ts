/**
 * THE SEED: A DEPLOY DECLARES ITS ASSISTANTS AND ASKS THE PROVISIONER FOR THEM (ADR-048, amended 2026-10-24).
 *
 * No stack owns an assistant identity. A stack that declares assistants (each `Assistants-<classification>`,
 * and `AdminServices` for the admin assistant) holds this one custom resource, whose properties are the declaration,
 * and whose handler is a thin CloudFormation adapter (`lambda/src/seed-declared-assistants.ts`): it invokes the
 * provisioner (`assistant-provisioner.ts`, in `Messaging`), the one principal that builds and retires every
 * assistant, and hands CloudFormation its answer. Everything the provisioner builds is stamped
 * `provisioner = runtime` and is the console's from then on.
 *
 * ITS ROLE HOLDS THREE GRANTS: invoking the provisioner; writing a claim under its own classification's path
 * (`{root}/provisioner-claims/seed/{classification}/`), which proves to the provisioner that a request is this
 * seed's and which no other role may write, so the boundary between classifications is IAM's and lives in the
 * classification's own stack; and reading its own stack's status, to tell a rollback from an update. No identity,
 * Amazon Lex, directory or record write is on it.
 *
 * `primaryBotArn` is the declared primary's identity, read from the seed's answer at deploy. A stack writes it into
 * a parameter or an environment; it is never a resource the stack owns.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { ASSISTANT_PROVISIONER_FUNCTION_NAME, SSM_ROOT } from '../stacks/agent-classification-common';
import { invokeTheProvisioner, claimWriteFor } from './assistant-provisioner';
import type { DeclaredAssistant, Declaration } from '../../lambda/src/lib/declared-assistants';

export type { DeclaredAssistant, Declaration };

export interface DeclaredAssistantsSeedProps {
  classification: string;
  /** The roles deployed on the classification. */
  roles: string[];
  assistants: DeclaredAssistant[];
  /** The function that fulfills the assistants' Amazon Lex turns. */
  fulfillmentArn: string;
}

export class DeclaredAssistantsSeed extends Construct {
  /** The declared primary's identity, from the seed's answer. Empty when the declaration names no primary. */
  public readonly primaryBotArn: string;
  public readonly role: iam.Role;
  public readonly resource: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: DeclaredAssistantsSeedProps) {
    super(scope, id);
    const c = props.classification;
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        AskTheProvisionerOnly: new iam.PolicyDocument({
          statements: [
            invokeTheProvisioner(this),
            // THE PROOF THAT A REQUEST IS THIS CLASSIFICATION'S SEED'S: a claim under its own classification's path,
            // which no other role in the app may write. Granted here, in the classification's own stack.
            claimWriteFor(this, { seedOf: c }),
            // ITS OWN STACK'S STATUS, which tells CloudFormation rolling back an update from making one.
            new iam.PolicyStatement({ sid: 'ReadItsOwnStacksStatus', actions: ['cloudformation:DescribeStacks'], resources: [cdk.Stack.of(this).stackId] }),
          ],
        }),
      },
    });
    const fn = new lambdaNodeJs.NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, '../../lambda/src/seed-declared-assistants.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      role: this.role,
      // It waits on the provisioner, which builds each declared assistant's Amazon Lex bot in about a minute.
      timeout: cdk.Duration.minutes(14),
      memorySize: 128,
      environment: {
        CLASSIFICATION: c,
        FULFILLMENT_ARN: props.fulfillmentArn,
        PROVISIONER_FUNCTION_NAME: ASSISTANT_PROVISIONER_FUNCTION_NAME,
        SSM_ROOT,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.provider = new cr.Provider(this, 'Provider', { onEventHandler: fn });
    this.classification = c;
    this.roles = [...props.roles].sort();
    this.resource = this.declareOn(this, 'Resource', props.assistants);
    this.primaryBotArn = this.resource.getAttString('PrimaryBotArn');
  }

  private readonly provider: cr.Provider;
  private readonly classification: string;
  private readonly roles: string[];

  /**
   * A FURTHER DECLARATION ON THE SAME SEED, as a resource of its own, for assistants a CAPABILITY adds (a duel's
   * alts, where `battle` is declared). Its own resource keeps declaring the capability additive (STACKS.md,
   * additivity): it adds this resource and changes none the stack had, and withdrawing the capability deletes it,
   * which removes those assistants and no other.
   */
  public declare(scope: Construct, id: string, assistants: DeclaredAssistant[]): cdk.CustomResource {
    return this.declareOn(scope, id, assistants);
  }

  private declareOn(scope: Construct, id: string, assistants: DeclaredAssistant[]): cdk.CustomResource {
    const declaration: Declaration = {
      classification: this.classification,
      roles: this.roles,
      assistants: [...assistants].sort((a, b) => a.assistantId.localeCompare(b.assistantId)),
    };
    return new cdk.CustomResource(scope, id, {
      serviceToken: this.provider.serviceToken,
      resourceType: 'Custom::DeclaredAssistants',
      // THE DECLARATION IS THE PROPERTY, so the seed runs exactly when what is declared changes, and an unchanged
      // deploy asks for nothing. The provisioner decides what a delete removes (the assistants this declaration
      // names), so CloudFormation's own policy is the default.
      properties: { declaration: JSON.stringify(declaration) },
    });
  }
}
