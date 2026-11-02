/**
 * sync-project-knowledge.mjs
 *
 * Gives the demo assistants knowledge OF AGENTECHELON ITSELF, so at any tier they
 * can answer "what is this / how does X work" about the platform they run on.
 *
 * Two outputs (per the launch decision: curated + RAG), each CLASSIFICATION-SCOPED:
 *   1. CURATED (this script, offline), written under backend/demo/platform-knowledge/ and uploaded by
 *      seed-demo to the `platform-knowledge/{classification}/` S3 prefixes:
 *        - `basic/`: the PUBLIC OVERVIEW only - what the platform is, its purpose, licence, author and
 *          repository. The external classification learns what the platform does and nothing of how.
 *        - `{INTERNAL_CLASSIFICATION}/`: the full file, overview plus the documented index.
 *      An assistant reads only the prefixes its classification grants (IAM on the role and on the vended
 *      session), and `load_platform_info` asks only for those.
 *   2. RAG (Aurora only, needs a deploy): with `--rag`, the full repo docs + public blog are uploaded to
 *      the Aurora archive bucket under `rag/agentechelon/{INTERNAL_CLASSIFICATION}/`. The DocumentIngestion
 *      Lambda chunks + Titan-embeds them tagged with that classification, so row-level security admits them
 *      only for a classification that grants it. A key is put when it is new, changed, or holds no chunks in
 *      the database, so a run re-triggers an ingest that failed and leaves an ingested key alone.
 *
 * THE PLATFORM'S DOCUMENTATION IS INTERNAL MATERIAL. It was ingested at the lowest classification, so the
 * external assistant's every turn was grounded in it and answered "how do I customize the welcome?" with
 * Parameter Store paths and function names. A classification reaches exactly what it declares (tenet D2).
 *
 * Content = repo docs + public blog (no source code), per the launch decision.
 *
 * Usage:
 *   node backend/scripts/sync-project-knowledge.mjs
 *   AE_BLOG_VAULT_PATH="/path/to/your/blog-vault" node backend/scripts/sync-project-knowledge.mjs
 *   node backend/scripts/sync-project-knowledge.mjs --rag             # upload the corpus (Aurora)
 *   node backend/scripts/sync-project-knowledge.mjs --rag --dry-run   # list what would be put, and why
 *   node backend/scripts/sync-project-knowledge.mjs --rag --verify    # and fail unless every key is ingested
 *
 * The blog vault is external (not in this repo); it is OPTIONAL and skipped when the
 * path is unset or missing - OSS users just get the repo-docs knowledge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
// Platform self-knowledge lives OUTSIDE the company `context/` tree so it is
// retrieved separately (load_platform_info tool), not bundled into every
// company-context load. seed-demo uploads it to the `platform-knowledge/` S3 prefix.
/** The classification the platform's documentation belongs to: the internal one the internal classifications grant. */
const INTERNAL_CLASSIFICATION = 'standard';
/** Where the corpus was ingested before it was scoped; its keys are overwritten with stubs so their chunks are cleared. */
const RETIRED_RAG_PREFIX = 'rag/agentechelon/basic/';
const KNOWLEDGE_DIR = path.join(REPO_ROOT, 'backend', 'demo', 'platform-knowledge');
const OUTPUT = path.join(KNOWLEDGE_DIR, INTERNAL_CLASSIFICATION, 'agentechelon-about.json');
const OUTPUT_PUBLIC = path.join(KNOWLEDGE_DIR, 'basic', 'agentechelon-about.json');
const RAG = process.argv.includes('--rag');

/**
 * Docs that DOCUMENT THE DEMO DATASET, and therefore quote content the demo deliberately restricts by
 * classification. They are excluded from the corpus entirely.
 *
 * THIS IS A CLASSIFICATION BOUNDARY, not tidiness. Anything in the corpus is readable by every classification
 * that grants the one it is ingested at. `SPEC-DEMO-COMPANY.md` reproduces the Stratum org chart, the quarterly financials and the
 * top accounts to illustrate what each tier may see, so ingesting it hands `basic` precisely the
 * standard/premium-only data the demo exists to prove it cannot reach.
 *
 * Caught by `classification-context.spec.ts` ("basic CANNOT name internal leadership"), which failed
 * with the assistant answering "the VP of Engineering at Stratum Technologies is Priya Patel" - sourced
 * from this spec, not from any basic-tier context file. The lesson generalises: a doc ABOUT restricted
 * data is itself restricted data.
 */
const DEMO_DATASET_DOCS = ['SPEC-DEMO-COMPANY.md'];

// Repo docs to index: README + every TRACKED docs/**/*.md. docs/ is organized into
// subfolders (overview/ guides/ specs/ design/), so walk it recursively. Excludes
// decisions/ (ADRs), non-doc/marker assets, and the demo-dataset docs above.
//
// TRACKED, because the corpus describes the repo AS SHIPPED - what a fresh checkout holds - and the
// owner's working tree also carries gitignored private files (now under private/) that must
// never reach a store every classification reads. This is not hypothetical: a private account of an earlier
// leak QUOTES a restricted employee name, so indexing it re-created the exact leak it
// records - a doc ABOUT restricted data is itself restricted data, one level up. The name guard
// caught it, but the guard knows only the demo directory's names; git-tracked is the general boundary.
function gitTrackedDocs() {
  try {
    const out = execSync('git ls-files -- docs', { cwd: REPO_ROOT, encoding: 'utf8' });
    return new Set(
      out.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => path.resolve(REPO_ROOT, l)),
    );
  } catch {
    // No git (an exported tree). There the filesystem IS the shipped surface - a tree without .git has
    // no private working files to exclude - so the walk alone is correct, not merely tolerated.
    return null;
  }
}

function repoDocPaths() {
  const tracked = gitTrackedDocs();
  const paths = [path.join(REPO_ROOT, 'README.md')];
  const skipped = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      // Skip meta/marker files (e.g. `!-THIS-VAULT-IS-PUBLIC.md`, `_drafts`),
      // image assets, and the ADR decisions/ tree - not project knowledge.
      if (name.startsWith('!') || name.startsWith('_') || name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (name === 'decisions' || name === 'images') continue;
        walk(path.join(dir, name));
        continue;
      }
      if (DEMO_DATASET_DOCS.includes(name)) continue;
      if (!name.endsWith('.md')) continue;
      const full = path.join(dir, name);
      if (tracked && !tracked.has(path.resolve(full))) { skipped.push(name); continue; }
      paths.push(full);
    }
  };
  walk(DOCS_DIR);
  if (skipped.length) {
    console.log(`  untracked (private) docs excluded from the corpus: ${skipped.join(', ')}`);
  }
  return paths.filter((p) => fs.existsSync(p));
}

/**
 * Refuse to ship a corpus that carries classification-restricted demo data.
 *
 * The exclusion above is a list, and a list rots - a new doc quoting the org chart would sail past it.
 * So the content is checked too, against the EMPLOYEE DIRECTORY: any of those people named in a doc
 * bound for a corpus every classification can read is restricted data leaving its tier.
 *
 * The names are read from the directory's own structure rather than pattern-matched out of the context
 * files. A "two capitalised words" heuristic flags `Customer Success` and `Principal Engineer` as
 * readily as `Priya Patel`, and a guard that cries wolf on a security spec gets switched off - which
 * would be worse than not having one.
 *
 * Fails the run rather than warning. This corpus is read by the lowest classification, so shipping it
 * with restricted content is not a degraded feature - it is the isolation guarantee not holding.
 */
function assertNoRestrictedDemoData(paths) {
  const dir = path.join(REPO_ROOT, 'backend', 'demo', 'context', 'standard', 'employee-directory.json');
  if (!fs.existsSync(dir)) return; // no demo dataset in this checkout - nothing to protect
  let names = [];
  try {
    const doc = JSON.parse(fs.readFileSync(dir, 'utf8'));
    names = (doc.departments || []).flatMap((d) => (d.members || []).map((m) => m.name)).filter(Boolean);
  } catch {
    return; // unreadable directory: do not invent a boundary from a parse failure
  }
  if (!names.length) return;
  const offenders = [];
  for (const p of paths) {
    const body = fs.readFileSync(p, 'utf8');
    const hits = names.filter((n) => body.includes(n));
    if (hits.length) offenders.push(`${path.relative(REPO_ROOT, p).replace(/\\/g, '/')}  [${hits.slice(0, 4).join(', ')}]`);
  }
  if (offenders.length) {
    console.error(
      '\n✗ Refusing to ingest: these docs carry demo data restricted to standard/premium, and this\n'
      + '  corpus is ingested at the LOWEST classification - so basic would be able to retrieve it.\n'
      + '  Add the file to DEMO_DATASET_DOCS, or take the restricted content out of it.\n\n  '
      + offenders.join('\n  ') + '\n',
    );
    process.exit(1);
  }
}

/** Strip YAML frontmatter and return { frontmatter, body }. */
function splitFrontmatter(md) {
  if (!md.startsWith('---')) return { frontmatter: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: md };
  const fmBlock = md.slice(3, end).trim();
  const body = md.slice(end + 4).trimStart();
  const frontmatter = {};
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) frontmatter[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatter, body };
}

/** First H1 as title, first real paragraph as a one-line summary. */
function titleAndSummary(body, fallbackTitle) {
  const lines = body.split('\n');
  let title = fallbackTitle;
  const h1 = lines.find((l) => l.startsWith('# '));
  if (h1) title = h1.replace(/^#\s+/, '').trim();

  let summary = '';
  let started = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!started) {
      if (l.startsWith('#')) { started = true; }
      continue;
    }
    if (!l || l.startsWith('#') || l.startsWith('>') || l.startsWith('```') || l.startsWith('|') || l.startsWith('-')) {
      if (summary) break; // paragraph ended
      continue;
    }
    summary += (summary ? ' ' : '') + l;
    if (summary.length > 320) break;
  }
  return { title, summary: summary.slice(0, 400) };
}

function gatherDocs() {
  return repoDocPaths().map((p) => {
    const { body } = splitFrontmatter(fs.readFileSync(p, 'utf8'));
    const rel = path.relative(REPO_ROOT, p).replace(/\\/g, '/');
    const { title, summary } = titleAndSummary(body, path.basename(p, '.md'));
    return { title, summary, path: rel };
  });
}

function gatherBlog() {
  const vault = process.env.AE_BLOG_VAULT_PATH;
  if (!vault || !fs.existsSync(vault)) return [];
  const posts = [];
  for (const name of fs.readdirSync(vault)) {
    if (!name.endsWith('.md')) continue;
    const { frontmatter, body } = splitFrontmatter(fs.readFileSync(path.join(vault, name), 'utf8'));
    if ((frontmatter.visibility || '').toLowerCase() !== 'public') continue; // PUBLIC posts only
    const { title, summary } = titleAndSummary(body, frontmatter.title || name);
    posts.push({ title: frontmatter.title || title, summary, slug: frontmatter.slug || '' });
  }
  return posts;
}

/**
 * WHO MADE IT, UNDER WHAT LICENCE, AND WHERE THE SOURCE IS.
 *
 * Reported live: asked "who created it", the assistant answered that the
 * retrieved context does not name a creator. It was telling the truth - this file carried a project
 * name and a hardcoded licence string and nothing else about the project's own provenance, so the
 * one question a person asks first about a platform it claims to know about was the one it could not
 * answer.
 *
 * READ FROM THE REPOSITORY, NEVER WRITTEN HERE. A name typed into this script would be wrong for
 * every fork of it, and this is the file that teaches an assistant what it is running on - a fork
 * whose assistant claims somebody else's authorship is worse than one that says nothing. LICENSE is
 * the authoritative statement of both the holder and the licence, and it is already the file a
 * person is pointed at for exactly this question.
 *
 * ABSENT IS A VALID ANSWER. Every field degrades to omitted rather than guessed: a checkout with no
 * LICENSE, or no git remote, produces a smaller object, and `answering_guidance` already tells the
 * assistant to say so when something is not here.
 */
function gatherOrigin() {
  const origin = {};

  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8');
    const firstLine = (text.split('\n')[0] || '').trim();
    if (firstLine) origin.license = firstLine.replace(/\s*License\s*$/i, '').trim() || firstLine;
    // `Copyright (c) 2025 Ryan McHarg`, and the same line with a year range.
    const m = /^Copyright \(c\)\s*(\d{4})(?:\s*[-–]\s*(\d{4}))?\s+(.+?)\s*$/m.exec(text);
    if (m) {
      origin.author = m[3];
      origin.since = m[1];
    }
  } catch {
    /* a checkout without a LICENSE says nothing about authorship rather than guessing. */
  }

  // AN OVERRIDE FIRST, because a remote is a local convenience: an SSH host alias, a fork's own
  // remote, or no remote at all in a tarball checkout. A deployment that knows its canonical URL
  // should be able to say so without this having to infer it.
  const declared = process.env.AE_PROJECT_REPO_URL;
  if (declared) {
    origin.repository = declared;
  } else {
    const url = httpsRepoUrl(forgeRemote(REPO_ROOT));
    // NOTHING DERIVED IS NOT A REASON TO ERASE. A tarball or a remote that names nothing would
    // otherwise rewrite a tracked, correct value away; the one already published stands.
    origin.repository = url || publishedRepository();
  }
  if (!origin.repository) delete origin.repository;

  return origin;
}

/**
 * The origin remote, followed through LOCAL CLONES to the checkout they were cloned from. A clean
 * clone made for a fresh deploy has the parent checkout's path as its origin, which names no forge;
 * the parent's own origin does. Bounded, so a remote loop cannot hang the sync.
 */
function forgeRemote(dir) {
  for (let hop = 0; hop < 4; hop++) {
    let remote;
    try {
      remote = execSync('git remote get-url origin', {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return ''; /* no remote, or not a git checkout at all. */
    }
    const local = remote.replace(/^file:\/\//, '');
    if (!fs.existsSync(local)) return remote;
    dir = local;
  }
  return '';
}

/** The repository the tracked about file already carries, or ''. */
function publishedRepository() {
  try {
    return JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_DIR, 'basic', 'agentechelon-about.json'), 'utf8')).repository || '';
  } catch {
    return '';
  }
}

/**
 * A remote as a browsable https URL, or '' when it cannot be said confidently.
 *
 * `git@github-mcharg:owner/repo.git` is an SSH HOST ALIAS - a local `~/.ssh/config` name that
 * resolves to github.com on one machine and means nothing anywhere else. Publishing it as a URL
 * would hand somebody an address that does not exist, which is worse than omitting it, so an alias
 * is only rewritten when it plainly names a known forge.
 */
function httpsRepoUrl(remote) {
  if (!remote) return '';
  const scp = /^(?:[^@]+@)?([^:/]+):([^/].*?)(?:\.git)?$/.exec(remote);
  const url = /^(?:https?|ssh|git):\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/.exec(remote);
  const [host, repoPath] = scp ? [scp[1], scp[2]] : url ? [url[1], url[2]] : ['', ''];
  if (!host || !repoPath) return '';
  const forge = /github/i.test(host) ? 'github.com'
    : /gitlab/i.test(host) ? 'gitlab.com'
      : host.includes('.') ? host : '';
  return forge ? `https://${forge}/${repoPath}` : '';
}

const docs = gatherDocs();
const blog = gatherBlog();
const origin = gatherOrigin();

// The overview is taken from PLATFORM-OVERVIEW (the positioning source) if present,
// else the README.
const overviewDoc = docs.find((d) => d.path.endsWith('PLATFORM-OVERVIEW.md'))
  || docs.find((d) => d.path.endsWith('README.md'));

const about = {
  project: 'AgentEchelon',
  // Read from LICENSE rather than restated, so a fork that relicenses does not ship an assistant
  // asserting the licence it was forked from. Falls back to the previous literal when there is no
  // LICENSE to read, which keeps a checkout without one answering exactly as it did before.
  license: origin.license || 'MIT',
  ...(origin.author ? { author: origin.author } : {}),
  ...(origin.since ? { since: origin.since } : {}),
  ...(origin.repository ? { repository: origin.repository } : {}),
  purpose:
    'AgentEchelon is a governed, multi-party, multi-channel AI platform you deploy into your own AWS '
    + 'account. This context lets the assistant answer questions about the platform itself - what it '
    + 'is, how it works, and where a topic is documented.',
  overview: overviewDoc?.summary || '',
  answering_guidance:
    'Answer from these summaries and, when deployed in Aurora mode, from the retrieved full docs. '
    + 'Point the user at the named doc path for detail. Do not fabricate; if it is not here, say so. '
    // ── WHAT IT CAN CITE AND WHAT IT CANNOT REACH (owner-reported, 2026-09-05) ─────────────────
    //
    // Asked about the project's origin, the assistant reached for the company documents, found
    // nothing, and reported that the platform's authorship was outside the knowledge it has. The
    // `author` and `repository` fields above are that answer, and this says they are usable: the
    // provenance of the platform is answered from HERE, not from the deploying company's documents,
    // which have no reason to carry it.
    //
    // AND THE LIMIT IS STATED, because the same turn implied it could go and look. There is no web
    // or repository access on this path - what exists is this file plus, in Aurora mode, the
    // retrieved docs. Naming the repository is how a person gets the source; offering to read it is
    // a promise nothing here can keep.
    + 'The `author`, `since`, `license` and `repository` fields above answer questions about who '
    + 'made the platform and where its source is - answer those from here rather than from the '
    + 'deploying company\'s documents, which do not carry them. You cannot browse the web or read '
    + 'that repository: cite it as where the source lives, and do not offer to look anything up in '
    + 'it.',
  docs,
  blog,
  generated_from: {
    repo_docs: docs.length,
    public_blog_posts: blog.length,
    blog_vault_used: Boolean(process.env.AE_BLOG_VAULT_PATH && fs.existsSync(process.env.AE_BLOG_VAULT_PATH)),
  },
};

// The superseded unscoped file, which every classification could read, is removed rather than left beside them.
fs.rmSync(path.join(KNOWLEDGE_DIR, 'agentechelon-about.json'), { force: true });
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(about, null, 2) + '\n');
console.log(`[sync-project-knowledge] wrote ${path.relative(REPO_ROOT, OUTPUT)}`);
// THE PUBLIC OVERVIEW: what the platform is and who made it, and nothing of how it is built.
const publicAbout = {
  project: about.project,
  license: about.license,
  author: about.author,
  since: about.since,
  repository: about.repository,
  purpose: about.purpose,
  overview: about.overview,
  answering_guidance:
    'Answer what the platform is and what it does, in plain terms, from the overview above. This is all the '
    + 'platform information available here: do not describe how it is built or configured, and say that an '
    + 'internal conversation covers that. The `author`, `since`, `license` and `repository` fields answer who '
    + 'made it and where its source is.',
};
fs.mkdirSync(path.dirname(OUTPUT_PUBLIC), { recursive: true });
fs.writeFileSync(OUTPUT_PUBLIC, JSON.stringify(publicAbout, null, 2) + '\n');
console.log(`[sync-project-knowledge] wrote ${path.relative(REPO_ROOT, OUTPUT_PUBLIC)}`);
console.log(`  repo docs indexed: ${docs.length}`);
console.log(`  public blog posts: ${blog.length}${blog.length === 0 ? ' (set AE_BLOG_VAULT_PATH to include them)' : ''}`);

if (RAG) {
  await ingestToRag();
} else {
  console.log('  RAG (Aurora deep Q&A): re-run with --rag against a deployed Aurora stack to ingest the full corpus into pgvector (see docs/RAG.md).');
}

/**
 * --rag: upload the FULL repo docs + public blog to the Aurora archive bucket under
 * rag/agentechelon/{INTERNAL_CLASSIFICATION}/. The DocumentIngestion Lambda (S3 PutObject notification on
 * `rag/`) chunks + Titan-embeds + stores them in the pgvector `embeddings` table, tagged with that
 * classification, so only a classification that grants it can retrieve them. Then every key under the
 * retired unscoped prefix is deleted; the delete event clears its chunks.
 *
 * WHAT IS PUT (scripts/lib/rag-sync-plan.cjs `planRagSync`). A key is put when it is new, when its content changed
 * (the `content-sha256` metadata each upload carries), or when the database holds no chunks for it, or chunks at
 * another ETag. The database is asked through the data plane's `ragSourceCoverage` op. Re-putting a key the database
 * holds nothing for re-fires the S3 event that ingests it, which is what recovers an ingest that timed out; an
 * unchanged key the database already holds is left alone. When the database cannot be asked, every key is put.
 *
 * --dry-run: write nothing to S3; print what would be put (and why) and deleted.
 * --verify: after the puts, wait until every synced key holds chunks written at its current ETag, and exit 1 when one
 *   does not within --verify-timeout=<seconds> (default 600). The knowledge-rag validate phase runs with it.
 */
async function ingestToRag() {
  const { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const require = createRequire(import.meta.url);
  const { CONTENT_HASH_METADATA, planRagSync, waitForIngest, coverageMap } = require('./lib/rag-sync-plan.cjs');
  const region = process.env.AWS_REGION || 'us-east-1';
  const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
  const stackName = process.env.AE_ANALYTICS_STACK || `${resolveStackPrefix(process.env)}Archive`;
  const dryRun = process.argv.includes('--dry-run');
  const verify = process.argv.includes('--verify');
  const timeoutArg = process.argv.find((a) => a.startsWith('--verify-timeout='))?.slice('--verify-timeout='.length);
  const verifyTimeoutMs = (timeoutArg ? Number(timeoutArg) : 600) * 1000;
  if (!Number.isFinite(verifyTimeoutMs) || verifyTimeoutMs <= 0) throw new Error(`--verify-timeout must be a positive number of seconds, got "${timeoutArg}"`);

  const cfn = new CloudFormationClient({ region });
  const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = {};
  for (const o of desc.Stacks?.[0]?.Outputs || []) outputs[o.OutputKey] = o.OutputValue;
  const bucket = outputs['ArchiveBucketName'];
  if (!bucket) {
    throw new Error(`ArchiveBucketName output not found on stack "${stackName}". RAG needs an Aurora-mode deploy (analyticsMode=aurora). Set AE_ANALYTICS_STACK if your stack is named differently.`);
  }
  const s3 = new S3Client({ region });
  const PREFIX = `rag/agentechelon/${INTERNAL_CLASSIFICATION}/`;

  // Checked BEFORE the first upload: the corpus must carry nothing the demo restricts to a higher
  // classification than the one it is ingested at.
  const docPaths = repoDocPaths();
  assertNoRestrictedDemoData(docPaths);

  // THE CORPUS, as the keys and bodies this run syncs. An empty body is left out: ingestion skips it, so it would
  // never hold chunks and would read as a failed ingest.
  const corpus = [];
  const add = (key, body) => {
    if (!body.trim()) return;
    corpus.push({ key, body, sha256: createHash('sha256').update(body, 'utf8').digest('hex') });
  };
  for (const p of docPaths) add(PREFIX + path.basename(p), fs.readFileSync(p, 'utf8'));
  const vault = process.env.AE_BLOG_VAULT_PATH;
  if (vault && fs.existsSync(vault)) {
    for (const name of fs.readdirSync(vault)) {
      if (!name.endsWith('.md')) continue;
      const { frontmatter, body } = splitFrontmatter(fs.readFileSync(path.join(vault, name), 'utf8'));
      if ((frontmatter.visibility || '').toLowerCase() !== 'public') continue;
      const slug = frontmatter.slug || name.replace(/\.md$/, '');
      add(`${PREFIX}blog-${slug}.md`, body);
    }
  }

  // WHAT S3 HOLDS, and WHAT THE DATABASE HOLDS.
  const heads = new Map();
  for (const { key } of corpus) {
    try {
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      heads.set(key, { sha256: h.Metadata?.[CONTENT_HASH_METADATA], etag: h.ETag });
    } catch (err) {
      if (err?.name !== 'NotFound' && err?.$metadata?.httpStatusCode !== 404) throw err;
    }
  }
  const dataPlane = await resolveDataPlane(region, stackName);
  const readCoverage = async () => coverageMap(await invokeDataPlane(dataPlane, 'ragSourceCoverage', { bucket, prefix: PREFIX }));
  let coverage = null;
  if (dataPlane) {
    try {
      coverage = await readCoverage();
    } catch (err) {
      console.warn(`  RAG: could not ask the database which keys hold chunks (${err.message}); every key is put.`);
    }
  } else {
    console.warn(`  RAG: no data-plane function on ${stackName}, so the database cannot be asked which keys hold chunks; every key is put.`);
  }

  const plan = planRagSync({ corpus, heads, coverage });
  const byReason = (r) => plan.put.filter((p) => p.reason === r).map((p) => p.key);
  const missing = [...byReason('no-chunks'), ...byReason('stale-chunks')];
  console.log(`  RAG: ${corpus.length} keys under s3://${bucket}/${PREFIX}: ${byReason('new').length} new, ${byReason('changed').length} changed, `
    + `${missing.length} without current chunks, ${plan.unchanged.length} unchanged and ingested`
    + `${coverage ? '' : `, ${byReason('coverage-unknown').length} put because the database could not be asked`}`);
  for (const key of missing) console.log(`       no current chunks: ${key}`);

  const retiredKeys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: RETIRED_RAG_PREFIX, ContinuationToken: token }));
    for (const o of page.Contents || []) if (o.Key) retiredKeys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  if (dryRun) {
    for (const p of plan.put) console.log(`  [dry-run] would put ${p.key} (${p.reason})`);
    for (const name of DEMO_DATASET_DOCS) console.log(`  [dry-run] would delete ${PREFIX + name} (a demo-dataset doc)`);
    for (const key of retiredKeys) console.log(`  [dry-run] would delete ${key} (the retired prefix)`);
    console.log('  [dry-run] nothing written to S3.');
    return;
  }

  // A doc that is excluded from the corpus is DELETED: the S3 delete event removes its chunks
  // (document-ingestion.ts removeObjectChunks), so nothing of it stays retrievable.
  const del = (key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  for (const name of DEMO_DATASET_DOCS) {
    await del(PREFIX + name);
  }

  const etags = new Map([...heads].map(([k, h]) => [k, h.etag]));
  const bodies = new Map(corpus.map((c) => [c.key, c]));
  for (const { key } of plan.put) {
    const { body, sha256 } = bodies.get(key);
    const res = await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: 'text/markdown', Metadata: { [CONTENT_HASH_METADATA]: sha256 },
    }));
    etags.set(key, res.ETag);
  }
  console.log(`  RAG: put ${plan.put.length} of ${corpus.length} keys; DocumentIngestion chunks + embeds + stores each put (classification=${INTERNAL_CLASSIFICATION}).`);

  // THE RETIRED PREFIX IS DELETED. Its chunks were readable by every classification; each delete event removes
  // the object's chunks (document-ingestion.ts removeObjectChunks).
  for (const key of retiredKeys) await del(key);
  console.log(`  RAG: deleted ${retiredKeys.length} retired keys under s3://${bucket}/${RETIRED_RAG_PREFIX}; their delete events clear the chunks`);

  if (!verify) return;
  // THE INGEST HAS SETTLED, or the run fails. A put returns before ingestion runs, so a successful sync says nothing
  // about the corpus until the database holds every key at its current ETag.
  if (!dataPlane) throw new Error(`--verify needs the data-plane function on ${stackName} to read which keys hold chunks.`);
  console.log(`  RAG: waiting up to ${verifyTimeoutMs / 1000}s for every synced key to hold chunks at its current ETag`);
  const { settled, unsettled } = await waitForIngest({
    keys: corpus.map((c) => c.key),
    etags,
    read: readCoverage,
    timeoutMs: verifyTimeoutMs,
    intervalMs: 15_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onPoll: (left) => console.log(`       ${corpus.length - left.length}/${corpus.length} ingested`),
  });
  if (!settled) {
    for (const key of unsettled) console.error(`       not ingested: ${key}`);
    throw new Error(`${unsettled.length} synced key(s) hold no chunks at their current ETag after ${verifyTimeoutMs / 1000}s. `
      + `Read the ${stackName} DocumentIngestion function's log and its dead-letter queue (alarm ${stackName}-document-ingestion-failed); `
      + 're-running the sync re-puts every key the database holds no chunks for.');
  }
  console.log(`  RAG: every synced key is ingested (${corpus.length}).`);
}

/**
 * This deployment's data-plane function on the Archive stack (by its logical id, never a generated function name),
 * or null when the stack has none.
 */
async function resolveDataPlane(region, stackName) {
  const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
  const { physicalIdsIn } = createRequire(import.meta.url)('./lib/stack-resources.cjs');
  const [name] = await physicalIdsIn(new CloudFormationClient({ region }), [stackName], {
    type: 'AWS::Lambda::Function', logicalId: /^DataPlaneLambda/,
  }).catch(() => []);
  return name ? { name, region } : null;
}

/** One data-plane op, synchronously; throws on a function error. */
async function invokeDataPlane(dataPlane, op, input) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const resp = await new LambdaClient({ region: dataPlane.region }).send(new InvokeCommand({
    FunctionName: dataPlane.name,
    Payload: Buffer.from(JSON.stringify({ op, input })),
  }));
  const payload = resp.Payload ? JSON.parse(Buffer.from(resp.Payload).toString('utf-8')) : null;
  if (resp.FunctionError) throw new Error(`data-plane ${op} failed: ${payload?.errorMessage || resp.FunctionError}`);
  return payload;
}
