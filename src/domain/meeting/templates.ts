import type { MeetingSummarySectionKind } from './summary';

export type MeetingTemplateId = 'general';

export interface SummarySectionDefinition {
  stableKey: string;
  title: string;
  kind: MeetingSummarySectionKind;
}

export interface MeetingTemplate {
  id: MeetingTemplateId;
  revision: number;
  title: string;
  mode: 'adaptive';
  version: 'current';
  sectionSchema: readonly SummarySectionDefinition[];
}

/**
 * There is one authored summary presentation. `general@3` is retained only as
 * the wire/storage envelope understood by released clients and existing DB
 * constraints; product code owns it as the adaptive current contract.
 */
export const DEFAULT_MEETING_TEMPLATE: MeetingTemplate = {
  id: 'general',
  revision: 3,
  title: '整理结果',
  mode: 'adaptive',
  version: 'current',
  sectionSchema: [
    { stableKey: 'overview', title: '概述', kind: 'paragraph' },
    { stableKey: 'topics', title: '主要内容', kind: 'bullet_group' },
    { stableKey: 'conclusions', title: '关键结论', kind: 'bullet_group' },
  ],
};

export function meetingTemplateById(
  id: string | null | undefined,
  revision?: number | null,
): MeetingTemplate | null {
  if (String(id ?? '').trim() !== DEFAULT_MEETING_TEMPLATE.id) return null;
  if (revision != null && revision !== DEFAULT_MEETING_TEMPLATE.revision) return null;
  return DEFAULT_MEETING_TEMPLATE;
}
