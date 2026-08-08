import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  secureClientIdFactory,
  type MeetingSummaryAttachmentAuthorization,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
} from '../domain/meeting';
import type { TranscriptLine } from '../types';

export type MeetingSummaryCallSource =
  | 'manual'
  | 'regenerate'
  | 'automatic_resume'
  | 'resume'
  | 'remote_sync';

export interface MeetingSummaryTraceContext {
  traceId: string;
  clientRequestId: string;
  source: MeetingSummaryCallSource;
  meetingId: string;
  inputSha256: string;
  inputFingerprint?: string;
  inputLineCount: number;
  inputCharCount: number;
  templateId: string;
  templateRevision: number;
  authMode: 'guest' | 'authenticated';
  transcriptRevisionId?: string | null;
  deviceId: string;
  deviceName: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  buildVersion: string;
}

export type MeetingSummaryTracePhase = 'started' | 'submitted' | 'completed' | 'failed' | 'background';

export interface MeetingSummaryTraceRecord extends MeetingSummaryTraceContext {
  phase: MeetingSummaryTracePhase;
  taskId?: string | null;
  errorCode?: string | null;
  recordedAt: string;
}

const DEVICE_ID_KEY = '@laoji:diagnostics:installation-id:v1';
let deviceIdPromise: Promise<string> | null = null;
let traceAuditWrite: Promise<void> = Promise.resolve();

export function persistMeetingSummaryTrace(
  trace: MeetingSummaryTraceContext,
  input: {
    phase: MeetingSummaryTracePhase;
    taskId?: string | null;
    errorCode?: string | null;
  },
): Promise<void> {
  const operation = traceAuditWrite
    .catch(() => {})
    .then(async () => {
      try {
        const raw = await AsyncStorage.getItem('@laoji:meeting-summary-trace:v1');
        const previous = raw ? JSON.parse(raw) : [];
        const records = Array.isArray(previous) ? previous : [];
        const next: MeetingSummaryTraceRecord[] = [
          ...records.slice(-79),
          {
            ...trace,
            phase: input.phase,
            taskId: safeHeaderValue(input.taskId, 120) || null,
            errorCode: safeHeaderValue(input.errorCode, 120) || null,
            recordedAt: new Date().toISOString(),
          },
        ];
        await AsyncStorage.setItem('@laoji:meeting-summary-trace:v1', JSON.stringify(next));
      } catch {
        // Diagnostics must never make整理 fail when local storage is unavailable.
      }
    });
  traceAuditWrite = operation;
  return operation;
}

export async function loadMeetingSummaryTraceRecords(): Promise<MeetingSummaryTraceRecord[]> {
  try {
    const raw = await AsyncStorage.getItem('@laoji:meeting-summary-trace:v1');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as MeetingSummaryTraceRecord[] : [];
  } catch {
    return [];
  }
}

function safeHeaderValue(value: unknown, maxLength = 180): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

async function installationId(): Promise<string> {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      try {
        const existing = (await AsyncStorage.getItem(DEVICE_ID_KEY))?.trim();
        if (existing) return existing;
        const created = secureClientIdFactory.create();
        await AsyncStorage.setItem(DEVICE_ID_KEY, created);
        return created;
      } catch {
        // A diagnostics identifier must never block meeting整理. The session
        // id is still useful for correlating one app run when storage is down.
        return safeHeaderValue(Constants.sessionId || 'unknown', 96) || 'unknown';
      }
    })();
  }
  return deviceIdPromise;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function traceInputPayload(input: {
  meetingId: string;
  title?: string;
  meetingDate?: string;
  transcriptLines: readonly TranscriptLine[];
  template: Pick<MeetingTemplate, 'id' | 'revision'>;
  carryForward?: MeetingSummaryCarryForwardAuthorization | null;
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
}): string {
  return stableJson({
    meeting_id: input.meetingId,
    title: input.title?.trim() ?? '',
    meeting_date: input.meetingDate?.trim() ?? '',
    template_id: input.template.id,
    template_revision: input.template.revision,
    carry_forward: input.carryForward ?? null,
    attachment_authorization: input.attachmentAuthorization ?? null,
    transcript_lines: input.transcriptLines.map(line => ({
      id: line.id ?? null,
      recording_asset_id: line.recording_asset_id ?? line.recordingAssetRemoteId ?? null,
      transcription_job_id: line.transcription_job_id ?? line.transcriptionJobId ?? null,
      speaker_id: line.speaker_id ?? null,
      speaker_label: line.speaker_label ?? null,
      text: line.text ?? '',
      start_time: line.start_time ?? null,
      end_time: line.end_time ?? null,
    })),
  });
}

export async function createMeetingSummaryTrace(input: {
  meetingId: string;
  title?: string;
  meetingDate?: string;
  transcriptLines: readonly TranscriptLine[];
  template: Pick<MeetingTemplate, 'id' | 'revision'>;
  carryForward?: MeetingSummaryCarryForwardAuthorization | null;
  attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null;
  source: MeetingSummaryCallSource;
  authMode: 'guest' | 'authenticated';
  inputFingerprint?: string;
}): Promise<MeetingSummaryTraceContext> {
  const serialized = traceInputPayload(input);
  const inputSha256 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    serialized,
  );
  const inputCharCount = input.transcriptLines.reduce(
    (total, line) => total + String(line.text ?? '').length,
    0,
  );
  return {
    traceId: secureClientIdFactory.create(),
    clientRequestId: secureClientIdFactory.create(),
    source: input.source,
    meetingId: safeHeaderValue(input.meetingId, 120),
    inputSha256,
    inputFingerprint: safeHeaderValue(input.inputFingerprint, 180) || undefined,
    inputLineCount: input.transcriptLines.length,
    inputCharCount,
    templateId: safeHeaderValue(input.template.id, 80),
    templateRevision: input.template.revision,
    authMode: input.authMode,
    deviceId: await installationId(),
    deviceName: safeHeaderValue(Constants.deviceName || '未知设备', 120),
    platform: Platform.OS,
    osVersion: safeHeaderValue(Platform.Version, 40),
    appVersion: safeHeaderValue(Constants.nativeAppVersion || Constants.expoConfig?.version || '未知', 40),
    buildVersion: safeHeaderValue(Constants.nativeBuildVersion || '未知', 40),
  };
}

export function meetingSummaryTraceHeaders(
  trace?: MeetingSummaryTraceContext,
): Record<string, string> {
  if (!trace) return {};
  return {
    'X-Trace-Id': trace.traceId,
    'X-Laoji-Client-Request-Id': trace.clientRequestId,
    'X-Laoji-Call-Source': trace.source,
    'X-Laoji-Meeting-Id': trace.meetingId,
    'X-Laoji-Input-SHA256': trace.inputSha256,
    'X-Laoji-Input-Fingerprint': trace.inputFingerprint ?? '',
    'X-Laoji-Input-Lines': String(trace.inputLineCount),
    'X-Laoji-Input-Chars': String(trace.inputCharCount),
    'X-Laoji-Template-Id': trace.templateId,
    'X-Laoji-Template-Revision': String(trace.templateRevision),
    'X-Laoji-Auth-Mode': trace.authMode,
    'X-Laoji-Device-Id': trace.deviceId,
    'X-Laoji-Device-Name': trace.deviceName,
    'X-Laoji-Platform': trace.platform,
    'X-Laoji-OS-Version': trace.osVersion,
    'X-Laoji-App-Version': trace.appVersion,
    'X-Laoji-Build-Version': trace.buildVersion,
  };
}
