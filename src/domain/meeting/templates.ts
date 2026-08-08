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
    revision: 2,
    title: '通用',
    sectionSchema: [
      { stableKey: 'overview', title: '概述', kind: 'paragraph' },
      { stableKey: 'key_discussion', title: '关键讨论', kind: 'topics' },
    ],
    actionExtraction: 'standard',
  },
  {
    id: 'one_on_one',
    revision: 2,
    title: '1:1',
    sectionSchema: [
      { stableKey: 'topics', title: '讨论主题', kind: 'topics' },
      { stableKey: 'feedback_concerns', title: '反馈与关注', kind: 'bullets' },
      { stableKey: 'support_improvements', title: '支持与改进', kind: 'bullets' },
    ],
    actionExtraction: 'follow_up_focused',
  },
  {
    id: 'project_sync',
    revision: 2,
    title: '项目同步',
    sectionSchema: [
      { stableKey: 'progress', title: '进展', kind: 'bullets' },
      { stableKey: 'risks', title: '风险与阻塞', kind: 'risks' },
      { stableKey: 'scope_milestones', title: '范围与里程碑', kind: 'bullets' },
    ],
    actionExtraction: 'follow_up_focused',
  },
  {
    id: 'interview',
    revision: 2,
    title: '访谈',
    sectionSchema: [
      { stableKey: 'topics', title: '主题', kind: 'topics' },
      { stableKey: 'interviewee_views', title: '受访者观点', kind: 'bullets' },
      { stableKey: 'evidence_quotes', title: '证据摘录', kind: 'bullets' },
      { stableKey: 'follow_up_questions', title: '后续问题', kind: 'numbered' },
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
