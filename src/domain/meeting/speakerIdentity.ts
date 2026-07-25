const SYSTEM_SPEAKER_PATTERN = /^speaker[\s_:#-]*(\d+)$/i;
const LOCALIZED_NUMBERED_SPEAKER_PATTERN = /^(?:发言人|讲话人|说话人)[\s_:#-]*(\d+)$/;

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

function normalizedLabel(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim() ?? '';
}

/**
 * Anonymous diarization clusters are useful inside one transcript but are not
 * stable people. Keep this classifier in the domain so list projection and UI
 * formatting cannot disagree about whether a label identifies a person.
 */
export function isAnonymousSpeakerIdentityLabel(
  value: string | null | undefined,
): boolean {
  const label = normalizedLabel(value);
  if (!label) return true;
  if (INTERNAL_UNKNOWN_VALUES.has(label.toLocaleLowerCase())) return true;
  if (GENERIC_SPEAKER_LABELS.has(label)) return true;
  return SYSTEM_SPEAKER_PATTERN.test(label)
    || LOCALIZED_NUMBERED_SPEAKER_PATTERN.test(label);
}

/** Returns an exact, display-safe person name without fuzzy/case folding. */
export function namedSpeakerIdentityLabel(
  value: string | null | undefined,
): string | null {
  const label = normalizedLabel(value);
  if (
    !label
    || [...label].length > 100
    || /[\u0000-\u001f\u007f]/.test(label)
    || isAnonymousSpeakerIdentityLabel(label)
  ) return null;
  return label;
}
