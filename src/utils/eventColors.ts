import { Colors as C } from '../theme/colors';

export const EVENT_CATEGORIES = ['工作', '学习', '健康', '生活', '社交', '出行', '财务', '重要', '其他'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];

const CATEGORY_COLORS: Record<EventCategory, string> = {
  工作: C.blue,
  学习: C.green,
  健康: C.teal,
  生活: C.purple,
  社交: C.pink,
  出行: C.orange,
  财务: '#9B59B6',
  重要: C.red,
  其他: C.faint,
};

type EventColorInput = {
  category?: string | null;
};

export function normalizeEventCategory(category?: string | null): EventCategory {
  const clean = String(category ?? '').trim();
  return EVENT_CATEGORIES.includes(clean as EventCategory) ? clean as EventCategory : '其他';
}

export function colorForEventCategory(category?: string | null): string {
  return CATEGORY_COLORS[normalizeEventCategory(category)];
}

export function colorForEvent(input: EventColorInput): string {
  return colorForEventCategory(input.category);
}
