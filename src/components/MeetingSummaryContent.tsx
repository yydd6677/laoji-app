import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';

export type MeetingSummaryBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string }
  | { type: 'ordered'; marker: string; text: string }
  | { type: 'task'; checked: boolean; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string };

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .trim();
}

export function parseMeetingSummaryMarkdown(markdown: string): MeetingSummaryBlock[] {
  const blocks: MeetingSummaryBlock[] = [];
  const paragraph: string[] = [];
  const code: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = stripInlineMarkdown(paragraph.join('\n'));
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph.length = 0;
  };

  const flushCode = () => {
    const text = code.join('\n').trimEnd();
    if (text) blocks.push({ type: 'code', text });
    code.length = 0;
  };

  markdown.replace(/\r\n?/g, '\n').split('\n').forEach(rawLine => {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      if (inCodeBlock) flushCode();
      else flushParagraph();
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (inCodeBlock) {
      code.push(rawLine);
      return;
    }
    if (!line.trim()) {
      flushParagraph();
      return;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      return;
    }

    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line);
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*(\d+[.)])\s+(.+)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const matched = heading || task || bullet || ordered || quote;
    if (matched) flushParagraph();

    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: stripInlineMarkdown(heading[2]) });
    } else if (task) {
      blocks.push({ type: 'task', checked: task[1].toLowerCase() === 'x', text: stripInlineMarkdown(task[2]) });
    } else if (bullet) {
      blocks.push({ type: 'bullet', text: stripInlineMarkdown(bullet[1]) });
    } else if (ordered) {
      blocks.push({ type: 'ordered', marker: ordered[1], text: stripInlineMarkdown(ordered[2]) });
    } else if (quote) {
      blocks.push({ type: 'quote', text: stripInlineMarkdown(quote[1]) });
    } else {
      paragraph.push(line.trim());
    }
  });

  if (inCodeBlock) flushCode();
  flushParagraph();
  return blocks;
}

type Props = {
  markdown: string;
  testID?: string;
};

function renderBlock(block: MeetingSummaryBlock, index: number) {
  const testID = `meeting-summary-block-${index}`;
  if (block.type === 'heading') {
    return (
      <Text key={testID} testID={testID} style={[s.block, s.heading]}>
        {block.text}
      </Text>
    );
  }
  if (block.type === 'bullet') {
    return (
      <View key={testID} testID={testID} style={[s.block, s.listRow]}>
        <View style={s.bullet} />
        <Text style={s.content}>{block.text}</Text>
      </View>
    );
  }
  if (block.type === 'ordered') {
    return (
      <View key={testID} testID={testID} style={[s.block, s.listRow]}>
        <Text style={s.orderedMarker}>{block.marker}</Text>
        <Text style={s.content}>{block.text}</Text>
      </View>
    );
  }
  if (block.type === 'task') {
    return (
      <View key={testID} testID={testID} style={[s.block, s.listRow]}>
        <View style={[s.checkbox, block.checked && s.checkboxChecked]}>
          {block.checked ? <Ionicons name="checkmark" size={12} color="#FFFFFF" /> : null}
        </View>
        <Text style={s.content}>{block.text}</Text>
      </View>
    );
  }
  if (block.type === 'quote') {
    return (
      <View key={testID} testID={testID} style={[s.block, s.quote]}>
        <Text style={[s.content, s.quoteText]}>{block.text}</Text>
      </View>
    );
  }
  if (block.type === 'code') {
    return (
      <View key={testID} testID={testID} style={[s.block, s.codeBlock]}>
        <Text selectable style={s.codeText}>{block.text}</Text>
      </View>
    );
  }
  return (
    <Text key={testID} testID={testID} selectable style={[s.block, s.content]}>
      {block.text}
    </Text>
  );
}

export function MeetingSummaryContent({ markdown, testID = 'meeting-summary-rich-text' }: Props) {
  const blocks = parseMeetingSummaryMarkdown(markdown);
  return (
    <View testID={testID} style={s.root}>
      {blocks.map(renderBlock)}
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: 20 },
  block: { marginTop: 8 },
  heading: { fontSize: 16, lineHeight: 24, fontWeight: '600', color: C.text },
  content: { flex: 1, fontSize: 16, lineHeight: 24, color: C.text },
  listRow: { flexDirection: 'row', alignItems: 'flex-start' },
  bullet: { width: 4, height: 4, borderRadius: 2, marginTop: 10, marginRight: 12, backgroundColor: C.text },
  orderedMarker: { width: 28, paddingRight: 8, fontSize: 16, lineHeight: 24, color: C.text, textAlign: 'right' },
  checkbox: {
    width: 16,
    height: 16,
    marginTop: 4,
    marginRight: 8,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { borderColor: C.primary, backgroundColor: C.primary },
  quote: { borderLeftWidth: 2, borderLeftColor: C.border, paddingLeft: 12 },
  quoteText: { color: C.sub },
  codeBlock: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 4, backgroundColor: C.inputBg },
  codeText: { fontSize: 14, lineHeight: 22, color: C.text },
});
