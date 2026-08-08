import { getApiConfig } from '../../../services/config';
import { readResponseError } from '../../../services/errors';
import { fetchWithTimeout, readJsonWithTimeout } from '../../../services/http';

export interface MeetingQuestionTranscriptEvidenceWire {
  segment_id: string;
  source_segment_id: string | null;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  text: string;
}

export interface MeetingQuestionSummaryEvidenceWire {
  section_id: string;
  title: string | null;
  text: string;
}

export interface MeetingQuestionContextWire {
  ordinal: number;
  question: string;
  answer_scope: 'meeting' | 'general';
  answer_kind: 'answer' | 'insufficient';
  answer: string;
  citations: readonly {
    kind: 'transcript' | 'summary' | 'manual_note';
    source_id: string;
  }[];
}

export interface MeetingQuestionRequestWire {
  schema_version: 1;
  client_meeting_id: string;
  client_thread_id: string;
  client_request_id: string;
  expected_ordinal: number;
  input_fingerprint: string;
  transcript_revision_id: string;
  summary_version_id: string | null;
  manual_note_revision: number | null;
  include_manual_note: boolean;
  question: string;
  transcript_segments: readonly MeetingQuestionTranscriptEvidenceWire[];
  summary_sections: readonly MeetingQuestionSummaryEvidenceWire[];
  manual_note: { revision: number; content: string } | null;
  context: readonly MeetingQuestionContextWire[];
}

export interface MeetingQuestionResponseWire {
  schema_version: 1;
  client_meeting_id: string;
  client_thread_id: string;
  client_request_id: string;
  remote_thread_id: string | null;
  remote_turn_id: string | null;
  ordinal: number;
  input_fingerprint: string;
  transcript_revision_id: string;
  summary_version_id: string | null;
  manual_note_revision: number | null;
  answer_scope: 'meeting' | 'general';
  answer_kind: 'answer' | 'insufficient';
  answer: string;
  citations: readonly {
    kind: 'transcript' | 'summary' | 'manual_note';
    source_id: string;
  }[];
  created_at_ms: number;
  completed_at_ms: number;
  transient: boolean;
}

export class MeetingQuestionAuthenticationRequiredError extends Error {
  constructor() {
    super('登录状态已失效，请重新登录。');
    this.name = 'MeetingQuestionAuthenticationRequiredError';
  }
}

function meetingApiUrl(path: string): string {
  return `${getApiConfig().apiBase.replace(/\/+$/, '')}${path}`;
}

export async function askMeetingQuestionRemote(input: {
  request: MeetingQuestionRequestWire;
  remoteMeetingId: string | null;
  accessToken?: string | null;
  /**
   * Account-owned remote meetings must never silently downgrade to the
   * transient guest endpoint when the token is missing or expired.
   */
  requiresAuthentication?: boolean;
  signal?: AbortSignal;
}): Promise<unknown> {
  const remoteMeetingId = input.remoteMeetingId?.trim() || null;
  const accessToken = input.accessToken?.trim() || null;
  if (input.requiresAuthentication && (!remoteMeetingId || !accessToken)) {
    throw new MeetingQuestionAuthenticationRequiredError();
  }
  const authenticated = Boolean(remoteMeetingId && accessToken);
  const path = authenticated
    ? `/api/laoji/meetings/${encodeURIComponent(remoteMeetingId!)}/questions`
    : '/api/laoji/meetings/guest-questions';
  const response = await fetchWithTimeout(meetingApiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(input.request),
    signal: input.signal,
  });
  if (!response.ok) {
    throw await readResponseError('会议问答失败', response, {
      unauthorizedToken: authenticated ? accessToken ?? undefined : undefined,
    });
  }
  // The 30-second request budget covers model/retrieval work.  Once headers
  // arrive, cap the small JSON body separately so a stalled proxy cannot keep
  // the question sheet in a permanent "正在回答" state.
  return readJsonWithTimeout(response, 5_000, input.signal);
}
