/**
 * Real readers for the catalog's source types (SPEC-CONTEXT-SOURCES-AND-STORES phase 5).
 *
 * `context-sources-runtime.ts` owns the security invariants and stays pure; this owns the I/O. The
 * split is deliberate: a new source type is a reader here, never a branch in the resolver, and the
 * resolver's tests never need an AWS mock.
 *
 * Every reader is best-effort by contract. Returning null (or throwing) omits that source's section
 * and nothing else - INV-CTX-CAT-4. So none of these retry, and none of them raise for an absent
 * resource: a missing digest is a source with nothing to say, not a broken turn.
 *
 * Best-effort is NOT the same as silent. A reader that cannot read for a reason it knows - above all
 * an authorisation refusal - raises {@link ContextSourceAccessError} carrying that reason, so the
 * resolver can count it. Only an ABSENT thing is swallowed. The distinction matters because these two
 * used to arrive identically: a bare `catch {}` around the S3 GetObject turned `AccessDenied` into the
 * same empty result as a missing object, which meant a broken or probed IAM grant produced no signal
 * anywhere - not a log line, not a metric.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { PublishedContextSource } from './context-sources-runtime.js';
import {
  ContextSourceAccessError,
  classifyAccessError,
  emitContextSourceFieldFailure,
} from './context-source-outcomes.js';

/**
 * What a reader knows about the turn.
 *
 * `userSub` is why `availability` exists: a per-user source cannot resolve without it, and at
 * `WelcomeIntent` it is not yet reliably known. A reader must never invent a fallback identity - it
 * returns null and the section is omitted.
 */
export interface ReaderContext {
  classification: string;
  userSub?: string;
  channelArn?: string;
}

export interface ReaderClients {
  s3?: S3Client;
  ddb?: DynamoDBClient;
  ssm?: SSMClient;
  lambda?: LambdaClient;
}

/** `from` falls back to the field name; `s3-prefix` additionally defaults to `{field}.json`. */
function sourceKeyFor(field: string, from: string | undefined, isS3: boolean): string {
  if (from) return from;
  return isS3 ? `${field}.json` : field;
}

/**
 * Walk a dotted path into a DynamoDB AttributeValue tree: `facts.company`.
 *
 * Needed because real records nest. The built-in user profile store writes
 * `{ userSub, onboardedAt, facts: { company, role }, updatedAt }`, so a catalog that could only name
 * TOP-LEVEL attributes could not read a single onboarding answer - the shipped `user-profile` entry
 * declared `company` and `role`, found neither, and resolved to nothing on every turn for every user.
 *
 * Only `.M` is traversed. A path that runs into a scalar, a list, or a missing key yields undefined
 * rather than guessing, so a mistyped path reads as an absent field and not as a wrong value.
 */
function attributeAtPath(
  item: Record<string, { S?: string; N?: string; M?: Record<string, unknown> }>,
  path: string,
): { S?: string; N?: string } | undefined {
  const segments = path.split('.');
  let node: unknown = item[segments[0]];
  for (const segment of segments.slice(1)) {
    const map = (node as { M?: Record<string, unknown> } | undefined)?.M;
    if (!map) return undefined;
    node = map[segment];
  }
  return node as { S?: string; N?: string } | undefined;
}

async function streamToString(body: unknown): Promise<string> {
  if (!body) return '';
  const anyBody = body as { transformToString?: () => Promise<string> };
  if (typeof anyBody.transformToString === 'function') return anyBody.transformToString();
  return String(body);
}

/**
 * Pull a declared field out of a fetched object.
 *
 * A source may return the value directly (a text file) or as a property of a JSON document. Trying
 * the property first and falling back to the whole body keeps both shapes working without the catalog
 * having to declare which - and the declared field NAME is what disambiguates.
 */
function extractField(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    // Look up the FIELD name, never `from`. For an s3-prefix source `from` is the OBJECT KEY
    // (`_digest.json`), not a property - using it here looked for a property called "_digest.json",
    // found nothing, and silently returned the entire document as the value.
    const named = parsed?.[field];
    if (named !== undefined && named !== null) {
      return typeof named === 'string' ? named : JSON.stringify(named);
    }
  } catch {
    /* not JSON after all - fall through to the raw body */
  }
  return trimmed;
}

/**
 * A precondition the reader cannot proceed without, and which is a CONFIGURATION fault rather than a
 * content gap: an unwired client or a catalog entry with no locator. Raised as `error` so it lands in
 * the failure metric instead of masquerading as "nothing to say".
 */
function requireReadable(condition: unknown, entry: PublishedContextSource, what: string): void {
  if (!condition) {
    throw new ContextSourceAccessError('error', entry.key, `${entry.key}: ${what}`);
  }
}

/**
 * Run one SDK call, converting any failure into a CLASSIFIED one.
 *
 * The single-object readers (DynamoDB, SSM, Lambda) previously let the raw SDK error propagate. The
 * resolver caught it and counted `error`, so a refusal on a per-user table looked the same as a
 * malformed response - the distinction the security signal depends on. This is where it is drawn.
 */
async function rethrowAccessFailures<T>(
  entry: PublishedContextSource,
  target: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const reason = classifyAccessError(err);
    throw new ContextSourceAccessError(
      reason, entry.key, `${entry.key}: reading ${target} was refused or failed (${reason})`, err,
    );
  }
}

/**
 * Build the reader the resolver calls. Dispatches on `type`; an unknown type reads NOTHING rather
 * than guessing, so a catalog entry the runtime does not understand degrades to an omitted section
 * instead of an unpredictable one.
 */
export function createSourceReader(ctx: ReaderContext, clients: ReaderClients) {
  return async (entry: PublishedContextSource): Promise<Record<string, string> | null> => {
    switch (entry.type) {
      case 's3-prefix': {
        // Bucket and prefix come from the PUBLISHED entry, so the read lands exactly where the IAM
        // grant was scoped. This previously hardcoded `context/{classification}/` because the catalog
        // stripped `prefix` before publication - which meant the authorised resource and the read
        // resource could name different locations, and a per-team prefix was granted but never read.
        requireReadable(clients.s3, entry, 'no S3 client is wired into the processor');
        requireReadable(entry.locator, entry, 'the catalog entry publishes no bucket locator');
        const values: Record<string, string> = {};
        for (const [field, spec] of Object.entries(entry.fields)) {
          const key = `${entry.prefix || ''}${sourceKeyFor(field, spec.from, true)}`;
          try {
            const res = await clients.s3!.send(
              new GetObjectCommand({ Bucket: entry.locator, Key: key }),
            );
            values[field] = extractField(await streamToString(res.Body), field);
          } catch (err) {
            // Three dispositions, and the old bare `catch {}` collapsed them into one.
            //
            // ABSENT  a field with nothing to say. Required-vs-optional is the renderer's call (a
            //         required field renders "(unavailable)"), so it does not fail the source.
            // DENIED  a fact about the GRANT, not about this object. Continuing would resolve the
            //         source from its other fields and present a partially-refused read as a healthy
            //         one, so it fails the whole source and is counted as `denied`.
            // OTHER   throttling, a malformed body, a transient fault. The other fields are still
            //         worth having, so the loop continues - but it is COUNTED, because a swallowed
            //         error that leaves the turn looking healthy is what this module is fixing.
            const reason = classifyAccessError(err);
            if (reason === 'absent') continue;
            if (reason === 'denied') {
              throw new ContextSourceAccessError(
                'denied',
                entry.key,
                `${entry.key}: reading s3://${entry.locator}/${key} was DENIED`,
                err,
              );
            }
            console.warn(`[context-sources] '${entry.key}' field '${field}' failed (${reason}); continuing:`, err);
            // Its OWN metric, not ContextSourceFailed. The source may still resolve from its other
            // fields, and counting this as a source failure would put the same source on both sides
            // of the failure-rate ratio - making the percentage mean something other than
            // sources-failed over sources-attempted.
            emitContextSourceFieldFailure({
              classification: ctx.classification, sourceKey: entry.key, field, reason,
            });
          }
        }
        return Object.keys(values).length ? values : null;
      }

      case 'dynamodb-table': {
        // Per-user by construction. No userSub means the caller is not yet identified, which is
        // exactly what `availability: identity-settled` is meant to have prevented - so this is a
        // second line of defence, not the primary one. It is `absent` rather than `error`: at a call
        // site with no settled identity there is genuinely nothing to read, and alarming on it would
        // train an operator to ignore the metric.
        requireReadable(clients.ddb, entry, 'no DynamoDB client is wired into the processor');
        requireReadable(entry.locator, entry, 'the catalog entry publishes no table locator');
        if (!ctx.userSub) return null;
        const res = await rethrowAccessFailures(entry, `dynamodb:${entry.locator}`, () =>
          clients.ddb!.send(new GetItemCommand({
            TableName: entry.locator,
            Key: { userSub: { S: ctx.userSub! } },
          })));
        if (!res.Item) return null;
        const values: Record<string, string> = {};
        for (const [field, spec] of Object.entries(entry.fields)) {
          // `from` may be a dotted path into a nested map (`facts.company`), because real records
          // nest and a top-level-only lookup silently read nothing.
          const attr = attributeAtPath(res.Item, spec.from || field);
          if (attr?.S) values[field] = attr.S;
          else if (attr?.N) values[field] = attr.N;
        }
        return Object.keys(values).length ? values : null;
      }

      case 'ssm-parameter': {
        requireReadable(clients.ssm, entry, 'no SSM client is wired into the processor');
        requireReadable(entry.locator, entry, 'the catalog entry publishes no parameter locator');
        // The parameter VALUE is the source; a single declared field receives it.
        const [field] = Object.keys(entry.fields);
        requireReadable(field, entry, 'the catalog entry declares no field to receive the value');
        const res = await rethrowAccessFailures(entry, `ssm:${entry.locator}`, () =>
          clients.ssm!.send(new GetParameterCommand({ Name: entry.locator })));
        const value = res.Parameter?.Value;
        return value ? { [field]: value } : null;
      }

      case 'lambda-service': {
        requireReadable(clients.lambda, entry, 'no Lambda client is wired into the processor');
        requireReadable(entry.locator, entry, 'the catalog entry publishes no function locator');
        const res = await rethrowAccessFailures(entry, `lambda:${entry.locator}`, () =>
          clients.lambda!.send(new InvokeCommand({
            // Addressed by the published LOCATOR (the function name), not the ARN - the ARN is the
            // grant resource and is stripped before publication, so the invoke lands on exactly the
            // function `lambda:InvokeFunction` was scoped to.
            FunctionName: entry.locator,
            Payload: Buffer.from(JSON.stringify({ userSub: ctx.userSub, classification: ctx.classification })),
          })));
        if (!res.Payload) return null;
        const parsed = JSON.parse(Buffer.from(res.Payload).toString('utf8')) as Record<string, unknown>;
        const values: Record<string, string> = {};
        for (const [field, spec] of Object.entries(entry.fields)) {
          const v = parsed?.[spec.from || field];
          if (v !== undefined && v !== null) values[field] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        return Object.keys(values).length ? values : null;
      }

      default:
        // A published type this build cannot read is a version skew between the deployed stack and the
        // deployed Lambda, not a content gap - so it is counted as a failure rather than swallowed.
        console.warn(`[context-sources] '${entry.key}' has unreadable type '${entry.type}'; omitting`);
        throw new ContextSourceAccessError(
          'error', entry.key, `${entry.key}: no reader for published type '${entry.type}'`,
        );
    }
  };
}
