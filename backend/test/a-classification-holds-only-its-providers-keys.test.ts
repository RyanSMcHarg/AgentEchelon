/**
 * A CLASSIFICATION'S PROCESSOR HOLDS ONLY THE KEYS OF THE IMAGE PROVIDERS IT SELECTS.
 *
 * One Secrets Manager secret (`imageGenKeysSecretArn`) may carry every external image provider's key. The
 * stack names the selected providers' fields on the processor (`IMAGE_GEN_KEY_FIELDS`, from
 * `externalImageKeyFieldsFor`), the processor copies only those fields of the secret into its environment
 * (`imageGenKeysFromSecret`), and a key exported in the deploy shell is copied for a selected provider only.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cdk = require('aws-cdk-lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Template } = require('aws-cdk-lib/assertions');
import { DEFAULT_PROFILES_CONFIG, type ProfilesConfig } from '../lib/config/profiles';
import { useDeploymentProfiles } from '../lib/profile-registry';
import { externalImageKeyFieldsFor, imageGenKeysFromSecret } from '../lambda/src/lib/image-gen-models';
import { assistantsOf, assistantsStackId } from './helpers/assistants';

const PROPS = {
  env: { account: '123456789012', region: 'us-east-1' },
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
};
const SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:image-gen-keys-AbCdEf';

/** The shipped set, with `premium` selecting OpenAI's image model and not FAL's. */
const OPENAI_ONLY: ProfilesConfig = {
  ...DEFAULT_PROFILES_CONFIG,
  classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'premium'
    ? { ...c, models: { selected: c.models!.selected.filter((k) => k !== 'fal_flux_pro_1_1'), default: c.models!.default } }
    : c)),
};

describe('a classification holds only the keys of the image providers it selects', () => {
  it('reads only the named fields of the secret, and nothing without a list', () => {
    const secret = { OPENAI_API_KEY: 'sk-openai', FAL_KEY: 'fal-key', OTHER: 'x' };
    expect(imageGenKeysFromSecret(secret, 'OPENAI_API_KEY')).toEqual({ OPENAI_API_KEY: 'sk-openai' });
    expect(imageGenKeysFromSecret(secret, 'FAL_KEY, OPENAI_API_KEY')).toEqual({ OPENAI_API_KEY: 'sk-openai', FAL_KEY: 'fal-key' });
    expect(imageGenKeysFromSecret(secret, undefined)).toEqual({});
    expect(imageGenKeysFromSecret(secret, '')).toEqual({});
  });

  describe('synthesized', () => {
    const saved = { fal: process.env.FAL_KEY, openai: process.env.OPENAI_API_KEY };
    let env: Record<string, string>;
    beforeAll(() => {
      useDeploymentProfiles(OPENAI_ONLY);
      process.env.FAL_KEY = 'fal-from-the-shell';
      process.env.OPENAI_API_KEY = 'openai-from-the-shell';
      const app = new cdk.App({ context: { imageGenKeysSecretArn: SECRET } });
      const t = Template.fromStack(assistantsOf('premium')(app, assistantsStackId('premium'), PROPS));
      const [, processor] = Object.entries(t.findResources('AWS::Lambda::Function'))
        .find(([, f]: [string, any]) => f.Properties.Environment?.Variables?.IMAGE_GEN_KEYS_SECRET_ARN === SECRET) as [string, any];
      env = processor.Properties.Environment.Variables;
    });
    afterAll(() => {
      useDeploymentProfiles(DEFAULT_PROFILES_CONFIG);
      if (saved.fal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = saved.fal;
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
    });

    it('names the selected provider\'s field alone on the processor', () => {
      expect(externalImageKeyFieldsFor('premium')).toEqual(['OPENAI_API_KEY']);
      expect(env.IMAGE_GEN_KEY_FIELDS).toBe('OPENAI_API_KEY');
    });

    it('copies a deploy-shell key for a selected provider only', () => {
      expect(env.OPENAI_API_KEY).toBe('openai-from-the-shell');
      expect(env).not.toHaveProperty('FAL_KEY');
    });
  });
});
