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
 * Reality: the Bedrock Amazon image models
 * (titan/nova) are legacy-locked and Stability base generators are
 * us-west-2 only, so generation-out from a us-east-1 deployment runs
 * through these external providers (keys in Secrets Manager).
 */

import { invokeImageGenModel } from '../../lambda/src/lib/image-gen-models';

const LIVE = process.env.RUN_LIVE_IMAGE_GEN === '1';
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
