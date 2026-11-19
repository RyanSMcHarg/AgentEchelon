/** The room's started card exactly as the deployed router posted it: its text and its Metadata. */
export const MEETING_CONVERSATION = 'conv-meeting-1794616948536-da83f54c6a64';

export const STARTED_CARD_METADATA = {
  meetingCard: { event: 'meeting-started', meetingId: '5f9350c8-1a2b-4c3d-8e9f-0a1b2c3d4e5f', conversationId: MEETING_CONVERSATION },
  notify: { email: true },
  notifySubject: 'Incident call: AgentEchelon-demo-incident',
  notifyConversationId: MEETING_CONVERSATION,
  notifyBody: 'A call has started on the AgentEchelon-demo-incident incident, in a conversation you are in. Sign in to join it from the button below.',
  notifyLink: 'meeting',
  notifyExclude: ['01a19ed6-0000-4000-8000-000000000000'],
} as const;

export const STARTED_CARD_CONTENT = `@humans **Incident call in progress: AgentEchelon-demo-incident** · [Join the call](?meeting=${MEETING_CONVERSATION})\n`
  + 'The alarm reports: Threshold Crossed: 2 out of the last 2 datapoints [1.0 (13/11/26 23:01:00), 1.0 (13/11/26 23:00:00)] were greater than or equal to the threshold (1.0) (minimum 2 datapoints for OK -> ALARM transition).';
