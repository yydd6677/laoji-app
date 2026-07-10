import { meetingSummaryToText, normalizeGuestSummaryResult } from '../src/services/meetingSummary';

describe('meeting summary helpers', () => {
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
  });
});
