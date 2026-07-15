import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import {
  MeetingSummaryContent,
  parseMeetingSummaryMarkdown,
} from '../src/components/MeetingSummaryContent';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

describe('MeetingSummaryContent', () => {
  it('turns the meeting markdown contract into source-style content blocks', () => {
    expect(parseMeetingSummaryMarkdown([
      '# 会议总结',
      '',
      '讨论了 **发布安排**。',
      '- 本周完成回归',
      '1. 周五发布',
      '- [x] 确认负责人',
      '> 风险仍需跟踪',
      '```text',
      'build passed',
      '```',
    ].join('\n'))).toEqual([
      { type: 'heading', level: 1, text: '会议总结' },
      { type: 'paragraph', text: '讨论了 发布安排。' },
      { type: 'bullet', text: '本周完成回归' },
      { type: 'ordered', marker: '1.', text: '周五发布' },
      { type: 'task', checked: true, text: '确认负责人' },
      { type: 'quote', text: '风险仍需跟踪' },
      { type: 'code', text: 'build passed' },
    ]);
  });

  it('renders content without exposing markdown control characters', async () => {
    await render(<MeetingSummaryContent markdown={'# 会议总结\n\n- 第一项'} />);

    expect(screen.getByText('会议总结')).toBeTruthy();
    expect(screen.getByText('第一项')).toBeTruthy();
    expect(screen.queryByText('# 会议总结')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('meeting-summary-rich-text').props.style))
      .toEqual(expect.objectContaining({ paddingHorizontal: 20 }));
    expect(StyleSheet.flatten(screen.getByTestId('meeting-summary-block-0').props.style))
      .toEqual(expect.objectContaining({ marginTop: 8, fontSize: 16, lineHeight: 24 }));
  });
});
