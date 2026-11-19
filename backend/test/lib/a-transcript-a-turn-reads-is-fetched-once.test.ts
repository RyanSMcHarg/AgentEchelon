/**
 * A TRANSCRIPT A TURN READS AS GROUNDING IS FETCHED ONCE PER CONTAINER.
 *
 * What it proves:
 *  - a turn after the first that lists the same newest transcript reads no object again, and reads the same text;
 *  - the listing is made on every turn, so a newer transcript is read when it appears;
 *  - a read that fails is not remembered.
 */
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { latestTranscriptOf } from '../../lambda/src/lib/meeting-transcript';

process.env.PROFILE_NAME = process.env.PROFILE_NAME || 'concierge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { transcriptReader } = require('../../lambda/src/assistant-async-processor');

const CHILD = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/meet-child-1';
const keyOf = (meetingId: string) => `transcripts/premium/meet-child-1/${meetingId}.md`;
const commands = {
  list: (input: Record<string, unknown>) => new ListObjectsV2Command(input as never),
  get: (input: Record<string, unknown>) => new GetObjectCommand(input as never),
};

describe('a transcript read as grounding', () => {
  it('is fetched once, listed every turn, and a newer one is read when it appears', async () => {
    let newest = 'a1b2c3d4-0000-1111-2222-333344445555';
    const gets: string[] = [];
    const s3 = {
      send: jest.fn(async (cmd: unknown) => {
        if (cmd instanceof ListObjectsV2Command) return { Contents: [{ Key: keyOf(newest), LastModified: new Date() }] };
        const key = (cmd as GetObjectCommand).input.Key as string;
        gets.push(key);
        return { Body: { transformToString: async () => `[0:00] **Ana**: about ${key}` } };
      }),
    };
    const read = () => latestTranscriptOf(transcriptReader(s3), 'bucket', 'premium', CHILD, commands);
    const first = await read();
    expect(first).toContain('about');
    expect(await read()).toBe(first);
    expect(gets).toHaveLength(1);
    expect(s3.send.mock.calls.filter(([c]) => c instanceof ListObjectsV2Command)).toHaveLength(2);
    newest = 'b1b2c3d4-0000-1111-2222-333344445555';
    expect(await read()).not.toBe(first);
    expect(gets).toHaveLength(2);
  });

  it('a read that fails is not remembered', async () => {
    let fail = true;
    const s3 = {
      send: jest.fn(async () => {
        if (fail) throw Object.assign(new Error('slow down'), { name: 'SlowDown' });
        return { Body: { transformToString: async () => 'text' } };
      }),
    };
    const get = new GetObjectCommand({ Bucket: 'bucket', Key: keyOf('c1b2c3d4-0000-1111-2222-333344445555') });
    await expect(transcriptReader(s3).send(get)).rejects.toThrow('slow down');
    fail = false;
    const out = await transcriptReader(s3).send(get) as { Body: { transformToString(): Promise<string> } };
    expect(await out.Body.transformToString()).toBe('text');
    expect(s3.send).toHaveBeenCalledTimes(2);
  });
});
