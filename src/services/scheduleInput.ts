import type { PendingHardwareRecording } from 'laoji-native-platform';
import type { ParseResult, ScheduleParseContext } from './scheduleParsing';

/** Intent is selected by the physical gesture, never by keywords or duration. */
export function scheduleInputIdentity(source: PendingHardwareRecording): string {
  if (source.purpose !== 'schedule' || !source.sourceCaptureId) throw new Error('schedule capture identity missing');
  return `capture:${source.deviceId}:${source.sourceCaptureId}`;
}
export function scheduleInputContext(source: PendingHardwareRecording): ScheduleParseContext {
  return {
    ...(source.recordedAtMs >= 1577836800000 && source.timeZone
      ? { reference_datetime: new Date(source.recordedAtMs).toISOString(), timezone: source.timeZone } : {}),
  };
}
export function scheduleInputDraft(source: PendingHardwareRecording, result: ParseResult): ParseResult {
  if (scheduleInputContext(source).reference_datetime) return result;
  // A cold offline board has no clock. Never assign "tomorrow" to the receive date.
  return { ...result, start_date: '', end_date: null, schedule_graph: undefined,
    needs_clarification: true, clarification_question: '这条日程是哪一天？' };
}
export type ScheduleInputJob = {
  id: string;
  source: PendingHardwareRecording;
  draft: ParseResult | null;
  state: 'pending' | 'ready' | 'saved' | 'dismissed' | 'failed';
  attempts: number;
};
