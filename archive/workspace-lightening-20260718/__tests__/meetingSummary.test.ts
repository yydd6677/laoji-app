jest.mock('../src/services/api', () => ({
  generateGuestMeetingSummary: jest.fn(),
  fetchGuestMeetingSummaryTask: jest.fn(),
  generateMeetingSummary: jest.fn(),
  fetchMeetingSummaryTask: jest.fn(),
  fetchMeetingSummaryDetail: jest.fn(),
}));

import {
  fetchMeetingSummaryDetail,
  fetchMeetingSummaryTask,
  fetchGuestMeetingSummaryTask,
  generateGuestMeetingSummary,
  generateMeetingSummary,
} from '../src/services/api';
import { HttpResponseError } from '../src/services/errors';
import {
  generateSummaryForMeeting,
  meetingDateForSummary,
  meetingSummaryProgressLabel,
  meetingSummaryToText,
  normalizeGuestSummaryResult,
  shouldDiscardPendingMeetingSummaryTask,
  summaryTaskFailureMessage,
  summaryPollDelayMs,
} from '../src/services/meetingSummary';

describe('meeting summary helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes the displayed local meeting date for relative-date context', () => {
    expect(meetingDateForSummary('2026年7月10日')).toBe('2026-07-10');
    expect(meetingDateForSummary('', 'invalid')).toBeUndefined();
  });

  it('normalizes a transient guest task result for local caching', () => {
    const summary = normalizeGuestSummaryResult('guest-meeting-1', {
      overview: '讨论了发布安排',
      markdown: '# 会议总结\n\n讨论了发布安排',
      key_decisions: ['周五发布'],
      action_items: [{ content: '完成验收', assignee: '小李' }],
      generated_at: '2026-07-10T09:00:00Z',
    });

    expect(summary).toMatchObject({
      meeting_id: 'guest-meeting-1',
      overview: '讨论了发布安排',
      key_decisions: ['周五发布'],
    });
    expect(meetingSummaryToText(summary)).toContain('会议总结');
  });

  it('rejects an empty or malformed guest summary result', () => {
    expect(normalizeGuestSummaryResult('guest-meeting-1', null)).toBeNull();
    expect(normalizeGuestSummaryResult('guest-meeting-1', { key_decisions: [] })).toBeNull();
    expect(normalizeGuestSummaryResult('guest-meeting-1', { overview: '   ', markdown: '\n' })).toBeNull();
  });

  it('rejects an authenticated task whose durable summary has no displayable content', async () => {
    (generateMeetingSummary as jest.Mock).mockResolvedValueOnce({ task_id: 'cloud-empty-task' });
    (fetchMeetingSummaryTask as jest.Mock).mockResolvedValueOnce({
      status: 'SUCCESS',
      result: { key_decisions: [], action_items: [] },
    });
    (fetchMeetingSummaryDetail as jest.Mock).mockResolvedValueOnce({
      meeting_id: 'cloud-meeting-empty',
      overview: '',
      full_text: '',
      markdown: '',
      key_decisions: [],
      action_items: [],
    });

    await expect(generateSummaryForMeeting({
      meetingId: 'cloud-meeting-empty',
      transcriptLines: [{ id: 'line-1', text: '讨论发布计划' }],
      isGuest: false,
      accessToken: 'token-1',
    })).rejects.toThrow('meeting summary is empty');
  });

  it('polls quickly for interactive summaries and backs off for long tasks', () => {
    expect(summaryPollDelayMs(0)).toBe(250);
    expect(summaryPollDelayMs(4_999, 'STARTED')).toBe(250);
    expect(summaryPollDelayMs(5_000, 'STARTED')).toBe(500);
    expect(summaryPollDelayMs(5_000, 'PENDING')).toBe(1_000);
    expect(summaryPollDelayMs(30_000, 'STARTED')).toBe(1_000);
    expect(summaryPollDelayMs(30_000, 'PENDING')).toBe(2_000);
    expect(summaryPollDelayMs(0, 'RECONNECTING')).toBe(500);
  });

  it('uses actual elapsed time and distinguishes queueing from generation', () => {
    expect(meetingSummaryProgressLabel({
      attempt: 1,
      status: 'PENDING',
      elapsedMs: 0,
      stage: 'queued',
    })).toBe('总结任务正在排队');
    expect(meetingSummaryProgressLabel({
      attempt: 4,
      status: 'STARTED',
      elapsedMs: 1_620,
      stage: 'generating',
    })).toBe('正在生成总结 · 2 秒');
    expect(meetingSummaryProgressLabel({
      attempt: 5,
      status: 'RECONNECTING',
      elapsedMs: 4_200,
      stage: 'reconnecting',
    })).toBe('网络波动，正在重连 · 4 秒');
    expect(meetingSummaryProgressLabel({
      attempt: 0,
      status: 'RESUBMITTING',
      elapsedMs: 0,
      stage: 'resubmitting',
    })).toBe('原总结任务已失效，正在重新提交');
  });

  it('resumes a persisted guest task without submitting a duplicate', async () => {
    (fetchGuestMeetingSummaryTask as jest.Mock).mockResolvedValueOnce({
      status: 'SUCCESS',
      result: { overview: '恢复完成', key_decisions: [], action_items: [] },
    });

    await expect(generateSummaryForMeeting({
      meetingId: 'guest-meeting-resume',
      transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
      isGuest: true,
      resumeTaskId: 'task-existing',
    })).resolves.toMatchObject({ overview: '恢复完成' });

    expect(fetchGuestMeetingSummaryTask).toHaveBeenCalledWith('task-existing', undefined, 0);
    expect(generateGuestMeetingSummary).not.toHaveBeenCalled();
  });

  it('resubmits once when a persisted guest task expired on the server', async () => {
    const onTaskSubmitted = jest.fn();
    (fetchGuestMeetingSummaryTask as jest.Mock)
      .mockRejectedValueOnce(new HttpResponseError('expired', 404, '任务已过期'))
      .mockResolvedValueOnce({
        status: 'SUCCESS',
        result: { overview: '重新提交后完成', key_decisions: [], action_items: [] },
      });
    (generateGuestMeetingSummary as jest.Mock).mockResolvedValueOnce({ task_id: 'task-new' });

    await expect(generateSummaryForMeeting({
      meetingId: 'guest-meeting-expired',
      transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
      isGuest: true,
      resumeTaskId: 'task-old',
      onTaskSubmitted,
    })).resolves.toMatchObject({ overview: '重新提交后完成' });

    expect(generateGuestMeetingSummary).toHaveBeenCalledTimes(1);
    expect(onTaskSubmitted).toHaveBeenCalledWith('task-new');
  });

  it('resubmits a newly created guest task once when the service process loses it', async () => {
    (generateGuestMeetingSummary as jest.Mock)
      .mockResolvedValueOnce({ task_id: 'task-lost' })
      .mockResolvedValueOnce({ task_id: 'task-replacement' });
    (fetchGuestMeetingSummaryTask as jest.Mock)
      .mockRejectedValueOnce(new HttpResponseError('missing', 404, '任务不存在'))
      .mockResolvedValueOnce({
        status: 'SUCCESS',
        result: { overview: '重提后完成', key_decisions: [], action_items: [] },
      });

    await expect(generateSummaryForMeeting({
      meetingId: 'guest-meeting-new-task-lost',
      transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
      isGuest: true,
    })).resolves.toMatchObject({ overview: '重提后完成' });

    expect(generateGuestMeetingSummary).toHaveBeenCalledTimes(2);
  });

  it('resubmits a newly created authenticated task once when the service process loses it', async () => {
    (generateMeetingSummary as jest.Mock)
      .mockResolvedValueOnce({ task_id: 'cloud-task-lost' })
      .mockResolvedValueOnce({ task_id: 'cloud-task-replacement' });
    (fetchMeetingSummaryTask as jest.Mock)
      .mockRejectedValueOnce(new HttpResponseError('missing', 404, '任务不存在'))
      .mockResolvedValueOnce({ status: 'SUCCESS', result: null });
    (fetchMeetingSummaryDetail as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ overview: '登录任务重提后完成' });

    await expect(generateSummaryForMeeting({
      meetingId: 'cloud-meeting-new-task-lost',
      transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
      isGuest: false,
      accessToken: 'token-1',
    })).resolves.toMatchObject({ overview: '登录任务重提后完成' });

    expect(generateMeetingSummary).toHaveBeenCalledTimes(2);
    expect(fetchMeetingSummaryTask).toHaveBeenCalledTimes(2);
  });

  it('stops polling promptly when the caller aborts', async () => {
    (generateGuestMeetingSummary as jest.Mock).mockResolvedValueOnce({ task_id: 'task-1' });
    (fetchGuestMeetingSummaryTask as jest.Mock).mockResolvedValueOnce({ status: 'PENDING' });
    const controller = new AbortController();
    const pending = generateSummaryForMeeting({
      meetingId: 'guest-meeting-1',
      transcriptLines: [{ id: 'line-1', text: '讨论发布计划' }],
      isGuest: true,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(fetchGuestMeetingSummaryTask).toHaveBeenCalledTimes(1);
  });

  it('keeps the 250 ms fallback for a server without long-poll support', async () => {
    jest.useFakeTimers();
    try {
      (generateGuestMeetingSummary as jest.Mock).mockReset();
      (fetchGuestMeetingSummaryTask as jest.Mock).mockReset();
      (generateGuestMeetingSummary as jest.Mock).mockResolvedValueOnce({ task_id: 'task-fast' });
      (fetchGuestMeetingSummaryTask as jest.Mock)
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({
          status: 'SUCCESS',
          result: { overview: '已完成总结', key_decisions: [], action_items: [] },
        });
      const progress = jest.fn();
      const pending = generateSummaryForMeeting({
        meetingId: 'guest-meeting-fast',
        transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
        isGuest: true,
        onProgress: progress,
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(fetchGuestMeetingSummaryTask).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(249);
      expect(fetchGuestMeetingSummaryTask).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({ overview: '已完成总结' });
      expect(fetchGuestMeetingSummaryTask).toHaveBeenCalledTimes(2);
      expect(progress).toHaveBeenNthCalledWith(1, expect.objectContaining({ stage: 'queued' }));
      expect(progress).toHaveBeenNthCalledWith(2, expect.objectContaining({ stage: 'generating' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts a long poll immediately after the server advertises support', async () => {
    (generateGuestMeetingSummary as jest.Mock).mockResolvedValueOnce({ task_id: 'task-long-poll' });
    (fetchGuestMeetingSummaryTask as jest.Mock)
      .mockResolvedValueOnce({
        status: 'STARTED',
        result: null,
        long_poll_supported: true,
      })
      .mockResolvedValueOnce({
        status: 'SUCCESS',
        result: { overview: '长轮询完成', key_decisions: [], action_items: [] },
        long_poll_supported: true,
      });

    await expect(generateSummaryForMeeting({
      meetingId: 'guest-meeting-long-poll',
      transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
      isGuest: true,
    })).resolves.toMatchObject({ overview: '长轮询完成' });

    expect(fetchGuestMeetingSummaryTask).toHaveBeenNthCalledWith(
      1,
      'task-long-poll',
      undefined,
      0,
    );
    expect(fetchGuestMeetingSummaryTask).toHaveBeenNthCalledWith(
      2,
      'task-long-poll',
      undefined,
      5_000,
    );
  });

  it('recovers from short polling disconnects instead of reporting a false failure', async () => {
    jest.useFakeTimers();
    try {
      (generateGuestMeetingSummary as jest.Mock).mockReset();
      (fetchGuestMeetingSummaryTask as jest.Mock).mockReset();
      (generateGuestMeetingSummary as jest.Mock).mockResolvedValueOnce({ task_id: 'task-recover' });
      (fetchGuestMeetingSummaryTask as jest.Mock)
        .mockRejectedValueOnce(new Error('temporary network error'))
        .mockRejectedValueOnce(new Error('temporary network error'))
        .mockResolvedValueOnce({
          status: 'SUCCESS',
          result: { overview: '网络恢复后拿到结果', key_decisions: [], action_items: [] },
        });
      const progress = jest.fn();
      const pending = generateSummaryForMeeting({
        meetingId: 'guest-meeting-recover',
        transcriptLines: [{ id: 'line-1', text: '确认发布计划' }],
        isGuest: true,
        onProgress: progress,
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toMatchObject({ overview: '网络恢复后拿到结果' });
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'reconnecting' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('extracts a readable task failure reason from structured results', () => {
    expect(summaryTaskFailureMessage({ detail: '会议转写内容不足' })).toBe('会议转写内容不足');
    expect(summaryTaskFailureMessage({})).toBe('会议总结任务执行失败');
  });

  it('keeps recoverable network failures but discards terminal pending tasks', () => {
    expect(shouldDiscardPendingMeetingSummaryTask(new Error('network offline'))).toBe(false);
    expect(shouldDiscardPendingMeetingSummaryTask(new HttpResponseError('unauthorized', 401))).toBe(true);
  });
});
