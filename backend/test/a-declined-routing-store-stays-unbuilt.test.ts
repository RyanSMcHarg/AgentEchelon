/**
 * ADR-044 IS DECLINED, SO ITS STORE DOES NOT EXIST.
 *
 * The flow reads the live roster on every message. A stored "larger than a one-to-one" bit would be a
 * second source for who is in the room, and the decline says the ~32 ms it saves does not pay for that.
 * A store nothing reads still costs a writer, an IAM grant and a table key, and reads to a reviewer as
 * a decision that went the other way. This keeps it gone.
 */
import * as fs from 'fs';
import * as path from 'path';

const backend = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(backend, rel), 'utf8');

describe('the declined routing store stays unbuilt (ADR-044)', () => {
  it('has no store module and no writer', () => {
    expect(fs.existsSync(path.join(backend, 'lambda/src/lib/routing-context.ts'))).toBe(false);
    expect(fs.existsSync(path.join(backend, 'lambda/src/lib/refresh-routing-context.ts'))).toBe(false);
  });

  it('post-processing runs no membership rule and holds no admin bearer for one', () => {
    expect(read('lambda/src/message-post-processing.ts')).not.toMatch(/refreshRoutingContext|routing-context/);
    const stack = read('lib/stacks/post-processing-stack.ts');
    expect(stack).not.toMatch(/AdminBearerRead/);
    expect(stack).not.toMatch(/ADMIN_ARN_PARAM/);
  });

  it('the flow reads the live roster', () => {
    expect(read('lambda/src/channel-flow-processor.ts')).toMatch(/resolveChannelSize\(/);
  });
});
