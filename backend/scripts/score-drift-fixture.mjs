/**
 * score-drift-fixture.mjs - score the curated drift cases against the live comparison rule (SPEC-DRIFT-CONVERGENCE FR20).
 *
 * The fixture (`tests/e2e/fixtures/drift-detection-cases.json`) holds labeled cases: a conversation's summary and
 * subjects, and a message that should or should not draw an offer. This embeds both with the model and settings
 * drift uses (`embed-text.ts`: Titan Text Embeddings V2, 1024 dimensions, normalized) and reports, per threshold:
 *
 *   - NEAREST: the rule `detectDrift` runs, the minimum cosine distance over the summary and every subject.
 *   - SUMMARY: the summary-only comparison, for reference.
 *
 * A positive case should fire (distance above the threshold); a negative case should not. Prompt-injection cases
 * are scored elsewhere: they belong to the off-topic path, which the classifier decides, not to drift.
 *
 * Usage (AWS credentials with Bedrock access in the target region; about 500 embedding calls):
 *   AWS_PROFILE=<profile> node backend/scripts/score-drift-fixture.mjs [--region us-east-1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'tests', 'e2e', 'fixtures', 'drift-detection-cases.json');
const MODEL = 'amazon.titan-embed-text-v2:0';
const argRegion = process.argv.indexOf('--region');
const REGION = argRegion > 0 ? process.argv[argRegion + 1] : (process.env.AWS_REGION || 'us-east-1');
const THRESHOLDS = [0.35, 0.6, 0.7, 0.75, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88, 0.9];

const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
const bedrock = new BedrockRuntimeClient({ region: REGION });

const cache = new Map();
async function embed(text) {
  const key = text.trim();
  if (cache.has(key)) return cache.get(key);
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: key, dimensions: 1024, normalize: true }),
  }));
  const vector = JSON.parse(new TextDecoder().decode(res.body)).embedding;
  cache.set(key, vector);
  return vector;
}

function cosineDistance(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function score(anchorSummary, anchorTopics, message) {
  const m = await embed(message);
  const summary = await embed(anchorSummary);
  const subjects = await Promise.all((anchorTopics ?? []).filter(Boolean).map((t) => embed(t)));
  const toSummary = cosineDistance(m, summary);
  const nearest = Math.min(toSummary, ...subjects.map((s) => cosineDistance(m, s)));
  return { nearest, summary: toSummary };
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const positives = [];
for (const c of fixture.drift_positive) positives.push(await score(c.anchor_summary, c.anchor_topics, c.pivot_message));
const negatives = [];
for (const c of fixture.drift_negative) negatives.push(await score(c.anchor_summary, c.anchor_topics, c.non_pivot_message));

const rate = (xs, pred) => xs.filter(pred).length / xs.length;
const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(5);
console.log(`Scored ${positives.length} drift-positive and ${negatives.length} drift-negative cases (${MODEL}, ${REGION}).`);
console.log('A positive should fire (true positive); a negative should not (a fire is a false positive).\n');
console.log('threshold | NEAREST TP  FP | SUMMARY TP  FP');
for (const t of THRESHOLDS) {
  console.log(
    `   ${t.toFixed(2)}   |   ${pct(rate(positives, (p) => p.nearest > t))} ${pct(rate(negatives, (n) => n.nearest > t))} |`
    + `   ${pct(rate(positives, (p) => p.summary > t))} ${pct(rate(negatives, (n) => n.summary > t))}`,
  );
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\nmedian NEAREST distance: positives ${median(positives.map((p) => p.nearest)).toFixed(3)}, negatives ${median(negatives.map((n) => n.nearest)).toFixed(3)}`);
