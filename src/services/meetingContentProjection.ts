import type { MeetingSummary, TranscriptLine } from '../types';
import type {
  SummarySectionRecord,
  SummaryVersionProjection,
  TranscriptRevisionProjection,
} from '../data/repositories';

function sectionText(section: SummarySectionRecord): string {
  return (section.userText !== null ? section.userText : section.generatedText).trim();
}

function bulletLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean);
}

export function transcriptProjectionToLegacyLines(
  projection: TranscriptRevisionProjection | null,
  legacyMeetingId: string,
): TranscriptLine[] {
  if (!projection) return [];
  return projection.segments.map(segment => ({
    id: segment.id,
    meeting_id: legacyMeetingId,
    speaker_id: segment.speakerProfileId ?? segment.speakerClusterId ?? undefined,
    speaker_label: segment.speakerLabelOverride ?? segment.speakerLabel ?? undefined,
    text: segment.text,
    start_time: segment.startMs / 1000,
    end_time: segment.endMs / 1000,
    confidence: segment.confidence ?? undefined,
    created_at: new Date(segment.createdAtMs).toISOString(),
  }));
}

export function summaryProjectionToLegacySummary(
  projection: SummaryVersionProjection | null,
  legacyMeetingId: string,
): MeetingSummary | null {
  if (!projection || !['ready', 'stale'].includes(projection.version.status)) return null;
  const visibleSections = projection.sections
    .map(section => ({ section, text: sectionText(section) }))
    .filter(item => item.text);
  const overview = visibleSections.find(item => item.section.stableKey === 'overview')?.text
    ?? visibleSections.find(item => item.section.kind === 'paragraph')?.text
    ?? visibleSections.find(item => item.section.kind !== 'action_items')?.text
    ?? '';
  const decisions = visibleSections
    .filter(item => item.section.stableKey === 'decisions' || item.section.kind === 'decisions')
    .flatMap(item => bulletLines(item.text));
  const actionItems = projection.meetingActions.map(action => ({
    id: action.id,
    content: action.content,
    assignee: action.assigneeText,
    due_date: action.dueAtMs === null ? null : new Date(action.dueAtMs).toISOString(),
    status: action.status,
  }));
  const fullText = visibleSections
    .map(({ section, text }) => section.title ? `${section.title}\n${text}` : text)
    .join('\n\n');
  if (!overview && decisions.length === 0 && actionItems.length === 0 && !fullText) return null;
  return {
    id: projection.version.id,
    meeting_id: legacyMeetingId,
    overview,
    full_text: fullText || overview || undefined,
    markdown: null,
    key_decisions: decisions,
    action_items: actionItems,
    generated_at: new Date(
      projection.version.completedAtMs ?? projection.version.createdAtMs,
    ).toISOString(),
  };
}
