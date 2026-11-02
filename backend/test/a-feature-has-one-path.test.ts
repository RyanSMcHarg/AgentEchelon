/**
 * A FEATURE HAS ONE PATH, NEVER A `federated-` COPY.
 *
 * A person from a second identity provider is the same kind of principal as one from the deployment's
 * own pool: an AppInstanceUser, resolved once from the token's issuer and subject. So every feature has
 * one handler and one route for every issuer. A `federated-` copy of a handler is a second
 * implementation of the same rule, and a fix to one silently leaves the other broken (tenet D9).
 *
 * Refused:
 *  - a handler file `backend/lambda/src/federated-*.ts`;
 *  - a route whose path ends `/federated`, read two ways: from the stack sources
 *    (`addResource('federated')`) and from the generated route reference, which
 *    `api-contract-reference.test.ts` keeps equal to what the synthesized app serves.
 *
 * The one credential exchange, the one create path and the one membership path serve every issuer in the
 * trusted-issuer registry (`lib/config/issuers.ts`); what differs between two people follows from their
 * issuer's entry, never from which file ran.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAMBDA_SRC = path.join(REPO_ROOT, 'backend', 'lambda', 'src');
const STACK_ROOTS = [path.join(REPO_ROOT, 'backend', 'lib'), path.join(REPO_ROOT, 'backend', 'bin')];
const API_CONTRACT = path.join(REPO_ROOT, 'docs', 'reference', 'api-contract.md');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...walkTs(full)); }
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const rel = (f: string): string => path.relative(REPO_ROOT, f).split(path.sep).join('/');

/** `backend/lambda/src/federated-*.ts`, at any depth under `src`. */
function federatedHandlers(): string[] {
  return walkTs(LAMBDA_SRC).filter((f) => /^federated-.+\.ts$/.test(path.basename(f))).map(rel).sort();
}

const FEDERATED_RESOURCE = /\.addResource\(\s*['"`]federated['"`]\s*\)/;
const FEDERATED_ROUTE_STRING = /['"`][^'"`\s]*\/federated['"`]/;

/** Stack source lines that mount a route ending `/federated`. */
function federatedRouteSources(): string[] {
  const out: string[] = [];
  for (const root of STACK_ROOTS) {
    for (const file of walkTs(root)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (FEDERATED_RESOURCE.test(line) || FEDERATED_ROUTE_STRING.test(line)) out.push(`${rel(file)}:${i + 1}`);
      });
    }
  }
  return out;
}

/** Route rows in the generated reference whose path ends `/federated`. */
function federatedRoutesInContract(contract: string): string[] {
  return contract.split('\n').filter((l) => /^\|\s*`[A-Z]+`\s*\|\s*`[^`]*\/federated`\s*\|/.test(l));
}

describe('a feature has one path for every issuer', () => {
  it('no `federated-` handler exists', () => {
    expect(federatedHandlers()).toEqual([]);
  });

  it('no stack mounts a route ending `/federated`', () => {
    expect(federatedRouteSources()).toEqual([]);
  });

  it('the generated route reference serves no route ending `/federated`', () => {
    expect(federatedRoutesInContract(fs.readFileSync(API_CONTRACT, 'utf8'))).toEqual([]);
  });

  // Non-vacuity: each scan reads what it says it reads, so a moved tree cannot leave it passing over nothing.
  it('scans the lambda tree, the stack sources and a route reference that carries routes', () => {
    expect(walkTs(LAMBDA_SRC).length).toBeGreaterThan(50);
    expect(STACK_ROOTS.flatMap(walkTs).some((f) => f.endsWith('backend.ts'))).toBe(true);
    const contract = fs.readFileSync(API_CONTRACT, 'utf8');
    expect(contract.split('\n').filter((l) => /^\|\s*`(GET|POST|PUT|DELETE|PATCH)`\s*\|/.test(l)).length).toBeGreaterThan(20);
  });

  describe('recognizes each refused shape', () => {
    it.each([
      [".addResource('federated').addMethod('POST', integration)"],
      ['  exchange.addResource("federated")'],
      ["routes.push({ path: '/create-conversation/federated', method: 'POST' })"],
    ])('%s', (line) => {
      expect(FEDERATED_RESOURCE.test(line) || FEDERATED_ROUTE_STRING.test(line)).toBe(true);
    });

    it('and lets a path that only contains the word through', () => {
      expect(FEDERATED_ROUTE_STRING.test("'/federated-users/{id}'")).toBe(false);
      expect(FEDERATED_RESOURCE.test(".addResource('federation')")).toBe(false);
    });

    it('reads a `/federated` row from the reference and no other', () => {
      const rows = [
        '| `POST` | `/exchange-credentials/federated` | Cognito user pool | `F` | `x` |',
        '| `POST` | `/exchange-credentials` | Cognito user pool | `E` | always |',
      ].join('\n');
      expect(federatedRoutesInContract(rows)).toHaveLength(1);
    });
  });
});
