export const SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION = 2 as const;

export type ScheduleVoicePhase =
  | 'input'
  | 'preparing'
  | 'recording'
  | 'parsing'
  | 'confirm'
  | 'saving';

export interface ScheduleVoiceFieldSnapshot {
  key: string;
  label: string;
  value: string;
}

export interface ScheduleVoiceSnapshot {
  schemaVersion: typeof SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION;
  phase: ScheduleVoicePhase;
  text: string;
  errorMessage?: string;
  statusLabel?: string;
  title?: string;
  fields?: ScheduleVoiceFieldSnapshot[];
  canParse?: boolean;
  canSave?: boolean;
  canEditDetails?: boolean;
  needsClarification?: boolean;
  clarificationQuestion?: string;
  clarificationAnswer?: string;
  canClarify?: boolean;
}

export type ScheduleVoiceAction =
  | { type: 'close' | 'record-start' | 'record-stop' | 'parse' | 'save' | 'edit-details' | 'retry-input' | 'clarify' }
  | { type: 'text-change' | 'clarification-change'; text: string };

/** UI-OVERLAY-WINDOW-001 / MIN-AUDIO-001: the snapshot is hosted by LaojiUi's Activity owner. */
