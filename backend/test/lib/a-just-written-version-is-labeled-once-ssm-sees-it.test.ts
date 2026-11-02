/**
 * A JUST-WRITTEN VERSION IS LABELED ONCE SSM SEES IT (`lib/label-active.ts`).
 *
 * SSM can answer `ParameterVersionNotFound` for a version written milliseconds before. Measured on dev on 2026-10-31: an
 * activation wrote version 37 of an assistant's definition and labeled it 52 ms later, was refused, and reported a 500
 * with the version stored and unlabeled. The label is retried on that one answer only; any other error is thrown at once,
 * and a version still missing after the retries is thrown too.
 */
import { LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { labelJustWrittenVersion } from '../../lambda/src/lib/label-active';
import * as fs from 'fs';
import * as path from 'path';

const notFound = () => Object.assign(new Error('could not find version'), { name: 'ParameterVersionNotFound' });
const noSleep = async () => undefined;

describe('labeling a version just written', () => {
  it('retries while SSM does not see the version yet, then labels it', async () => {
    const send = jest.fn().mockRejectedValueOnce(notFound()).mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});
    await labelJustWrittenVersion({ send } as never, '/x/definition', 37, 'active', noSleep);
    expect(send).toHaveBeenCalledTimes(3);
    const cmd = send.mock.calls[2][0] as LabelParameterVersionCommand;
    expect(cmd.input).toEqual({ Name: '/x/definition', ParameterVersion: 37, Labels: ['active'] });
  });

  it('throws any other error at once, and a version still missing after the retries', async () => {
    const denied = jest.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'AccessDeniedException' }));
    await expect(labelJustWrittenVersion({ send: denied } as never, '/x', 1, 'active', noSleep)).rejects.toThrow('no');
    expect(denied).toHaveBeenCalledTimes(1);
    const missing = jest.fn().mockRejectedValue(notFound());
    await expect(labelJustWrittenVersion({ send: missing } as never, '/x', 1, 'active', noSleep)).rejects.toThrow('could not find');
    expect(missing).toHaveBeenCalledTimes(6);
  });

  it('every label that follows a write goes through it', () => {
    for (const rel of ['lib/profile-lifecycle.ts', 'lib/seed-profile-definitions.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');
      expect(src).not.toMatch(/putDefinition\(ssm, name, def\);\n\s*await ssm\.send\(new LabelParameterVersionCommand/);
      expect(src).toContain('labelJustWrittenVersion(');
    }
  });
});
