import React, { useState } from 'react';
import DataTable from './DataTable';
import { DocLink, InfoTooltip } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import type { AnalyticsResult, ExecutionStep, ExecutionStepRow } from '@ae/shared';

/**
 * StepsTab — the admin per-message step breakdown
 * (SPEC-MESSAGE-METADATA-CODEBOOK.md / ADR-016; SPEC-BATTLE "Per-Step Telemetry").
 *
 * Each bot turn's self-hosted tool loop records a step per Converse iteration
 * (generate / tool / tool-propose); the array is persisted out-of-band and
 * merged by archival into Aurora's `messages.metadata->'steps'`. This view lists
 * recent turns that carry steps and reveals the full per-step table on demand:
 * which model actually ran each step, its duration, tokens, and estimated cost.
 *
 * Aurora-only — the steps live in the messages JSONB column (Athena's
 * partition-only table has none; the dashboard shows the Aurora-only banner).
 */
interface StepsTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatCost(c: number | null | undefined): string {
  if (c == null) return '—';
  return `$${c.toFixed(c < 0.01 ? 4 : 3)}`;
}

function stepDurationMs(s: ExecutionStep): number | null {
  const start = Date.parse(s.startedAt);
  const end = Date.parse(s.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
}

/** A label color cue so generate vs tool steps read at a glance. */
function stepKindColor(label: string): string {
  if (label.startsWith('tool-propose')) return 'var(--status-warn)';
  if (label.startsWith('tool')) return 'var(--status-info)';
  return 'var(--status-good)'; // generate
}

const StepsTab: React.FC<StepsTabProps> = ({ data, isLoading }) => {
  const [selected, setSelected] = useState<ExecutionStepRow | null>(null);

  if (isLoading) {
    return <div className="admin-tab-loading">Loading execution steps...</div>;
  }

  const rows = (data?.data as unknown as ExecutionStepRow[]) ?? [];

  return (
    <div className="admin-tab">
      <h3>
        Execution Steps{' '}
        <InfoTooltip
          label="What is a step?"
          content="A step is one round of the assistant's work on a single reply. Simple answers take one step; when the assistant looks something up or uses a tool, it adds a step for each round. This tab shows those steps so you can see WHY a reply took as long (or cost as much) as it did — which model ran, how long each round took, and the tokens/cost per round."
        />
      </h3>
      <p className="admin-tab-description">
        Most replies are a single step. When the assistant needs to look something up or
        run a tool before answering, it takes extra steps — and each one adds latency and
        cost. Use this to break down a slow or expensive turn: pick a row to see every step
        for that reply, the model that ran it, its duration, and its estimated cost.{' '}
        <DocLink href={DOC_LINKS.messageFlow}>How a reply is produced</DocLink>
      </p>

      <DataTable
        columns={[
          {
            key: 'timestamp',
            label: 'When',
            render: (v) => (v ? new Date(String(v)).toLocaleString() : '—'),
          },
          { key: 'intent', label: 'Intent', render: (v) => (v ? String(v) : '—') },
          { key: 'bedrock_model', label: 'Model', render: (v) => (v ? String(v) : '—') },
          { key: 'step_count', label: 'Steps' },
          { key: 'total_ms', label: 'Total time', render: (v) => formatMs(v as number | null) },
          {
            key: 'actions',
            label: '',
            sortable: false,
            render: (_v, row) => (
              <button
                className="admin-btn admin-btn-small"
                onClick={() => setSelected(row as unknown as ExecutionStepRow)}
              >
                Steps
              </button>
            ),
          },
        ]}
        data={rows as unknown as Record<string, unknown>[]}
        emptyMessage="No per-step telemetry recorded for this period (Aurora mode only)"
      />

      {selected && (
        <div className="admin-flow-detail">
          <div className="admin-flow-detail-header">
            <h4>Steps — {String(selected.message_id).substring(0, 12)}…</h4>
            <button className="admin-btn admin-btn-small" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>

          <div className="admin-flow-meta">
            <span>Intent: {selected.intent ?? '—'}</span>
            <span>Model: {selected.bedrock_model ?? '—'}</span>
            <span>Total: {formatMs(selected.total_ms)}</span>
            <span>Steps: {selected.step_count}</span>
          </div>

          <DataTable
            columns={[
              { key: 'n', label: '#', sortable: false },
              {
                key: 'stepLabel',
                label: 'Step',
                render: (v) => (
                  <span style={{ color: stepKindColor(String(v)), fontWeight: 600 }}>{String(v)}</span>
                ),
              },
              { key: 'modelId', label: 'Model', render: (v) => (v ? String(v) : '—') },
              { key: 'durationMs', label: 'Duration', render: (v) => formatMs(v as number | null) },
              {
                key: 'tokens',
                label: 'Tokens (in/out)',
                sortable: false,
                render: (_v, row) => `${(row.tokensIn as number) ?? 0} / ${(row.tokensOut as number) ?? 0}`,
              },
              { key: 'estCostUsd', label: 'Est. cost', render: (v) => formatCost(v as number | null) },
            ]}
            data={(selected.steps ?? []).map((s, i) => ({
              n: i + 1,
              stepLabel: s.stepLabel,
              modelId: s.modelId,
              durationMs: stepDurationMs(s),
              tokensIn: s.tokensIn ?? 0,
              tokensOut: s.tokensOut ?? 0,
              estCostUsd: s.estCostUsd ?? null,
            }))}
            emptyMessage="No steps on this message"
          />
        </div>
      )}
    </div>
  );
};

export default StepsTab;
