/**
 * THE REMOTE VIDEOS THIS WINDOW RECEIVES ARE THE ONES ON SCREEN (SPEC-ASSISTANT-MEETINGS FR61). The meeting session runs
 * the Amazon Chime SDK's `VideoPriorityBasedPolicy` (`MeetingProvider.tsx`), and this hands it the videos in view each
 * time they change, by `videoPreferencesFor` (`videoLayout.ts`): a grid page turned, the stage changing hands, a share
 * starting, or a person starting their camera. Each call replaces the last, and a video left out is unsubscribed, so an
 * off-page tile costs no bandwidth (priority-based downlink policy guide,
 * https://aws.github.io/amazon-chime-sdk-js/modules/prioritybased_downlink_policy.html: "pass a complete array" and
 * "switching the current page of videos" as an event that calls for one).
 */
import { useEffect } from 'react';
import { TargetDisplaySize, VideoPreference, VideoPreferences } from 'amazon-chime-sdk-js';
import { useMeeting } from '../../providers/MeetingProvider';
import { videoPreferencesFor, type VideoSize } from './videoLayout';

/** The SDK's display size for a size by name, read when a choice is made. */
function sizeOf(size: VideoSize): TargetDisplaySize {
  return size === 'low' ? TargetDisplaySize.Low : size === 'medium' ? TargetDisplaySize.Medium : TargetDisplaySize.High;
}

/** Subscribe to the remote videos `visible` (by attendee id), `featured` among them at high resolution, every share first. */
export function useVideoSubscriptions(visible: readonly string[], featured: readonly string[]): void {
  const { videoSources, videoPolicy, status } = useMeeting();
  const sources = videoSources ?? [];
  const choices = videoPreferencesFor({ sources, visible, featured });
  // One call per change of what is chosen, not per render: the policy may limit how often it resubscribes.
  const key = choices.map((c) => `${c.attendeeId}:${c.priority}:${c.size}`).join(',');
  useEffect(() => {
    const policy = videoPolicy?.();
    if (!policy) return;
    const prefs = VideoPreferences.prepare();
    for (const c of choices) prefs.add(new VideoPreference(c.attendeeId, c.priority, sizeOf(c.size)));
    policy.chooseRemoteVideoSources(prefs.build());
  // `choices` is read through `key`; a new session (a rejoin) is a status change and is chosen for again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, status]);
}
