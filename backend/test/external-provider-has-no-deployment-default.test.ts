/**
 * NOTHING AT DEPLOY TIME OPENS THE EXTERNAL (NON-AWS) PROVIDER.
 *
 * The processor used to receive `EXTERNAL_MODEL_CONSENT_DEFAULT`, set to 'true' unless a deployer
 * passed `-c externalConsentDefault=false`, so a Chinese-language turn on a context-routing deployment
 * left AWS by default under a field framed as an end user's consent. Whether an assistant may use that
 * path is whether its classification selects the external model (`models.selected`), which is also exactly
 * where its stack holds the provider's key (`lib/an-external-model-is-the-classifications-to-select.test.ts`).
 *
 * This file pins the deploy-time half: the synthesized processor carries no such variable whatever
 * context is passed, no source file sets one, and the retired context key fails the synth loudly with
 * the name of its replacement, so nobody deploys believing the old switch still works.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import {
  RETIRED_CONTEXT_KEYS,
  retiredContextKeyErrors,
  assertNoRetiredContext,
  describeDeployContextGap,
} from '../lib/config/deploy-context';

const env = { account: '123456789012', region: 'us-east-1' };
const props = {
  env,
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
  attachmentsBucketName: 'agent-echelon-attachments-test',
  attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
};

function processorEnvs(template: Template): Array<Record<string, unknown>> {
  return Object.values(template.findResources('AWS::Lambda::Function'))
    .map((r) => ((r.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment?.Variables ?? {}));
}

describe('the external provider has no deployment-time default', () => {
  it('a context-routing processor is synthesized with NO consent variable', () => {
    const app = new cdk.App({ context: { enableContextRouting: 'true' } });
    const template = Template.fromStack(assistantsOf('standard')(app, 'AgentEchelonAssistants-ext-provider', props));

    const envs = processorEnvs(template);
    // The routing processor is really there, so the absence below is not vacuous.
    expect(envs.some((v) => v.ENABLE_CONTEXT_ROUTING === 'true')).toBe(true);
    expect(envs.some((v) => 'EXTERNAL_MODEL_CONSENT_DEFAULT' in v)).toBe(false);
    expect(JSON.stringify(template.toJSON())).not.toContain('EXTERNAL_MODEL_CONSENT_DEFAULT');
  });

  it('no source file sets or reads EXTERNAL_MODEL_CONSENT_DEFAULT', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          if (fs.readFileSync(full, 'utf8').includes('EXTERNAL_MODEL_CONSENT_DEFAULT')) offenders.push(full);
        }
      }
    };
    for (const root of ['bin', 'lib', 'lambda/src']) walk(path.join(__dirname, '..', root));
    expect(offenders).toEqual([]);
  });
});

describe('the retired externalConsentDefault context key fails loudly', () => {
  it('is refused with ANY value, and the message names the selection that replaced it', () => {
    for (const value of ['true', 'false', '', true, false]) {
      const errs = retiredContextKeyErrors((k) => (k === 'externalConsentDefault' ? value : undefined));
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/externalConsentDefault is retired/);
      expect(errs[0]).toMatch(/models\.selected/);
    }
  });

  it('says nothing when the key is absent', () => {
    expect(retiredContextKeyErrors(() => undefined)).toEqual([]);
  });

  it('deploy.mjs names it as RETIRED, not as a probable typo, when it sits in deploy.config.json', () => {
    expect(Object.keys(RETIRED_CONTEXT_KEYS)).toContain('externalConsentDefault');
    const msg = describeDeployContextGap({ destructive: [], missing: [], unknown: ['externalConsentDefault'] }, '--x')!;
    expect(msg).toMatch(/RETIRED/);
    expect(msg).toMatch(/models\.selected/);
    expect(msg).not.toMatch(/Most likely a typo/);
  });

  it('the refusal throws for a retired key and names it, and passes a context without one', () => {
    const app = new cdk.App({ context: { externalConsentDefault: 'false', enableContextRouting: 'true' } });
    expect(() => assertNoRetiredContext((key) => app.node.tryGetContext(key)))
      .toThrow(/Retired cdk context:[\s\S]*externalConsentDefault is retired/);

    const clean = new cdk.App({ context: { enableContextRouting: 'true' } });
    expect(() => assertNoRetiredContext((key) => clean.node.tryGetContext(key))).not.toThrow();
  });

  it('names every retired key present, not only the first', () => {
    const read = (k: string): unknown => (k in RETIRED_CONTEXT_KEYS ? '' : undefined);
    let message = '';
    try {
      assertNoRetiredContext(read);
    } catch (err) {
      message = (err as Error).message;
    }
    for (const key of Object.keys(RETIRED_CONTEXT_KEYS)) expect(message).toContain(`${key} is retired`);
  });

  it('the CDK app entry point calls that refusal with the app context', () => {
    // The behavior is tested above; this pins only that the entry point calls it, which a synth of
    // `bin/backend.ts` would otherwise need a full app (every stack) to prove.
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'backend.ts'), 'utf8');
    expect(src).toMatch(/assertNoRetiredContext\(\(key\) => app\.node\.tryGetContext\(key\)\)/);
  });
});

describe('the retired per-classification model keys fail loudly', () => {
  // A model is the classification's to select (`models` on its registry entry), so no context key picks one.
  const MODEL_KEYS = ['basicModelKey', 'standardModelKey', 'premiumModelKey', 'guestModelKey', 'customerModelKey',
    'cnBedrockChatModel', 'cnBedrockReasoningModel', 'deepseekModel'];

  it('refuses each with any value, naming the selection that replaced it', () => {
    for (const key of MODEL_KEYS) {
      const errs = retiredContextKeyErrors((k) => (k === key ? 'sonnet' : undefined));
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain(`${key} is retired`);
      expect(errs[0]).toMatch(/models\.selected|selects/);
    }
  });

  it('no source file reads one from the context', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          const src = fs.readFileSync(full, 'utf8');
          for (const key of MODEL_KEYS) {
            if (src.includes(`tryGetContext('${key}'`) || src.includes(`tryGetContext("${key}"`)) offenders.push(`${full}: ${key}`);
          }
        }
      }
    };
    for (const root of ['bin', 'lib']) walk(path.join(__dirname, '..', root));
    expect(offenders).toEqual([]);
  });
});

describe('the retired hostAdminPoolId context key fails loudly', () => {
  it('is refused with any value, and the message names what replaced it', () => {
    for (const value of ['us-east-1_XXXX', '']) {
      const errs = retiredContextKeyErrors((k) => (k === 'hostAdminPoolId' ? value : undefined));
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/hostAdminPoolId is retired/);
      expect(errs[0]).toMatch(/AWS_IAM/);
      expect(errs[0]).toMatch(/Approach 1/);
    }
  });

  it('no source file reads it from the context', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          if (/tryGetContext\(\s*['"]hostAdminPoolId['"]/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    for (const root of ['bin', 'lib']) walk(path.join(__dirname, '..', root));
    expect(offenders).toEqual([]);
  });
});
