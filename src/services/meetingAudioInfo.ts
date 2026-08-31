export interface MeetingAudioInfo {
  url: string;
  mime_type?: string | null;
  duration_sec?: number | null;
  file_name?: string | null;
  expires_at?: string | null;
  requires_auth?: boolean;
}
