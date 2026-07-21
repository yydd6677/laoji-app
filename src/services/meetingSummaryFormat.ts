import type { MeetingSummary } from '../types';

type UnknownRecord = Record<string, unknown>;
type SummaryActionItem = NonNullable<MeetingSummary['action_items']>[number];

const EMPTY_VALUE_PATTERN = /^(?:n\/?a|tbd|none|null|不适用|待定|未知|未记录|未提供|未提及|暂无|无|[-—/])$/i;
const SUMMARY_METADATA_PATTERN = /^(?:会议(?:标题|类型|日期|时间|地点|地址|主持人)|标题|日期|时间|地点|地址|主持人|参会人|参与人(?:员)?)[：:]/;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function parseRecord(value: unknown): UnknownRecord | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  const clean = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!clean.startsWith('{') || !clean.endsWith('}')) return null;
  try {
    return asRecord(JSON.parse(clean));
  } catch {
    return null;
  }
}

function meaningfulText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  if (!text) return '';
  const placeholder = text.replace(/[。.!！?？:：;；]+$/g, '').trim();
  return EMPTY_VALUE_PATTERN.test(placeholder) ? '' : text;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .trim();
}

function cleanOverview(value: unknown): string {
  const raw = meaningfulText(value);
  if (!raw) return '';
  const parsed = parseRecord(raw);
  if (parsed) {
    const meeting = asRecord(parsed.meeting);
    return [parsed.overview, parsed.tldr, meeting?.summary]
      .map(cleanOverview)
      .find(Boolean) ?? '';
  }

  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  const jsonish = /["'](?:overview|tldr)["']\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(normalized);
  if (jsonish) {
    try {
      return stripInlineMarkdown(JSON.parse(`"${jsonish[1]}"`));
    } catch {
      return stripInlineMarkdown(jsonish[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'));
    }
  }
  if (/^(?:\{|\[)/.test(normalized)) return '';

  const tldr = /(?:^|\n)\s*>?\s*(?:\*{0,2})?(?:TL;?DR|会议概述|概述|摘要)(?:\*{0,2})?\s*[：:]\s*([^\n]+)/i.exec(normalized);
  if (tldr) return stripInlineMarkdown(tldr[1].replace(/^\s*>\s*/, ''));

  const hasStructure = /(?:^|\n)\s*(?:#{1,6}\s+|\|.+\||[-*+]\s+|\d+[.)]\s+)/m.test(normalized);
  const blocks = hasStructure ? normalized.split(/\n\s*\n/) : [normalized];
  for (const block of blocks) {
    if (/^\s*(?:\||```)/m.test(block)) continue;
    const content = block
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !/^#{1,6}\s+/.test(line))
      .filter(line => !/^[-*+]\s+/.test(line) && !/^\d+[.)]\s+/.test(line))
      .map(line => stripInlineMarkdown(line.replace(/^>\s?/, '')))
      .filter(line => line && !SUMMARY_METADATA_PATTERN.test(line))
      .filter(line => meaningfulText(line));
    if (content.length > 0) return content.join(' ');
  }
  return '';
}

function cleanListItem(value: unknown): string {
  const text = meaningfulText(value);
  return text
    ? stripInlineMarkdown(text).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim()
    : '';
}

function itemText(value: unknown, keys: readonly string[]): string {
  const direct = cleanListItem(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return '';
  return keys.map(key => cleanListItem(record[key])).find(Boolean) ?? '';
}

function sourceArrays(sources: readonly UnknownRecord[], keys: readonly string[]): unknown[] {
  const values: unknown[] = [];
  sources.forEach(source => keys.forEach(key => {
    if (Array.isArray(source[key])) values.push(...source[key] as unknown[]);
  }));
  return values;
}

function summaryContent(value: unknown) {
  const root = parseRecord(value) ?? {};
  const raw = parseRecord(root.raw_json);
  const sources = raw && raw !== root ? [root, raw] : [root];
  const meetingSummaries = sources.map(source => asRecord(source.meeting)?.summary);
  const overview = [
    ...sources.flatMap(source => [source.overview, source.tldr]),
    ...meetingSummaries,
    root.full_text,
    root.markdown,
  ].map(cleanOverview).find(Boolean) ?? '';

  const seenDecisions = new Set<string>();
  const decisions = sourceArrays(sources, ['key_decisions', 'decisions'])
    .map(item => itemText(item, ['content', 'description', 'decision', 'text', 'title', 'summary']))
    .filter(Boolean)
    .filter(item => {
      const key = item.replace(/\s+/g, '').toLowerCase();
      if (seenDecisions.has(key)) return false;
      seenDecisions.add(key);
      return true;
    });

  const seenActions = new Set<string>();
  const actions: SummaryActionItem[] = [];
  sourceArrays(sources, ['action_items', 'actions']).forEach(item => {
    const record = asRecord(item);
    const content = itemText(item, ['content', 'task', 'description', 'text', 'title']);
    if (!content) return;
    const action: SummaryActionItem = {
      content,
      assignee: meaningfulText(record?.assignee ?? record?.owner ?? record?.responsible_person) || null,
      due_date: meaningfulText(record?.due_date ?? record?.due ?? record?.deadline) || null,
      status: meaningfulText(record?.status) || undefined,
    };
    const key = [action.content, action.assignee, action.due_date]
      .map(part => (part ?? '').replace(/\s+/g, '').toLowerCase())
      .join('|');
    if (seenActions.has(key)) return;
    seenActions.add(key);
    actions.push(action);
  });
  return { root, overview, decisions, actions };
}

function actionText(item: SummaryActionItem): string {
  const details: string[] = [];
  if (item.assignee && !item.content.includes(item.assignee)) details.push(`负责人：${item.assignee}`);
  if (item.due_date && !item.content.includes(item.due_date)) details.push(`截止：${item.due_date}`);
  return details.length > 0 ? `${item.content}（${details.join('，')}）` : item.content;
}

export function meetingSummaryToText(summary: MeetingSummary | null): string {
  if (!summary) return '';
  const { overview, decisions, actions } = summaryContent(summary);
  const sections: string[] = [];
  if (overview) sections.push(overview);
  if (decisions.length > 0) {
    sections.push(`## 关键决定\n${decisions.map(item => `- ${item}`).join('\n')}`);
  }
  if (actions.length > 0) {
    sections.push(`## 待办事项\n${actions.map(item => `- ${actionText(item)}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

export function meetingSummaryTextToPlainText(value: string): string {
  return value
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

export function normalizeMeetingSummaryResult(meetingId: string, value: unknown): MeetingSummary | null {
  const { root, overview, decisions, actions } = summaryContent(value);
  if (!(overview || decisions.length > 0 || actions.length > 0)) return null;
  return {
    id: meaningfulText(root.id) || undefined,
    meeting_id: meaningfulText(root.meeting_id) || meetingId,
    overview,
    full_text: overview || undefined,
    markdown: null,
    key_decisions: decisions,
    action_items: actions,
    generated_at: meaningfulText(root.generated_at) || new Date().toISOString(),
  };
}
