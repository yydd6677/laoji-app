const SYSTEM_SPEAKER_PATTERN = /^speaker[\s_:#-]*(\d+)$/i;

const INTERNAL_UNKNOWN_VALUES = new Set([
  'unknown',
  'unknown speaker',
  'unknown_speaker',
  'unknown-speaker',
]);

const GENERIC_SPEAKER_LABELS = new Set([
  '发言人',
  '讲话人',
  '说话人',
  '未知',
  '未知发言人',
  '未知讲话人',
  '未知说话人',
]);

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function isInternalUnknown(value: string): boolean {
  return INTERNAL_UNKNOWN_VALUES.has(value.toLowerCase());
}

/**
 * [SOURCE] Feishu formats anonymous numeric participants with
 * View_G_Subtitles_SpeakerNum_Text (Chinese: "说话人 {{number}}").
 */
export function systemSpeakerDisplayLabel(value: string | null | undefined): string | null {
  const match = SYSTEM_SPEAKER_PATTERN.exec(trimmed(value));
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(number) && number > 0 ? `说话人 ${number}` : null;
}

/** Keeps user-authored names verbatim while localizing backend speaker identifiers. */
export function speakerDisplayLabel(
  label: string | null | undefined,
  id: string | null | undefined,
  fallback = '发言人',
): string {
  const rawLabel = trimmed(label);
  const localizedLabel = systemSpeakerDisplayLabel(rawLabel);
  if (localizedLabel) return localizedLabel;

  if (rawLabel && !isInternalUnknown(rawLabel) && !GENERIC_SPEAKER_LABELS.has(rawLabel)) {
    return rawLabel;
  }

  const rawId = trimmed(id);
  const localizedId = systemSpeakerDisplayLabel(rawId);
  if (localizedId) return localizedId;

  if (rawLabel && !isInternalUnknown(rawLabel)) return rawLabel;
  if (rawId && !isInternalUnknown(rawId)) return rawId;
  return fallback;
}
