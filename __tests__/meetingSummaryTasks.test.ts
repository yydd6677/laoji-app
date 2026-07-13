import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryInputFingerprint,
  resetMeetingSummaryTaskStorageForTests,
  savePendingMeetingSummaryTask,
} from '../src/services/meetingSummaryTasks';
import { TranscriptLine } from '../src/types';

const lines: TranscriptLine[] = [
  { id: 'line-1', speaker_label: '甲', text: '确认周五发布', start_time: 0, end_time: 2 },
  { id: 'line-2', speaker_label: '乙', text: '我负责整理回归结果', start_time: 2, end_time: 5 },
];

describe('meeting summary task persistence', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    resetMeetingSummaryTaskStorageForTests();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => storage.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
      storage.delete(key);
    });
  });

  it('creates a stable fingerprint and changes it when summary input changes', () => {
    const first = meetingSummaryInputFingerprint(lines, '发布例会', '2026-07-13');
    expect(meetingSummaryInputFingerprint(lines, '发布例会', '2026-07-13')).toBe(first);
    expect(meetingSummaryInputFingerprint(
      [{ ...lines[0], text: '改为下周发布' }, lines[1]],
      '发布例会',
      '2026-07-13',
    )).not.toBe(first);
    expect(meetingSummaryInputFingerprint(lines, '另一个标题', '2026-07-13')).not.toBe(first);
  });

  it('persists tasks by account scope and clears only the requested meeting', async () => {
    const inputFingerprint = meetingSummaryInputFingerprint(lines);
    await savePendingMeetingSummaryTask('user:A', {
      meetingId: 'meeting-1',
      taskId: 'task-A',
      mode: 'authenticated',
      inputFingerprint,
    });
    await savePendingMeetingSummaryTask('user:B', {
      meetingId: 'meeting-1',
      taskId: 'task-B',
      mode: 'authenticated',
      inputFingerprint,
    });

    await expect(getPendingMeetingSummaryTask('user:A', 'meeting-1')).resolves.toEqual(
      expect.objectContaining({ taskId: 'task-A' }),
    );
    await expect(getPendingMeetingSummaryTask('user:B', 'meeting-1')).resolves.toEqual(
      expect.objectContaining({ taskId: 'task-B' }),
    );

    await clearPendingMeetingSummaryTask('user:A', 'meeting-1');
    await expect(getPendingMeetingSummaryTask('user:A', 'meeting-1')).resolves.toBeNull();
    await expect(getPendingMeetingSummaryTask('user:B', 'meeting-1')).resolves.toEqual(
      expect.objectContaining({ taskId: 'task-B' }),
    );
  });

  it('serializes concurrent saves without losing either meeting task', async () => {
    const inputFingerprint = meetingSummaryInputFingerprint(lines);
    await Promise.all([
      savePendingMeetingSummaryTask('guest', {
        meetingId: 'meeting-1', taskId: 'task-1', mode: 'guest', inputFingerprint,
      }),
      savePendingMeetingSummaryTask('guest', {
        meetingId: 'meeting-2', taskId: 'task-2', mode: 'guest', inputFingerprint,
      }),
    ]);

    await expect(getPendingMeetingSummaryTask('guest', 'meeting-1')).resolves.toEqual(
      expect.objectContaining({ taskId: 'task-1' }),
    );
    await expect(getPendingMeetingSummaryTask('guest', 'meeting-2')).resolves.toEqual(
      expect.objectContaining({ taskId: 'task-2' }),
    );
  });

  it('purges guest and account tasks at their server retention boundary', async () => {
    const createdAt = '2026-07-13T00:00:00.000Z';
    const inputFingerprint = meetingSummaryInputFingerprint(lines);
    await savePendingMeetingSummaryTask('guest', {
      meetingId: 'guest-meeting', taskId: 'guest-task', mode: 'guest', inputFingerprint, createdAt,
    });
    await savePendingMeetingSummaryTask('user:A', {
      meetingId: 'cloud-meeting', taskId: 'cloud-task', mode: 'authenticated', inputFingerprint, createdAt,
    });

    await expect(getPendingMeetingSummaryTask(
      'guest',
      'guest-meeting',
      Date.parse(createdAt) + 55 * 60 * 1000,
    )).resolves.toBeNull();
    await expect(getPendingMeetingSummaryTask(
      'user:A',
      'cloud-meeting',
      Date.parse(createdAt) + 23 * 60 * 60 * 1000,
    )).resolves.toBeNull();
  });

  it('surfaces a corrupted registry instead of silently dropping recovery state', async () => {
    storage.set('@laoji:pendingMeetingSummaryTasks:v1:guest', '{bad-json');
    await expect(getPendingMeetingSummaryTask('guest', 'meeting-1')).rejects.toThrow();
  });
});
