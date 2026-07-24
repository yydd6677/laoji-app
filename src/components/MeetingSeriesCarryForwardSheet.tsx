import React from 'react';
import {
  SeriesMemoryCarryNoteConflictError,
  SeriesMemoryCarrySelectionStaleError,
  type CarrySeriesMemoryToManualNoteResult,
} from '../application/meeting';
import type { MeetingSeriesMemoryProjection } from '../services/meetingSeriesMemory';
import {
  MeetingSeriesSelectionSheet,
  type MeetingSeriesSelection,
} from './MeetingSeriesSelectionSheet';

export type MeetingSeriesCarryForwardSelection = MeetingSeriesSelection;

function carryErrorMessage(error: unknown): string {
  if (error instanceof SeriesMemoryCarrySelectionStaleError) {
    return '上次会议内容已变化，请取消后重试。';
  }
  if (error instanceof SeriesMemoryCarryNoteConflictError) {
    return '笔记已在其他位置更新，请取消后重试。';
  }
  return '暂时无法带入，请稍后重试。';
}

export function MeetingSeriesCarryForwardSheet({
  visible,
  memory,
  onClose,
  onCarry,
  onCompleted,
}: {
  visible: boolean;
  memory: MeetingSeriesMemoryProjection | null;
  onClose: () => void;
  onCarry: (
    selection: MeetingSeriesCarryForwardSelection,
  ) => Promise<CarrySeriesMemoryToManualNoteResult>;
  onCompleted: (result: CarrySeriesMemoryToManualNoteResult) => void;
}) {
  return (
    <MeetingSeriesSelectionSheet
      visible={visible}
      memory={memory}
      title="带入我的笔记"
      cancelAccessibilityLabel="取消带入我的笔记"
      submitLabel={count => count > 0 ? `带入（${count}）` : '带入'}
      submitAccessibilityLabel={count => count > 0 ? `带入所选 ${count} 项` : '带入所选内容'}
      onClose={onClose}
      onSubmit={onCarry}
      onCompleted={onCompleted}
      errorMessage={carryErrorMessage}
    />
  );
}
