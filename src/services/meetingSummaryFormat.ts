import type { MeetingSummary } from '../types';
import type { MeetingSummaryDocument } from '../domain/meeting';
import {
  meetingSummaryDocumentToText,
  normalizeMeetingSummaryDocument,
} from './meetingSummaryDocument';
import { toSimplifiedChinese } from '../utils/simplifiedChinese';

function documentLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean);
}

/** Current summaries are projections of an immutable Facts V3 document. */
export function meetingSummaryToText(summary: MeetingSummary | null): string {
  if (!summary?.structured_document) return '';
  const meetingId = summary.meeting_id?.trim()
    || summary.structured_document.meetingId.trim();
  if (!meetingId) return '';
  const document = normalizeMeetingSummaryDocument(meetingId, summary);
  return document ? meetingSummaryDocumentToText(document) : '';
}

/** Compatibility-shaped cache object backed exclusively by a current document. */
export function meetingSummaryDocumentToLegacySummary(
  document: MeetingSummaryDocument,
): MeetingSummary {
  const overview = document.sections.find(section => section.stableKey === 'overview')?.content
    ?? document.sections.find(section => section.kind === 'paragraph')?.content
    ?? document.sections.find(section => section.kind !== 'action_items')?.content
    ?? '';
  const decisions = document.sections
    .filter(section => section.stableKey === 'decisions')
    .flatMap(section => documentLines(section.content));
  const fullText = meetingSummaryDocumentToText(document);
  return {
    id: document.remoteVersionId ?? undefined,
    meeting_id: document.meetingId,
    overview,
    full_text: fullText || overview || undefined,
    markdown: null,
    key_decisions: decisions,
    action_items: document.actionItemCandidates.map(action => ({
      id: action.id,
      content: action.content,
      assignee: action.assignee,
      due_date: action.dueAtMs === null ? null : new Date(action.dueAtMs).toISOString(),
      status: action.status,
    })),
    generated_at: new Date(document.completedAtMs).toISOString(),
    structured_document: document,
  };
}

export function meetingSummaryTextToPlainText(value: string): string {
  return toSimplifiedChinese(value)
    .replace(/```(?:\w+)?\s*\n?([\s\S]*?)```/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rejects plain v2/Markdown payloads instead of reviving them as current. */
export function normalizeMeetingSummaryResult(
  meetingId: string,
  value: unknown,
): MeetingSummary | null {
  const document = normalizeMeetingSummaryDocument(meetingId, value);
  return document ? meetingSummaryDocumentToLegacySummary(document) : null;
}
