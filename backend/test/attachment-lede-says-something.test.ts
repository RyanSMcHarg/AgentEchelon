/**
 * The text beside a delivered file is the first paragraph that says something.
 *
 * A report that opens with a thematic break (`---`) made that rule the whole lede, so the delivery
 * message rendered as a bare horizontal line beside the file and read as an empty reply.
 */
import { buildAttachmentLede } from '../lambda/src/lib/async-processor-core';

describe('buildAttachmentLede', () => {
  it('skips a leading thematic break and takes the heading that follows', () => {
    const report = '---\n\n# Q2 ARR Performance Report\n\n**Prepared for:** Leadership Team\n\n---\n\nBody.';
    expect(buildAttachmentLede(report)).toBe('# Q2 ARR Performance Report');
  });

  it('drops a rule that shares a paragraph with text', () => {
    expect(buildAttachmentLede('***\n## Summary\n\nMore.')).toBe('## Summary');
  });

  it('keeps an ordinary first paragraph unchanged', () => {
    expect(buildAttachmentLede('Here is the summary.\n\nDetail.')).toBe('Here is the summary.');
  });

  it('does not treat a bullet or a short dash run as a rule', () => {
    expect(buildAttachmentLede('- first point\n- second point\n\nMore.')).toBe('- first point\n- second point');
    expect(buildAttachmentLede('-- note\n\nMore.')).toBe('-- note');
  });

  it('still bounds a long lede', () => {
    const lede = buildAttachmentLede(`---\n\n${'word '.repeat(200)}`);
    expect(lede.length).toBeLessThanOrEqual(404);
    expect(lede.endsWith('...')).toBe(true);
  });
});
