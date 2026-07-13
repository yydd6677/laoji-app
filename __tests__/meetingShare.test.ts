import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { zip } from 'react-native-zip-archive';
import {
  buildMeetingDocumentText,
  buildMeetingTranscriptText,
  cleanupStaleMeetingShareCache,
  MEETING_SHARE_RETENTION_MS,
  safeMeetingFileName,
  shareMeetingArtifact,
} from '../src/services/meetingShare';
import { Meeting } from '../src/types';

const meeting: Meeting = {
  id: 'meeting-1',
  title: '周五/发布会议',
  date: '2026年7月10日',
  time: '09:30',
  duration: '25 分钟',
  tags: [{ label: '已完成', color: '#52C41A' }],
  participants: ['小李', '小王'],
};

describe('meeting share content', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([]);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('builds a readable timestamped transcript file', () => {
    expect(buildMeetingTranscriptText([
      { id: '1', speaker_label: '小李', text: '确认周五发布。', start_time: 5 },
      { id: '2', speaker_label: '小王', text: '我负责验收。', start_time: 65 },
    ])).toBe('[00:05] 小李：确认周五发布。\n[01:05] 小王：我负责验收。');
  });

  it('builds one text document containing metadata, summary, and transcript', () => {
    const text = buildMeetingDocumentText(
      meeting,
      [{ id: '1', speaker_label: '小李', text: '确认周五发布。', start_time: 5 }],
      '决定周五发布安卓版本。',
    );
    expect(text).toContain('会议标题：周五/发布会议');
    expect(text).toContain('参与人员：小李、小王');
    expect(text).toContain('会议总结\n决定周五发布安卓版本。');
    expect(text).toContain('会议转写\n[00:05] 小李：确认周五发布。');
  });

  it('omits the summary section when no summary has been generated', () => {
    const text = buildMeetingDocumentText(
      meeting,
      [{ id: '1', speaker_label: '小李', text: '确认周五发布。', start_time: 5 }],
    );
    expect(text).not.toContain('会议总结');
    expect(text).toContain('会议转写\n[00:05] 小李：确认周五发布。');
  });

  it('creates filesystem-safe names while preserving Chinese text', () => {
    expect(safeMeetingFileName(' 周五/发布：会议 ')).toBe('周五_发布_会议');
  });

  it('builds a ZIP package containing text files and a local recording', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (zip as jest.Mock).mockImplementation(async (_sources, target) => target);

    await shareMeetingArtifact('bundle', {
      meeting: { ...meeting, audioLocalUri: 'file:///data/meeting.wav', audioAvailable: true },
      transcriptLines: [{ id: '1', speaker_label: '小李', text: '确认周五发布。', start_time: 5 }],
      summaryText: '决定周五发布安卓版本。',
      isGuest: true,
    });

    expect(FileSystem.copyAsync).toHaveBeenCalledWith(expect.objectContaining({
      from: 'file:///data/meeting.wav',
    }));
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledTimes(3);
    expect(zip).toHaveBeenCalledWith(expect.arrayContaining([
      expect.stringContaining('会议信息.txt'),
      expect.stringContaining('会议总结.txt'),
      expect.stringContaining('会议转写.txt'),
      expect.stringContaining('录音.wav'),
    ]), expect.stringContaining('完整资料_'), 1);
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/.*\.zip$/),
      expect.objectContaining({ mimeType: 'application/zip' }),
    );
  });

  it('downloads authenticated cloud audio before sharing it', async () => {
    (FileSystem.downloadAsync as jest.Mock).mockResolvedValue({ status: 200 });

    await shareMeetingArtifact('audio', {
      meeting,
      transcriptLines: [],
      isGuest: false,
      accessToken: 'test-token',
      audioInfo: {
        url: 'http://203.0.113.10:18020/api/laoji/meetings/meeting-1/audio/file',
        file_name: 'meeting.m4a',
        mime_type: 'audio/mp4',
        requires_auth: true,
      },
    });

    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(
      'http://203.0.113.10:18020/api/laoji/meetings/meeting-1/audio/file',
      expect.stringContaining('_录音.m4a'),
      { headers: { Authorization: 'Bearer test-token' } },
    );
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      expect.stringContaining('_录音.m4a'),
      expect.objectContaining({ mimeType: 'audio/mp4' }),
    );
  });

  it('never forwards the login token to an authenticated external audio origin', async () => {
    await expect(shareMeetingArtifact('audio', {
      meeting,
      transcriptLines: [],
      isGuest: false,
      accessToken: 'sensitive-token',
      audioInfo: {
        url: 'https://external.example/audio/file',
        mime_type: 'audio/mp4',
        requires_auth: true,
      },
    })).rejects.toMatchObject({ code: 'AUTH_ORIGIN_MISMATCH' });

    expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  });

  it('keeps a shared document available during the receiving app grace period', async () => {
    await shareMeetingArtifact('document', {
      meeting,
      transcriptLines: [{ id: '1', text: '需要被接收方读取的内容' }],
      isGuest: true,
    });

    const sharedUri = (Sharing.shareAsync as jest.Mock).mock.calls[0][0] as string;
    const sharedDirectory = sharedUri.slice(0, sharedUri.lastIndexOf('/') + 1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(sharedDirectory, expect.anything());

    await jest.advanceTimersByTimeAsync(MEETING_SHARE_RETENTION_MS);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(sharedDirectory, { idempotent: true });
  });

  it('deletes expired share artifacts and schedules young artifacts from a previous process', async () => {
    const now = 1_800_000_000_000;
    const expired = `会议-资料-${now - MEETING_SHARE_RETENTION_MS - 1}`;
    const young = `会议-资料-${now - 1_000}`;
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([expired, young, 'unrelated-entry']);

    await cleanupStaleMeetingShareCache(now);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      `file:///tmp/laoji-cache/meeting-shares/${expired}`,
      { idempotent: true },
    );
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      `file:///tmp/laoji-cache/meeting-shares/${young}`,
      expect.anything(),
    );

    await jest.advanceTimersByTimeAsync(MEETING_SHARE_RETENTION_MS - 1_000);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      `file:///tmp/laoji-cache/meeting-shares/${young}`,
      { idempotent: true },
    );
  });
});
