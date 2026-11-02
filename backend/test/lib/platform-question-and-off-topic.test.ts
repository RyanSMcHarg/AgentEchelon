/**
 * PLATFORM QUESTIONS AND OFF-TOPIC REQUESTS ARE NAMED, NOT LEFT IN `general`.
 *
 * "What is AgentEchelon?" was classified `general`: every welcome invited it and every assistant had the
 * tool, but no intent named it, so it was uncounted and judged against an offer list that did not mention
 * it. And a request unrelated to anything offered was also `general`, declined only if the model chose to.
 *
 *   - `platform_question` is a platform intent each pack declares at its own depth: basic explains and
 *     stops, the internal classifications give examples and architecture.
 *   - `off_topic` is a label every assistant has; the turn is told to decline, not left to judgment.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_INTENT_PACK, UNIVERSAL_INTENT_KEYS } from '../../lambda/src/lib/intent-pack';
import { intentAnswerPrompt } from '../../lambda/src/lib/intent-answer';
import { stratumIntentPack } from '../../demo/intent-packs';

const platformQuestionIn = (tier: 'basic' | 'standard' | 'premium') =>
  stratumIntentPack(tier).intents.find((d) => (d as { key: string }).key === 'platform_question') as
    { instructions?: string; tools?: string[]; summary?: string } | undefined;

describe('platform questions', () => {
  it('are a platform intent, so a pack that does not declare one refuses it', () => {
    expect(DEFAULT_INTENT_PACK.intents.map((d) => d.key)).toContain('platform_question');
    expect(UNIVERSAL_INTENT_KEYS as readonly string[]).not.toContain('platform_question');
  });

  it('every Stratum classification declares it, answered from the platform information', () => {
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      expect(platformQuestionIn(tier)?.tools).toEqual(['load_platform_info']);
    }
  });

  it('basic explains and stops: no recommendations, configuration, code or architecture', () => {
    const basic = platformQuestionIn('basic')!.instructions!.toLowerCase();
    expect(basic).toMatch(/recommend nothing/);
    expect(basic).toMatch(/never name internal components/);
    expect(basic).toMatch(/never explain how to configure, customize, deploy or build anything, even when asked how/);
    expect(basic).toMatch(/internal conversation covers/);
  });

  it('the internal classifications give examples and architecture', () => {
    for (const tier of ['standard', 'premium'] as const) {
      const how = platformQuestionIn(tier)!.instructions!.toLowerCase();
      expect(how).toMatch(/code examples/);
      expect(how).toMatch(/architecture/);
    }
  });

  it('the turn is told it is offered, so the platform answer is not declined as off topic', () => {
    const prompt = intentAnswerPrompt('platform_question', stratumIntentPack('premium') as never);
    expect(prompt).toMatch(/You offer this, so answer it/);
  });
});

describe('off-topic requests', () => {
  it('are a label every assistant has, recognized by the classifier', () => {
    expect(UNIVERSAL_INTENT_KEYS as readonly string[]).toContain('off_topic');
    const classifier = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/intent-classifier.ts'), 'utf8');
    expect(classifier).toMatch(/- OFF_TOPIC: /);
    expect(classifier).toMatch(/key === 'off_topic'/);
  });

  it('a turn classified off topic is told to decline, not left to the model to judge', () => {
    const prompt = intentAnswerPrompt('off_topic', stratumIntentPack('premium') as never);
    expect(prompt).toMatch(/THIS REQUEST IS OFF TOPIC/);
    expect(prompt).toMatch(/Do not answer it/);
    expect(intentAnswerPrompt('general', stratumIntentPack('premium') as never)).not.toMatch(/THIS REQUEST IS OFF TOPIC/);
  });
});

describe('every reply is the answer, not an account of getting it', () => {
  it('every turn is told to begin with the answer rather than narrate its tool use', () => {
    for (const intent of ['platform_question', 'general', 'off_topic']) {
      expect(intentAnswerPrompt(intent, stratumIntentPack('premium') as never)).toContain('## YOUR REPLY');
    }
    expect(intentAnswerPrompt('general', { intents: [] } as never)).toMatch(/begin with the answer/);
  });
});
