import { driftTopicLabel } from '../../lambda/src/lib/live-drift-flow';

describe('driftTopicLabel', () => {
  it('strips a conversational preamble so the label is the SUBJECT', () => {
    // The label titles a conversation in the sidebar. Repeating the whole request back ("let's start a new
    // conversation about X") makes every drift conversation read like an instruction rather than a topic.
    expect(driftTopicLabel("let's start a new conversation about quarterly revenue forecasting"))
      .toBe('quarterly revenue forecasting');
    expect(driftTopicLabel('can we talk about CI costs')).toBe('CI costs');
    expect(driftTopicLabel("I'd like to discuss the Q3 roadmap")).toBe('the Q3 roadmap');
  });

  it('keeps a message that has no preamble intact', () => {
    expect(driftTopicLabel('CI costs doubled last month')).toBe('CI costs doubled last month');
  });

  it('truncates on a WORD boundary, never mid-word', () => {
    // A label cut mid-word ("…revenue forecasti") reads as a bug to anyone who sees it.
    const label = driftTopicLabel(`${'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(2)}`);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label).not.toMatch(/\s$/);
    expect(label.endsWith('foxtrot') || /\b\w+$/.test(label)).toBe(true);
    // Every word in the label must be a whole word from the input.
    const words = new Set('alpha bravo charlie delta echo foxtrot golf hotel india juliet'.split(' '));
    label.split(' ').forEach((w) => expect(words.has(w)).toBe(true));
  });

  it('takes only the first clause', () => {
    expect(driftTopicLabel('CI costs. Also the roadmap. And hiring.')).toBe('CI costs');
  });

  it('falls back to the old label when there is nothing to derive from', () => {
    expect(driftTopicLabel('')).toBe('Drift Follow-up');
    expect(driftTopicLabel(undefined)).toBe('Drift Follow-up');
    expect(driftTopicLabel('   ')).toBe('Drift Follow-up');
  });
});
