/**
 * MOVE THE `active` LABEL ONTO A VERSION OF A PARAMETER.
 *
 * SSM reads after a write are eventually consistent: a `LabelParameterVersion` sent milliseconds after the
 * `PutParameter` that created the version can be answered `ParameterVersionNotFound` for a version that exists. It was,
 * 52 ms after the write, on an activation that then reported a 500 with the version stored and unlabeled. And a label
 * landing seconds after another write to the parameter is answered `TooManyUpdates`, which means the label did not move.
 * Both answers are retried with a short backoff, safely, because moving a label again is the same move; every other
 * error, and either answer once the pauses are used up, is thrown.
 */
import { LabelParameterVersionCommand, type SSMClient } from '@aws-sdk/client-ssm';

const DELAYS_MS = [100, 250, 500, 1000, 2000];
const RETRIED = new Set(['ParameterVersionNotFound', 'TooManyUpdates']);

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function labelJustWrittenVersion(
  ssm: Pick<SSMClient, 'send'>,
  name: string,
  version: number,
  label: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await ssm.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: version, Labels: [label] }));
      return;
    } catch (err) {
      if (!RETRIED.has(String((err as { name?: string })?.name)) || i >= DELAYS_MS.length) throw err;
      await sleep(DELAYS_MS[i]);
    }
  }
}
