import React from 'react';
import type { MeetingSummaryCarryForwardAuthorization } from '../domain/meeting';
import {
  MeetingSummaryCarryForwardSelectionStaleError,
  MeetingSummaryCarryForwardSourceUnavailableError,
  type MeetingSummaryCarryForwardSelection,
} from '../services/meetingSummaryCarryForward';
import type { MeetingSeriesMemoryProjection } from '../services/meetingSeriesMemory';
import { MeetingSeriesSelectionSheet } from './MeetingSeriesSelectionSheet';

function authorizationErrorMessage(error: unknown): string {
  if (error instanceof MeetingSummaryCarryForwardSelectionStaleError) {
    return '上次会议内容已变化，请取消后重试。';
  }
  if (error instanceof MeetingSummaryCarryForwardSourceUnavailableError) {
    return '所选内容尚未同步到账号，暂时无法引用。';
  }
  return '暂时无法引用，请稍后重试。';
}

export function MeetingSummaryCarryForwardSheet({
  visible,
  memory,
  onClose,
  onSkip,
  onAuthorize,
  onCompleted,
}: {
  visible: boolean;
  memory: MeetingSeriesMemoryProjection | null;
  onClose: () => void;
  onSkip: () => void;
  onAuthorize: (
    selection: MeetingSummaryCarryForwardSelection,
  ) => Promise<MeetingSummaryCarryForwardAuthorization>;
  onCompleted: (authorization: MeetingSummaryCarryForwardAuthorization) => void;
}) {
  return (
    <MeetingSeriesSelectionSheet
      visible={visible}
      memory={memory}
      title="引用上次会议内容"
      cancelAccessibilityLabel="取消生成整理结果"
      submitLabel={count => count > 0 ? `引用（${count}）` : '引用'}
      submitAccessibilityLabel={count => count > 0 ? `引用所选 ${count} 项` : '引用所选内容'}
      onClose={onClose}
      onSkip={onSkip}
      onSubmit={onAuthorize}
      onCompleted={onCompleted}
      errorMessage={authorizationErrorMessage}
    />
  );
}
