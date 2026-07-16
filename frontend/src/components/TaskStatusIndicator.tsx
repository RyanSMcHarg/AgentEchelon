import React from 'react';
import type { ActiveTask } from '../types';
import './TaskStatusIndicator.css';

interface TaskStatusIndicatorProps {
  task: ActiveTask;
}

const TaskStatusIndicator: React.FC<TaskStatusIndicatorProps> = ({ task }) => {
  const isInProgress = task.status === 'in_progress' || task.status === 'processing';

  return (
    <div className="task-status-indicator">
      <span className={`task-status-dot ${isInProgress ? 'task-status-dot--pulsing' : ''}`} />
      <span className="task-status-label">{task.label}</span>
    </div>
  );
};

export default TaskStatusIndicator;
