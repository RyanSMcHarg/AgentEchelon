/**
 * A RUN'S MESSAGES RECORD ITS WORKFLOW (ADR-067 decision 6, WT60, migration 099).
 *
 * What it proves: a bot message a run says carries its workflow, step, run, origin version and workflow hash from its own
 * `eventStep` and `eventRun`, and a turn of a run's task carries them from the task's `workflowRun` in its analytics; a
 * person's message carries none; and the projection has the five columns, in the archival's write list.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runFieldsOf } from '../../lambda/src/analytics-aurora/kinesis-archival';

describe('a run\'s fields on its messages', () => {
  it('reads a run\'s own message from its eventStep and eventRun', () => {
    expect(runFieldsOf(true, {
      eventStep: { workflow: 'ops-room', step: 'opening', event: 'conversation-opened' },
      eventRun: { runKey: 'conversation-opened#c#advisor', originConfigId: 'cfg-1', workflowHash: 'abc123def456' },
    }, {})).toEqual({
      workflow_name: 'ops-room', workflow_step: 'opening', workflow_run_key: 'conversation-opened#c#advisor',
      workflow_origin_config_id: 'cfg-1', workflow_origin_hash: 'abc123def456', workflow_trigger: null,
    });
  });

  it('reads a run\'s task turn from the task\'s run in its analytics', () => {
    expect(runFieldsOf(true, null, { workflowRun: { workflow: 'report_generation', step: 'work', runKey: 'intent#corr#advisor', originConfigId: 'cfg-2', workflowHash: 'fff' } })).toMatchObject({
      workflow_name: 'report_generation', workflow_run_key: 'intent#corr#advisor', workflow_origin_hash: 'fff',
    });
  });

  it('a person\'s message, and a bot message no run said, carry none', () => {
    const none = { workflow_name: null, workflow_step: null, workflow_run_key: null, workflow_origin_config_id: null, workflow_origin_hash: null, workflow_trigger: null };
    expect(runFieldsOf(false, { eventStep: { workflow: 'x', step: 'y' } }, {})).toEqual(none);
    expect(runFieldsOf(true, {}, {})).toEqual(none);
  });

  it('the projection has the five columns, indexed by edition, and the archival writes them', () => {
    const sql = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/schema/099-a-runs-turns-record-its-workflow.sql'), 'utf8');
    for (const col of ['workflow_name', 'workflow_step', 'workflow_run_key', 'workflow_origin_config_id', 'workflow_origin_hash']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col} `);
    }
    expect(sql).toMatch(/idx_messages_workflow_edition ON messages \(workflow_name, workflow_origin_hash\)/);
    const archival = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/kinesis-archival.ts'), 'utf8');
    expect(archival).toMatch(/'workflow_origin_hash',\s*\/\/ WT118 \(migration 100\)\.\s*'workflow_trigger',\s*'experiment_id'/);
  });
});
