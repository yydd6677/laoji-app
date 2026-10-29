/** The summary's meaning is separate from immutable transcript identity.
 * Timestamps, confidence, segment IDs and ASR window boundaries can change
 * without new information. Never use this key to bypass revision integrity.
 */
type Utterance = { text: string; speakerLabel?: string | null; speakerLabelOverride?: string | null };

export function summaryTranscriptMeaning(rows: readonly Utterance[]): string {
  const runs: Array<{ speaker: string; text: string }> = [];
  for (const row of rows) {
    const speaker = (row.speakerLabelOverride ?? row.speakerLabel ?? '').normalize('NFC').trim();
    const text = row.text.normalize('NFC').replace(/\s+/g, ' ')
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').trim();
    if (!text) continue;
    const previous = runs[runs.length - 1];
    if (previous?.speaker === speaker) {
      const separator = /[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(text) ? ' ' : '';
      previous.text += separator + text;
    } else runs.push({ speaker, text });
  }
  return JSON.stringify(runs);
}
