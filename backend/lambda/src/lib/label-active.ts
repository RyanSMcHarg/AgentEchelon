/**
 * MOVE THE `active` LABEL ONTO A VERSION THIS CALLER JUST WROTE.
 *
 * SSM reads after a write are eventually consistent: a `LabelParameterVersion` sent milliseconds after the
 * `PutParameter` that created the version can be answered `ParameterVersionNotFound` for a version that exists. It was,
 * 52 ms after the write, on an activation that then reported a 500 with the version stored and unlabeled. So that one
 * answer is retried with a short backoff; every other error, and a version still missing after the retries, is thrown.
 */
import { LabelParameterVersionCommand, type SSMClient } from '@aws-sdk/client-ssm';

const DELAYS_MS = [100, 250, 500, 1000, 2000];

export async function labelJustWrittenVersion(
  ssm: Pick<SSMClient, 'send'>,
  name: string,
  version: number,
  label: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: [label] }));
      return;
    } catch (err) {
      if ((err as { name?: string })?.name !== 'ParameterVersionNotFound' || i >= DELAYS_MS.length) throw err;
      await sleep(DELAYS_MS[i]);
    }
  }
}
