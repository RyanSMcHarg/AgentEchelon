/**
 * A CAPABILITY'S PART IN ONE CLASSIFICATION IS BUILT BY THAT CLASSIFICATION'S OWN STACK.
 *
 * `battle` and `experiments` each run in every classification that uses them: a duel fields the alt of the
 * classification's primary role and runs on its acting role and its router, and an experiment is read and
 * recorded on the same two roles. What either capability holds in one classification is that classification's,
 * so `Assistants-<classification>` builds it, on the capability's tables and orchestrator by their fixed names
 * (`CAPABILITY_RESOURCES`), when the deployment declares the capability:
 *
 *   - adding or removing a classification adds or removes its alt and its grants with its own stack, and no
 *     capability stack names a classification (the deploy matrix's independence pairs, `C7-custom+research`);
 *   - declaring a capability adds these resources to each classification's stack and changes none it had
 *     (`attachKindOf`, `test/deploy-matrix/configurations.ts`).
 *
 * The capability stacks keep what is not per classification: their tables, the orchestrator, their routes, and
 * the grants on the one channel flow.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { battleResourcesOf, experimentsResourcesOf } from './agent-classification-common';
import type { AssistantAttachPoints } from './assistant-profile-stack';

/**
 * BATTLE IN ONE CLASSIFICATION: the grants a duel runs on, on this classification's acting role and router role. Called by a
 * battle-capable classification's stack where the deployment declares `battle`.
 */
export function attachBattle(scope: Construct, a: AssistantAttachPoints): void {
  const names = battleResourcesOf(scope);
  // A RICH SESSION reads and writes the duel's state rows and hands the last transition to the orchestrator.
  // No delete or batch: nothing on the turn path issues one.
  if (a.richProcessor) {
    new iam.Policy(scope, 'BattleOnTheTurn', {
      roles: [a.actingRole],
      statements: [
        new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'], resources: [names.battleStateArn] }),
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [names.battleOrchestratorArn] }),
      ],
    });
  }
  // THE ROUTER reads and records a duel's rows and reads whether Battle Mode is on in the room.
  new iam.Policy(scope, 'BattleOnTheRouter', {
    roles: [a.handlerRole],
    statements: [new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [names.battleStateArn, names.channelBattleConfigArn],
    })],
  });
  // THE ALT OF EACH ROLE A DUEL FIELDS is in the classification's declaration, seeded by the provisioner like every
  // assistant (`DeclaredAssistantsSeed` in `assistant-profile-stack.ts`), with its record at `(classification, role, alt)`.
}

/**
 * EXPERIMENTS IN ONE CLASSIFICATION: the grants a turn and the router read and record an experiment through, on
 * this classification's acting role and router role. Called by every classification's stack where the
 * deployment declares `experiments`.
 */
export function attachExperiments(scope: Construct, a: AssistantAttachPoints): void {
  const { experimentsArn } = experimentsResourcesOf(scope);
  // A RICH SESSION reads and writes the experiment a turn runs under, and scans for it. No delete or batch:
  // nothing on the turn path issues one, and the only deletes on this table run on admin roles.
  if (a.richProcessor) {
    new iam.Policy(scope, 'ExperimentsOnTheTurn', {
      roles: [a.actingRole],
      statements: [new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'],
        resources: [experimentsArn],
      })],
    });
  }
  // THE ROUTER scans for the active experiment of a turn (`experiment-manager.ts`) and records an enrollment,
  // so the verb reaches this table and no other.
  new iam.Policy(scope, 'ExperimentsOnTheRouter', {
    roles: [a.handlerRole],
    statements: [new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
      resources: [experimentsArn, ...(a.handlerExperimentsIndex ? [`${experimentsArn}/index/*`] : [])],
    })],
  });
}
