import React from 'react';
import { AppActionSheet } from './AppActionSheet';
import type { ScheduleEditorResumeSelection } from '../hooks/useScheduleEditorEntry';

export function ScheduleEditorResumeSheet({ selection, onChoose, onClose }: {
  selection: ScheduleEditorResumeSelection | null;
  onChoose: (selection: ScheduleEditorResumeSelection, id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  return <AppActionSheet visible={Boolean(selection)} title={selection?.entry.eventRef ? '未保存的修改' : '未保存的日程'} onClose={onClose}
    items={selection ? [
      ...selection.drafts.map(draft => ({ key: draft.id,
        label: `${draft.startDate ? draft.startDate.slice(5).replace('-', '月') + '日 ' : ''}${draft.title.trim() || draft.latestInputText.trim() || '未命名日程'}`,
        onPress: () => { void onChoose(selection, draft.id); } })),
      ...(!selection.entry.followup && !selection.entry.draft ? [{ key: 'new',
        label: selection.entry.eventRef ? '重新编辑' : '新建日程',
        onPress: () => { void onChoose(selection, null); } }] : []),
    ] : []} />;
}
