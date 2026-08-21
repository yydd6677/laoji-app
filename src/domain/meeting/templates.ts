import type { MeetingSummarySectionKind } from './summary';

export type MeetingTemplateId = 'general' | 'one_on_one' | 'project_sync' | 'interview';

export interface SummarySectionDefinition {
  stableKey: string;
  title: string;
  kind: MeetingSummarySectionKind;
}

export interface MeetingTemplate {
  id: MeetingTemplateId;
  revision: number;
  title: string;
  sectionSchema: readonly SummarySectionDefinition[];
  actionExtraction: 'standard' | 'follow_up_focused';
}

export const MEETING_TEMPLATES: readonly MeetingTemplate[] = [
  {
    id: 'general',
    revision: 3,
    title: '通用',
    sectionSchema: [
      { stableKey: 'overview', title: '概述', kind: 'paragraph' },
      { stableKey: 'topics', title: '主要议题', kind: 'bullet_group' },
      { stableKey: 'conclusions', title: '关键结论', kind: 'bullet_group' },
    ],
    actionExtraction: 'standard',
  },
  {
    id: 'one_on_one',
    revision: 3,
    title: '1:1',
    sectionSchema: [
      { stableKey: 'overview', title: '概述', kind: 'paragraph' },
      { stableKey: 'discussion', title: '讨论主题', kind: 'bullet_group' },
      { stableKey: 'feedback', title: '反馈与关注', kind: 'quote' },
      { stableKey: 'support', title: '支持需求', kind: 'bullet_group' },
    ],
    actionExtraction: 'follow_up_focused',
  },
  {
    id: 'project_sync',
    revision: 3,
    title: '项目同步',
    sectionSchema: [
      { stableKey: 'overview', title: '概述', kind: 'paragraph' },
      { stableKey: 'progress', title: '进展', kind: 'bullet_group' },
      { stableKey: 'risks', title: '风险与阻塞', kind: 'risk_card' },
      { stableKey: 'timeline', title: '范围和里程碑', kind: 'timeline' },
    ],
    actionExtraction: 'follow_up_focused',
  },
  {
    id: 'interview',
    revision: 3,
    title: '访谈',
    sectionSchema: [
      { stableKey: 'overview', title: '概述', kind: 'paragraph' },
      { stableKey: 'topics', title: '主题', kind: 'bullet_group' },
      { stableKey: 'views', title: '受访者观点', kind: 'quote' },
      { stableKey: 'evidence', title: '证据摘录', kind: 'quote' },
      { stableKey: 'follow_up_questions', title: '后续问题', kind: 'bullet_group' },
    ],
    actionExtraction: 'standard',
  },
] as const;

export const DEFAULT_MEETING_TEMPLATE = MEETING_TEMPLATES[0];

export function meetingTemplateById(
  id: string | null | undefined,
  revision?: number | null,
): MeetingTemplate | null {
  const template = MEETING_TEMPLATES.find(candidate => candidate.id === id) ?? null;
  if (!template) return null;
  return revision == null || revision === template.revision ? template : null;
}

export function meetingTemplateKey(template: Pick<MeetingTemplate, 'id' | 'revision'>): string {
  return `${template.id}@${template.revision}`;
}

export function meetingTemplateSectionLabel(template: MeetingTemplate): string {
  return template.sectionSchema.map(section => section.title).join(' · ');
}
