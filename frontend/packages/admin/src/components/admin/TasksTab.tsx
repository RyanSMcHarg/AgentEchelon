import React, { useState } from 'react';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import type { AnalyticsResult } from '@ae/shared';

interface TasksTabProps {
  metricsData: AnalyticsResult | null;
  detailData: AnalyticsResult | null;
  isLoading: boolean;
}

function statusBadge(status: string): React.ReactNode {
  const colors: Record<string, string> = {
    completed: 'var(--status-good)',
    in_progress: 'var(--status-info)',
    pending: 'var(--status-neutral)',
    failed: 'var(--status-bad)',
    cancelled: 'var(--status-warn)',
  };
  const color = colors[status] || 'var(--status-neutral)';
  return (
    <span style={{ backgroundColor: `${color}20`, color, padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600 }}>
      {status}
    </span>
  );
}

const TasksTab: React.FC<TasksTabProps> = ({ metricsData, detailData, isLoading }) => {
  const [view, setView] = useState<'metrics' | 'detail'>('metrics');

  if (isLoading) {
    return <div className="admin-tab-loading">Loading task data...</div>;
  }

  const metrics = metricsData?.data ?? [];
  const details = detailData?.data ?? [];

  // Aggregate totals
  const totalTasks = metrics.reduce((sum, r) => sum + Number(r.total || 0), 0);
  const completedTasks = metrics.reduce((sum, r) => sum + Number(r.completed || 0), 0);
  const failedTasks = metrics.reduce((sum, r) => sum + Number(r.failed || 0), 0);
  const avgCompletionRate = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Task Tracking</h3>
        <div className="admin-filter-group">
          <button
            className={`admin-filter-btn ${view === 'metrics' ? 'active' : ''}`}
            onClick={() => setView('metrics')}
          >
            Metrics
          </button>
          <button
            className={`admin-filter-btn ${view === 'detail' ? 'active' : ''}`}
            onClick={() => setView('detail')}
          >
            Task List
          </button>
        </div>
      </div>

      <div className="admin-metrics-row">
        <MetricCard title="Total Tasks" value={totalTasks} />
        <MetricCard title="Completed" value={completedTasks} />
        <MetricCard title="Failed" value={failedTasks} />
        <MetricCard
          title="Completion Rate"
          value={`${avgCompletionRate.toFixed(0)}%`}
        />
      </div>

      {view === 'metrics' ? (
        <DataTable
          columns={[
            { key: 'date', label: 'Date' },
            { key: 'task_type', label: 'Task Type' },
            { key: 'total', label: 'Total' },
            { key: 'completed', label: 'Completed' },
            { key: 'failed', label: 'Failed' },
            { key: 'abandoned', label: 'Abandoned' },
            {
              key: 'completion_rate',
              label: 'Rate',
              render: (v) => {
                const rate = Number(v) * 100;
                return (
                  <span style={{ color: rate >= 70 ? 'var(--status-good)' : rate >= 40 ? 'var(--status-warn)' : 'var(--status-bad)', fontWeight: 600 }}>
                    {rate.toFixed(0)}%
                  </span>
                );
              },
            },
            {
              key: 'avg_duration_ms',
              label: 'Avg Duration',
              render: (v) => {
                const ms = Number(v);
                if (!ms) return '-';
                if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
                return `${(ms / 60000).toFixed(1)}m`;
              },
            },
          ]}
          data={metrics}
          emptyMessage="No task data for this period"
        />
      ) : (
        <DataTable
          columns={[
            { key: 'task_id', label: 'Task ID', render: (v) => String(v).substring(0, 8) + '...' },
            { key: 'task_type', label: 'Type' },
            { key: 'status', label: 'Status', render: (v) => statusBadge(String(v)) },
            { key: 'user_sub', label: 'User', render: (v) => String(v).substring(0, 8) + '...' },
            { key: 'exchange_count', label: 'Exchanges' },
            { key: 'created_at', label: 'Created', render: (v) => new Date(String(v)).toLocaleString() },
            {
              key: 'duration_ms',
              label: 'Duration',
              render: (v) => {
                const ms = Number(v);
                if (!ms) return '-';
                if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
                return `${(ms / 60000).toFixed(1)}m`;
              },
            },
          ]}
          data={details}
          emptyMessage="No tasks found for this period"
        />
      )}
    </div>
  );
};

export default TasksTab;
