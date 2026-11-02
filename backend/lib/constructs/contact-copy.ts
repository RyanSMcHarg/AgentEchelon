/**
 * THE `claims` DIRECTORY'S CONTACT COPIES, AS THE STACKS WIRE THEM (C5).
 *
 * An issuer declaring `directory: 'claims'` has its people's contact claims kept from their last sign-in
 * (`lambda/src/lib/claims-directory.ts`): one item per person and issuer in the user-profile table,
 * keyed `<personId>#contact#<issuerId>`, its claims encrypted with a customer managed key, expiring 90
 * days after the sign-in that wrote it, erased with the person. Nothing here exists in a deployment that
 * declares no such issuer.
 *
 * Who holds what, and nothing more:
 *  - the credential exchange (Identity) writes and deletes the copies, `kms:Encrypt` on the key;
 *  - a function that names or reaches people (`grantDirectoryRead` with `AdminGetUser`) reads them,
 *    `kms:Decrypt` on the key, `GetItem` on the copy keys only;
 *  - offboarding deletes them with the person's other profile rows (its existing `DeleteItem`).
 *
 * The item keys are what IAM names (`dynamodb:LeadingKeys`), so a reader of the copies cannot read a
 * person's profile item through this grant, and a profile reader that holds no `kms:Decrypt` on the key
 * reads ciphertext.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SHARED_SSM } from '../stacks/agent-classification-common';
import { issuersOf } from './trusted-issuers';

/** The key pattern every contact copy matches, as IAM names it. */
export const CONTACT_COPY_LEADING_KEY = '*#contact#*';

/** True when the registry declares an issuer whose directory is the contact copy. */
export function contactCopiesDeclared(scope: Construct): boolean {
  return issuersOf(scope).claimsDirectoryIssuers().length > 0;
}

/** The writer's grant: put and delete a copy, and encrypt with the key. */
export function grantContactCopyWrite(role: iam.IRole, tableArn: string, keyArn: string): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
    resources: [tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [CONTACT_COPY_LEADING_KEY] } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['kms:Encrypt'], resources: [keyArn] }));
}

/**
 * The exchange's run-time lookup, for a function in a stack deployed before the table's: the SSM
 * parameter names, and the read of those two parameters.
 */
export function grantContactCopyParams(fn: lambda.Function): void {
  const stack = cdk.Stack.of(fn);
  fn.addEnvironment('CONTACT_COPY_TABLE_PARAM', SHARED_SSM.userProfileName);
  fn.addEnvironment('CONTACT_COPY_KEY_PARAM', SHARED_SSM.contactCopyKeyArn);
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: [SHARED_SSM.userProfileName, SHARED_SSM.contactCopyKeyArn].map(
      (name) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${name.startsWith('/') ? name : `/${name}`}`,
    ),
  }));
}

/**
 * A reader's grant, for a function in a stack deployed after the table's: the table and key resolved
 * from the SSM contract at deploy, `GetItem` on the copy keys alone and `kms:Decrypt` on the key.
 */
export function grantContactCopyRead(fn: lambda.Function): void {
  const tableName = ssm.StringParameter.valueForStringParameter(fn, SHARED_SSM.userProfileName);
  const tableArn = ssm.StringParameter.valueForStringParameter(fn, SHARED_SSM.userProfileArn);
  const keyArn = ssm.StringParameter.valueForStringParameter(fn, SHARED_SSM.contactCopyKeyArn);
  fn.addEnvironment('CONTACT_COPY_TABLE', tableName);
  fn.addEnvironment('CONTACT_COPY_KEY_ARN', keyArn);
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [CONTACT_COPY_LEADING_KEY] } },
  }));
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [keyArn] }));
}
