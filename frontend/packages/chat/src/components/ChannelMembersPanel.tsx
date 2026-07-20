import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@ae/shared';
import { useConversations } from '../providers/ConversationProvider.chime';
import { useAwsClient } from '../providers/AwsClientProvider';
import { chimeService } from '../services/chimeService';
import { removeConversationMember } from '../services/conversationManagementService';
import type { ChannelMember } from '@ae/shared';
import {
  type ChannelBattleConfig,
  getBattleConfig,
  enableBattle,
  disableBattle,
} from '../services/channelBattleService';
import { listExperiments, type Experiment } from '@ae/shared';
import './ChannelMembersPanel.css';

interface ChannelMembersPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type Role = 'moderator' | 'bot' | 'member';

interface DecoratedMember extends ChannelMember {
  role: Role;
  isSelf: boolean;
}

function initialsFrom(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return trimmed[0]!.toUpperCase();
  const first = parts[0]![0] ?? '';
  const second = parts.length > 1 ? parts[1]![0] ?? '' : '';
  return (first + second).toUpperCase() || '?';
}

const ChannelMembersPanel: React.FC<ChannelMembersPanelProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { activeConversation, channelMembers } = useConversations();
  const { user } = useAuth();
  // Canonical caller ARN: AwsClientProvider exposes the reactive
  // chimeService userArn (${APP_INSTANCE_ARN}/user/<sub>). useAuth().user
  // never carries userArn — reading it there left isCurrentUserModerator
  // permanently false, so the Battle Mode panel never rendered.
  const { userArn: currentUserArn } = useAwsClient();
  const [removingArn, setRemovingArn] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Moderator status is read from Chime's LIVE moderator list (the source of truth),
  // never inferred from createdBy: an admin-added co-moderator, or a creator who was
  // demoted, must be reflected accurately. Fetched when the panel opens for a channel.
  const [moderators, setModerators] = useState<Set<string>>(new Set());
  useEffect(() => {
    const arn = activeConversation?.conversationArn;
    if (!isOpen || !arn) return;
    let cancelled = false;
    void chimeService.listModerators(arn).then((mods) => {
      if (!cancelled) setModerators(mods);
    });
    return () => { cancelled = true; };
  }, [isOpen, activeConversation?.conversationArn]);
  const isCurrentUserModerator = !!currentUserArn && moderators.has(currentUserArn);

  // /battle (SPEC-BATTLE.md): only premium channels with a
  // moderator caller can toggle Battle Mode. The section is hidden for
  // everyone else; the API enforces the same gates server-side.
  const isPremium = activeConversation?.modelTier === 'premium';
  const showBattleSection = isPremium && isCurrentUserModerator;

  const [battleConfig, setBattleConfig] = useState<ChannelBattleConfig | null>(null);
  const [battleExperiments, setBattleExperiments] = useState<Experiment[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string>('');
  const [battleBusy, setBattleBusy] = useState(false);
  const [battleError, setBattleError] = useState<string | null>(null);

  useEffect(() => {
    if (!showBattleSection || !activeConversation) {
      setBattleConfig(null);
      setBattleExperiments([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // listExperiments hits /admin/experiments — the API authorizer rejects
        // non-admin callers with 403 (browser logs each as a console error,
        // which trips the E2E console-monitor gate). Restrict the call to
        // admins; non-admin premium moderators still see the battle section
        // and the current channel config, just no experiment picker (they
        // couldn't enable a new battle from this UI either way until the
        // backend grows a non-admin listing endpoint).
        const canListExperiments = !!user?.isAdmin;
        const [config, experiments] = await Promise.all([
          getBattleConfig(activeConversation.conversationArn).catch(() => null),
          canListExperiments
            ? listExperiments().catch(() => [] as Experiment[])
            : Promise.resolve([] as Experiment[]),
        ]);
        if (cancelled) return;
        setBattleConfig(config);
        // Filter to battle-eligible (battleEnabled + active). The server
        // re-checks; this filter just narrows the picker.
        const eligible = experiments.filter(
          (e) => (e as Experiment & { battleEnabled?: boolean }).battleEnabled === true
            && e.status === 'active',
        );
        setBattleExperiments(eligible);
        if (eligible.length > 0 && !selectedExperimentId) {
          setSelectedExperimentId(eligible[0].experimentId);
        }
      } catch {
        // Non-fatal; section just shows the off state with no experiments
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversation, showBattleSection, user?.isAdmin]);

  const handleEnableBattle = async () => {
    if (!activeConversation || !selectedExperimentId) return;
    setBattleBusy(true);
    setBattleError(null);
    try {
      await enableBattle(activeConversation.conversationArn, selectedExperimentId);
      const refreshed = await getBattleConfig(activeConversation.conversationArn);
      setBattleConfig(refreshed);
    } catch (err) {
      setBattleError(err instanceof Error ? err.message : String(err));
    } finally {
      setBattleBusy(false);
    }
  };

  const handleDisableBattle = async () => {
    if (!activeConversation) return;
    if (!window.confirm(t('membersPanel.battle.confirmDisable', { defaultValue: 'Turn off Battle Mode and remove the alternative assistant?' }))) {
      return;
    }
    setBattleBusy(true);
    setBattleError(null);
    try {
      await disableBattle(activeConversation.conversationArn);
      setBattleConfig({ channelArn: activeConversation.conversationArn, enabled: false });
    } catch (err) {
      setBattleError(err instanceof Error ? err.message : String(err));
    } finally {
      setBattleBusy(false);
    }
  };

  const decorated: DecoratedMember[] = useMemo(() => {
    return channelMembers
      .map<DecoratedMember>((m) => {
        let role: Role;
        if (m.isBot) role = 'bot';
        else if (moderators.has(m.userArn)) role = 'moderator';
        else role = 'member';
        return { ...m, role, isSelf: m.userArn === currentUserArn };
      })
      .sort((a, b) => {
        // Bot last, moderator first, then alphabetical
        if (a.role === 'bot' && b.role !== 'bot') return 1;
        if (b.role === 'bot' && a.role !== 'bot') return -1;
        if (a.role === 'moderator' && b.role !== 'moderator') return -1;
        if (b.role === 'moderator' && a.role !== 'moderator') return 1;
        return a.name.localeCompare(b.name);
      });
  }, [channelMembers, moderators, currentUserArn]);

  const handleRemove = async (member: DecoratedMember) => {
    if (!activeConversation) return;
    if (member.isBot || member.isSelf) return;
    if (!isCurrentUserModerator) {
      setErrorMessage(t('membersPanel.remove.moderatorOnly'));
      return;
    }

    const confirmed = window.confirm(t('membersPanel.remove.confirm', { name: member.name }));
    if (!confirmed) return;

    setRemovingArn(member.userArn);
    setErrorMessage(null);

    try {
      // Server-side path (SPEC-CONVERSATION-ARCHIVE): a chat-plane removeMember is
      // pinned to the caller's own ARN and would be denied for removing others, so
      // this goes through the moderator-gated backend Lambda (which also refuses the
      // assistant, matching the UI guard above).
      await removeConversationMember(activeConversation.conversationArn, member.userArn);
      // The WebSocket DELETE_CHANNEL_MEMBERSHIP event will refresh channelMembers
      // automatically via MessagingProvider. As a fallback we also optimistically
      // clear below on success.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(t('membersPanel.remove.error', { name: member.name, error: message }));
    } finally {
      setRemovingArn(null);
    }
  };

  if (!isOpen || !activeConversation) return null;

  return (
    <aside
      className="channel-members-panel"
      role="complementary"
      aria-label={t('membersPanel.title')}
    >
      <div className="channel-members-panel-header">
        <h3 className="channel-members-panel-title">{t('membersPanel.title')}</h3>
        <span className="channel-members-panel-count">
          {t('membersPanel.memberCount', { count: decorated.length })}
        </span>
        <button
          type="button"
          className="channel-members-panel-close"
          onClick={onClose}
          title={t('membersPanel.toggleClose')}
          aria-label={t('membersPanel.toggleClose')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {errorMessage && (
        <div className="channel-members-panel-error" role="alert">
          {errorMessage}
        </div>
      )}

      {showBattleSection && (
        <section className="channel-members-panel-battle" aria-label="Battle Mode">
          <div className="channel-members-panel-battle-header">
            <h4 className="channel-members-panel-battle-title">Battle Mode</h4>
            <span
              className={`status-badge${battleConfig?.enabled ? ' status-badge--live' : ''}`}
            >
              {battleConfig?.enabled ? 'Active' : 'Off'}
            </span>
          </div>
          <p className="channel-members-panel-battle-help">
            {battleConfig?.enabled
              ? 'A second assistant has joined. Type /battle <prompt> to compare both.'
              : 'Add an alternative assistant and compare both with /battle.'}
          </p>
          {battleError && (
            <div className="channel-members-panel-battle-error" role="alert">
              {battleError}
            </div>
          )}
          {battleConfig?.enabled ? (
            <button
              type="button"
              className="channel-members-panel-battle-btn channel-members-panel-battle-btn--disable"
              onClick={handleDisableBattle}
              disabled={battleBusy}
            >
              {battleBusy ? 'Working…' : 'Turn off Battle Mode'}
            </button>
          ) : (
            <div className="channel-members-panel-battle-controls">
              {battleExperiments.length === 0 ? (
                <p className="channel-members-panel-battle-empty">
                  No battle-eligible experiments configured. Ask an admin to mark one as battle-enabled in the Experiments tab.
                </p>
              ) : (
                <>
                  <label htmlFor="battle-experiment-select" className="channel-members-panel-battle-label">
                    Experiment
                  </label>
                  <select
                    id="battle-experiment-select"
                    className="channel-members-panel-battle-select"
                    value={selectedExperimentId}
                    onChange={(e) => setSelectedExperimentId(e.target.value)}
                    disabled={battleBusy}
                  >
                    {battleExperiments.map((exp) => (
                      <option key={exp.experimentId} value={exp.experimentId}>
                        {exp.experimentId}
                        {exp.description ? ` — ${exp.description}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="channel-members-panel-battle-btn channel-members-panel-battle-btn--enable"
                    onClick={handleEnableBattle}
                    disabled={battleBusy || !selectedExperimentId}
                  >
                    {battleBusy ? 'Working…' : 'Turn on Battle Mode'}
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {decorated.length === 0 ? (
        <p className="channel-members-panel-empty">{t('membersPanel.empty')}</p>
      ) : (
        <ul className="channel-members-panel-list">
          {decorated.map((member) => {
            const canRemove =
              isCurrentUserModerator && !member.isBot && !member.isSelf;
            return (
              <li
                key={member.userArn}
                className={`channel-members-panel-item${member.isSelf ? ' is-self' : ''}`}
                data-role={member.role}
              >
                <div className="channel-members-panel-avatar" aria-hidden="true">
                  {member.isBot ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                      <path d="M10 2a2 2 0 012 2v1h2a3 3 0 013 3v6a3 3 0 01-3 3H6a3 3 0 01-3-3V8a3 3 0 013-3h2V4a2 2 0 012-2zm-2 9a1 1 0 100-2 1 1 0 000 2zm4 0a1 1 0 100-2 1 1 0 000 2z" />
                    </svg>
                  ) : (
                    initialsFrom(member.name)
                  )}
                </div>
                <div className="channel-members-panel-info">
                  <div className="channel-members-panel-name">
                    {member.name}
                    {member.isSelf && (
                      <span className="channel-members-panel-you">
                        {' '}{t('membersPanel.youSuffix')}
                      </span>
                    )}
                  </div>
                  <div className="channel-members-panel-role">
                    {t(`membersPanel.role.${member.role}`)}
                  </div>
                </div>
                {canRemove && (
                  <button
                    type="button"
                    className="channel-members-panel-remove"
                    onClick={() => handleRemove(member)}
                    disabled={removingArn === member.userArn}
                    title={t('membersPanel.remove.button')}
                  >
                    {t('membersPanel.remove.button')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
};

export default ChannelMembersPanel;
