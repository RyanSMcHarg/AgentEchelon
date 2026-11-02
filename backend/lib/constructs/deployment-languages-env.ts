/**
 * EVERY FUNCTION READS THE SAME DECLARED LANGUAGES (ADR-062 decision 4).
 *
 * The deployment's `languages` are the closed set a reply-language instruction names, a person's language setting
 * offers, a condition on `signal:userLanguage` or `person:preferredLanguage` decides over, and a message template's
 * language order resolves to. One aspect tells every Lambda function the list, so the router, the processor, the
 * profile validation, the console's listing and the person's setting cannot disagree about it.
 *
 * A deployment that declares nothing is told nothing: `deploymentLanguages()` reads the default then, so the
 * functions of a deployment that never set `languages` synthesize exactly as before. No grant is added.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';
import { DEPLOYMENT_LANGUAGES_ENV, isDefaultLanguages } from '../config/languages';

export class DeploymentLanguagesEnv implements cdk.IAspect {
  constructor(private readonly languages: readonly string[]) {}

  visit(node: IConstruct): void {
    if (isDefaultLanguages(this.languages)) return;
    if (node instanceof lambda.Function) node.addEnvironment(DEPLOYMENT_LANGUAGES_ENV, JSON.stringify(this.languages));
  }
}
