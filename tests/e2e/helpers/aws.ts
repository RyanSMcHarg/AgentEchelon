/**
 * THE AWS CLI, AS EVERY e2e HELPER AND SPEC CALLS IT.
 *
 * One runner, so the environment every call needs is set once:
 *   - `MSYS_NO_PATHCONV=1`: SSM names and IAM paths begin with `/`, which Git Bash on Windows rewrites
 *     into a drive path.
 *   - `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`: the CLI is Python, and its default console codec on
 *     Windows is the system ANSI page, so a row or message carrying a real arrow or an emoji kills the
 *     command rather than the read (measured live: `'charmap' codec can't encode character '→'`, and
 *     with the encoding variable alone, the same for '✅'). Model-authored text is ordinary here.
 *
 * `aws` takes a command string through the shell; `awsv` takes an argv and goes through no shell, for
 * arguments a shell would mangle (JSON keys, JMESPath with spaces and quotes). Both return parsed JSON,
 * or null for an empty answer. `awsvText` returns the raw output, for `--output text` reads.
 */
import { execFileSync, execSync } from 'child_process';

const REGION = process.env.AWS_REGION || 'us-east-1';

export interface AwsCallOptions {
  /** Default 60 seconds. */
  timeoutMs?: number;
  /** Default 20 MB. */
  maxBufferMb?: number;
  /** Keep the CLI's stderr out of the run log (it stays on the thrown error). */
  quiet?: boolean;
}

function runOptions(opts: AwsCallOptions = {}) {
  return {
    encoding: 'utf8' as const,
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: (opts.maxBufferMb ?? 20) * 1024 * 1024,
    ...(opts.quiet ? { stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] } : {}),
    env: { ...process.env, MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  };
}

/** `aws <cmd> --region <region> --output json`, through the shell. Throws on a CLI error. */
export function aws<T = any>(cmd: string, opts?: AwsCallOptions): T {
  const out = execSync(`aws ${cmd} --region ${REGION} --output json`, runOptions(opts)).trim();
  return (out ? JSON.parse(out) : null) as T;
}

/** The same, and null on a CLI error, for a read whose absence the caller states. */
export function awsOrNull(cmd: string, opts?: AwsCallOptions): any {
  try {
    return aws(cmd, { quiet: true, ...opts });
  } catch {
    return null;
  }
}

/** `aws ...args --region <region> --output json`, with no shell. Throws on a CLI error. */
export function awsv(args: string[], opts?: AwsCallOptions): any {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], runOptions(opts)).trim();
  return out ? JSON.parse(out) : null;
}

/** `aws ...args --region <region>`, with no shell, returning the raw output trimmed. */
export function awsvText(args: string[], opts?: AwsCallOptions): string {
  return execFileSync('aws', [...args, '--region', REGION], runOptions(opts)).trim();
}
