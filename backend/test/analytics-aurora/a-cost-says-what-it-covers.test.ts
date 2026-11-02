/**
 * A COST NUMBER SAYS WHAT IT COVERS, AND PRICES EVERY MODEL AT ITS OWN RATE.
 *
 * Two defects in one column, both reported as the figure being untrustworthy.
 *
 * ── ONE: IT PRICED EVERY REPLY AT THE COMMONEST MODEL'S RATE ────────────────────────────────────
 *
 * `cost_per_reply_usd` took the intent's AVERAGE tokens and priced them at `dominant_model`, which is
 * a MODE. That is exact where an intent is served by one model and silently wrong where it is not,
 * with nothing telling a reader which case they were in. Measured live: the general intent ran 57
 * replies on Haiku, 30 on Sonnet and 170 on Opus, so a 62% majority priced all 257 - including the
 * Haiku turns, which cost about a hundredth as much. The intent read about 40% high.
 *
 * ── TWO: IT WAS CALLED "COST", AND IT IS NOT THE COST ───────────────────────────────────────────
 *
 * It is the ANSWER's model inference. It excludes the intent classifier (a model call on most turns,
 * measured and then only logged), guardrail evaluations, the embeddings drift detection takes per
 * message, the scheduled summariser, the evaluation judge that scores these very rows, and every
 * piece of infrastructure. A reader doing cost work off a number labelled "Cost/reply" would be
 * wrong by an amount nothing on the surface disclosed.
 *
 * What it DOES cover fully is the tool loop: tokens accumulate across every Converse call the answer
 * made, so a multi-step answer is not undercounted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveReplyCostUsd, resolveCostPricedReplies } from '../../lambda/src/analytics-aurora/analytics-query';

const CONSOLE_TAB = path.join(
  __dirname, '..', '..', '..', 'frontend', 'packages', 'admin', 'src', 'components', 'admin',
  'EffectivenessTab.tsx',
);
const tab = fs.readFileSync(CONSOLE_TAB, 'utf8');
/**
 * Copy moved to the shared locale file; CODE assertions still read `tab`. The two are kept separate so a
 * future reader can see which half of this file is about words and which is about behavior.
 */
const consoleCopy = (): string => JSON.stringify(JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../frontend/packages/shared/src/locales/en.json'), 'utf8'),
).admin);

/**
 * One Effectiveness column's visible label, by the key the TSX asks for.
 *
 * Throws rather than returning undefined when the key is absent: a missing key would make an assertion about
 * the label pass against `undefined`, which is the vacuous-guard shape this suite exists to avoid.
 */
const localeLabel = (column: string): string => {
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../../frontend/packages/shared/src/locales/en.json'), 'utf8'),
  );
  const label = en?.admin?.effectiveness?.column?.[column]?.label;
  if (typeof label !== 'string') {
    throw new Error(`admin.effectiveness.column.${column}.label is missing from en.json`);
  }
  return label;
};

/**
 * Published per-1k rates the table prices with, restated so the arithmetic below is checkable.
 *
 * THE IDS ARE THE INFERENCE-PROFILE ONES, which is what the live rows carry and what the rate table's
 * reverse map is keyed on. A bare "anthropic.claude-opus-..." prices as NULL, and the first version of
 * this file used those - so every arithmetic case returned null and the unpriceable-slice case below
 * passed for the wrong reason. A vacuous pass on the honesty test is the one failure that matters most
 * here.
 */
const HAIKU = { in: 0.00025, out: 0.00125 };
const OPUS = { in: 0.015, out: 0.075 };

describe('a mixed intent is priced slice by slice', () => {
  it('blends two models instead of charging both at the commoner one', () => {
    // 100 Haiku replies at 1k in / 1k out, and 100 Opus replies at the same shape.
    const cost = resolveReplyCostUsd({
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [
        { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', replies: 100, tokensIn: 100_000, tokensOut: 100_000 },
        { model: 'us.anthropic.claude-opus-4-6-v1', replies: 100, tokensIn: 100_000, tokensOut: 100_000 },
      ],
    });
    const haikuTotal = 100 * (HAIKU.in + HAIKU.out);
    const opusTotal = 100 * (OPUS.in + OPUS.out);
    expect(cost).toBeCloseTo((haikuTotal + opusTotal) / 200, 6);

    // And it is NOT the mode's price applied to the average, which is what it used to be.
    const asIfAllOpus = OPUS.in + OPUS.out;
    expect(cost).toBeLessThan(asIfAllOpus);
  });

  it('weights by replies, so a rare expensive model does not dominate a cheap intent', () => {
    // 990 Haiku against 10 Opus. The mode is Haiku either way; the point is the Opus turns are
    // counted at Opus rates rather than at Haiku's.
    const cost = resolveReplyCostUsd({
      dominant_model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      model_mix: [
        { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', replies: 990, tokensIn: 990_000, tokensOut: 990_000 },
        { model: 'us.anthropic.claude-opus-4-6-v1', replies: 10, tokensIn: 10_000, tokensOut: 10_000 },
      ],
    });
    const perHaiku = HAIKU.in + HAIKU.out;
    expect(cost).toBeGreaterThan(perHaiku); // the Opus turns cost more than Haiku's rate
    expect(cost).toBeLessThan(OPUS.in + OPUS.out);
  });

  it('prices the slices it can and reports the denominator, rather than blanking the intent', () => {
    // THE FIRST VERSION OF THIS CHANGE RETURNED NULL for the whole intent if any slice was unpriceable.
    // Defensible - better than costing part of an intent as the whole - but measured live it blanked
    // report_generation entirely because ONE turn ran a model the rate table had no entry for,
    // taking 39 priceable replies with it. Skipping the slice and publishing the denominator is honest
    // and useful at once, which is what every other rate on this surface does.
    const row = {
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [
        { model: 'us.anthropic.claude-opus-4-6-v1', replies: 10, tokensIn: 10_000, tokensOut: 10_000 },
        { model: 'some.model.this.build.has.never.heard.of', replies: 1, tokensIn: 5_000, tokensOut: 300 },
      ],
    };
    const cost = resolveReplyCostUsd(row);
    const priced = resolveCostPricedReplies(row);
    // Only the Opus slice priced, so the rate is over 10 replies and says so.
    expect(priced).toBe(10);
    expect(cost).toBeCloseTo(10 * (OPUS.in + OPUS.out) / 10, 6);
  });

  it('returns NULL only when NOTHING in the mix can be priced', () => {
    const row = {
      dominant_model: 'some.model.this.build.has.never.heard.of',
      model_mix: [{ model: 'some.model.this.build.has.never.heard.of', replies: 5, tokensIn: 5_000, tokensOut: 500 }],
    };
    expect(resolveReplyCostUsd(row)).toBeNull();
    expect(resolveCostPricedReplies(row)).toBe(0);
  });

  it('keeps the per-image path for an image intent, which reports no tokens at all', () => {
    // An image model prices PER IMAGE and reports zero tokens, so the token blend would price every
    // slice at null and blank the column. The blend is skipped entirely when the dominant model is an
    // image model - a regression the first version of this change introduced and live data caught.
    const cost = resolveReplyCostUsd({
      dominant_model: 'stability.stable-image-core-v1:1',
      avg_image_count: 1,
      model_mix: [{ model: 'stability.stable-image-core-v1:1', replies: 1, tokensIn: null, tokensOut: null }],
    });
    // Whatever the rate table says for this image model, it must not be the token path's null-by-blend.
    const viaImagePath = resolveReplyCostUsd({
      dominant_model: 'stability.stable-image-core-v1:1',
      avg_image_count: 1,
    });
    expect(cost).toEqual(viaImagePath);
  });

  it('falls back to the old shape for a deployment whose query predates the mix', () => {
    // No model_mix on the row: price the average at the dominant model, as before. A deployment that
    // has not shipped the new query must still get a number rather than a blank column.
    const cost = resolveReplyCostUsd({
      dominant_model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      avg_input_tokens: 1000,
      avg_output_tokens: 1000,
    });
    expect(cost).toBeCloseTo(HAIKU.in + HAIKU.out, 6);
  });
});

describe('the console says what the number is not', () => {
  it('does not call it "Cost/reply" flat, which reads as the whole cost', () => {
    /**
     * READ FROM THE LOCALE FILE, not from the TSX.
     *
     * This asserted `hdr('Model cost/reply'` in the source, which stopped being true when the column headers
     * moved into `en.json`: `hdr` now takes the column key and resolves both the label and its tooltip. The
     * CLAIM is unchanged and is the one that matters - the word "Model" is what stops a reader taking this
     * figure for the whole cost - so it is asserted where the word now lives.
     */
    const label = localeLabel('costPerReply');
    expect(label).not.toBe('Cost/reply');
    expect(label).toMatch(/^Model /);
  });

  it('names the biggest excluded model call, the classifier', () => {
    // It runs on most turns and is the one exclusion a reader would most reasonably assume included.
    expect(consoleCopy()).toMatch(/classifier/i);
  });

  it('states plainly that the real cost is higher and unquantified here', () => {
    // The honest form. "An estimate" implies imprecision in the same quantity, not a different and
    // smaller quantity, which is what this actually is.
    //
    // BOTH HALVES, AND NOT ONE SENTENCE. This asserted the exact phrase "higher than this number",
    // which pinned a wording rather than the claim: the copy moved into the column tooltip and the
    // card, the sentence was reworded, and the guard failed on a surface where the claim had in fact
    // been strengthened from one place to three. A single-phrase match is a guard against editing,
    // not against dishonesty.
    //
    // So both halves are required, because either alone is misreadable: "higher" without the
    // unquantified half invites a reader to assume the gap is small, and "does not measure" without
    // the direction does not say WHICH way the number is wrong.
    // KEPT STRICT, AND THE COPY FIXED INSTEAD. The first response to this failing was to widen the
    // pattern to `/higher|costs more/`, on the reasoning that the claim mattered and the wording did
    // not. That was wrong about the facts: neither phrase was in the copy at all. Shortening this
    // tooltip had dropped the direction-and-magnitude claim outright, which is exactly the misreading
    // the comment above describes - so the guard stands and the sentence came back.
    expect(consoleCopy()).toMatch(/\bhigher\b/i);
    expect(consoleCopy()).toMatch(/does not (yet )?measure/i);
    // And it is not a charge, said in those terms rather than implied by the two above.
    expect(consoleCopy()).toMatch(/not your bill|never as a charge/i);
  });

  it('says the tool loop IS fully counted, so the exclusions are not read as everything', () => {
    // Without this a reader could conclude a multi-step answer is undercounted too. It is not:
    // tokens accumulate across every Converse call in the loop.
    expect(consoleCopy()).toMatch(/every Converse call/i);
  });
});

/**
 * A MODEL THE DEPLOYMENT RAN IS PRICEABLE, EVEN ONCE THE CATALOG MOVES ON.
 *
 * The reverse map is built from the live catalog, so a retired model resolves to no key and prices as
 * null. Correct for a model nobody can identify; wrong for one whose rate is well known and which is
 * sitting in the history being priced.
 *
 * Found on the surface it hurt most: every experiment CONTROL arm read cost = null, because the
 * controls ran claude-3-haiku while the catalog has moved to Haiku 4.5. An operator comparing arms on
 * cost had a figure for one side and a blank for the other - on the view whose whole job is that
 * comparison.
 */
describe('a retired model still prices', () => {
  it('prices claude-3-haiku at the haiku family rate', () => {
    const cost = resolveReplyCostUsd({
      dominant_model: 'anthropic.claude-3-haiku-20240307-v1:0',
      avg_input_tokens: 1000,
      avg_output_tokens: 1000,
    });
    expect(cost).toBeCloseTo(HAIKU.in + HAIKU.out, 6);
  });

  it('prices it through an inference-profile id too', () => {
    const cost = resolveReplyCostUsd({
      dominant_model: 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-3-haiku-20240307-v1:0',
      avg_input_tokens: 1000,
      avg_output_tokens: 1000,
    });
    expect(cost).toBeCloseTo(HAIKU.in + HAIKU.out, 6);
  });

  it('still refuses a model nobody can identify', () => {
    // The honesty contract has to survive the exception: a retired model is one whose rate we KNOW,
    // not a licence to guess at an unrecognised id.
    expect(resolveReplyCostUsd({
      dominant_model: 'some.model.this.build.has.never.heard.of',
      avg_input_tokens: 1000,
      avg_output_tokens: 1000,
    })).toBeNull();
  });
});

/**
 * THE CLASSIFIER IS SPEND, AND IT WAS MEASURED AND THROWN AWAY.
 *
 * Most turns pay a model to decide where they are going before anything answers. `intent-classifier`
 * captured those tokens from the day it was written; the router read them and wrote them to a
 * console.log and nowhere else. So the cost column covered the ANSWER and could not have covered
 * more - and an operator comparing two intents was comparing their answers while the cheaper-to-answer
 * one might be paying more to route.
 *
 * Migration 063 stores the tokens AND the model, because the classifier is per-profile configurable:
 * two deployments with identical counts can pay ten times differently, so a count without its model is
 * an input to a cost rather than a cost.
 */
describe('the classifier leg is priced beside the answer leg', () => {
  it('adds both legs to the spend', () => {
    // 100 replies: classified on Haiku, answered on Opus. Both are real Bedrock calls.
    const row = {
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [
        { model: 'us.anthropic.claude-opus-4-6-v1', leg: 'answer', replies: 100, tokensIn: 100_000, tokensOut: 100_000 },
        { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', leg: 'classifier', replies: 100, tokensIn: 50_000, tokensOut: 5_000 },
      ],
    };
    const answer = 100 * (OPUS.in + OPUS.out);
    const classifier = 50 * HAIKU.in + 5 * HAIKU.out;
    expect(resolveReplyCostUsd(row)).toBeCloseTo((answer + classifier) / 100, 8);
  });

  it('counts ONE reply per turn, not one per model call', () => {
    // The denominator must be the answer legs alone. Summing both would halve the rate on every turn
    // that classified, which is most of them.
    const row = {
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [
        { model: 'us.anthropic.claude-opus-4-6-v1', leg: 'answer', replies: 100, tokensIn: 100_000, tokensOut: 100_000 },
        { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', leg: 'classifier', replies: 100, tokensIn: 50_000, tokensOut: 5_000 },
      ],
    };
    expect(resolveCostPricedReplies(row)).toBe(100);
  });

  it('is strictly more expensive than the answer alone, which is the point of storing it', () => {
    const answerOnly = resolveReplyCostUsd({
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [{ model: 'us.anthropic.claude-opus-4-6-v1', leg: 'answer', replies: 100, tokensIn: 100_000, tokensOut: 100_000 }],
    })!;
    const withClassifier = resolveReplyCostUsd({
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [
        { model: 'us.anthropic.claude-opus-4-6-v1', leg: 'answer', replies: 100, tokensIn: 100_000, tokensOut: 100_000 },
        { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', leg: 'classifier', replies: 100, tokensIn: 50_000, tokensOut: 5_000 },
      ],
    })!;
    expect(withClassifier).toBeGreaterThan(answerOnly);
  });

  it('treats a slice with no leg as an answer, so the old query shape still divides correctly', () => {
    // A deployment whose query predates 063 returns no `leg`. It must not start counting zero replies.
    const row = {
      dominant_model: 'us.anthropic.claude-opus-4-6-v1',
      model_mix: [{ model: 'us.anthropic.claude-opus-4-6-v1', replies: 10, tokensIn: 10_000, tokensOut: 10_000 }],
    };
    expect(resolveCostPricedReplies(row)).toBe(10);
    expect(resolveReplyCostUsd(row)).toBeCloseTo(OPUS.in + OPUS.out, 6);
  });
});
