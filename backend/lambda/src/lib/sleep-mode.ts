/**
 * Cost sleep mode — shared logic for the auto-sleep / wake feature.
 *
 * Design + rationale: docs/SPEC-COST-SLEEP-MODE.md. In short: an Aurora-mode
 * deployment's idle cost is dominated by Aurora Serverless v2 billing its
 * minimum ACU 24/7. "Sleep" pauses that (ModifyDBCluster → ServerlessV2
 * MinCapacity = 0) after a configurable idle period; "wake" restores it. A
 * single-item DynamoDB record holds the state + last-activity timestamp and
 * doubles as the app-level maintenance flag.
 *
 * This module keeps the PURE decision logic (shouldSleep / parseIdleThresholdMs)
 * free of AWS calls so it is unit-testable without mocks; the AWS-touching
 * helpers (DynamoDB / RDS / SNS) are thin wrappers below.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { RDSClient, ModifyDBClusterCommand } from '@aws-sdk/client-rds';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

export type DeploymentState = 'awake' | 'asleep';

export interface DeploymentStateRecord {
  /** Partition key — always the literal below (single-item table). */
  id: string;
  state: DeploymentState;
  /** Epoch ms of the last observed user activity. */
  lastActivityAt: number;
  /** Epoch ms the state last changed. */
  changedAt: number;
  /** Who/what last changed the state: 'auto-idle' | 'admin:<sub>' | 'init'. */
  changedBy: string;
}

/** Fixed partition-key value for the single-item deployment-state table. */
export const DEPLOYMENT_STATE_KEY = 'deployment-state';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// ---------------------------------------------------------------------------
// Pure logic (no AWS) — unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Parse an idle-threshold spec into milliseconds. Accepts `<n>m` (minutes),
 * `<n>h` (hours), `<n>d` (days), or a bare integer (minutes). Returns null on
 * anything unparseable so the caller can fall back to a safe default rather
 * than sleep on a garbage threshold.
 */
export function parseIdleThresholdMs(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = String(spec).trim().toLowerCase().match(/^(\d+)\s*(m|min|h|hr|hour|d|day|hours|minutes|days)?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || 'm';
  const perUnit: Record<string, number> = {
    m: 60_000, min: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
  };
  return n * perUnit[unit];
}

/**
 * Should the deployment sleep right now? True only when it is currently awake
 * AND has been idle longer than the threshold. Defensive against a missing /
 * future `lastActivityAt` (treats non-finite as "active now" → never sleeps on
 * bad data).
 */
export function shouldSleep(
  record: Pick<DeploymentStateRecord, 'state' | 'lastActivityAt'>,
  thresholdMs: number,
  now: number,
): boolean {
  if (record.state !== 'awake') return false;
  const last = record.lastActivityAt;
  if (!Number.isFinite(last)) return false;
  if (last > now) return false;
  return now - last > thresholdMs;
}

// ---------------------------------------------------------------------------
// AWS-touching helpers.
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const rds = new RDSClient({ region: AWS_REGION });
const sns = new SNSClient({ region: AWS_REGION });

function stateTableName(): string {
  const t = process.env.DEPLOYMENT_STATE_TABLE;
  if (!t) throw new Error('DEPLOYMENT_STATE_TABLE env not set');
  return t;
}

export async function getDeploymentState(): Promise<DeploymentStateRecord | null> {
  const res = await ddb.send(new GetCommand({
    TableName: stateTableName(),
    Key: { id: DEPLOYMENT_STATE_KEY },
  }));
  return (res.Item as DeploymentStateRecord) ?? null;
}

/**
 * Record user activity. Fire-and-forget from the hot path: only bumps
 * `lastActivityAt`, never creates contention on the state field. Best-effort —
 * callers must swallow errors so a state-table hiccup never blocks a reply.
 */
export async function touchActivity(now: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: stateTableName(),
    Key: { id: DEPLOYMENT_STATE_KEY },
    UpdateExpression: 'SET lastActivityAt = :now, #st = if_not_exists(#st, :awake), changedAt = if_not_exists(changedAt, :now), changedBy = if_not_exists(changedBy, :init)',
    ExpressionAttributeNames: { '#st': 'state' },
    ExpressionAttributeValues: { ':now': now, ':awake': 'awake', ':init': 'init' },
  }));
}

export async function setDeploymentState(
  state: DeploymentState,
  changedBy: string,
  now: number,
): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: stateTableName(),
    Key: { id: DEPLOYMENT_STATE_KEY },
    UpdateExpression: 'SET #st = :state, changedAt = :now, changedBy = :by, lastActivityAt = if_not_exists(lastActivityAt, :now)',
    ExpressionAttributeNames: { '#st': 'state' },
    ExpressionAttributeValues: { ':state': state, ':now': now, ':by': changedBy },
  }));
}

/**
 * Set the Aurora Serverless v2 minimum capacity. Sleep → 0 (lets the cluster
 * pause and stop billing when idle); wake → the configured floor. Throws on
 * failure so the caller can decline to flip state (never report "asleep" while
 * the DB is still billing).
 */
export async function setAuroraMinCapacity(minCapacity: number): Promise<void> {
  const clusterId = process.env.AURORA_CLUSTER_ID;
  if (!clusterId) throw new Error('AURORA_CLUSTER_ID env not set');
  const maxCapacity = Number(process.env.AURORA_WAKE_MAX_ACU || '4');
  await rds.send(new ModifyDBClusterCommand({
    DBClusterIdentifier: clusterId,
    ApplyImmediately: true,
    ServerlessV2ScalingConfiguration: { MinCapacity: minCapacity, MaxCapacity: maxCapacity },
  }));
}

export async function notify(subject: string, message: string): Promise<void> {
  const topicArn = process.env.SLEEP_TOPIC_ARN;
  if (!topicArn) return; // notifications are optional
  await sns.send(new PublishCommand({ TopicArn: topicArn, Subject: subject.slice(0, 100), Message: message }));
}
