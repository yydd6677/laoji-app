import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { RecordingScreen } from '../src/screens/RecordingScreen';

jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));

describe('RecordingScreen compatibility route', () => {
  it('replaces the retired preview page with the unified meeting detail', async () => {
    const navigation = {
      replace: jest.fn(),
    } as unknown as React.ComponentProps<typeof RecordingScreen>['navigation'];
    const route = {
      key: 'recording-compatibility',
      name: 'Recording' as const,
      params: { meetingId: 'meeting-1' },
    } as React.ComponentProps<typeof RecordingScreen>['route'];

    await render(<RecordingScreen navigation={navigation} route={route} />);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('Transcription', {
      meetingId: 'meeting-1',
    }));
  });
});
