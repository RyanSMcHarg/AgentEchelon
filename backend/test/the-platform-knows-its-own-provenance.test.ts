/**
 * THE PLATFORM CAN SAY WHO MADE IT (owner-reported, 2026-09-05).
 *
 * Asked "who created it", the assistant answered that the retrieved context does not name a creator
 * or founding team. It was telling the truth, which is the part worth keeping in mind: the curated
 * self-knowledge carried a project name and a hardcoded license string and nothing else about the
 * project's own provenance, so the first question anybody asks about a platform an assistant claims
 * to know about was the one question it could not answer.
 *
 * It also reached for the deploying company's documents to try, which is the right instinct and the
 * wrong shelf - Stratum has no reason to carry the authorship of a platform it merely runs.
 *
 * WHAT THIS GUARDS, and it is two different things:
 *
 *   - the committed artifact actually carries the fields, so a regeneration that silently loses them
 *     fails here rather than in front of somebody;
 *   - the fields are DERIVED, not typed in. A name written into the generator would be wrong for
 *     every fork, and an assistant that asserts somebody else's authorship is worse than one that
 *     says nothing. So the values are checked against the repository they must come from.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const ABOUT = path.join(ROOT, 'demo', 'platform-knowledge', 'standard', 'agentechelon-about.json');
const PUBLIC_ABOUT = path.join(ROOT, 'demo', 'platform-knowledge', 'basic', 'agentechelon-about.json');

// THE EXTERNAL CLASSIFICATION GETS THE OVERVIEW AND NOTHING OF HOW IT IS BUILT.
describe('the public overview carries no internal documentation', () => {
  const pub = JSON.parse(fs.readFileSync(PUBLIC_ABOUT, 'utf8'));
  it('has the overview and provenance, and no document index', () => {
    expect(Object.keys(pub).sort()).toEqual(['answering_guidance', 'author', 'license', 'overview', 'project', 'purpose', 'repository', 'since']);
    expect(JSON.stringify(pub)).not.toContain('.md');
    expect(JSON.stringify(pub)).not.toContain('docs/');
  });
  it('no unscoped file every classification could read is left beside the scoped ones', () => {
    expect(fs.existsSync(path.join(ROOT, 'demo', 'platform-knowledge', 'agentechelon-about.json'))).toBe(false);
  });
});

describe('the curated self-knowledge names its own provenance', () => {
  const about = JSON.parse(fs.readFileSync(ABOUT, 'utf8'));

  it('names the author, and names the one the LICENSE names', () => {
    // NOT "is a non-empty string". The point is that it agrees with the repository's own statement
    // of authorship, which is what makes it right in a fork as well as here.
    const license = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
    const holder = /^Copyright \(c\)\s*(\d{4})(?:\s*[-–]\s*\d{4})?\s+(.+?)\s*$/m.exec(license);

    expect(holder).toBeTruthy();
    expect(about.author).toBe(holder![2]);
    expect(about.since).toBe(holder![1]);
  });

  it('takes the licence from LICENSE rather than asserting one of its own', () => {
    const firstLine = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8').split('\n')[0].trim();

    expect(about.license).toBe(firstLine.replace(/\s*License\s*$/i, '').trim());
  });

  it('names where the source lives, as a URL somebody could open', () => {
    // An SSH host alias (`git@github-mcharg:owner/repo.git`) resolves on one machine and nowhere
    // else, so publishing one as a URL hands somebody an address that does not exist.
    expect(about.repository).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^/]+\/[^/]+$/i);
    expect(about.repository).not.toMatch(/\.git$/);
    expect(about.repository).not.toContain('@');
  });

  it('tells the assistant these are the fields that answer it, and that it cannot go and look', () => {
    // The second half matters as much as the first: the same turn that could not name a creator
    // implied it could go and check the repository. There is no web access on this path, and an
    // offer to look something up is a promise nothing here can keep.
    expect(about.answering_guidance).toMatch(/author/);
    expect(about.answering_guidance).toMatch(/repository/);
    expect(about.answering_guidance).toMatch(/cannot browse the web/i);
  });
});

describe('the tool that serves it says it holds provenance', () => {
  // Reachability, not content: the model chooses whether to call this from the description alone,
  // and a description listing only architecture and features reads as the wrong shelf for "who
  // created it" - which is how the question reached the company documents instead.
  const src = (f: string) => fs.readFileSync(path.join(ROOT, 'lambda', 'src', f), 'utf8');

  it('names authorship in the description the model actually chooses from', () => {
    expect(src('lib/async-processor-core.ts')).toMatch(/who made it, when, under what licence/);
  });

  it('names it in the registry too, so the two cannot describe different tools', () => {
    expect(src('lib/tool-registry.ts')).toMatch(/authorship, licence and source repository/);
  });
});
