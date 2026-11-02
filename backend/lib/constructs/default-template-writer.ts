/**
 * THE PLATFORM'S DOCUMENT TEMPLATES, WRITTEN AT DEPLOY FOR ONE CLASSIFICATION (SPEC-DOCUMENT-TEMPLATES FR2).
 *
 * For each shipped template a workflow of the classification declares (`templatesDeclaredFor`), the deploy
 * writes the body to `templates/<classification>/<name>/<sha256>.md` and then, only if no version of that
 * name is active, the pointer `<ssmRoot>/assistant/<classification>/templates/<name>`. Both writes are
 * create-only: the body with `If-None-Match: *`, so an existing object is never overwritten, and the
 * pointer with `Overwrite: false`, so a version a deployment activated with `npm run template` is never
 * moved by a redeploy. A changed shipped template is a new body beside the old one, and a deployment
 * adopts it by activating it.
 *
 * WRITE SCOPE FOLLOWS THE OWNER (tenet D15), as the intent pack's body writer does: PutObject on this
 * classification's `templates/<classification>/<name>/` key family and PutParameter on its pointer, for exactly the
 * names written, so it reaches no assistant's family (ADR-062). No turn role holds either.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { templateKey, templatePointerName, templatePrefix, templatePointerValue } from '../../lambda/src/lib/template-store';
import { shippedTemplates } from '../config/default-templates';

export interface DefaultTemplateWriterProps {
  classification: string;
  /** The template names this classification's workflows declare. Only shipped ones are written. */
  declared: string[];
  ssmRoot: string;
  bucketName: string;
  bucketArn: string;
  region: string;
  account: string;
}

export class DefaultTemplateWriter extends Construct {
  /** The shipped templates this classification received, by name. */
  readonly written: string[];

  constructor(scope: Construct, id: string, props: DefaultTemplateWriterProps) {
    super(scope, id);
    const shipped = shippedTemplates();
    this.written = props.declared.filter((n) => shipped.has(n));
    for (const name of this.written) {
      const t = shipped.get(name)!;
      const key = templateKey(props.classification, name, t.contentHash);
      const pointer = templatePointerName(props.ssmRoot, props.classification, name);
      const body = new cr.AwsCustomResource(this, `Body-${name}`, {
        onUpdate: {
          service: 'S3',
          action: 'putObject',
          parameters: {
            Bucket: props.bucketName, Key: key, Body: t.source,
            ContentType: 'text/markdown; charset=utf-8', IfNoneMatch: '*',
          },
          physicalResourceId: cr.PhysicalResourceId.of(key),
          // The body is already there: content-addressed, so it is these bytes. Success.
          ignoreErrorCodesMatching: 'PreconditionFailed',
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['s3:PutObject'],
            // This template's own key family: never another name's, an assistant's (`_assistants/`) or the
            // shipped family (ADR-062 decision 2).
            resources: [`${props.bucketArn}/${templatePrefix(props.classification)}${name}/*`],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      const activate = new cr.AwsCustomResource(this, `Pointer-${name}`, {
        onUpdate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: pointer, Value: templatePointerValue({ active: t.contentHash, history: [] }),
            Type: 'String', Overwrite: false,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${pointer}@${t.contentHash.slice(0, 16)}`),
          // A version is already active, whether an earlier deploy's or one an operator chose. It stays.
          ignoreErrorCodesMatching: 'ParameterAlreadyExists',
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ssm:PutParameter'],
            resources: [`arn:aws:ssm:${props.region}:${props.account}:parameter${pointer}`],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      // The body before the pointer, so a pointer never names an object that is not there.
      activate.node.addDependency(body);
    }
  }
}
