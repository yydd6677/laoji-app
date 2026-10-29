import React from 'react';
import { LaojiCalendarEditView } from 'laoji-native-platform';
import type { ScheduleEditorSurfaceProps } from './ScheduleEditorSurface';

export function ScheduleEditorSurface({ onAction, ...props }: ScheduleEditorSurfaceProps) {
  return <LaojiCalendarEditView {...props} onAction={event => onAction(event.nativeEvent)} />;
}
