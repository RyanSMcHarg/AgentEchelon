/**
 * AN ASSISTANT'S SESSION IS NARROWED TO WHAT ITS DEFINITION DECLARES (tenet D4).
 *
 * The vend passes session policies chosen from the assistant's approved definition
 * (`lambda/src/lib/assistant-grant.ts`). A session's permission is the acting role, its boundary and
 * those policies together, so what an assistant reaches is bounded by the UNION of the policies it was
 * handed. The acting role and boundary are already deny-tested (`assistant-classification-boundary`,
 * `an-assistant-boundary-refuses-cloudwatch`, `a-classification-is-denied-a-model-it-does-not-declare`);
 * this tests the other operand against the deployed policies:
 *
 * - `base` alone reaches no model, no company context, no platform knowledge and no telemetry, and
 *   still reaches the conversation;
 * - each edge adds exactly its own family: `context` the company context, a `models-{key}` edge that
 *   model and no other.
 *
 * Unit tests pin which edges a definition selects (`an-assistant-reaches-only-what-it-declares`,
 * `a-turn-acts-as-the-assistant-it-was-routed-to`).
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { CLASSIFICATIONS, NO_AWS_REASON, STACK_PREFIX, awsReachable, awsJson, awsOrNull } from './helpers/assistant-acting-role';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

guardBackendErrors('an-assistant-session-is-narrowed');

/** The deployed document of one grant policy, or null when the policy does not exist here. */
function grantDocument(classification: string, edge: string): any | null {
  const account = awsJson('sts get-caller-identity --query Account');
  const arn = `arn:aws:iam::${account}:policy/${STACK_PREFIX}AssistantGrant-${classification}-${edge}`;
  const version = awsOrNull(`iam get-policy --policy-arn ${arn} --query Policy.DefaultVersionId`);
  if (typeof version !== 'string') return null;
  const doc = awsJson(`iam get-policy-version --policy-arn ${arn} --version-id ${version} --query PolicyVersion.Document`);
  return typeof doc === 'string' ? JSON.parse(decodeURIComponent(doc)) : doc;
}

/** AWS's decision for the UNION of these session policies, one action on one resource. */
function decideUnion(docs: any[], action: string, resource: string): string {
  // THROUGH --cli-input-json, with each policy as a STRING. Handed to --policy-input-list as a file, the
  // CLI parses the JSON and sends IAM an object, which it rejects as invalid content.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-'));
  const input = path.join(dir, 'simulate.json');
  fs.writeFileSync(input, JSON.stringify({
    PolicyInputList: docs.map((d) => JSON.stringify(d)),
    ActionNames: [action],
    ResourceArns: [resource],
  }));
  const res = awsJson(
    `iam simulate-custom-policy --cli-input-json file://${input.replace(/\\/g, '/')} `
    + '--query "EvaluationResults[0].EvalDecision"',
  );
  if (typeof res !== 'string') throw new Error(`simulate-custom-policy returned no decision for ${action}`);
  return res;
}

const firstResource = (doc: any): string => {
  const s = ([] as any[]).concat(doc.Statement).find((x) => x.Resource);
  return ([] as string[]).concat(s.Resource)[0];
};

test.describe('an assistant session is narrowed to its definition', () => {
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('base reaches no model and no narrowed data; each edge adds exactly its own family', async () => {
    test.setTimeout(300_000);
    const violations: string[] = [];
    let checked = 0;
    for (const c of CLASSIFICATIONS) {
      const base = grantDocument(c, 'base');
      if (!base) { console.log(`[narrowing] ${c}: no grant catalog deployed`); continue; }
      checked += 1;
      const context = grantDocument(c, 'context');
      const haiku = grantDocument(c, 'models-haiku');
      const contextObject = 'arn:aws:s3:::any-bucket/context/basic/doc.md';
      const attachmentObject = 'arn:aws:s3:::any-bucket/attachments/a.pdf';

      if (decideUnion([base], 'bedrock:InvokeModel', 'arn:aws:bedrock:us-east-1::foundation-model/any') === 'allowed') violations.push(`${c}: base alone may invoke a model`);
      if (decideUnion([base], 's3:GetObject', contextObject) === 'allowed') violations.push(`${c}: base alone may read company context`);
      if (decideUnion([base], 'cloudwatch:GetMetricData', '*') === 'allowed') violations.push(`${c}: base alone may read telemetry`);
      // Positive controls: base is not a policy that denies everything.
      if (decideUnion([base], 's3:GetObject', attachmentObject) !== 'allowed') violations.push(`${c}: base cannot read an attachment`);
      if (decideUnion([base], 'chime:SendChannelMessage', 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c') !== 'allowed') violations.push(`${c}: base cannot speak in a conversation`);

      if (context && decideUnion([base, context], 's3:GetObject', contextObject) !== 'allowed') violations.push(`${c}: the context edge does not add company context`);
      if (haiku) {
        if (decideUnion([base, haiku], 'bedrock:InvokeModel', firstResource(haiku)) !== 'allowed') violations.push(`${c}: models-haiku does not add Haiku`);
        const other = grantDocument(c, 'models-sonnet') || grantDocument(c, 'models-titan');
        if (other && decideUnion([base, haiku], 'bedrock:InvokeModel', firstResource(other)) === 'allowed') violations.push(`${c}: models-haiku reaches another model`);
      }
      console.log(`[narrowing] ${c}: base and edges checked`);
    }
    expect(checked, 'no classification has a grant catalog deployed').toBeGreaterThan(0);
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});
