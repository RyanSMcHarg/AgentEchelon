import React from 'react';
import { useTranslation } from 'react-i18next';
import './TaskStatusIndicator.css';

/**
 * WHAT IS HAPPENING TO THE QUEUE, SHOWN THE WAY A TASK'S STATE IS SHOWN.
 *
 * A queue being worked looks exactly like a queue that is stuck: the same messages, marked waiting,
 * for as long as it takes. The person who sent them cannot tell the difference, and the difference is
 * the whole of their experience of it - one is patience, the other is a product that has stopped.
 *
 * Deliberately the SAME presentation as `TaskStatusIndicator`, down to sharing its stylesheet. A queue
 * being worked and a task being worked are the same thing to the person watching, and giving them two
 * different-looking treatments would be inventing a distinction they do not have.
 *
 * ── THE WORDS COME FROM ONE OF TWO PLACES, AND THE ORDER MATTERS ────────────────────────────────
 *
 * The stage arrives as a TOKEN so it can be said in whatever language the person is reading; a label
 * fixed at the server would defeat that. But a deployment that deliberately worded a stage must not
 * have its wording replaced by a translation - so a configured label, when there is one, wins.
 */
interface QueueStatusIndicatorProps {
  /** The stage token, e.g. `reviewing`. */
  status: string;
  /** The deployment's own wording, when it configured any for this stage. */
  label?: string;
}

/** The stage is over. Anything else is still moving, and says so. */
const SETTLED = 'settled';

const QueueStatusIndicator: React.FC<QueueStatusIndicatorProps> = ({ status, label }) => {
  const { t } = useTranslation();

  // A stage this client does not know is still shown rather than swallowed: it came from a
  // deployment that knows something this build does not, and silence would be the worse answer.
  const text = label || t(`conversation.queueStatus.${status}`, { defaultValue: status });

  return (
    <div className="task-status-indicator" data-queue-status={status}>
      <span
        className={`task-status-dot ${status !== SETTLED ? 'task-status-dot--pulsing' : ''}`}
      />
      <span className="task-status-label">{text}</span>
    </div>
  );
};

export default QueueStatusIndicator;
