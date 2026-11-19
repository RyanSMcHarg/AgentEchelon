/**
 * THE PROCESSES TAB (SPEC-PROCESSES P9, SPEC-ADMIN-CONSOLE 2.8): the process analytics on their own page under Performance.
 *
 * It reads over the Performance window and the two axes a process run carries, the classification and the assistant, from
 * the filter set every Performance view shares, so a view narrowed on Overview opens here narrowed the same way. A team
 * member's console reads on its assistant's team route (`teamScope.ts`), so a team sees the processes its own assistants
 * ran; an admin's console reads every assistant's.
 */
import React from 'react';
import PerformanceFilterBar, { EMPTY_FILTERS, type PerformanceFilters } from './PerformanceFilters';
import ProcessesPanel from './ProcessesPanel';
import type { AnalyticsDateRange } from '@ae/shared';

/** The filters a process run is read by: the classification and the assistant, and no other axis. */
export function processFilters(f: PerformanceFilters): PerformanceFilters {
  return { ...EMPTY_FILTERS, classification: f.classification, assistant: f.assistant };
}

const ProcessesTab: React.FC<{
  dateRange: AnalyticsDateRange | undefined;
  filters: PerformanceFilters;
  onFiltersChange: (next: PerformanceFilters) => void;
  /** Rows that carry the classification and assistant axes, which the filter bar offers as choices. */
  filterRows: Record<string, unknown>[];
  /** Opens the Assistants tab, where a process is created and changed on its owning assistant's page. */
  onOpenAssistants?: () => void;
  /** Opens a run's conversation in the Conversations tab. */
  onOpenConversation?: (channelArn: string) => void;
}> = ({ dateRange, filters, onFiltersChange, filterRows, onOpenAssistants, onOpenConversation }) => {
  const shown = processFilters(filters);
  // Only the two axes a process run carries are offered, so no choice is shown that this tab would not apply.
  const axes = filterRows.map((r) => ({ conversation_classification: r.conversation_classification ?? r.classification, assistant: r.assistant }));
  // A CHANGE HERE IS A CHANGE TO THE SHARED SET: the two axes this tab shows, and a version the assistant change clears.
  const change = (next: PerformanceFilters) => onFiltersChange({
    ...filters,
    classification: next.classification,
    assistant: next.assistant,
    ...(next.assistant !== filters.assistant || next.classification !== filters.classification ? { version: null } : {}),
    ...(next.classification !== filters.classification ? { role: null } : {}),
  });
  return (
    <div className="admin-tab" data-testid="processes-tab">
      <PerformanceFilterBar rows={axes} value={shown} onChange={change} showEntry={false} showDuel={false} />
      <ProcessesPanel dateRange={dateRange} assistant={shown.assistant} classification={shown.classification} onOpenAssistants={onOpenAssistants} onOpenConversation={onOpenConversation} />
    </div>
  );
};

export default ProcessesTab;
