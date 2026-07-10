import {
  ApiMeetingTaskStatus,
  fetchGuestMeetingSummaryTask,
  fetchMeetingSummaryDetail,
  fetchMeetingSummaryTask,
  generateGuestMeetingSummary,
  generateMeetingSummary,
} from './api';
import { MeetingSummary, TranscriptLine } from '../types';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 180;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function meetingSummaryToText(summary: MeetingSummary | null): string {
  if (!summary) return '';
  return (summary.markdown || summary.full_text || summary.overview || '').trim();
}

export function normalizeGuestSummaryResult(meetingId: string, value: unknown): MeetingSummary | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  const overview = typeof result.overview === 'string' ? result.overview : '';
  const fullText = typeof result.full_text === 'string' ? result.full_text : overview;
  const markdown = typeof result.markdown === 'string' ? result.markdown : fullText;
  if (!(overview || fullText || markdown)) return null;
  return {
    meeting_id: typeof result.meeting_id === 'string' ? result.meeting_id : meetingId,
    overview,
    full_text: fullText,
    markdown,
    key_decisions: Array.isArray(result.key_decisions) ? result.key_decisions.filter(item => typeof item === 'string') as string[] : [],
    action_items: Array.isArray(result.action_items) ? result.action_items as MeetingSummary['action_items'] : [],
    generated_at: typeof result.generated_at === 'string' ? result.generated_at : new Date().toISOString(),
  };
}

async function waitForTask(fetchStatus: () => Promise<ApiMeetingTaskStatus>): Promise<ApiMeetingTaskStatus> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(POLL_INTERVAL_MS);
    const status = await fetchStatus();
    if (status.status === 'SUCCESS') return status;
    if (status.status === 'FAILURE') {
      throw new Error(typeof status.result === 'string' ? status.result : 'meeting summary task failed');
    }
  }
  throw new Error('meeting summary task timed out');
}

export async function generateSummaryForMeeting(options: {
  meetingId: string;
  title?: string;
  transcriptLines: TranscriptLine[];
  isGuest: boolean;
  accessToken?: string | null;
}): Promise<MeetingSummary> {
  const { meetingId, title, transcriptLines, isGuest, accessToken } = options;
  if (transcriptLines.length === 0) throw new Error('meeting transcript is empty');

  if (isGuest) {
    const task = await generateGuestMeetingSummary(meetingId, transcriptLines, title);
    const status = await waitForTask(() => fetchGuestMeetingSummaryTask(task.task_id));
    const summary = normalizeGuestSummaryResult(meetingId, status.result);
    if (!summary) throw new Error('guest meeting summary is empty');
    return summary;
  }

  if (!accessToken) throw new Error('not authenticated');
  const task = await generateMeetingSummary(meetingId, accessToken);
  if (task.task_id) {
    await waitForTask(() => fetchMeetingSummaryTask(meetingId, task.task_id, accessToken));
  }
  const summary = await fetchMeetingSummaryDetail(meetingId, accessToken);
  if (!summary) throw new Error('meeting summary is empty');
  return summary;
}
