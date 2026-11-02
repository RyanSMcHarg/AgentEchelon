/**
 * Code with no caller is removed, and stays removed.
 *
 * Each name below had no live reader: the `/add-agent` route and its Lambda (no client called it, and it
 * was a membership writer with nothing in front of it but a session), `requireGroup` (no caller),
 * `selectNotifyRecipients` (read only by its own test), the `notifyTargetSubs` directive shape (nothing
 * produces it), the frontend's model selector and mock provider (no importer), and the router's
 * `conversationOpened` notice kinds with the `lead-mention` helper they read (no service names either
 * kind). A name that comes back
 * is either a revival that needs its own review, or a copy of something that no longer exists.
 *
 * The retired `federated` admin auth mode is refused at synth rather than accepted and ignored, so a
 * deployer who still passes it is told.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { getAdminAuthMode, FEDERATED_ADMIN_MODE_RETIRED } from '../lib/constructs/admin-auth-mode';

const REPO = path.join(__dirname, '..', '..');

const REMOVED_NAMES = [
  'add-agent-to-conversation',
  'AddAgentApiUrl',
  'VITE_ADD_BOT_API_URL',
  'AddBotToChannelFunction',
  'requireGroup',
  'selectNotifyRecipients',
  'notifyTargetSubs',
  'ConversationProvider.mock',
  'utils/mockData',
  'ModelSelector',
  'conversationOpened',
  'lead-mention',
  'leadMention',
  'leadEmailDirective',
];

/** Source the deployment builds or ships from. Tests are left out: this file names what it guards. */
const ROOTS = [
  'backend/lambda',
  'backend/lib',
  'backend/bin',
  'backend/scripts',
  'frontend/packages',
  'tests/e2e',
];
const FILES = ['quickstart.sh', '.github/workflows/ci.yml'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', '.cache', 'build', 'coverage']);
const EXT = /\.(ts|tsx|js|mjs|cjs|json|sh|yml|example)$/;

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (EXT.test(entry.name) || entry.name.startsWith('.env')) {
      out.push(path.join(dir, entry.name));
    }
  }
}

describe('removed dead code stays removed', () => {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(REPO, root), files);
  for (const f of FILES) files.push(path.join(REPO, f));
  const sources = files
    .filter((f) => fs.existsSync(f) && !f.endsWith('.d.ts.map') && !/\.js\.map$/.test(f))
    // Compiled output beside the TypeScript source is not where a name is written.
    .filter((f) => !(f.endsWith('.js') && fs.existsSync(f.replace(/\.js$/, '.ts'))))
    .filter((f) => !(f.endsWith('.d.ts') && fs.existsSync(f.replace(/\.d\.ts$/, '.ts'))));

  it('reads some source', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it.each(REMOVED_NAMES)('no shipped source names %s', (name) => {
    const hits = sources.filter((f) => fs.readFileSync(f, 'utf8').includes(name)).map((f) => path.relative(REPO, f));
    expect(hits).toEqual([]);
  });
});

describe('the retired federated admin auth mode', () => {
  const modeWith = (value: string | undefined) => {
    const app = new cdk.App({ context: value === undefined ? {} : { adminAuthMode: value } });
    return getAdminAuthMode(new cdk.Stack(app, 'S'));
  };

  it('is refused at synth with the message naming what replaces it', () => {
    expect(() => modeWith('federated')).toThrow(FEDERATED_ADMIN_MODE_RETIRED);
  });

  it('leaves the two live modes and the default as they are', () => {
    expect(modeWith(undefined)).toBe('ae-cognito');
    expect(modeWith('ae-cognito')).toBe('ae-cognito');
    expect(modeWith('service')).toBe('service');
  });
});
