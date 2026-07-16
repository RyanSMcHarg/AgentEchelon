/**
 * sync-project-knowledge.mjs
 *
 * Gives the demo assistants knowledge OF AGENTECHELON ITSELF, so at any tier they
 * can answer "what is this / how does X work" about the platform they run on.
 *
 * Two outputs (per the launch decision: curated + RAG):
 *   1. CURATED (this script, offline): a concise, all-tier context file written to
 *      backend/demo/context/basic/agentechelon-about.json. It lands in the `basic/`
 *      prefix, which EVERY tier inherits (basic reads basic/*, standard reads
 *      basic/*+standard/*, premium reads all), so the pitch + a documented index are
 *      available in Athena AND Aurora mode via the `load_company_context` tool.
 *   2. RAG (Aurora only, needs a deploy): with `--rag`, the SAME file set (full repo
 *      docs + public blog) is uploaded to the Aurora archive bucket under
 *      `rag/agentechelon/basic/`. The DocumentIngestion Lambda (S3 notification on
 *      `rag/`) chunks + Titan-embeds + stores each in pgvector, tagged tier=basic so
 *      every tier can retrieve it, for deep semantic Q&A (docs/RAG.md). Idempotent on
 *      S3 ETag. Requires a deployed Aurora-mode stack + creds.
 *
 * Content = repo docs + public blog (no source code), per the launch decision.
 *
 * Usage:
 *   node backend/scripts/sync-project-knowledge.mjs
 *   AE_BLOG_VAULT_PATH="/path/to/mcharg-site/McHarg Site/Blog/Posts" node backend/scripts/sync-project-knowledge.mjs
 *
 * The blog vault is external (not in this repo); it is OPTIONAL and skipped when the
 * path is unset or missing - OSS users just get the repo-docs knowledge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
// Platform self-knowledge lives OUTSIDE the company `context/` tree so it is
// retrieved separately (load_platform_info tool), not bundled into every
// company-context load. seed-demo uploads it to the `platform-knowledge/` S3 prefix.
const OUTPUT = path.join(REPO_ROOT, 'backend', 'demo', 'platform-knowledge', 'agentechelon-about.json');
const RAG = process.argv.includes('--rag');

// Repo docs to index: README + every docs/**/*.md. docs/ is organized into
// subfolders (overview/ guides/ specs/ design/), so walk it recursively. Excludes
// decisions/ (ADRs) and non-doc/marker assets.
function repoDocPaths() {
  const paths = [path.join(REPO_ROOT, 'README.md')];
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
      if (name.endsWith('.md')) paths.push(path.join(dir, name));
    }
  };
  walk(DOCS_DIR);
  return paths.filter((p) => fs.existsSync(p));
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

const docs = gatherDocs();
const blog = gatherBlog();

// The overview is taken from PLATFORM-OVERVIEW (the positioning source) if present,
// else the README.
const overviewDoc = docs.find((d) => d.path.endsWith('PLATFORM-OVERVIEW.md'))
  || docs.find((d) => d.path.endsWith('README.md'));

const about = {
  project: 'AgentEchelon',
  license: 'MIT',
  purpose:
    'AgentEchelon is a governed, multi-party, multi-channel AI platform you deploy into your own AWS '
    + 'account. This context lets the assistant answer questions about the platform itself - what it '
    + 'is, how it works, and where a topic is documented.',
  overview: overviewDoc?.summary || '',
  answering_guidance:
    'Answer from these summaries and, when deployed in Aurora mode, from the retrieved full docs. '
    + 'Point the user at the named doc path for detail. Do not fabricate; if it is not here, say so.',
  docs,
  blog,
  generated_from: {
    repo_docs: docs.length,
    public_blog_posts: blog.length,
    blog_vault_used: Boolean(process.env.AE_BLOG_VAULT_PATH && fs.existsSync(process.env.AE_BLOG_VAULT_PATH)),
  },
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(about, null, 2) + '\n');
console.log(`[sync-project-knowledge] wrote ${path.relative(REPO_ROOT, OUTPUT)}`);
console.log(`  repo docs indexed: ${docs.length}`);
console.log(`  public blog posts: ${blog.length}${blog.length === 0 ? ' (set AE_BLOG_VAULT_PATH to include them)' : ''}`);

if (RAG) {
  await ingestToRag();
} else {
  console.log('  RAG (Aurora deep Q&A): re-run with --rag against a deployed Aurora stack to ingest the full corpus into pgvector (see docs/RAG.md).');
}

/**
 * --rag: upload the FULL repo docs + public blog to the Aurora archive bucket under
 * rag/agentechelon/basic/. The DocumentIngestion Lambda (S3 PutObject notification on
 * `rag/`) chunks + Titan-embeds + stores them in the pgvector `embeddings` table. The
 * `basic` tier segment makes every chunk retrievable at ALL tiers (retrieval scope is
 * cumulative). Idempotent on S3 ETag. Requires a deployed Aurora-mode stack + creds.
 */
async function ingestToRag() {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const region = process.env.AWS_REGION || 'us-east-1';
  const stackName = process.env.AE_ANALYTICS_STACK || 'AgentEchelonAnalyticsAurora';

  const cfn = new CloudFormationClient({ region });
  const desc = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = {};
  for (const o of desc.Stacks?.[0]?.Outputs || []) outputs[o.OutputKey] = o.OutputValue;
  const bucket = outputs['ArchiveBucketName'];
  if (!bucket) {
    throw new Error(`ArchiveBucketName output not found on stack "${stackName}". RAG needs an Aurora-mode deploy (analyticsMode=aurora). Set AE_ANALYTICS_STACK if your stack is named differently.`);
  }
  const s3 = new S3Client({ region });
  const PREFIX = 'rag/agentechelon/basic/'; // basic tier = retrievable at ALL tiers

  const put = (key, body) =>
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/markdown' }));

  let n = 0;
  for (const p of repoDocPaths()) {
    await put(PREFIX + path.basename(p), fs.readFileSync(p, 'utf8'));
    n++;
  }
  const vault = process.env.AE_BLOG_VAULT_PATH;
  if (vault && fs.existsSync(vault)) {
    for (const name of fs.readdirSync(vault)) {
      if (!name.endsWith('.md')) continue;
      const { frontmatter, body } = splitFrontmatter(fs.readFileSync(path.join(vault, name), 'utf8'));
      if ((frontmatter.visibility || '').toLowerCase() !== 'public') continue;
      const slug = frontmatter.slug || name.replace(/\.md$/, '');
      await put(`${PREFIX}blog-${slug}.md`, body);
      n++;
    }
  }
  console.log(`  RAG: uploaded ${n} files to s3://${bucket}/${PREFIX}`);
  console.log('       DocumentIngestion Lambda chunks + embeds + stores them (tier=basic, all-tier). Idempotent on ETag.');
}
