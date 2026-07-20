import { HttpResponseError } from '../src/services/errors';
import {
  classifyMeetingAudioUploadFailure,
  LocalMeetingAudioFileMissingError,
} from '../src/services/meetingAudioUploadFailure';

describe('meeting audio upload failure classification', () => {
  it.each([
    [413, 'file_too_large'],
    [404, 'meeting_missing'],
    [400, 'audio_rejected'],
    [415, 'audio_rejected'],
    [422, 'audio_rejected'],
    [403, 'forbidden'],
  ])('blocks permanent HTTP %s responses', (status, code) => {
    expect(classifyMeetingAudioUploadFailure(new HttpResponseError('failed', status))).toEqual(
      expect.objectContaining({ retryable: false, code }),
    );
  });

  it('blocks an explicitly missing local recording', () => {
    expect(classifyMeetingAudioUploadFailure(new LocalMeetingAudioFileMissingError())).toEqual({
      retryable: false,
      code: 'file_missing',
      message: '本机录音文件已不存在，无法继续上传。',
    });
  });

  it.each([401, 409, 429, 500, 503])('keeps HTTP %s retryable', status => {
    expect(classifyMeetingAudioUploadFailure(new HttpResponseError('failed', status))).toEqual(
      expect.objectContaining({ retryable: true, code: 'temporary' }),
    );
  });

  it('keeps network failures retryable', () => {
    expect(classifyMeetingAudioUploadFailure(new Error('Network request failed'))).toEqual(
      expect.objectContaining({ retryable: true, code: 'temporary' }),
    );
  });
});
