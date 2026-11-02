/**
 * LIVE image generation-out validation — hits REAL external providers
 * (OpenAI gpt-image-1, FAL FLUX 1.1 Pro) with keys pulled from Secrets
 * Manager, exactly as the deployed processor does.
 *
 * This is the deploy-validation proof for /battle generation-out: it
 * proves the providers are genuinely reachable + return persistable
 * (base64 PNG) bytes through the real code path
 * (hydrateImageGenKeysFromSecret -> invokeExternalHttp). The mocked
 * provider tests can't prove the key is valid or the wire shape is right.
 *
 * GATED + SKIPPED BY DEFAULT — it costs ~$0.04 per image and needs AWS
 * credentials + the image-gen-keys secret. Run it during deploy validation:
 *
 *   RUN_LIVE_IMAGE_GEN=1 AWS_PROFILE=<p> AWS_REGION=us-east-1 \
 *     IMAGE_GEN_KEYS_SECRET_ARN=arn:aws:secretsmanager:...:agent-echelon/image-gen-keys-XXXX \
 *     npx jest image-gen-live
 *
 * WHAT THIS FILE COVERS, AND WHAT IT DOES NOT. Every active image model in the registry comes from a
 * third-party provider - AWS's own generators (`titan_image_g1`, `nova_canvas`) are both
 * `lifecycle: 'legacy'` and legacy-locked by AWS. But "third-party provider" and "external HTTP" are
 * two different axes, and conflating them is how this header previously claimed that generation-out
 * always runs through these two:
 *
 *   - `hosting: 'external-http'` - OpenAI gpt-image-1 and FAL FLUX 1.1 Pro. Provider's own API, key
 *     from Secrets Manager. THIS FILE.
 *   - `hosting: 'aws-bedrock'` - Stability Image Core and Ultra, `lifecycle: 'active'`, invoked
 *     through Bedrock with IAM auth and no API key. They are `region: 'us-west-2'`, which is a
 *     cross-region Bedrock call from a us-east-1 deployment, not a reason to bypass Bedrock - and it
 *     is why `ImageGuardrailStack` is instantiated per region from the registry
 *     (`bin/backend.ts`). The battle e2e drives exactly these two.
 *
 * So a us-east-1 deployment reaches Stability through Bedrock cross-region and OpenAI/FAL over
 * HTTPS. This file proves the second pair only; the first pair is covered by the battle suite.
 */

import { IMAGE_GEN_MODELS, invokeImageGenModel } from '../../lambda/src/lib/image-gen-models';

const LIVE = process.env.RUN_LIVE_IMAGE_GEN === '1';

// The processor reads only the key fields its stack names in IMAGE_GEN_KEY_FIELDS (the providers its
// classification selects). This file exercises every external-http provider, so it names each one's field,
// read from the registry, as a stack that selects them all does.
if (LIVE && !process.env.IMAGE_GEN_KEY_FIELDS) {
  process.env.IMAGE_GEN_KEY_FIELDS = [
    ...new Set(
      Object.values(IMAGE_GEN_MODELS)
        .filter((m) => m.hosting === 'external-http' && m.authEnvVar)
        .map((m) => m.authEnvVar as string),
    ),
  ].join(',');
}
const d = LIVE ? describe : describe.skip;

/** PNG files start with the 8-byte signature 89 50 4E 47 0D 0A 1A 0A. */
function isPng(b64: string): boolean {
  const buf = Buffer.from(b64, 'base64');
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

d('LIVE generation-out (real external providers via Secrets Manager)', () => {
  jest.setTimeout(120_000); // external image models are slow by design

  const PROMPT = 'a single red bicycle leaning against a white wall, soft daylight';

  it('FAL FLUX 1.1 Pro returns one persistable base64 PNG', async () => {
    const result = await invokeImageGenModel('fal-ai/flux-pro/v1.1', PROMPT, {
      count: 1,
      requestTimeoutMs: 110_000,
    });
    expect(result.images.length).toBe(1);
    // sync_mode:true => inline data: URI => parser strips to raw base64.
    expect(isPng(result.images[0])).toBe(true);
    expect(result.modelId).toBe('fal-ai/flux-pro/v1.1');
  });

  it('OpenAI gpt-image-1 returns one persistable base64 PNG', async () => {
    const result = await invokeImageGenModel('gpt-image-1', PROMPT, {
      count: 1,
      requestTimeoutMs: 110_000,
    });
    expect(result.images.length).toBe(1);
    expect(isPng(result.images[0])).toBe(true);
    expect(result.modelId).toBe('gpt-image-1');
  });
});
