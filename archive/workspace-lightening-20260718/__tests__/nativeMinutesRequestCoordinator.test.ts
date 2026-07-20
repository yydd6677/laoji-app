jest.mock('laoji-native-platform', () => ({ MINUTES_SNAPSHOT_SCHEMA_VERSION: 1 }));

import {
  NativeMinutesRequestCoordinator,
  NativeMinutesTabSelectionOwner,
} from '../src/native/nativeMinutesRequestCoordinator';

describe('MIN-DETAIL-PAGER-001 request ownership', () => {
  it('rejects an old summary sync that completes after regeneration', async () => {
    const coordinator = new NativeMinutesRequestCoordinator();
    const initial = coordinator.begin('meeting-1', 'summary').token;
    const regenerated = coordinator.begin('meeting-1', 'summary').token;
    let summary = '';

    await Promise.resolve('new generation').then(value => {
      if (coordinator.isCurrent(regenerated, 'meeting-1')) summary = value;
    });
    await Promise.resolve('late initial sync').then(value => {
      if (coordinator.isCurrent(initial, 'meeting-1')) summary = value;
    });

    expect(summary).toBe('new generation');
  });

  it('rejects an older Expo tab action after the newer action already owns state', () => {
    const owner = new NativeMinutesTabSelectionOwner({
      meetingId: 'meeting-1',
      tab: 'transcript',
      generation: 3,
    });

    expect(owner.accept({ meetingId: 'meeting-1', tab: 'summary', generation: 7 })).toBe(true);
    expect(owner.accept({ meetingId: 'meeting-1', tab: 'speakers', generation: 6 })).toBe(false);
    expect(owner.accept({ meetingId: 'meeting-1', tab: 'speakers', generation: 7 })).toBe(false);
    expect(owner.current()).toEqual({ meetingId: 'meeting-1', tab: 'summary', generation: 7 });
  });
});
