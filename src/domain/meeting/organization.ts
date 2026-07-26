export interface AutomaticMeetingTopic {
  name: string;
  normalizedName: string;
}

const MAXIMUM_AUTOMATIC_TOPICS_PER_SECTION = 12;
const MAXIMUM_AUTOMATIC_TOPIC_CODEPOINTS = 40;

const GENERIC_TOPIC_HEADINGS = new Set([
  'topic',
  'topics',
  '主题',
  '主要主题',
  '讨论主题',
  '核心主题',
  '会议主题',
]);

function stripTopicMarkdown(value: string): string {
  return value
    .replace(/^\s*(?:[-*+•·]\s+|\d{1,3}[.)、]\s+|#{1,6}\s+)/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1');
}

/**
 * Structured Summary `topics` sections are model-derived evidence, not user
 * labels. Normalize only explicit lines and keep their identity independent
 * from `meeting_tags`; never infer extra topics by punctuation splitting.
 */
export function automaticMeetingTopicsFromSummaryText(
  value: string | null | undefined,
): readonly AutomaticMeetingTopic[] {
  if (!value) return [];
  const topics: AutomaticMeetingTopic[] = [];
  const seen = new Set<string>();
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    const name = stripTopicMarkdown(line)
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
    const structuredBoundary = name.startsWith('{')
      || name.startsWith('[')
      || name.endsWith('}')
      || name.endsWith(']');
    if (
      !name
      || [...name].length > MAXIMUM_AUTOMATIC_TOPIC_CODEPOINTS
      || /[\u0000-\u001f\u007f]/.test(name)
      || structuredBoundary
    ) continue;
    const normalizedName = name.toLocaleLowerCase();
    if (GENERIC_TOPIC_HEADINGS.has(normalizedName) || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    topics.push({ name, normalizedName });
    if (topics.length >= MAXIMUM_AUTOMATIC_TOPICS_PER_SECTION) break;
  }
  return topics;
}
