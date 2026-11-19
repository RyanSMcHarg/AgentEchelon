/**
 * A FUNCTION'S ENVIRONMENT, MEASURED THE WAY AWS LAMBDA MEASURES IT, FROM A SYNTHESIZED TEMPLATE.
 *
 * Lambda refuses a function whose environment exceeds 4 KB, measured over the variables as JSON
 * (`JSON.stringify(Variables)`, in UTF-8 bytes), and CloudFormation reports it only at deploy. A template
 * holds tokens where the deployed values go, so each token is replaced by a stand-in as long as the
 * longest value it realistically deploys as, which keeps the measurement at or above the deployed size:
 *
 *  - an ARN (`Fn::GetAtt [<resource>, Arn]`, or a `Ref`, import or SSM parameter whose name says `arn`) is a
 *    full-length ARN of its service with a 64-character resource name, in the `aws` partition and a
 *    14-character region (a Lambda function ARN is 116 characters, an IAM role ARN 95);
 *  - any other token (a table, bucket or function name, a pool id) is a 64-character name, the longest
 *    name CloudFormation generates for a Lambda function and longer than it generates for a table;
 *  - `Fn::Join` and `Fn::Sub` render their literal text with each token in them replaced the same way;
 *  - the account is 12 digits, the region 14 characters (`ap-southeast-4`, the longest in use) and the
 *    partition `aws`.
 */

type Resource = { Type?: string; Properties?: Record<string, unknown> };
export type EnvTemplate = { Resources?: Record<string, Resource> };

const ACCOUNT = '123456789012';
/** The longest commercial region name in use (`ap-southeast-4` is 14), so a region never undercounts. */
const REGION = 'ap-southeast-4';
const PARTITION = 'aws';
const NAME = 'n'.repeat(64);

/** A full-length ARN for one resource type, with a 64-character name. */
function arnFor(type: string | undefined): string {
  const name = NAME;
  switch (type) {
    case 'AWS::IAM::Role':
      return `arn:${PARTITION}:iam::${ACCOUNT}:role/${name}`;
    case 'AWS::DynamoDB::Table':
      return `arn:${PARTITION}:dynamodb:${REGION}:${ACCOUNT}:table/${name}`;
    case 'AWS::SQS::Queue':
      return `arn:${PARTITION}:sqs:${REGION}:${ACCOUNT}:${name}`;
    case 'AWS::SNS::Topic':
      return `arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${name}`;
    case 'AWS::S3::Bucket':
      return `arn:${PARTITION}:s3:::${name}`;
    default:
      // A Lambda function ARN: the longest ordinary ARN the platform passes in an environment.
      return `arn:${PARTITION}:lambda:${REGION}:${ACCOUNT}:function:${name}`;
  }
}

const saysArn = (s: string): boolean => /arn/i.test(s);

/** The longest string a CloudFormation value realistically deploys as, in one template. */
export function deployedValue(v: unknown, template: EnvTemplate): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return NAME;
  const o = v as Record<string, unknown>;
  const resources = template.Resources ?? {};

  if ('Ref' in o) {
    const ref = String(o.Ref);
    if (ref === 'AWS::AccountId') return ACCOUNT;
    if (ref === 'AWS::Region') return REGION;
    if (ref === 'AWS::Partition') return PARTITION;
    if (ref === 'AWS::URLSuffix') return 'amazonaws.com.cn';
    const target = resources[ref];
    // An SSM parameter value is a template parameter, not a resource: its name is the parameter's.
    return saysArn(ref) ? arnFor(target?.Type) : NAME;
  }
  if ('Fn::GetAtt' in o) {
    const [logicalId, attr] = (Array.isArray(o['Fn::GetAtt']) ? o['Fn::GetAtt'] : String(o['Fn::GetAtt']).split('.')) as [string, string];
    return /arn/i.test(String(attr)) ? arnFor(resources[logicalId]?.Type) : NAME;
  }
  if ('Fn::ImportValue' in o) {
    const exportName = JSON.stringify(o['Fn::ImportValue']);
    return saysArn(exportName.replace(/ExportsOutput(Ref|FnGetAtt)/g, '')) ? arnFor(undefined) : NAME;
  }
  if ('Fn::Join' in o) {
    const [sep, parts] = o['Fn::Join'] as [string, unknown];
    return Array.isArray(parts) ? parts.map((p) => deployedValue(p, template)).join(sep) : NAME;
  }
  if ('Fn::Sub' in o) {
    const arg = o['Fn::Sub'];
    const [body, vars] = Array.isArray(arg) ? (arg as [string, Record<string, unknown>]) : [String(arg), {} as Record<string, unknown>];
    return body.replace(/\$\{([^}!][^}]*)\}/g, (_m, key: string) => {
      if (key in vars) return deployedValue(vars[key], template);
      if (key.includes('.')) return deployedValue({ 'Fn::GetAtt': key.split('.') }, template);
      return deployedValue({ Ref: key }, template);
    });
  }
  // Fn::Select, Fn::If and the rest: a name-length stand-in.
  return NAME;
}

export interface EnvSize { logicalId: string; bytes: number; largest: Array<[string, number]> }

/** Every `AWS::Lambda::Function` in a template with its environment's size as Lambda measures it. */
export function environmentSizes(template: EnvTemplate): EnvSize[] {
  const out: EnvSize[] = [];
  for (const [logicalId, r] of Object.entries(template.Resources ?? {})) {
    if (r.Type !== 'AWS::Lambda::Function') continue;
    const vars = ((r.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables) ?? {};
    const deployed: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) deployed[k] = deployedValue(v, template);
    const bytes = Buffer.byteLength(JSON.stringify(deployed), 'utf8');
    const largest = Object.entries(deployed)
      .map(([k, v]): [string, number] => [k, Buffer.byteLength(JSON.stringify({ [k]: v }), 'utf8') - 2])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    out.push({ logicalId, bytes, largest });
  }
  return out;
}
