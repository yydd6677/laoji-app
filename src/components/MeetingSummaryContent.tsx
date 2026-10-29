import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  type MeetingSummaryDocument,
  type MeetingSummarySectionKind,
} from '../domain/meeting/summary';
import { useTheme } from '../theme/ThemeProvider';

type AuthoredEntry = Readonly<{
  kind: 'prose' | 'entry' | 'ordered' | 'action' | 'quote' | 'code';
  text: string;
  marker?: string;
  checked?: boolean;
  meta?: string;
}>;

type AuthoredSection = Readonly<{
  id: string;
  title: string | null;
  kind: MeetingSummarySectionKind | 'compatibility';
  entries: readonly AuthoredEntry[];
  evidenceCount: number;
}>;

function cleanInlineSyntax(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .trim();
}

/** Compatibility input is converted into an authored hierarchy before render. */
export function parseSummaryText(content: string): AuthoredSection[] {
  const sections: Array<{ id: string; title: string | null; entries: AuthoredEntry[] }> = [];
  let current = { id: 'summary-section-0', title: null as string | null, entries: [] as AuthoredEntry[] };
  const paragraph: string[] = [];
  const code: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    const text = cleanInlineSyntax(paragraph.join('\n'));
    if (text) current.entries.push({ kind: 'prose', text });
    paragraph.length = 0;
  };
  const flushCode = () => {
    const text = code.join('\n').trim();
    if (text) current.entries.push({ kind: 'code', text });
    code.length = 0;
  };
  const commit = () => {
    flushParagraph();
    if (current.title || current.entries.length > 0) sections.push(current);
    current = {
      id: `summary-section-${sections.length}`,
      title: null,
      entries: [],
    };
  };

  content.replace(/\r\n?/g, '\n').split('\n').forEach(rawLine => {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      if (inCode) flushCode(); else flushParagraph();
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(rawLine);
      return;
    }
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      return;
    }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      commit();
      current.title = cleanInlineSyntax(heading[1]);
      return;
    }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (task || unordered || ordered || quote) flushParagraph();
    if (task) {
      current.entries.push({ kind: 'action', checked: task[1].toLowerCase() === 'x', text: cleanInlineSyntax(task[2]) });
    } else if (unordered) {
      current.entries.push({ kind: 'entry', text: cleanInlineSyntax(unordered[1]) });
    } else if (ordered) {
      current.entries.push({ kind: 'ordered', marker: ordered[1].padStart(2, '0'), text: cleanInlineSyntax(ordered[2]) });
    } else if (quote) {
      current.entries.push({ kind: 'quote', text: cleanInlineSyntax(quote[1]) });
    } else {
      paragraph.push(line.trim());
    }
  });
  if (inCode) flushCode();
  commit();
  return sections.map(section => ({
    ...section,
    kind: 'compatibility' as const,
    evidenceCount: 0,
  }));
}

function sectionsFromDocument(document: MeetingSummaryDocument): AuthoredSection[] {
  const sections: AuthoredSection[] = document.sections
    .filter(section => section.kind !== 'action_items' && section.stableKey !== 'action_items')
    .map(section => {
      const richEntries = section.richBlock?.items.map((item, index) => ({
        kind: section.richBlock?.kind === 'quote'
          ? 'quote' as const
          : section.richBlock?.kind === 'flow'
            ? 'ordered' as const
            : 'entry' as const,
        marker: section.richBlock?.kind === 'flow' ? String(index + 1).padStart(2, '0') : undefined,
        text: item.text.trim(),
        meta: item.meta?.trim() || undefined,
      })).filter(entry => entry.text) ?? [];
      const fallbackEntries = section.content.trim()
        ? parseSummaryText(section.content).flatMap(value => value.entries)
        : [];
      return {
        id: section.id,
        title: section.title?.trim() || null,
        kind: section.kind,
        entries: richEntries.length > 0 ? richEntries : fallbackEntries,
        evidenceCount: section.citations.length,
      };
    })
    .filter(section => section.title || section.entries.length > 0);

  const actions: AuthoredEntry[] = document.actionItemCandidates
    .filter(action => action.status !== 'dismissed' && action.content.trim())
    .map(action => ({
      kind: 'action' as const,
      checked: action.status === 'completed',
      text: action.content.trim(),
      meta: [action.assignee, action.dueText].filter(Boolean).join('　') || undefined,
    }));
  if (actions.length > 0) {
    sections.push({
      id: 'summary-actions',
      title: '后续行动',
      kind: 'action_items',
      entries: actions,
      evidenceCount: document.actionItemCandidates.reduce((count, action) => count + action.citations.length, 0),
    });
  }
  return sections;
}

type Props = Readonly<{
  content: string;
  document?: MeetingSummaryDocument | null;
  testID?: string;
}>;

export function MeetingSummaryContent({
  content,
  document = null,
  testID = 'meeting-summary-authored-content',
}: Props) {
  const { appearance, colors } = useTheme();
  const sections = useMemo(
    () => document ? sectionsFromDocument(document) : parseSummaryText(content),
    [content, document],
  );
  const carded = appearance.surfaceMode === 'soft' || appearance.surfaceMode === 'layered';
  return (
    <View testID={testID} style={s.root}>
      {sections.map((section, sectionIndex) => (
        <View
          key={section.id}
          testID={`meeting-summary-section-${sectionIndex}`}
          style={[
            s.section,
            carded && {
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderRadius: appearance.cardRadius,
              borderWidth: appearance.borderWidth,
              borderColor: colors.border,
              backgroundColor: appearance.surfaceMode === 'layered' ? colors.inputBg : colors.card,
            },
            appearance.surfaceMode === 'editorial' && {
              paddingBottom: 16,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.divider,
            },
          ]}
        >
          {section.title ? (
            <View style={s.headingRow}>
              {['timeline', 'flow', 'comparison', 'risk_card', 'stat', 'quote'].includes(section.kind) ? (
                <Ionicons
                  name={section.kind === 'timeline' ? 'time-outline' : section.kind === 'quote' ? 'chatbox-ellipses-outline' : 'git-compare-outline'}
                  size={17}
                  color={colors.sub}
                />
              ) : null}
              <Text
                selectable
                style={[
                  s.heading,
                  {
                    color: colors.text,
                    fontFamily: appearance.titleFontFamily,
                    letterSpacing: appearance.titleLetterSpacing,
                  },
                ]}
              >
                {section.title}
              </Text>
            </View>
          ) : null}
          {section.entries.map((entry, entryIndex) => {
            const key = `${section.id}-${entryIndex}`;
            if (entry.kind === 'ordered') {
              return (
                <View key={key} style={s.orderedRow}>
                  <Text style={[s.orderedMarker, { color: colors.primary, fontFamily: appearance.titleFontFamily }]}>
                    {entry.marker}
                  </Text>
                  <EntryText entry={entry} color={colors.text} quiet={colors.sub} fontFamily={appearance.fontFamily} />
                </View>
              );
            }
            if (entry.kind === 'action') {
              return (
                <View key={key} style={[s.actionRow, { borderColor: colors.border, borderRadius: appearance.controlRadius }]}>
                  <View style={[s.check, { borderColor: entry.checked ? colors.primary : colors.disabled, backgroundColor: entry.checked ? colors.primary : 'transparent' }]}>
                    {entry.checked ? <Ionicons name="checkmark" size={12} color={colors.body} /> : null}
                  </View>
                  <EntryText entry={entry} color={colors.text} quiet={colors.sub} fontFamily={appearance.fontFamily} />
                </View>
              );
            }
            if (entry.kind === 'quote') {
              return (
                <View key={key} style={[s.quote, { borderLeftColor: colors.primary }]}>
                  <EntryText entry={entry} color={colors.sub} quiet={colors.faint} fontFamily={appearance.fontFamily} />
                </View>
              );
            }
            return (
              <View
                key={key}
                style={[
                  s.entry,
                  entryIndex > 0 && entry.kind === 'entry' && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
                ]}
              >
                <EntryText entry={entry} color={colors.text} quiet={colors.sub} fontFamily={appearance.fontFamily} />
              </View>
            );
          })}
          {section.evidenceCount > 0 ? (
            <Text style={[s.evidence, { color: colors.primary, fontFamily: appearance.fontFamily }]}>
              {`原始依据（${section.evidenceCount}段）`}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function EntryText({
  entry,
  color,
  quiet,
  fontFamily,
}: Readonly<{ entry: AuthoredEntry; color: string; quiet: string; fontFamily: string }>) {
  return (
    <View style={s.entryText}>
      <Text selectable style={[s.content, { color, fontFamily }]}>{entry.text}</Text>
      {entry.meta ? <Text style={[s.meta, { color: quiet, fontFamily }]}>{entry.meta}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: 20, gap: 10 },
  section: { paddingVertical: 10 },
  headingRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { flex: 1, fontSize: 18, lineHeight: 26, fontWeight: '600' },
  entry: { paddingVertical: 8 },
  entryText: { flex: 1, minWidth: 0 },
  content: { fontSize: 16, lineHeight: 25 },
  meta: { marginTop: 4, fontSize: 13, lineHeight: 19 },
  orderedRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 8 },
  orderedMarker: { width: 42, paddingTop: 1, fontSize: 17, lineHeight: 25 },
  actionRow: { minHeight: 64, flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12, paddingVertical: 11, borderWidth: StyleSheet.hairlineWidth, marginTop: 8 },
  check: { width: 20, height: 20, borderWidth: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 2, marginRight: 12 },
  quote: { borderLeftWidth: 2, paddingLeft: 14, paddingVertical: 10 },
  evidence: { marginTop: 8, minHeight: 32, paddingVertical: 6, fontSize: 14, lineHeight: 20 },
});
