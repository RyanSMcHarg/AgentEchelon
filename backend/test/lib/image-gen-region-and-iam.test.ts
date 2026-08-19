/**
 * Image generation must be invocable in the region it is invoked from, and granted by IAM.
 *
 * THE DEFECT, which was three faults stacked and each one alone enough to break every image turn:
 *   1. `DEFAULT_IMAGE_MODEL` is `stability_image_core`, which Bedrock offers in us-west-2 ONLY. The
 *      deployment runs us-east-1, where the only text-to-image model is Nova Canvas.
 *   2. Nothing set `IMAGE_GEN_REGION`, so the client was built for the Lambda's own region.
 *   3. The processor's `bedrock:InvokeModel` grant named Titan Image and Nova Canvas only - both
 *      LEGACY - so the shipped default was ungranted even in the right region.
 *
 * Bedrock reports (1) as `ValidationException: The provided model identifier is invalid`, which reads
 * exactly like a typo'd id and sent the investigation after the id instead of the region.
 *
 * WHY THESE TESTS AND NOT A LIVE CHECK. `bedrock:ListFoundationModels` would pin the true answer but
 * needs credentials and a network call, so it cannot gate a build. These pin the two invariants that
 * were actually violated - a model is invoked where it lives, and everything in the registry is
 * granted - both of which are decidable offline.
 */
import {
  imageGuardrailFor,
  IMAGE_GEN_MODELS,
  BEDROCK_IMAGE_MODEL_ARNS,
  imageGenRegionFor,
} from '../../lambda/src/lib/image-gen-models';
import { DEFAULT_IMAGE_MODEL } from '../../lambda/src/lib/active-profile';

describe('a model is invoked in the region that carries it', () => {
  const ENV = process.env;
  beforeEach(() => { process.env = { ...ENV }; delete process.env.IMAGE_GEN_REGION; });
  afterAll(() => { process.env = ENV; });

  it('uses the model\'s declared region when it is offered in only one', () => {
    process.env.AWS_REGION = 'us-east-1';
    // The whole defect in one assertion: a us-east-1 deployment must reach a us-west-2-only model
    // WITHOUT the deployer configuring anything.
    expect(imageGenRegionFor(IMAGE_GEN_MODELS.stability_image_core)).toBe('us-west-2');
  });

  it('uses the deploy region for a model with no regional restriction', () => {
    process.env.AWS_REGION = 'eu-west-1';
    // Nova Canvas carries no `region`, so it must NOT be pinned anywhere — pinning every model to a
    // literal would break every deployment that is not in that region.
    expect(IMAGE_GEN_MODELS.nova_canvas.region).toBeUndefined();
    expect(imageGenRegionFor(IMAGE_GEN_MODELS.nova_canvas)).toBe('eu-west-1');
  });

  it('lets IMAGE_GEN_REGION override even a model that declares its own region', () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.IMAGE_GEN_REGION = 'eu-central-1';
    // A deployer who sets this knows something the registry does not. Silently preferring the
    // hardcoded region would be unfixable from outside the codebase.
    expect(imageGenRegionFor(IMAGE_GEN_MODELS.stability_image_core)).toBe('eu-central-1');
  });

  it('pins the Stability generators to us-west-2, where Bedrock actually offers them', () => {
    // Verified against the account: `list-foundation-models --region us-west-2` returns
    // stable-image-core-v1:1 and stable-image-ultra-v1:1; us-east-1 returns neither, and every
    // Stability model it does return is an EDITING op (upscale/inpaint/erase), not a generator.
    expect(IMAGE_GEN_MODELS.stability_image_core.region).toBe('us-west-2');
    expect(IMAGE_GEN_MODELS.stability_image_ultra.region).toBe('us-west-2');
  });
});

describe('every Bedrock image model is granted to the processor role', () => {
  it('derives the grant from the registry, so a new model cannot be left ungranted', () => {
    const bedrockModels = Object.values(IMAGE_GEN_MODELS).filter((m) => m.hosting === 'aws-bedrock');
    expect(bedrockModels.length).toBeGreaterThan(0);
    for (const m of bedrockModels) {
      expect(BEDROCK_IMAGE_MODEL_ARNS).toContain(
        `arn:aws:bedrock:*::foundation-model/${m.bedrockModelId}`,
      );
    }
  });

  it('grants the DEFAULT model — the exact gap that broke every image turn', () => {
    const def = IMAGE_GEN_MODELS[DEFAULT_IMAGE_MODEL];
    expect(def.hosting).toBe('aws-bedrock');
    expect(BEDROCK_IMAGE_MODEL_ARNS).toContain(
      `arn:aws:bedrock:*::foundation-model/${def.bedrockModelId}`,
    );
  });

  it('keeps the region wildcard, without which a cross-region model is denied', () => {
    // A grant pinned to the deploy region denies the us-west-2-only generators. This is the one
    // character that makes the region fix above reachable at runtime.
    for (const arn of BEDROCK_IMAGE_MODEL_ARNS) {
      expect(arn).toMatch(/^arn:aws:bedrock:\*::foundation-model\//);
    }
  });

  it('excludes external-http providers, which are not IAM-reachable', () => {
    const external = Object.values(IMAGE_GEN_MODELS).filter((m) => m.hosting === 'external-http');
    expect(external.length).toBeGreaterThan(0);
    for (const m of external) {
      expect(BEDROCK_IMAGE_MODEL_ARNS).not.toContain(
        `arn:aws:bedrock:*::foundation-model/${m.bedrockModelId}`,
      );
    }
  });
});

describe('the shipped default is one a deployer can actually run', () => {
  it('is active, not legacy-locked', () => {
    // Nova Canvas is in-region for us-east-1 and would be the tempting fix, but AWS legacy-locks it
    // for accounts without recent usage with no self-serve unblock — so it must not become the
    // default just because it is local.
    expect(IMAGE_GEN_MODELS[DEFAULT_IMAGE_MODEL].lifecycle).toBe('active');
  });

  it('needs no external API key, so image generation works with IAM alone', () => {
    const def = IMAGE_GEN_MODELS[DEFAULT_IMAGE_MODEL];
    expect(def.hosting).toBe('aws-bedrock');
    expect(def.authEnvVar).toBeUndefined();
  });
});

/**
 * THE SAME TRAP, ONE LAYER UP: the guardrail was left in the deploy region.
 *
 * The model pinning above was fixed; the CONTENT GUARDRAIL was not. Bedrock guardrails are regional,
 * so attaching a us-east-1 guardrail to a us-west-2 image call fails with
 * `ValidationException: The guardrail identifier or version provided in the request does not exist`
 * - which again reads like a bad id. Verified live 2026-08-08: both the id and its version existed
 * and were READY in us-east-1, and `list-guardrails --region us-west-2` returned `[]`.
 */
describe('image guardrail resolution is REGIONAL', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('prefers the guardrail provisioned in the invocation region', () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.BATTLE_IMAGE_GUARDRAIL_ID = 'east-id';
    process.env.BATTLE_IMAGE_GUARDRAIL_VERSION = '1';
    process.env.BATTLE_IMAGE_GUARDRAIL_BY_REGION = JSON.stringify({
      'us-east-1': { id: 'east-id', version: '1' },
      'us-west-2': { id: 'west-id', version: '1' },
    });
    expect(imageGuardrailFor('us-west-2')).toEqual({ id: 'west-id', version: '1' });
    expect(imageGuardrailFor('us-east-1')).toEqual({ id: 'east-id', version: '1' });
  });

  it('returns UNDEFINED for a region with no guardrail, rather than the deploy-region one', () => {
    // Returning the deploy-region guardrail here is the original bug: the call is rejected, and the
    // only reason it is not WORSE is that Bedrock refuses it. Silently omitting the guardrail instead
    // would generate an unmoderated image and pass every test.
    process.env.AWS_REGION = 'us-east-1';
    process.env.BATTLE_IMAGE_GUARDRAIL_ID = 'east-id';
    process.env.BATTLE_IMAGE_GUARDRAIL_VERSION = '1';
    delete process.env.BATTLE_IMAGE_GUARDRAIL_BY_REGION;
    expect(imageGuardrailFor('us-west-2')).toBeUndefined();
    expect(imageGuardrailFor('us-east-1')).toEqual({ id: 'east-id', version: '1' });
  });

  it('falls back to the single-value env for the DEPLOY region when the map is malformed', () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.BATTLE_IMAGE_GUARDRAIL_ID = 'east-id';
    process.env.BATTLE_IMAGE_GUARDRAIL_VERSION = '1';
    process.env.BATTLE_IMAGE_GUARDRAIL_BY_REGION = '{not json';
    expect(imageGuardrailFor('us-east-1')).toEqual({ id: 'east-id', version: '1' });
    // ...and still refuses a region it knows nothing about.
    expect(imageGuardrailFor('us-west-2')).toBeUndefined();
  });

  it('every ACTIVE Bedrock-hosted model pinned to a region needs a guardrail there', () => {
    // The registry is the source of truth for which regions must be provisioned; bin/backend.ts
    // derives the guardrail stacks from exactly this filter, so adding a pinned model provisions its
    // guardrail automatically instead of failing on the first image turn.
    const pinned = Object.values(IMAGE_GEN_MODELS)
      .filter((m) => m.lifecycle === 'active' && m.hosting === 'aws-bedrock' && m.region)
      .map((m) => m.region);
    expect(pinned.length).toBeGreaterThan(0);
    expect([...new Set(pinned)]).toContain('us-west-2');
  });
});
