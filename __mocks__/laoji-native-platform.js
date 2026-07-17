const React = require('react');

const unavailableCapabilities = {
  calendarSurface: false,
  minutesSurface: false,
  nativeAudioRuntime: false,
  mediaPlayer: false,
};

module.exports = {
  NATIVE_PLATFORM_EVIDENCE_SCHEMA_VERSION: 1,
  NATIVE_CALENDAR_SNAPSHOT_SCHEMA_VERSION: 1,
  MINUTES_SNAPSHOT_SCHEMA_VERSION: 1,
  SCHEDULE_VOICE_SNAPSHOT_SCHEMA_VERSION: 1,
  MINUTES_PLAYBACK_RATES: [0.5, 0.75, 1, 1.25, 1.5, 2, 3],
  hasLaojiNativePlatform: () => false,
  getNativePlatformCapabilities: async () => unavailableCapabilities,
  activateMinutesPlaybackStorageScope: async () => undefined,
  hasNativeTransfer: () => false,
  nativeTransfer: null,
  LaojiCalendarView: props => React.createElement('LaojiCalendarView', props, props.children),
  LaojiCalendarSearchView: props => React.createElement('LaojiCalendarSearchView', props, props.children),
  LaojiCalendarDetailView: props => React.createElement('LaojiCalendarDetailView', props, props.children),
  LaojiCalendarEditView: props => React.createElement('LaojiCalendarEditView', props, props.children),
  LaojiMinutesView: props => React.createElement('LaojiMinutesView', props, props.children),
  LaojiScheduleVoiceView: props => React.createElement('LaojiScheduleVoiceView', props, props.children),
  LaojiSpeakerView: props => React.createElement('LaojiSpeakerView', props, props.children),
  LaojiNativeDialogHost: props => React.createElement('LaojiNativeDialogHost', props, props.children),
  LaojiNativeActionSheetHost: props => React.createElement('LaojiNativeActionSheetHost', props, props.children),
};
